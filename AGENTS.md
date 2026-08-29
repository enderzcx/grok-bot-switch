# grok_home Lab Contract

This directory is an isolated Grok Bot external-inference lab.

- Do not modify `/Applications/Grok Bot.app` from this directory.
- Do not read, copy, import, refresh, or persist real OAuth credentials.
- Do not call a metered provider unless Ender explicitly approves the live smoke.
- Keep all generated state under `runtime/` and the synthetic home under `sandbox-home/`.
- External-only means every inference lane is explicit and native fallback is disabled.
- A fake-upstream pass proves only the local routing components, not that a normal Grok Bot turn is routed.

