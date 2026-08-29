---
half_life: 7d
archive_at: 2026-09-30
artifact_mode: ai-implementable-prd
scope_type: version
scope_name: grokctl Provider Switcher v0.1
coverage: complete product, runtime, CLI, local control-panel, protocol-adapter, security, migration, verification, and rollout contract for the first usable generic provider switcher
not_complete_for: native Gemini generateContent, local-machine-to-cloud tunneling, automatic cost routing, automatic native fallback, per-Bot routing, public distribution, or unattended production rollout
verification_level: local
real_smoke_status: requires_approval
review_status: not_reviewed
reviewer: none
review_command: pending implementation diff
review_notes: Grok builders implement isolated slices; Codex owns integration and an independent structural review before promotion.
review_owner: Ender
review_due: 2026-09-06
execution_backend: collaborator-assisted
lead_agent: current
peer_agents: none
builder_agent: agent:ender-grok-orchestrator
verifier_agent: agent:ender-codex-orchestrator
verification_independence: independent
cwf_decision: not_needed
cwf_trigger_boundary: owner-waived
goal_handoff: skipped
acceptance_contract_status: proposed
memory_required: false
memory_space: default
acceptance_memory_id: none
memory_asserted_by: human:ender
memory_confirmed_by: none
memory_intended_for: grok_home maintainers, Grok builders, release reviewers
memory_validity: proposed
memory_valid_from: 2026-08-30
memory_review_due: event:owner-acceptance
---

# grokctl Provider Switcher v0.1 AI-Implementable PRD

## 1. Alignment Snapshot

- Building: a local-first CC Switch-style control plane that lets an operator run Grok Bot through the official native route or a custom provider profile with an explicit protocol, arbitrary valid base URL, model, authentication method, headers, and fail-closed behavior.
- Not building: a BeefAPI-specific product, a universal protocol guesser, a provider marketplace, silent fallback, automatic cheapest-provider routing, arbitrary shell hooks, or a replacement chat client.
- Source of truth: this document for v0.1 behavior; the current Grok Bot 0.30 bundle and its pinned stock hash for host integration; `src/` and deterministic tests for implemented protocol truth; runtime readback for any later production claim.
- Audience: Ender as operator, Grok builders, Codex integrator/verifier, and future maintainers adding verified provider presets.
- Completeness: complete for v0.1 local implementation and credential-free validation; not evidence of production activation or third-party compatibility until a provider-specific real smoke passes.
- Verification level: deterministic local tests with fake upstreams, synthetic homes, patcher fixtures, loopback UI tests, and dry-run switch plans.
- Review requirement: every worker diff is reviewed by Codex; the fixed integrated diff receives a structural review because it adds adapters, state transitions, credential handling, and rollback orchestration.
- Execution backend: collaborator-assisted. Grok writes bounded isolated slices; Codex owns all product decisions, integration, credentials, production access, and final verification.
- CWF decision: not needed; isolated worktrees and deterministic gates provide sufficient custody.
- Goal handoff: skipped because the user requested direct implementation in this thread.
- Forbidden writes: no installed app mutation, production restart, real credential import, OAuth-token read, public release, or metered provider call without a separate explicit gate.
- Open decisions: none for v0.1. Conservative defaults below are binding until owner acceptance changes them.

## 2. Conservative Defaults

| Decision | Default | Why safe | Signal to revisit |
|---|---|---|---|
| Product surface | `grokctl` CLI plus loopback-only local web panel | Cross-platform, dependency-light, scriptable, and packageable into a menu-bar shell later | Repeated daily use proves a native menu-bar wrapper is worth packaging cost |
| Provider identity | User-defined immutable profile id plus editable display name | Avoids routing by labels or URLs | Need for centrally managed team catalogs |
| Protocol selection | Explicit enum; URL inference only suggests and never overrides | Prevents Chat/Responses/Messages ambiguity | A signed provider catalog supplies authoritative protocol metadata |
| Authentication | `none`, bearer API key, `x-api-key`, or provider-owned OAuth adapter | Covers common APIs without pretending OAuth is generic | A new provider has a materially different refresh or identity contract |
| Fallback | `never` | Protects quota provenance and prevents hidden native usage | Owner explicitly approves a separately labeled fallback mode |
| Live validation | Off by default; `verify --live` is explicit and cost-labeled | Avoids unapproved metered calls | A provider offers a documented non-metered capability endpoint |
| Secrets | Separate owner-only files; configs contain secret references only | Limits disclosure and keeps profiles shareable | OS keychain integration becomes a packaging requirement |
| Remote URL | HTTPS required; HTTP allowed only for loopback | Blocks accidental cleartext credentials | An operator explicitly enables a trusted private-network route |
| Routing granularity | One active provider per Grok Bot host lifetime | Matches the verified ownership seam and prevents mid-turn split state | Host exposes a stable per-session provider contract |

## 3. Product Overview

- Positioning: a local Grok Bot provider switcher, comparable to CC Switch in profile ergonomics but explicit about transport protocols and quota provenance.
- Target users: power users running official Grok Bot who want to use official quota, API-key providers, compatible gateways, or provider OAuth accounts without editing bundles and secrets manually.
- Core user action: create or import a provider profile, test its non-secret configuration, activate it transactionally, see the actual resolved endpoint and quota owner, and roll back safely.
- Goals:
  - Make arbitrary compatible URL and key profiles first-class.
  - Keep official Grok as a first-class built-in route.
  - Support OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages through separate adapters.
  - Preserve streaming text, reasoning where representable, tools, tool-result continuation, usage, and upstream request identifiers.
  - Fail closed and make every active route auditable.
  - Keep the current BeefAPI deployment migratable as an ordinary custom `openai-chat` profile.
- Non-goals:
  - Claiming every model behind a compatible endpoint behaves correctly without a wire probe.
  - Generic OAuth configuration from only authorization/token URLs.
  - Automatic failover, load balancing, key pooling, or spend optimization.
  - Storing prompts, tool arguments, response bodies, or raw credentials in activity logs.
- Success criteria:
  - A user can create, inspect, update, remove, test, and activate profiles without editing JSON manually.
  - The UI and CLI always display the exact resolved method and endpoint before activation.
  - All three protocol adapters pass equivalent text, reasoning, tool-loop, usage, malformed-stream, and connection-failure fixtures.
  - Official activation restores the stock bundle and removes the external runtime atomically.
  - External activation never invokes the stock inference client or post-turn native labeling.

## 4. UI Or Workflow Structure

```text
+----------------------------------------------------------------+
| grokctl Provider Switcher                                      |
| Active: Custom OpenAI / gpt-5.4              Healthy           |
| Mode: External only · Native fallback disabled                 |
| POST https://api.example.com/v1/chat/completions               |
|                                                                |
| [Official Grok] [Custom OpenAI] [Claude Gateway] [+ Provider]  |
|                                                                |
| Requests: local activity only · Secrets: isolated              |
| [Test configuration] [Activate] [Rollback] [Activity]          |
+----------------------------------------------------------------+
```

Primary workflow:

```text
Add provider
    -> choose explicit protocol
    -> enter base URL, model, auth type, key/OAuth profile, headers
    -> preview resolved endpoint and redacted request shape
    -> credential-free validation
    -> optional explicit live test
    -> activate transactionally
    -> read host health and route receipt
```

## 5. Core Modules

### 5.1 Profile Registry

**Purpose**

Own non-secret provider definitions, schema validation, normalization, presets, model settings, and the active-profile pointer.

**Flow**

```text
profile input
    +-- valid explicit protocol/url/model/auth -> normalized immutable id
    +-- ambiguous/malformed                    -> field-level rejection
    +-- contains secret material               -> reject and direct to secret command
```

**State List**

| State | Trigger | User-visible marker | Exit condition |
|---|---|---|---|
| draft | Unsaved form or CLI input | Not active | Validation succeeds and user saves |
| ready | Valid profile and required secret reference exists | Ready | Activate, edit, or delete |
| active | Host readback matches generation and profile digest | Active | Another transaction commits |
| invalid | Schema or secret requirement fails | Configuration error | User corrects the field |
| drifted | Local desired state differs from host readback | Drift detected | Reconcile or rollback |

**Dependencies**

- Reads: `$GROKCTL_HOME/profiles.json`, current activation receipt.
- Writes: atomic owner-only JSON files under `$GROKCTL_HOME`.
- External/runtime dependencies: none for CRUD and validation.

### 5.2 Secret Store And Authentication

**Purpose**

Keep credentials out of profiles, argv, logs, bundle source, browser storage, and activity records.

**Auth contracts**

- `none`: no outbound authentication header.
- `bearer`: inject `Authorization: Bearer [secret]` at the hop.
- `x-api-key`: inject `x-api-key: [secret]` and a configured `anthropic-version` for Messages.
- `oauth-adapter`: only built-in provider adapters may own login, refresh, account identity, and logout; v0.1 defines the interface but ships no new generic OAuth implementation.

**State List**

| State | Trigger | User-visible marker | Exit condition |
|---|---|---|---|
| absent | Required secret not installed | Needs key | `secret set` succeeds |
| present | Owner-only regular file passes shape check | Connected | Rotation, removal, or validation failure |
| rejected | Permissions, symlink, whitespace, or header injection is unsafe | Secret rejected | Reinstall safely |

### 5.3 Protocol Adapter Registry

**Purpose**

Translate Grok Bot's prompt-session contract into one explicit upstream wire protocol and normalize the response back into host stream parts.

| Adapter | Request | Stream | Tool representation | Default auth |
|---|---|---|---|---|
| `openai-chat` | `POST {baseUrl}/chat/completions` | `data:` JSON chunks plus `[DONE]` | `tools[].function`, assistant `tool_calls`, role `tool` results | bearer |
| `openai-responses` | `POST {baseUrl}/responses` | named Responses SSE events ending in `response.completed` | function definitions, `function_call`, `function_call_output` | bearer |
| `anthropic-messages` | `POST {baseUrl}/messages` | Messages event stream ending in `message_stop` | `tool_use` and `tool_result` content blocks | `x-api-key` |

All adapters must:

- preserve system/user/assistant/tool semantics without flattening tool results;
- preserve tool-call identity through continuations;
- reject unrepresentable provider-defined tools;
- require a complete terminal event and usage when the protocol supplies it;
- expose protocol-neutral text, reasoning, tool-call, finish, usage, response id, request id, and error events;
- never call another adapter or official inference after an error.

### 5.4 Runtime Hop

**Purpose**

Own outbound credentials, resolved endpoint paths, header allowlists, upstream transport, timeouts, redacted receipts, and health endpoints.

**Safety invariants**

- Listen only on loopback.
- Overwrite credential-bearing headers; never accept them from Grok Bot.
- Reject URL userinfo, fragments, non-HTTP(S) schemes, unsafe header names, CR/LF values, and remote HTTP.
- Preserve method, upstream status, duration, profile id, protocol, model, request kind, response/request id, and byte counts only.
- Never log request or response bodies.

### 5.5 Switch Transaction

**Purpose**

Plan, apply, verify, and roll back official/external transitions without partial active state.

```text
preflight
  -> verify no supervisor command is pending
  -> verify stock and patched bundle hashes
  -> validate profile and secret
  -> stage generation-scoped config/runtime
  -> start and health-check hop
  -> atomically install selected bundle/config
  -> request one supervisor restart
  -> wait for command consumption and new PID
  -> read active profile digest + runtime health
  -> commit receipt

failure before restart -> remove staging and keep current route
failure after restart  -> restore previous transaction snapshot and restart once
```

The pre-restart failure path never changes active state. The post-restart failure path owns exactly one rollback attempt and then stops with preserved evidence.

Official mode restores the pinned stock bundle, disables external config, removes provisioned runtime secrets for the deactivated profile, stops the hop, and restarts through the same supervisor command protocol.

### 5.6 CLI

```text
grokctl status [--json]
grokctl providers list [--json]
grokctl providers add --file PROFILE.json
grokctl providers show PROFILE
grokctl providers remove PROFILE
grokctl secret set PROFILE [--stdin]
grokctl secret remove PROFILE
grokctl test PROFILE [--live]
grokctl plan PROFILE|official [--json]
grokctl use PROFILE|official [--apply]
grokctl verify [--live]
grokctl rollback [--apply]
grokctl activity [--limit N] [--json]
grokctl ui [--port 0]
```

Mutating remote commands print a plan by default. `--apply` is required for host changes; `--live` is separately required for a metered inference request.

### 5.7 Local Control Panel

**Purpose**

Expose the same control engine through a loopback-only browser surface without introducing a second source of truth.

- Backend calls the same Python service methods as the CLI.
- Bind `127.0.0.1` only and choose an ephemeral port by default.
- Generate a per-process CSRF/session token and require it for every mutation.
- Do not expose secret values to HTML, JSON, logs, or browser storage.
- Show resolved method/endpoint, auth type, model, fallback policy, desired state, observed host state, and last receipt.
- `Test` is credential-free unless the user explicitly selects the cost-labeled live test.

## 6. Data Model And Contracts

### Provider profile

```json
{
  "schemaVersion": 1,
  "id": "custom-openai",
  "displayName": "Custom OpenAI",
  "protocol": "openai-chat",
  "baseUrl": "https://api.example.com/v1",
  "endpointPath": "/chat/completions",
  "model": "model-name",
  "auth": {
    "type": "bearer",
    "secretRef": "profile/custom-openai"
  },
  "headers": {},
  "parameters": {
    "reasoningEffort": "high",
    "maxTokens": 8192
  },
  "fallbackPolicy": "never",
  "enabled": true
}
```

Rules:

- `endpointPath` defaults from `protocol` but may be overridden with an absolute-path-only value.
- The final endpoint is shown before save and activation.
- `id` is lowercase ASCII with dashes and does not change when display name changes.
- Headers are case-insensitively checked against a denylist including authorization, cookie, host, content-length, connection, and forwarding headers.
- Profile JSON containing key/token/secret values is rejected.
- `official` is built-in and cannot be edited or deleted.

### Activation receipt

```json
{
  "schemaVersion": 1,
  "transactionId": "uuid",
  "requestedProfile": "custom-openai",
  "previousProfile": "official",
  "generation": 7,
  "profileDigest": "sha256",
  "bundleDigest": "sha256",
  "hostPid": 12345,
  "startedAt": "ISO-8601",
  "hopHealth": "healthy",
  "liveVerified": false,
  "committedAt": "ISO-8601"
}
```

### Redacted hop receipt

```json
{
  "at": "ISO-8601",
  "profileId": "custom-openai",
  "protocol": "openai-chat",
  "model": "model-name",
  "requestKind": "main",
  "method": "POST",
  "endpointOrigin": "https://api.example.com",
  "status": 200,
  "durationMs": 1200,
  "streaming": true,
  "upstreamRequestId": "request-id"
}
```

## 7. Architecture And Risk

- Runtime model: Python standard-library control plane and local UI; injectable CommonJS host adapters; Python loopback hop; atomic filesystem state; existing Tailscale SSH and supervisor restart contract for remote activation.
- Key dependencies: Python 3.9+, Node runtime already present in the Grok Bot host, `ssh`, pinned host bundle, and provider endpoint availability. No new third-party runtime dependency is required for v0.1.
- Fallback behavior: never. A selected provider error is a visible failed turn. Switching to official is an explicit transaction.
- Biggest architecture risk: conflating provider identity, authentication, and protocol dialect. The registry keeps these independent and resolves them into one immutable activation plan.
- Credential risk: secrets copied to argv, config, logs, browser storage, or a shared file. All secret APIs use stdin/private files and negative permission tests.
- SSRF risk: arbitrary URLs from a cloud-host process. Validation requires HTTPS except loopback, rejects userinfo and unsafe redirects, and records only redacted origins. Private-network support is deferred.
- Update risk: Grok Bot silently replaces its bundle. Every patch is fenced by stock/known-patched hashes; unknown bundles block activation until a new reviewed patch is produced.
- What must stay flexible: protocol adapters, provider presets, auth adapters, model parameter maps, endpoint paths, and future packaging of the local panel.

## 8. Interaction Details

- Loading: the panel first displays local desired state, then marks observed host state when readback arrives.
- Empty state: built-in Official card plus “Add provider”; no example key or fake active state.
- Error states: field-level validation, unreachable host, pending supervisor command, invalid secret permissions, unsupported bundle hash, hop failure, protocol mismatch, incomplete stream, and drift each have separate messages.
- Undo/recovery: every successful activation retains one previous transaction snapshot; Rollback previews its exact target before `--apply`.
- Keyboard/accessibility: semantic HTML controls, visible focus, Enter saves forms only after validation, Escape closes dialogs, status never relies on color alone.
- Secret editing: existing secret is shown only as “installed” plus fingerprint; it is never returned to the browser.
- Cost: every live test labels the selected provider/model and states that it may consume quota before execution.

## 9. Priorities And Phase Plan

| Tier | Scope | Acceptance signal |
|---|---|---|
| P0 | Profile schema/store, secret isolation, `official` and generic `openai-chat`, CLI plan/status/use/rollback, transaction dry-run | Synthetic-home tests prove CRUD, no secret disclosure, deterministic plans, and official/external round trips |
| P1 | `openai-responses`, `anthropic-messages`, shared normalized event model, complete tool continuations | Equivalent fake-upstream protocol suites pass for text, tools, usage, and malformed streams |
| P2 | Loopback local control panel and activity view | Browser/API tests prove profile CRUD, endpoint preview, CSRF enforcement, and no secret readback |
| P3 | Signed presets, native menu-bar wrapper, more OAuth adapters, per-Bot routing | Separate future contract and owner approval |

Implementation stages:

1. Freeze the generic contracts and migrate existing BeefAPI names behind compatibility aliases.
2. Build profile/secret/CLI core without remote writes.
3. Build protocol adapters and fake upstreams.
4. Build switch transaction, bundle compiler, activation plan, and rollback tests.
5. Build the loopback control panel on the same service layer.
6. Run integrated local and synthetic-host gates plus structural review.
7. Stop at the production gate. A later approved smoke may migrate the current BeefAPI route into a generic profile and perform `official -> custom -> official` live verification.

## 10. Performance Metrics

| Metric | Target | Measurement | Degradation threshold |
|---|---:|---|---:|
| Local profile CRUD | p95 < 100 ms | 100 synthetic-home operations | p95 >= 250 ms |
| Control-panel API response excluding SSH | p95 < 200 ms | loopback integration test | p95 >= 500 ms |
| Credential-free validation | < 2 s | CLI fixture test | >= 5 s |
| Switch preflight excluding restart | < 5 s | synthetic-host transaction test | >= 10 s |
| Hop overhead before upstream first byte | p95 < 25 ms locally | timed fake-upstream test | p95 >= 75 ms |
| Rollback after detected post-restart failure | < 30 s excluding supervisor scheduling | synthetic supervisor test | >= 60 s |
| Secret disclosure regressions | 0 | repository scan plus negative tests | any occurrence |

## 11. Acceptance Matrix

| Criterion | Evidence level | Test or manual evidence | Status | Notes |
|---|---|---|---|---|
| Arbitrary valid HTTPS base URL, model, auth type, and secret reference can be saved | local | Profile registry unit tests and CLI fixture | pending | Secret value must be rejected in profile JSON |
| Resolved method and endpoint are deterministic for all three protocols | fixture | Protocol registry table tests | pending | Explicit path override remains visible |
| Chat, Responses, and Messages preserve text, tools, continuation ids, usage, and terminal semantics | fixture | Three adapter stream suites | pending | Each suite includes fragmentation and parallel tools where supported |
| Provider failure never calls official/native inference | local | Injected stock-factory negative assertions | pending | Applies to every request kind |
| Official mode restores stock bundle and removes external active state | dry-run | Synthetic-host transaction round trip | pending | Production proof remains gated |
| Secrets never appear in profile, argv, logs, receipts, UI JSON, or git diff | local | Leak scan and negative tests | pending | Fingerprint only |
| Invalid permissions, symlink secrets, unsafe URLs, unsafe headers, and CR/LF are rejected | local | Security negative suite | pending | Remote HTTP rejected; loopback HTTP allowed |
| Local panel is loopback-only and mutation endpoints require session/CSRF token | local | HTTP integration tests | pending | No browser secret readback |
| Unknown Grok Bot bundle hash blocks activation before mutation | dry-run | Patcher/transaction fixture | pending | Produces actionable drift error |
| Existing BeefAPI production route can be represented as ordinary `openai-chat` profile | fixture | Migration fixture with redacted sample | pending | No BeefAPI name in core contracts |
| Real `official -> custom -> official` switch has matching PID/hash/route/quota receipts | prod | Separate approved live smoke | blocked | Requires explicit production and metered-call approval |

## 12. Developer Handoff

- Build first: protocol-neutral profile and normalized event contracts, then independently testable storage/adapters/transaction modules.
- Do not reinterpret: arbitrary URL and key are first-class; BeefAPI is not a core provider type; protocol is explicit; official is native; fallback is never; configs never contain secrets.
- Flexible choices: internal Python package layout, exact CSS styling, fixture helper names, and whether the static UI uses modules or one bundled script, provided no new runtime dependency or second state owner is introduced.
- Known unknowns: current Grok Bot versions after 0.30 may move the injection seam; provider-specific hosted tools may not survive a generic protocol adapter; actual third-party compatibility requires provider-specific probes.
- Stop/Pause conditions:
  - A worker needs a real credential, provider request, production host mutation, installed-app change, or public push.
  - A protocol cannot preserve Grok Bot tool-result identity without changing the approved host contract.
  - Two slices require competing owners for the same active-state file.
  - The pinned bundle no longer matches and patch anchors cannot be proven uniquely.
  - A proposed generic OAuth implementation would require persisting refresh tokens without a reviewed provider-specific contract.

## 13. Goal Handoff Decision

- goal_handoff: skipped
- produced_goal: none
- shape_reason: the user explicitly requested immediate brain/worker implementation in this task; a separate persistent goal would duplicate the active work contract.
- evidence_before_next_goal: integrated local gates, structural-review verdict, and the unresolved production action gate.

## 14. Execution Backend Decision

- execution_backend: collaborator-assisted
- cwf_decision: not_needed
- cwf_trigger_boundary: owner-waived
- backend_reason: three isolated implementation slices have clear file ownership and deterministic tests; the main agent retains integration and evidence custody.
- if_cwf: not applicable for v0.1.
- if_not_cwf: Grok workers implement in isolated worktrees; Codex reviews each full diff, reruns touched suites, integrates once, runs all gates, and stops before production mutation.

## 15. G3 And Release Boundary

```yaml
g3:
  class: both
  risk_and_blast_radius: provider credentials, arbitrary upstream URLs, remote host bundle replacement, supervisor restart, and quota attribution
  design_boundary: local code, synthetic homes, fake upstreams, fixture bundles, and dry-run activation plans are authorized
  action_boundary: no real credential install, production restart, live provider request, installed-app mutation, or public release in this implementation round
  data_and_permission_boundary: secret input via stdin/private file only; no OAuth token reads; no prompt or response persistence
  observability: redacted activation and hop receipts, exact bundle/profile digests, PID/start time, health, and provider request id
  rollback: generation-scoped snapshot and one explicit supervisor restart to the previous known-good route
  owner_gate: explicit approval naming production profile and whether a metered canary may run
  release_gate: integrated gates pass, structural review PASS, credential leak scan passes, rollback fixture passes, and production action is separately approved
  stop_conditions: pending supervisor command, busy agent, unknown bundle, invalid secret, unsafe URL/header, protocol mismatch, missing receipt, or failed rollback
```
