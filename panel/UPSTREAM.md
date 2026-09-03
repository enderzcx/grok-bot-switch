# CC Switch frontend transplant

- Source: https://github.com/farion1231/cc-switch
- Pin: `d8065cc628fcd373d00c4363d718095f19e78c9e` (package version 3.20.1)
- License: MIT, Copyright (c) 2025 Jason Young. Full notice: `licenses/CC-Switch-MIT.txt`.
- `upstream.json` identifies 15 exact, hash-checked source copies: UI primitives, IME input, API-key input, request-header editor, status badge, confirmation dialog, list row and utilities.
- `tailwind.config.cjs` is copied from the same revision. Theme tokens in `src/styles.css` retain upstream's light/dark palette and system typography.
- `ProviderCard.tsx`, `ProviderActions.tsx`, `FullScreenPanel.tsx`, and `App.tsx` are adapted from the matching upstream components. The title/icon/badge/action row, blue buttons, card geometry and full-screen form layout remain. Multi-client, usage-query, failover, drag-region and native filesystem integration are removed.
- `ProviderForm.tsx` maps our profile schema to the transplanted controls. It does not import Grok Build or Codex configuration parsers. Grok Bot and Grok Build are not interchangeable backends.
- `src/lib/api.ts` is a same-origin adapter to the grok-switch panel API (`/api/*`, per-run token from the URL). No Tauri invoke bridge.
- Motion uses explicit properties and respects reduced-motion. The web full-screen panel uses Radix focus/scroll management instead of Tauri window logic. Radix-injected styles receive a CSP nonce; neither unsafe-inline nor unsafe-eval is enabled.
- Unimplemented usage, terminal, failover, and OAuth-login actions are omitted, not rendered as working controls.

## Build

`npm install && npm run build` in this folder rebuilds the checked-in `panel/dist/index.html` (a single self-contained file via vite-plugin-singlefile); `node build.mjs` at the repo root embeds it into `dist/grok-switch.cjs`.

Dependency notices in `licenses/dependencies.txt` were generated from the pinned lockfile of the original transplant; regenerate them when dependencies change. The panel has no dev server in production: `ui` serves the built file only.

