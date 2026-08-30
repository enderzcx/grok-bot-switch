"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const protocols = require("../src/provider_protocols/index.cjs");

const CONFIG_PATH = "/workspace/grok-home/config/external.json";
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "provider-direct-session.cjs"), "utf8");
const input = JSON.parse(fs.readFileSync(0, "utf8"));

class BasePromptBuilder {
  constructor(initialMessages) {
    this.messages = initialMessages == null ? [] : Array.isArray(initialMessages) ? initialMessages.slice() : [initialMessages];
  }
  appendMessages(messages) {
    this.messages.push(...(Array.isArray(messages) ? messages : [messages]));
    return this;
  }
  getState() {
    return this.messages.slice();
  }
  getMessages() {
    return this.messages.slice();
  }
  clearMessages() {
    this.messages = [];
  }
}

class BasePromptExecutor {
  constructor(builder) {
    this.builder = builder;
  }
  appendMessages(messages) {
    this.builder.appendMessages(messages);
    return this;
  }
  getState() {
    return this.builder.getState();
  }
  getMessages() {
    return this.builder.getMessages();
  }
  clearMessages() {
    this.builder.clearMessages();
  }
}

function usageChunk() {
  return {
    id: "chatcmpl-boundary",
    object: "chat.completion.chunk",
    model: "model-name",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
  };
}

function sseResponse() {
  const chunks = [
    `data: ${JSON.stringify({ id: "chatcmpl-boundary", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify(usageChunk())}\n\n`,
    "data: [DONE]\n\n"
  ];
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-request-id" ? "boundary-req" : null;
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= encoded.length) return { done: true, value: undefined };
            const value = encoded[index];
            index += 1;
            return { done: false, value };
          },
          releaseLock() {}
        };
      }
    }
  };
}

const fetches = [];
const context = {
  BasePromptBuilder,
  BasePromptExecutor,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
  crypto,
  fetch: async (url, init) => {
    fetches.push({ url, init });
    return sseResponse();
  },
  require(id) {
    if (id === "./provider_protocols/index.cjs") return protocols;
    if (id === "node:fs" || id === "fs") {
      return {
        readFileSync(filePath) {
          if (filePath !== CONFIG_PATH) {
            const error = new Error("ENOENT");
            error.code = "ENOENT";
            throw error;
          }
          return JSON.stringify(input.hostConfig);
        }
      };
    }
    throw new Error("unexpected require " + id);
  }
};

vm.createContext(context);
vm.runInContext(SOURCE, context, { filename: "provider-direct-session.cjs" });

const parsed = context.parseProviderDirectConfig(JSON.stringify(input.hostConfig));
const adapter = protocols.getAdapter(parsed.protocol);
if (adapter == null || typeof adapter.buildRequest !== "function") {
  throw new Error("adapter missing for " + parsed.protocol);
}
const request = {
  model: parsed.model,
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  stream: true
};
if (parsed.parameters != null) request.parameters = parsed.parameters;
if (input.executorMaxTokens != null) request.maxTokens = input.executorMaxTokens;
const built = adapter.buildRequest(request, { endpointPath: parsed.endpointPath });

const result = {
  parsed: parsed,
  adapterBody: built.body,
  adapterPath: built.path
};

if (input.stream === true) {
  const session = context.createProviderDirectPromptSession({ config: parsed });
  const executor = session.getExecutor([{ role: "user", content: "hi" }]);
  const options = input.executorMaxTokens == null ? {} : { maxTokens: input.executorMaxTokens };
  const streamed = executor.stream({}, "inv-boundary", [], options);
  (async () => {
    for await (const _event of streamed.fullStream) {
      void _event;
    }
    await streamed.usage;
    result.fetchBody = JSON.parse(fetches[0].init.body);
    result.fetchUrl = fetches[0].url;
    process.stdout.write(JSON.stringify(result));
  })().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exit(1);
  });
} else {
  process.stdout.write(JSON.stringify(result));
}
