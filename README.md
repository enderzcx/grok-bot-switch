# grok_home

Isolated lab for proving that Grok Bot inference can be routed to an external provider without exposing provider OAuth credentials to Grok Bot.

## Current scope

This phase is credential-free and does **not** patch or relaunch the installed Grok Bot app. It verifies:

- loopback-only hop routing;
- bearer injection at the hop instead of in model bindings;
- non-stream and SSE streaming requests;
- explicit coverage for `main`, `summary`, `compaction`, `label`, and `review` lanes;
- fail-closed behavior when the upstream is unavailable;
- redacted request receipts; and
- no changes to the installed Grok Bot `app.asar`.

The vendored `opengrok` checkout is pinned in `vendor/opengrok`. Generated files and logs stay in `runtime/`; synthetic user state stays in `sandbox-home/`.

## Run

```bash
HOME="$PWD/sandbox-home" python3 lab/smoke_external_only.py
```

The machine-readable result is written to `runtime/smoke-report.json`.

## Boundary before a real provider

A later live smoke requires a separately approved, scoped BeefAPI test token. Raw supplier OAuth access/refresh tokens must remain in BeefAPI or another trusted OAuth owner, never in this directory, Grok Bot bindings, or the Grok Bot cloud computer.

