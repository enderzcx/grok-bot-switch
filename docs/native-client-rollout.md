# Windows native-client rollout — 2026-08-30

## Scope and current truth

Ender authorized a backed-up, reversible adaptation and restart of the installed
Windows Grok Bot client. The product must discover that local client; users must
not configure SSH or Tailscale. Existing login data and Bots are preserved.
The Mac installation and original `grok_home` lab remain untouched.

**Windows native connection, external Chat API messaging, matching provider
receipts, and restoration to official are now verified.** Ender subsequently
explicitly approved sending real requests. A dedicated new Bot was created;
its onboarding used two external calls, and the single sent test prompt used
three. No real native OAuth credential was read from storage, exported, or copied.

## Windows evidence

- Installed executable: `F:\grok-bot\Grok Bot\Grok Bot.exe`, version `0.28.0`.
- Original ASAR SHA256:
  `3476b583b2757ec94b155197a20d0ebe0123929ec280483726cc3d8d6caa5591`.
- Verified backup: acceptance `runtime/windows-028-audit/<original-sha>.asar`;
  a second original copy is alongside the installed archive as
  `app.asar.original-v028`.
- Probe v6 ASAR SHA256 (subsequently restored during recovery validation):
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

Remaining release limits: this is unsigned/internal, supports only pinned
Windows 0.28.0 archives and known host bundles, has no provider OAuth adapter,
and has not completed equivalent live Responses/Messages or Mac acceptance.
Uncertain post-publication failures stay fail-closed and require inspection;
do not promise automatic recovery from every possible host crash.

Switching affects every Bot sharing the current cloud host. Never restart an
active agent, reuse a different account's host, overwrite an unknown bundle,
force a supervisor command, or treat a successful probe as provider activation.

## Independent review and recovery drill

Grok reviewed `44ccf64..fc87131` and returned REPAIR, not PASS. The missing
package-import closure was reproduced by extracting only the shipped members
and importing the runner/worker using isolated Python. The packaged initializer
now deliberately omits desktop service imports; full source API is unchanged.
Native readiness now respects all blockers, and a failed runtime status read
cannot keep a previous ready claim. Successful managed operations enable fresh
runtime inspection rather than relying only on a setup latch.

The Windows installer recovery helper restored probe v6 to the exact original
ASAR SHA256 above, using `ReplaceFileW` and preserving the replaced adapter at
`app.asar.previous-bd0a01b85b6941ccb5bfab29f7152ec7`. Original backup remains in
the private acceptance home's `backups/<stock-sha>.asar`. The restored app was
launched normally, PID 41680; a fresh screenshot confirmed the existing Bot and
chat history. No account credentials or Bot content were changed by restoration.

Pre-publication recovery and local receiver verification were repaired and
tested. Windows validation holds a real process handle, verifies executable and
TCP listener ownership, authenticates the private bridge instance, and sends
secrets only over the same non-reconnecting connection. Its actual Windows
loopback-child test passes. No Grok or sub-agent was used after Ender requested
solo completion; later live debugging and acceptance were performed by Codex.

## Final live control and request evidence

The initial health probe failed closed because the real native process owned
`0.0.0.0:1340`, not a loopback-only listener. Fixed read-only diagnostics proved
its socket inode belonged to PID 1159 and its argv contained the pinned host
entry. Native health now accepts that already-existing owned wildcard listener
while still requesting only `127.0.0.1`; the provider hop remains loopback-only.

| Stage | Request | PID / startedAt | Bundle | Result |
|---|---|---|---|---|
| Initial | none | 1159 / 1788080577032 | stock `0035c31a…` | healthy, idle |
| Official control drill | `gbs-314287a1-4274-412d-b87f-6431a905f9b4` | 39547 / 1788089725588 | stock | verified generation 1 |
| External activation | `gbs-f4d91cb8-455a-40fc-811a-73fc26b1904f` | 44998 / 1788090645129 | `c9a28aa3e30812d5c8dd327a3d4509b85260173e2d19b396e72edb14c94443e7` | verified generation 2 |
| Restore official | `gbs-72b4c9e0-282c-42e4-a028-579f0df91b94` | 50467 / 1788091218600 | stock | verified generation 3 |

Each verification requires matching native acknowledgement/status, changed
PID/startedAt, current file hashes, and fresh health. The external stage also
requires the owned hop's process/socket/config receipt. The final state was
official, healthy, idle, no pending command, no cleanup warning. Existing login
and the original Bot remained; the dedicated test Bot and its messages remain
as evidence. No second test prompt was sent; its partial draft was cleared and
the empty composer was read back.

At 19:55:32 local time, the single prompt asked for
`GROK_BOT_SWITCH_EXTERNAL_OK`; its exact reply is visible in the real Grok Bot
chat at 19:55:37. Background UI snapshots initially lagged; later fresh UIA and
screenshots showed both the sent prompt and reply. Do not misclassify that
display lag as a model/transport failure.

Provider was configured as an ordinary bearer-key Chat profile with
`https://beefapi.com/v1`, model `grok-4.6`. It is not a core dependency. The
existing token 2383 was selected read-only and transferred privately to the
Windows secret store. Its live configuration was unlimited (unlike an older
lab assumption); no token settings or quota limits were changed.

All five receipts match production group `grok`, model `grok-4.6`, channel 254,
token 2383, streaming=true. Hop receipts were HTTP 200:

| Production request ID | Quota | Input / output tokens | Scope |
|---|---:|---|---|
| `202608301153469213597038268d9d6nEde6CxX` | 28742 | 33668 / 785 | new-Bot onboarding |
| `202608301154091745419308268d9d6HuWyBUbg` | 7954 | 33847 / 448 | onboarding continuation |
| `202608301155328771048348268d9d6GYp9iv3h` | 7722 | 34414 / 194 | test-prompt flow |
| `202608301155379933850908268d9d6OxTAiXBw` | 7149 | 34505 / 53 | test-prompt flow |
| `202608301155403343097338268d9d6eY7n7PNK` | 973 | 808 / 168 | test-prompt flow |

Token used_quota readbacks: 4536332 before onboarding, 4573028 immediately
before the explicit prompt, 4588872 after it. Total delta 52540 equals the five
production rows; the explicit-prompt delta is 15844. These are provider quota
units, not a claimed currency amount. Native usage UI readback was 100% before
and 100% after (before also said resets in seven days). This coarse/capped
surface cannot prove exact zero native consumption; no such claim is made.

Local gates: 372 Python tests passed, with three Windows-only tests skipped on
Mac; actual Windows receiver tests (6), installation tests (10), platform
permissions/locking tests (7), and desktop tests (4) passed. Node 163 and React
35 tests passed. Actual frozen self-check, native window, client installation,
original restoration, native control, and provider receipts are separate
evidence, not substitutes for one another.

## Delivered Windows artifact

- Build code commit: `0a8f73b` (subsequent documentation changes do not change it).
- Local ZIP: `runtime/GrokBotSwitch-windows-x64-20260830.zip`.
- Windows ZIP: `F:\grok-bot-switch-acceptance\runtime\desktop-delivery\GrokBotSwitch-windows-x64.zip`.
- SHA256 on both machines:
  `25427c96a293116a24a43ce2d62a1b386263b9abea7a072d254ae8c308824fb8`.
- Installed Grok client adapter SHA256:
  `75b82c60d5cca8205a7b5613a4ede52abd6a7d521c5f4d127888d426375a89aa`.
- Embedded host package SHA256:
  `70da56f8c6d20198c615cb5690357fa7979e2b8771afcd52dbab307ba365d264`.
- Frozen self-check: exit 0; backend, frontend assets, native adapter, provider
  validator all true. It deliberately does not claim window/host verification.
- Archive inspection: only generic `ops/provider_hop.py` is loose host data;
  the native package is embedded in `bridge/client-bridge.cjs`. Provider-specific
  lab administration, credentials, and acceptance state are not bundled.
- Windows desktop shortcut: `C:\Users\Administrator\Desktop\Grok Bot Switch.lnk`.
  Its verified target is the delivery EXE and it supplies the isolated acceptance
  home, so the current user can open the already-attached client without command
  arguments. Fresh installations use the ordinary default app-data directory.
- The test API profile/key and dedicated Bot are retained for explicit reuse;
  current active channel is official. No account credentials or existing Bots
  were removed.
