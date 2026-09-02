// grok-switch command line. build.mjs appends this after the injectable
// payload (adapters + runtime.cjs), so grokSwitch* functions are in scope.
// This part is never injected into the host bundle.

var cliFs = require("node:fs");
var cliPath = require("node:path");
var cliChildProcess = require("node:child_process");

var CLI_VERSION = "__GROK_SWITCH_VERSION__";
var CLI_HOST_PATH = process.env.GROK_SWITCH_HOST || "/home/box/sand-host/host-main.cjs";
var CLI_HOST_VERSION_PATH = cliPath.join(cliPath.dirname(CLI_HOST_PATH), "version");
var CLI_BACKUP_PATH = CLI_HOST_PATH + ".grok-switch.orig";
var CLI_SUPERVISOR_DIR = process.env.GROK_SWITCH_SUPERVISOR_DIR || "/tmp/sand-supervisor";
var CLI_PROC_ROOT = process.env.GROK_SWITCH_PROC || "/proc";
var CLI_CONFIG_DIR = GROK_SWITCH_DIR;
var CLI_CONFIG_PATH = GROK_SWITCH_CONFIG_PATH;
var CLI_LOG_PATH = GROK_SWITCH_LOG_PATH;

var CLI_PAYLOAD_BEGIN = "// GROK_SWITCH_PAYLOAD_BEGIN";
var CLI_PAYLOAD_END = "// GROK_SWITCH_PAYLOAD_END";
var CLI_PATCH_BEGIN = "// GROK_SWITCH_BEGIN";
var CLI_PATCH_END = "// GROK_SWITCH_END";
var CLI_HOST_FACTORY = "function createHostInference(";
var CLI_RENAMED_FACTORY = "function __grokSwitchOriginalCreateHostInference(";
var CLI_REQUIRED_HOST_NAMES = ["BasePromptExecutor", "BasePromptBuilder", "function createCursorSandInference("];

var CLI_USAGE = [
  "grok-switch " + CLI_VERSION + " - route Grok Bot inference to your own model API",
  "",
  "usage: node grok-switch.cjs <command> [options]",
  "",
  "  use <name> [provider options]   switch to a saved provider (saves it first if options given)",
  "  official                        switch back to official Grok; saved providers are kept",
  "  add <name> <provider options>   save or update a provider without switching",
  "  remove <name>                   delete a saved provider",
  "  list                            show saved providers",
  "  status [--json]                 show host patch, process, supervisor and config state",
  "  test <name> [--json]            send one small request to a provider and print the reply",
  "  log [N]                         show the last N upstream requests (default 20)",
  "  restart                         ask the supervisor to restart the host when idle",
  "  restore                         remove the patch from the host bundle and restart",
  "",
  "provider options:",
  "  --url <baseUrl>                 e.g. https://api.openai.com/v1 (required)",
  "  --model <id>                    model id sent to the provider (required)",
  "  --protocol <p>                  openai-chat (default) | openai-responses | anthropic-messages",
  "  --key <apiKey>                  API key; or --key-file <path>; or env GROK_SWITCH_API_KEY",
  "  --auth <type>                   bearer | x-api-key | none (default depends on protocol)",
  "  --endpoint <path>               override the request path, e.g. /v1/chat/completions",
  "  --header <Name: value>          extra request header (repeatable)",
  "  --reasoning <effort>            reasoningEffort parameter (OpenAI protocols)",
  "  --max-tokens <n>                maxTokens parameter (Anthropic default 8192)",
  "",
  "files: " + CLI_CONFIG_PATH + " (config, mode 600), " + CLI_LOG_PATH + " (request log)",
  "host:  " + CLI_HOST_PATH
].join("\n");

class CliError extends Error {}

function cliParseArgs(argv) {
  var positional = [];
  var flags = {};
  for (var i = 0; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg.slice(0, 2) !== "--") {
      positional.push(arg);
      continue;
    }
    var eq = arg.indexOf("=");
    var name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    var value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (name === "json" || name === "force") {
      value = true;
    } else {
      if (i + 1 >= argv.length) throw new CliError("--" + name + " needs a value");
      i += 1;
      value = argv[i];
    }
    if (name === "header") {
      if (flags.header == null) flags.header = [];
      flags.header.push(value);
    } else {
      flags[name] = value;
    }
  }
  return { positional: positional, flags: flags };
}

// ---------------------------------------------------------------------------
// Config file

function cliReadRawConfig() {
  var text = grokSwitchReadConfigText();
  if (text == null) return { active: null, providers: {} };
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new CliError(CLI_CONFIG_PATH + " is not valid JSON; fix or delete it");
  }
  if (!grokSwitchIsPlainObject(parsed)) throw new CliError(CLI_CONFIG_PATH + " must contain a JSON object");
  if (parsed.providers == null) parsed.providers = {};
  if (parsed.active === void 0) parsed.active = null;
  return parsed;
}

function cliWriteConfig(config) {
  cliFs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 448 });
  try {
    cliFs.chmodSync(CLI_CONFIG_DIR, 448);
  } catch (_error) {}
  var tmp = CLI_CONFIG_PATH + "." + process.pid + ".tmp";
  cliFs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 384 });
  cliFs.renameSync(tmp, CLI_CONFIG_PATH);
}

function cliRequireProviderName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new CliError("provider name must be 1-64 letters, digits, '.', '_' or '-'");
  }
  return name;
}

function cliHasProviderFlags(flags) {
  var names = ["url", "model", "protocol", "key", "key-file", "auth", "endpoint", "header", "reasoning", "max-tokens"];
  for (var i = 0; i < names.length; i += 1) {
    if (flags[names[i]] != null) return true;
  }
  return false;
}

function cliReadKey(flags) {
  if (flags.key != null) return String(flags.key);
  if (flags["key-file"] != null) return cliFs.readFileSync(String(flags["key-file"]), "utf8").trim();
  if (process.env.GROK_SWITCH_API_KEY != null) return process.env.GROK_SWITCH_API_KEY;
  return null;
}

// Builds the raw provider entry from flags, merging over an existing entry so
// `use name --model x` can change one field.
function cliProviderFromFlags(name, flags, existing) {
  var entry = existing != null ? JSON.parse(JSON.stringify(existing)) : {};
  if (flags.protocol != null) entry.protocol = String(flags.protocol);
  if (entry.protocol == null) entry.protocol = "openai-chat";
  if (flags.url != null) entry.baseUrl = String(flags.url);
  if (flags.model != null) entry.model = String(flags.model);
  var key = cliReadKey(flags);
  if (key != null) entry.apiKey = key;
  if (flags.auth != null) entry.authType = String(flags.auth);
  if (flags.endpoint != null) entry.endpointPath = String(flags.endpoint);
  if (flags.header != null) {
    entry.headers = entry.headers || {};
    for (var i = 0; i < flags.header.length; i += 1) {
      var raw = String(flags.header[i]);
      var colon = raw.indexOf(":");
      if (colon <= 0) throw new CliError("--header must look like 'Name: value'");
      entry.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    }
  }
  if (flags.reasoning != null || flags["max-tokens"] != null) {
    entry.parameters = entry.parameters || {};
    if (flags.reasoning != null) entry.parameters.reasoningEffort = String(flags.reasoning);
    if (flags["max-tokens"] != null) {
      var n = Number(flags["max-tokens"]);
      if (!Number.isInteger(n) || n < 1) throw new CliError("--max-tokens must be a positive integer");
      entry.parameters.maxTokens = n;
    }
  }
  if (entry.baseUrl == null) throw new CliError("--url is required");
  if (entry.model == null) throw new CliError("--model is required");
  try {
    grokSwitchNormalizeProvider(name, entry);
  } catch (error) {
    throw new CliError(error.message);
  }
  return entry;
}

function cliDescribeProvider(provider) {
  return provider.protocol + " " + provider.baseUrl + provider.endpointPath + " model=" + provider.model;
}

// ---------------------------------------------------------------------------
// Host bundle patching

function cliPayload() {
  var self = cliFs.readFileSync(__filename, "utf8");
  var begin = self.indexOf(CLI_PAYLOAD_BEGIN);
  var end = self.indexOf(CLI_PAYLOAD_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new CliError("this file is not a built grok-switch bundle; run `npm run build` and use dist/grok-switch.cjs");
  }
  return self.slice(begin, end + CLI_PAYLOAD_END.length) + "\n";
}

function cliCount(text, needle) {
  var count = 0;
  var index = 0;
  for (;;) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

// Returns { stock, patched, version } where stock is the bundle text with our
// patch removed (identical to the original file when no patch is present).
function cliInspectBundle(text) {
  var begin = text.indexOf(CLI_PATCH_BEGIN);
  var end = text.indexOf(CLI_PATCH_END);
  if (begin === -1 && end === -1) return { stock: text, patched: false, version: null };
  if (begin === -1 || end === -1 || end < begin) {
    throw new CliError("host bundle contains a damaged grok-switch patch; restore it from " + CLI_BACKUP_PATH);
  }
  var lineEnd = text.indexOf("\n", begin);
  var version = text.slice(begin + CLI_PATCH_BEGIN.length, lineEnd).trim();
  var stop = end + CLI_PATCH_END.length;
  if (text[stop] === "\n") stop += 1;
  var stock = text.slice(0, begin) + text.slice(stop);
  if (cliCount(stock, CLI_RENAMED_FACTORY) !== 1) {
    throw new CliError("host bundle contains a damaged grok-switch patch; restore it from " + CLI_BACKUP_PATH);
  }
  stock = stock.replace(CLI_RENAMED_FACTORY, CLI_HOST_FACTORY);
  return { stock: stock, patched: true, version: version };
}

function cliAssertPatchable(stock) {
  var factories = cliCount(stock, CLI_HOST_FACTORY);
  if (factories !== 1) {
    throw new CliError("host bundle has " + factories + " createHostInference definitions (expected 1); this Grok Bot version is not supported yet");
  }
  for (var i = 0; i < CLI_REQUIRED_HOST_NAMES.length; i += 1) {
    if (stock.indexOf(CLI_REQUIRED_HOST_NAMES[i]) === -1) {
      throw new CliError("host bundle lacks " + CLI_REQUIRED_HOST_NAMES[i] + "; this Grok Bot version is not supported yet");
    }
  }
}

function cliBuildPatched(stock) {
  var block = CLI_PATCH_BEGIN + " " + CLI_VERSION + "\n" + cliPayload() + CLI_PATCH_END + "\n";
  return stock.replace(CLI_HOST_FACTORY, block + CLI_RENAMED_FACTORY);
}

function cliNodeCheck(path) {
  var result = cliChildProcess.spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) {
    var detail = String(result.stderr || result.stdout).trim().split("\n").filter(Boolean).slice(0, 4).join(" | ");
    throw new CliError("patched bundle failed `node --check`: " + detail);
  }
}

function cliWriteBundle(text) {
  var mode = 420;
  try {
    mode = cliFs.statSync(CLI_HOST_PATH).mode & 511;
  } catch (_error) {}
  // Keep the .cjs extension so `node --check` parses it as CommonJS.
  var tmp = CLI_HOST_PATH + ".grok-switch-tmp.cjs";
  cliFs.writeFileSync(tmp, text, { mode: mode });
  try {
    cliNodeCheck(tmp);
  } catch (error) {
    try {
      cliFs.unlinkSync(tmp);
    } catch (_unlink) {}
    throw error;
  }
  cliFs.renameSync(tmp, CLI_HOST_PATH);
}

function cliReadBundle() {
  try {
    return cliFs.readFileSync(CLI_HOST_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new CliError("host bundle not found at " + CLI_HOST_PATH + "; run this inside the Grok Bot cloud machine");
    throw error;
  }
}

// Ensures the host bundle on disk carries the current patch.
// Returns "unchanged" | "patched" | "updated".
function cliEnsurePatched() {
  var text = cliReadBundle();
  var info = cliInspectBundle(text);
  if (info.patched && info.version === CLI_VERSION) return "unchanged";
  cliAssertPatchable(info.stock);
  if (!info.patched) cliFs.writeFileSync(CLI_BACKUP_PATH, info.stock, { mode: 384 });
  cliWriteBundle(cliBuildPatched(info.stock));
  return info.patched ? "updated" : "patched";
}

function cliUnpatch() {
  var text = cliReadBundle();
  var info = cliInspectBundle(text);
  if (!info.patched) return false;
  cliWriteBundle(info.stock);
  try {
    cliFs.unlinkSync(CLI_BACKUP_PATH);
  } catch (_error) {}
  return true;
}

// ---------------------------------------------------------------------------
// Host process and supervisor

function cliBootTimeMs() {
  var stat = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, "stat"), "utf8");
  var match = /^btime (\d+)/m.exec(stat);
  return match ? Number(match[1]) * 1000 : null;
}

function cliFindHostProcess() {
  var entries;
  try {
    entries = cliFs.readdirSync(CLI_PROC_ROOT);
  } catch (_error) {
    return null;
  }
  var boot = null;
  try {
    boot = cliBootTimeMs();
  } catch (_error) {}
  for (var i = 0; i < entries.length; i += 1) {
    if (!/^\d+$/.test(entries[i]) || Number(entries[i]) === process.pid) continue;
    var cmdline;
    try {
      cmdline = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, entries[i], "cmdline"), "utf8").split("\0");
    } catch (_error) {
      continue;
    }
    if (cmdline.indexOf(CLI_HOST_PATH) === -1) continue;
    var startedAtMs = null;
    try {
      var stat = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, entries[i], "stat"), "utf8");
      var fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      var startTicks = Number(fields[19]);
      if (boot != null && Number.isFinite(startTicks)) startedAtMs = boot + startTicks * 10;
    } catch (_error) {}
    return { pid: Number(entries[i]), startedAtMs: startedAtMs };
  }
  return null;
}

function cliSupervisorState() {
  var commandPath = cliPath.join(CLI_SUPERVISOR_DIR, "command.json");
  var state = { busy: cliFs.existsSync(cliPath.join(CLI_SUPERVISOR_DIR, "agent.busy")), pending: null };
  if (cliFs.existsSync(commandPath)) {
    try {
      state.pending = JSON.parse(cliFs.readFileSync(commandPath, "utf8"));
    } catch (_error) {
      state.pending = { id: "unreadable" };
    }
  }
  return state;
}

// Asks the supervisor to restart the host. The supervisor applies restart
// commands only when no agent is busy, so this is safe to issue any time.
function cliRequestRestart(reason) {
  var state = cliSupervisorState();
  if (state.pending != null) return { issued: false, pending: state.pending };
  cliFs.mkdirSync(CLI_SUPERVISOR_DIR, { recursive: true });
  var command = {
    id: "grok-switch-" + Date.now(),
    kind: "restart",
    issuedAtMs: Date.now(),
    reason: reason
  };
  var commandPath = cliPath.join(CLI_SUPERVISOR_DIR, "command.json");
  cliFs.writeFileSync(commandPath + ".part", JSON.stringify(command));
  cliFs.renameSync(commandPath + ".part", commandPath);
  return { issued: true, command: command };
}

function cliHostState() {
  var text = null;
  try {
    text = cliReadBundle();
  } catch (_error) {}
  var info = text == null ? null : cliInspectBundle(text);
  var bundleMtimeMs = null;
  try {
    bundleMtimeMs = cliFs.statSync(CLI_HOST_PATH).mtimeMs;
  } catch (_error) {}
  var version = null;
  try {
    version = cliFs.readFileSync(CLI_HOST_VERSION_PATH, "utf8").trim();
  } catch (_error) {}
  var proc = cliFindHostProcess();
  var runningCurrent = null;
  if (proc != null && proc.startedAtMs != null && bundleMtimeMs != null) {
    runningCurrent = proc.startedAtMs >= bundleMtimeMs;
  }
  return {
    path: CLI_HOST_PATH,
    exists: text != null,
    version: version,
    patched: info == null ? false : info.patched,
    patchVersion: info == null ? null : info.version,
    backupExists: cliFs.existsSync(CLI_BACKUP_PATH),
    process: proc,
    runningCurrentBundle: runningCurrent,
    supervisor: cliSupervisorState()
  };
}

// ---------------------------------------------------------------------------
// Commands

function cliPrint(line) {
  process.stdout.write(line + "\n");
}

function cliCommandAdd(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  config.providers[name] = cliProviderFromFlags(name, args.flags, config.providers[name]);
  cliWriteConfig(config);
  cliPrint("saved provider " + name + ": " + cliDescribeProvider(grokSwitchNormalizeProvider(name, config.providers[name])));
}

function cliCommandRemove(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  if (config.providers[name] == null) throw new CliError("no provider named " + name);
  if (config.active === name) throw new CliError(name + " is the active provider; run `official` or `use <other>` first");
  delete config.providers[name];
  cliWriteConfig(config);
  cliPrint("removed provider " + name);
}

function cliCommandList(args) {
  var config = cliReadRawConfig();
  var names = Object.keys(config.providers);
  if (args.flags.json) {
    var out = {};
    for (var i = 0; i < names.length; i += 1) {
      var copy = JSON.parse(JSON.stringify(config.providers[names[i]]));
      if (copy.apiKey != null) copy.apiKey = "***";
      out[names[i]] = copy;
    }
    cliPrint(JSON.stringify({ active: config.active, providers: out }, null, 2));
    return;
  }
  if (names.length === 0) {
    cliPrint("no providers saved; add one with: use <name> --url <baseUrl> --model <id> --key <apiKey>");
    return;
  }
  for (var j = 0; j < names.length; j += 1) {
    var marker = config.active === names[j] ? "* " : "  ";
    var summary;
    try {
      summary = cliDescribeProvider(grokSwitchNormalizeProvider(names[j], config.providers[names[j]]));
    } catch (error) {
      summary = "INVALID: " + error.message;
    }
    cliPrint(marker + names[j] + "  " + summary);
  }
  cliPrint(config.active == null ? "active: official Grok" : "active: " + config.active);
}

function cliExplainRestart(result) {
  if (result.issued) {
    cliPrint("restart requested (" + result.command.id + "); the supervisor restarts the host as soon as no Bot is busy.");
  } else {
    cliPrint("a supervisor command is already pending (" + String(result.pending.id) + "); the host restarts when it is applied.");
  }
}

function cliCommandUse(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  if (cliHasProviderFlags(args.flags)) {
    config.providers[name] = cliProviderFromFlags(name, args.flags, config.providers[name]);
  }
  if (config.providers[name] == null) {
    throw new CliError("no provider named " + name + "; pass --url/--model/--key to create it");
  }
  var provider;
  try {
    provider = grokSwitchNormalizeProvider(name, config.providers[name]);
  } catch (error) {
    throw new CliError(error.message);
  }
  var outcome = cliEnsurePatched();
  config.active = name;
  cliWriteConfig(config);
  cliPrint("active provider: " + name + " (" + cliDescribeProvider(provider) + ")");
  if (outcome === "patched") cliPrint("host bundle patched; original saved to " + CLI_BACKUP_PATH);
  if (outcome === "updated") cliPrint("host bundle patch updated to " + CLI_VERSION);
  var state = cliHostState();
  if (outcome !== "unchanged" || state.runningCurrentBundle === false) {
    cliExplainRestart(cliRequestRestart("grok-switch use " + name));
    cliPrint("after the restart, new conversations use " + name + ".");
  } else if (state.process == null) {
    cliPrint("host process not found; it will use " + name + " when it starts.");
  } else {
    cliPrint("takes effect on the next conversation turn; no restart needed.");
  }
}

function cliCommandOfficial() {
  var config = cliReadRawConfig();
  config.active = null;
  cliWriteConfig(config);
  cliPrint("active provider: official Grok (saved providers kept)");
  cliPrint("takes effect on the next conversation turn.");
}

function cliCommandRestart() {
  cliExplainRestart(cliRequestRestart("grok-switch restart"));
}

function cliCommandRestore() {
  var config = cliReadRawConfig();
  if (config.active != null) {
    config.active = null;
    cliWriteConfig(config);
    cliPrint("active provider reset to official Grok");
  }
  if (cliUnpatch()) {
    cliPrint("patch removed from " + CLI_HOST_PATH);
    cliExplainRestart(cliRequestRestart("grok-switch restore"));
  } else {
    cliPrint("host bundle has no grok-switch patch; nothing to restore");
  }
}

function cliReadLog(limit) {
  var lines = [];
  try {
    lines = cliFs.readFileSync(CLI_LOG_PATH, "utf8").split("\n").filter(Boolean);
  } catch (_error) {}
  return lines.slice(-limit).map(function (line) {
    try {
      return JSON.parse(line);
    } catch (_error) {
      return { raw: line };
    }
  });
}

function cliFormatLogEntry(entry) {
  if (entry.raw != null) return entry.raw;
  var parts = [entry.ts, entry.provider || "-", entry.model || "-", entry.kind || "-", "HTTP " + entry.status, (entry.ms || 0) + "ms"];
  if (entry.usage) parts.push("tokens " + entry.usage.promptTokens + "+" + entry.usage.completionTokens);
  if (entry.error) parts.push("ERROR " + entry.error);
  return parts.join("  ");
}

function cliCommandLog(args) {
  var limit = args.positional[1] != null ? Number(args.positional[1]) : 20;
  if (!Number.isInteger(limit) || limit < 1) throw new CliError("log count must be a positive integer");
  var entries = cliReadLog(limit);
  if (entries.length === 0) {
    cliPrint("no upstream requests logged yet (" + CLI_LOG_PATH + ")");
    return;
  }
  for (var i = 0; i < entries.length; i += 1) cliPrint(cliFormatLogEntry(entries[i]));
}

function cliCommandStatus(args) {
  var host = cliHostState();
  var config = cliReadRawConfig();
  var route = grokSwitchResolveRoute();
  var recent = cliReadLog(5);
  if (args.flags.json) {
    var activeProvider = route.kind === "external" ? cliDescribeProvider(route.provider) : null;
    cliPrint(JSON.stringify({
      version: CLI_VERSION,
      host: host,
      config: { path: CLI_CONFIG_PATH, active: config.active, providers: Object.keys(config.providers), route: route.kind, error: route.kind === "error" ? route.message : null, activeProvider: activeProvider },
      recentRequests: recent
    }, null, 2));
    return;
  }
  cliPrint("grok-switch " + CLI_VERSION);
  if (!host.exists) {
    cliPrint("host bundle : not found at " + host.path + " (not inside the Grok Bot cloud machine?)");
  } else {
    var patch = host.patched ? "patched (" + host.patchVersion + ")" : "not patched";
    cliPrint("host bundle : " + host.path + (host.version ? " version " + host.version : "") + "  " + patch);
  }
  if (host.process == null) {
    cliPrint("host process: not running");
  } else {
    var running = host.runningCurrentBundle === true ? "running current bundle" : host.runningCurrentBundle === false ? "RESTART PENDING (bundle changed after start)" : "start time unknown";
    cliPrint("host process: pid " + host.process.pid + (host.process.startedAtMs ? " started " + new Date(host.process.startedAtMs).toISOString() : "") + "  " + running);
  }
  var sup = host.supervisor;
  cliPrint("supervisor  : " + (sup.busy ? "agent busy" : "idle") + (sup.pending ? ", command pending (" + String(sup.pending.id) + ")" : ""));
  if (route.kind === "official") cliPrint("active      : official Grok");
  else if (route.kind === "external") cliPrint("active      : " + route.provider.name + " -> " + cliDescribeProvider(route.provider));
  else cliPrint("active      : MISCONFIGURED - " + route.message + " (requests fail until fixed; run `official` to recover)");
  var names = Object.keys(config.providers);
  cliPrint("providers   : " + (names.length ? names.join(", ") : "none"));
  if (route.kind === "external" && host.exists && !host.patched) {
    cliPrint("warning     : provider selected but host is not patched (Grok Bot update replaced the bundle?); run `use " + route.provider.name + "` to re-apply");
  }
  if (recent.length > 0) {
    cliPrint("recent      :");
    for (var i = 0; i < recent.length; i += 1) cliPrint("  " + cliFormatLogEntry(recent[i]));
  }
}

async function cliCommandTest(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  if (config.providers[name] == null) throw new CliError("no provider named " + name);
  var provider;
  try {
    provider = grokSwitchNormalizeProvider(name, config.providers[name]);
  } catch (error) {
    throw new CliError(error.message);
  }
  var startedAt = Date.now();
  var result = grokSwitchStream(provider, {
    messages: [{ role: "user", content: "Reply with exactly the word OK and nothing else." }],
    tools: [],
    options: {},
    requestKind: "test"
  });
  var text = "";
  var failure = null;
  try {
    for await (var event of result.fullStream) {
      if (event.type === "text-delta") text += event.textDelta;
    }
  } catch (error) {
    failure = error;
  }
  var ms = Date.now() - startedAt;
  var usage = null;
  try {
    usage = await result.usage;
  } catch (_error) {}
  if (args.flags.json) {
    cliPrint(JSON.stringify({ ok: failure == null, provider: name, ms: ms, text: text, usage: usage, error: failure ? failure.message : null }));
  } else if (failure != null) {
    cliPrint("FAILED after " + ms + "ms: " + failure.message);
  } else {
    cliPrint("OK in " + ms + "ms via " + cliDescribeProvider(provider));
    cliPrint("reply: " + JSON.stringify(text));
    if (usage) cliPrint("usage: " + usage.promptTokens + " prompt + " + usage.completionTokens + " completion tokens");
  }
  if (failure != null) process.exitCode = 1;
}

async function cliMain(argv) {
  var args = cliParseArgs(argv);
  var command = args.positional[0];
  if (command == null || command === "help" || command === "--help" || command === "-h") {
    cliPrint(CLI_USAGE);
    return;
  }
  if (command === "version") return cliPrint(CLI_VERSION);
  if (command === "add") return cliCommandAdd(args);
  if (command === "remove") return cliCommandRemove(args);
  if (command === "list") return cliCommandList(args);
  if (command === "use") return cliCommandUse(args);
  if (command === "official") return cliCommandOfficial(args);
  if (command === "status") return cliCommandStatus(args);
  if (command === "test") return cliCommandTest(args);
  if (command === "log") return cliCommandLog(args);
  if (command === "restart") return cliCommandRestart(args);
  if (command === "restore") return cliCommandRestore(args);
  throw new CliError("unknown command " + command + "\n\n" + CLI_USAGE);
}

if (require.main === module) {
  cliMain(process.argv.slice(2)).catch(function (error) {
    process.stderr.write("error: " + (error instanceof CliError ? error.message : (error && error.stack) || String(error)) + "\n");
    process.exitCode = 1;
  });
}
