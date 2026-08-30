# Windows native-client rollout — 2026-08-30

## Scope and current truth

Ender authorized a backed-up, reversible adaptation and restart of the installed
Windows Grok Bot client. The product must discover that local client; users must
not configure SSH or Tailscale. Existing login data and Bots are preserved.
The Mac installation and original `grok_home` lab remain untouched.

**Native control connectivity is verified. Provider activation is not yet
implemented or verified through this connection.** No new Bot message or metered
provider request was sent during these checks. No real OAuth credential was
read from storage, exported, or copied.

## Windows evidence

- Installed executable: `F:\grok-bot\Grok Bot\Grok Bot.exe`, version `0.28.0`.
- Original ASAR SHA256:
  `3476b583b2757ec94b155197a20d0ebe0123929ec280483726cc3d8d6caa5591`.
- Verified backup: acceptance `runtime/windows-028-audit/<original-sha>.asar`;
  a second original copy is alongside the installed archive as
  `app.asar.original-v028`.
- Current probe v6 ASAR SHA256:
  `3356697e6026e8beaa38a8edaab3a43647df0de435b866ceed9ed9e9530ed4ca`.
- Probe is opt-in via `--grok-bot-switch-home=<private-home>`. The acceptance
  home is `F:\grok-bot-switch-acceptance\runtime\client-probe`.
- Pairing discovery is owner-only and carries a newly generated local token,
  never the original account credential. Windows explicit owner assignment is
  required: inherited private DACL alone may leave Administrators as owner.
- `grokctl.client_bridge.status` was exercised on Windows: connected=true,
  clientVersion=0.28.0, hostVersion=17184bb, hostReachable=true, hostBusy=false,
  executor available/reachable=true, providerSwitchReady=false.

The initial v2/v4 captures were blank. Original restoration was verified by
hash and a normal Bot-history screenshot. Independent `@electron/asar`
extraction confirmed that all 348 packed members are unchanged except main,
and all 348 full hashes plus 350 block hashes match. Original and patched
headers have identical size. Installed original/patched ACLs were equal.
V5 main diagnostics showed load finished, no renderer crash or recorded load
failure; two subsequent real screenshots showed Bot history normally and had
identical SHA256 `0403e927b4f57a5184f9849485c294a9d7f685c76de439e73728ca58d54c83b3`.
Do not claim a proven root cause for the earlier blank captures.

## Current account's cloud-host evidence

These observations came through the Windows client's native authenticated
`ensureSandBox` connection, not through the legacy lab host's SSH route.
Account epoch, account scope, selected team, sign-out and cancellation fences
apply around each operation. Credentials remain in the native process.

- Binary Connect `agent.v1.ControlService/Ping`: HTTP 200,
  `application/proto`, exact empty Ping response.
- Fixed read-only `ControlService/Exec`: marker `GROK_SWITCH_EXEC_OK`, exit 0.
- Node v22.14.0; native host version `17184bb`; observed host PID 1159.
- No pending supervisor command at inspection.
- `/home/box/sand-host/host-main.cjs`: 25,658,406 bytes; SHA256
  `0035c31a74ac9d7fc9d93532cf37e217d6074143d46b1eeb3c5e79699df2f88f`.
- `/usr/local/bin/sand-supervisor.mjs`: 115,773 bytes; SHA256
  `db270383ac06d217c78e6079508b39939b8a9f77dfe3213308e21b5c38a6c330`.
- Fixed `ReadTextFile` retrieved the public host bundle; requesting identity
  HTTP encoding avoids rejecting a compressed response before decoding.

The supervisor supports `kind: restart` and never forces restart while busy or
unknown. It records acknowledgements separately from status. Consumed command
alone is insufficient: verify matching acknowledgement/status, changed PID and
startedAt, current bundle hash, and fresh healthy host response. Its status file
does not itself contain PID/startedAt; those are gateway-discovery fields.

## Host compatibility and remaining delivery gates

The current host has the same precise inference factory anchor as the older
supported bundle, but adds `recordFollowupLabeling` and native audio transcription.
Both must be blocked in external mode. Audio is explicitly unsupported rather
than falling back. The host-lifetime activation remains latched if the config
is subsequently removed or disabled. Known stock hashes and exact anchors are
validated; unknown versions are not silently patched.

Remaining work:

1. Real host activation/controller with pending-restart and verified rollback,
   not the existing synthetic process gateway.
2. Package/bootstrap and desktop service integration, including first local
   attachment, generic URL/key provisioning and official-channel restoration.
3. End-to-end normal Bot turn, provider receipt and official usage readback;
   no claim of zero native usage based solely on HTTP or unit tests.
4. Final Windows desktop artifact, installation/recovery test and structural
   review. Current detection ZIP and manual probe are not that final artifact.

Switching affects every Bot sharing the current cloud host. Never restart an
active agent, reuse a different account's host, overwrite an unknown bundle,
force a supervisor command, or treat a successful probe as provider activation.
