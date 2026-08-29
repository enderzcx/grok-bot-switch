# Grok Bot 0.30 BeefAPI Direct Executor Contract

## Outcome

When `/workspace/grok-home/config/direct-external-only.json` exists and is enabled, every Grok Bot inference session is executed by the cloud host against a loopback BeefAPI hop. No inference request is sent to Cursor's `InferenceService`, and no labeling call is allowed to consume a native model after the turn.

The direct executor must cover normal turns, summarization, compaction, memory synthesis, labeling/review-related session creation, computer-use subagents, browser-use subagents, and ordinary subagents through the same `createSession` ownership seam.

## Current 0.30 source truth

- Read-only bundle: `/Users/sunny/Work/CODEX/grok_home/research/current-0.30/host-main.cjs`
- Verified stock SHA-256: `3c3f986e614aaf8fbec642269da40dd20f1dbd9912bdf8f2390bafd61ec684ef`
- `createHostInference` is the ownership seam. It currently returns `createCursorSandInference(...)` directly.
- `createCursorInferencePromptSession` constructs the Cursor-backend `InferenceService` client and must not be called in active direct mode.
- `recordPostTurnLabeling` from the Cursor inference object must become a no-op in active direct mode.
- `BasePromptBuilder`, `BasePromptExecutor`, and the existing stream-part vocabulary are already present in the bundle.

## Direct configuration

The only accepted active configuration is:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "mode": "external-only",
  "nativeFallback": false,
  "provider": "beefapi",
  "group": "grok",
  "modelId": "grok-4.6",
  "baseUrl": "http://127.0.0.1:18779/v1"
}
```

Rules:

- `baseUrl` must be loopback and exactly the value above.
- No API key, OAuth token, Authorization value, cookie, or credential path appears in host config or bindings.
- The loopback hop owns the credential and overwrites outbound Authorization.
- Config missing or `enabled: false` preserves stock behavior.
- Config present and enabled but malformed throws before inference; it never falls back.
- Only `grok-4.6` is allowed in the first vertical slice.

## Prompt-session contract

Provide a focused source module that can be injected into the stock bundle and exposes:

```text
loadBeefApiDirectConfig()
createBeefApiDirectPromptSession(options)
wrapHostInferenceWithBeefApiDirect(cursorInference, options)
```

The returned session must implement the same surface consumed by the host:

- `getModelId()` returns `grok-4.6`.
- `getExecutor(state?)` returns a `BasePromptExecutor`-compatible executor.
- Existing builder state survives tool-result continuation and later turns.
- `stream(ctx, invocationId, tools, options)` returns `fullStream`, `usage`, `extendedUsage`, `providerMetadata`, `invocationId`, and `response` promises.

Supported stream parts:

- `text-delta`
- `reasoning` when the upstream supplies reasoning content
- `tool-call-streaming-start`
- `tool-call-delta`
- `tool-call`
- exactly one terminal `finish`
- `error` followed by a thrown error for malformed/truncated/non-2xx streams

Usage must resolve from the upstream usage object. Provider metadata must contain the BeefAPI request ID when present. A successful HTTP status without a complete SSE terminator is an error.

## OpenAI-compatible wire contract

- Endpoint: `POST {baseUrl}/chat/completions`.
- Streaming is always enabled.
- Preserve system/user/assistant/tool messages without flattening tool results into user text.
- Convert host tools to OpenAI function tools; provider-defined tools that cannot be represented must be rejected, not silently dropped.
- Preserve tool call IDs, names, and JSON argument deltas.
- Tool results in the next executor call must retain the original `tool_call_id`.
- `max_tokens` may be set from executor options only when explicitly provided.
- Never log prompts, tool arguments/results, response bodies, or Authorization.

## Fail-closed conditions

- Missing or malformed active config.
- Non-loopback base URL.
- HTTP non-2xx.
- Invalid JSON/SSE.
- Truncated stream or missing terminal marker.
- Tool call missing ID/name or invalid final arguments.
- Unknown provider-defined tool shape.
- Upstream connection failure or timeout.

No direct-mode error may call `createCursorInferencePromptSession`, reuse the stock requested model, or synthesize a successful assistant reply.

## Verification gates

Credential-free tests must cover:

1. normal streamed text and usage;
2. reasoning plus text;
3. fragmented parallel tool-call deltas and exact final IDs/names/arguments;
4. tool-result continuation on a second request;
5. main, summary, compaction, label, review, computer, browser, and subagent session options all selecting direct mode;
6. malformed active config;
7. non-2xx, invalid JSON, truncated SSE, and connection failure;
8. explicit proof that direct-mode tests never invoke the injected stock Cursor session factory or post-turn labeling callback;
9. patcher anchor count, idempotence, stock SHA fence, injected syntax check, and rollback artifact generation.

The first real smoke is not authorized until all credential-free gates pass and Codex has reviewed every worker diff. Production activation, token creation/provisioning, host restart, and normal Bot send remain brain-owned.

