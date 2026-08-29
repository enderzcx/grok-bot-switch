# Direct executor source

`beefapi-direct-session.cjs` is source text intended for deterministic injection into the pinned Grok Bot 0.30 host bundle. It is tested as a standalone module through an explicit dependency-injection harness; it must not read real credentials or contact a live provider during unit tests.

