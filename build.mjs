// Concatenates src/ into the distributable files in dist/.
// The section between GROK_SWITCH_PAYLOAD_BEGIN/END is what gets injected into
// the Grok Bot host bundle; the CLI reads it back out of its own file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const PROTOCOL_FILES = [
  "contract.cjs",
  "sse.cjs",
  "tools.cjs",
  "openai-chat.cjs",
  "openai-responses.cjs",
  "anthropic-messages.cjs",
  "index.cjs"
];

function read(relative) {
  let text = readFileSync(join(root, relative), "utf8");
  if (text.startsWith("\ufeff")) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n");
  return text.endsWith("\n") ? text : text + "\n";
}

const registry = `var __grokSwitchFactories = Object.create(null);
var __grokSwitchModules = Object.create(null);
function __grokSwitchRegister(id, factory) {
  __grokSwitchFactories[id] = factory;
}
function __grokSwitchRequire(id) {
  if (__grokSwitchModules[id] == null) {
    var factory = __grokSwitchFactories[id];
    // Node built-ins (node:crypto) come from the host's own require.
    if (factory == null) return require(id);
    var module = { exports: {} };
    __grokSwitchModules[id] = module;
    factory(module, module.exports, __grokSwitchRequire);
  }
  return __grokSwitchModules[id].exports;
}
`;

function buildPayload() {
  let payload = "// GROK_SWITCH_PAYLOAD_BEGIN\n" + registry;
  for (const file of PROTOCOL_FILES) {
    payload += `__grokSwitchRegister(${JSON.stringify("./" + file)}, function (module, exports, require) {\n`;
    payload += read(join("src", "protocols", file));
    payload += "});\n";
  }
  payload += read("src/runtime.cjs");
  payload += `function createHostInference(options) {
  return grokSwitchWrapHostInference(__grokSwitchOriginalCreateHostInference(options));
}
// GROK_SWITCH_PAYLOAD_END
`;
  return payload;
}

export function buildCore() {
  const payload = buildPayload();
  const cli = read("src/cli.cjs").replace("__GROK_SWITCH_VERSION__", version);

  const output = `#!/usr/bin/env node
// grok-switch ${version} (core) - https://github.com/enderzcx/grok-bot-switch
// Single-file core build. Do not edit; regenerate with \`node build.mjs --core\`.
"use strict";
${payload}${cli}`;

  mkdirSync(join(root, "dist"), { recursive: true });
  const outPath = join(root, "dist", "grok-switch-core.cjs");
  writeFileSync(outPath, output, { mode: 0o755 });

  const check = spawnSync(process.execPath, ["--check", outPath], { encoding: "utf8" });
  if (check.status !== 0) {
    process.stderr.write(check.stderr);
    process.exit(1);
  }
  process.stdout.write(`wrote ${outPath} (${output.length} bytes, v${version})\n`);
  return outPath;
}

export function buildFull() {
  const payload = buildPayload();
  const panelHtml = readFileSync(join(root, "panel", "dist", "index.html"), "utf8");
  const panel = "var UI_HTML = " + JSON.stringify(panelHtml) + ";\n";
  const cli = read("src/ui.cjs") + panel + read("src/cli.cjs").replace("__GROK_SWITCH_VERSION__", version);

  const output = `#!/usr/bin/env node
// grok-switch ${version} - https://github.com/enderzcx/grok-bot-switch
// Single-file build. Do not edit; regenerate with \`node build.mjs\`.
"use strict";
${payload}${cli}`;

  mkdirSync(join(root, "dist"), { recursive: true });
  const outPath = join(root, "dist", "grok-switch.cjs");
  writeFileSync(outPath, output, { mode: 0o755 });

  const check = spawnSync(process.execPath, ["--check", outPath], { encoding: "utf8" });
  if (check.status !== 0) {
    process.stderr.write(check.stderr);
    process.exit(1);
  }
  process.stdout.write(`wrote ${outPath} (${output.length} bytes, v${version})\n`);
  return outPath;
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("build.mjs")
);

if (isMain) {
  if (process.argv.includes("--core")) {
    buildCore();
  } else {
    buildFull();
    buildCore();
  }
}
