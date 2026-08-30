# CC Switch frontend transplant

- Source: https://github.com/farion1231/cc-switch
- Pin: `d8065cc628fcd373d00c4363d718095f19e78c9e` (package version 3.20.1)
- License: MIT, Copyright (c) 2025 Jason Young. Full notice: `licenses/CC-Switch-MIT.txt`.
- `upstream.json` identifies 15 exact, hash-checked source copies: UI primitives, IME input, API-key input, request-header editor, status badge, confirmation dialog, list row and utilities.
- `tailwind.config.cjs` is copied from the same revision. Theme tokens in `src/styles.css` retain upstream's light/dark palette and system typography.
- `ProviderCard.tsx`, `ProviderActions.tsx`, `FullScreenPanel.tsx`, and `App.tsx` are adapted from the matching upstream components. The title/icon/badge/action row, blue buttons, card geometry and full-screen form layout remain. Multi-client, usage-query, failover, drag-region and native filesystem integration are removed.
- `ProviderForm.tsx` maps our profile schema to the transplanted controls. It does not import Grok Build or Codex configuration parsers. Grok Bot and Grok Build are not interchangeable backends.
- `src/lib/api.ts` is a same-origin adapter to the existing grokctl service. No Tauri invoke bridge, other-client config writes, token import, or upstream server execution is included.
- Motion uses explicit properties and respects reduced-motion. The web full-screen panel uses Radix focus/scroll management instead of Tauri window logic. Radix-injected styles receive a CSP nonce; neither unsafe-inline nor unsafe-eval is enabled.
- Unimplemented usage, terminal, failover, and OAuth-login actions are omitted, not rendered as working controls.

## Build

`npm ci && npm test && npm run build` in this folder rebuilds the checked-in `grokctl/web` assets. Node is only required for development; `grokctl ui` still serves the built frontend from Python.

`node scripts/licenses.mjs` regenerates runtime dependency notices from the lockfile. Test tooling uses patched Vitest 3 rather than upstream's older Vitest 2 because the latter has a known test-server advisory. No test or development server is exposed by `grokctl ui`.

The previous vanilla-JS panel is replaced, not maintained as a second UI. Its source-substring tests have been replaced by rendered React interaction tests; service/API security tests remain.
