# Pianoid Supervisor — M12 Host/Supervisor app (Phases 1 + 2)

> **Status: Phases 1 + 2 (additive — still no production cut-over).** The runtime
> + I/O-control module from the M12 proposal
> (`docs/proposals/m12-host-supervisor-app-2026-06-14.md`).
> **Phase 1** stands up the supervisor skeleton + the M10 channel-adapter contract
> + the Telegram reference adapter (folding in the inbox-queue and voice STT/TTS,
> so **both** Telegram monkey-patches are obsoleted **without patching the
> plugin**) + a durable, replayable **capture store**.
> **Phase 2** adds **subprocess ownership**: a lifecycle manager that spawns +
> owns a headless Claude Code session via the Agent SDK `query()`, a **`canUseTool`
> permission router** that routes safety-floor decisions over the channel and
> blocks on the user's reply (the FC-1 invisible-prompt eliminator), **stream-json
> bidirectional I/O on the bus**, and **health-check + `--resume` restart** (FI).
> The Phase-1 log/echo host hook is replaced by the real hosted session under
> `--session`.

A standalone TypeScript/Node app. It is built **alongside** today's in-CLI
orchestrator and retires nothing — the live orchestrator keeps running unchanged.
The **production cut-over** (the supervisor replacing the live orchestrator + the
keystroke/monkey-patch glue) is **Phase 3**, not done here.

---

## What's built (Phase 1)

| Module | File | Role |
|---|---|---|
| **Supervisor** | `src/supervisor.ts` | Lifecycle + adapter registry + wires bus↔capture↔adapters. Routes inbound→bus (captured)→host hook; routes outbound back through the originating adapter. *Does not own the Claude subprocess yet.* |
| **I/O bus** | `src/io-bus.ts` | In-memory, captured fan-out broker. Monotonic `seq`, fail-soft fan-out. The spine of FC-3 ("every byte on a captured bus"). |
| **Channel-adapter contract (M10)** | `src/contract.ts` | The interface the supervisor codes to: `start(onInbound)`, `outbound(handle, msg)`, `stop()`, `health()`; normalized inbound `{text?, voicePath?, attachments[], user, ts, replyHandle}`; outbound `{text?, voiceOggPath?, files[], options:{modality}}` where `modality` ∈ `text\|voice\|dual\|auto`. Queued + recoverable + voice-aware. |
| **Delivery queue** | `src/delivery-queue.ts` | Durable, ack'd, replayable inbound persistence — the inbox-queue patch made first-class. Enqueue-before-handle, ack-after-success; un-acked items replay on restart (FC-2). |
| **Capture store** | `src/capture-store.ts` | Durable, append-only NDJSON event store. Subscribes to the bus; `replay()`/`query()`; tolerant of a torn final line. The seed of §2c observability. |
| **Telegram adapter** | `src/adapters/telegram.ts` | The reference `ChannelAdapter`. Composes transport + gate + queue + voice. Obsoletes **both** monkey-patches natively. |
| **Telegram transport seam** | `src/adapters/telegram-transport.ts` | Decouples the adapter from the wire. `fileKindFor()` routes `.ogg/.oga/.opus`→voice bubble (the `sendVoice` patch, native). |
| **grammY transport (real)** | `src/adapters/grammy-transport.ts` | Wraps a grammY `Bot`. **Only ever used against a dedicated/test token** (see Safety). |
| **Loopback transport (test)** | `src/adapters/loopback-transport.ts` | Deterministic, in-memory, no network — the safety lever for automated acceptance. |
| **Transport policy** | `src/transport-policy.ts` | The PURE loopback-safety decision: a live poller only with `--live` + a dedicated token; never reads the production token. Unit-tested directly. |
| **Access gate** | `src/adapters/access-gate.ts` | Lifted from the plugin `gate()` — drops non-allowlisted senders. Reads `access.json` **read-only** (the live plugin owns pairing). |
| **Voice codec** | `src/voice.ts` | STT/TTS via the existing Python helpers (`transcribe_voice.py` / `tts_voice.py`) as out-of-process steps. Degrades gracefully if absent. |
| **Read-only web panel** | `src/panel.ts` | A thin operator view (OD-3: minimal web, **read-only** in Phase 1): `/api/health`, `/api/capture`, a live HTML page. Binds to loopback. |
| **Echo host-hook (dev/test)** | `src/echo.ts` | A throwaway connectivity affordance behind `--echo` — echoes inbound back (text + voice). NOT the real host (Phase 2 replaces it). |
| **Config** | `src/config.ts` | Resolves the supervisor's **own** state dir (never the live plugin's), token source, helper-script paths. Secret-safe (`productionTokenFilePresent` boolean only). |
| **Logger** | `src/logger.ts` | Dependency-free NDJSON logger. |
| **Entrypoint** | `src/index.ts` | Wires it all; **loopback-safe by default** (see Safety). |

## What's built (Phase 2 — subprocess ownership)

| Module | File | Role |
|---|---|---|
| **Session driver seam** | `src/session-driver.ts` | The normalized boundary between the supervisor and the SDK: `SessionDriver` interface + `SessionEvent`/`PermissionRequest`/`PermissionDecision` types. Confines all SDK-API uncertainty to one adapter. |
| **SDK session driver** | `src/adapters/sdk-session-driver.ts` | The REAL driver — wraps `@anthropic-ai/claude-agent-sdk` `query()`, maps stream-json messages → `SessionEvent`, adapts `canUseTool`, pumps multi-turn input. The only SDK-coupled file (dynamic import; the SDK is an optional dep). |
| **Lifecycle manager** | `src/lifecycle.ts` | Spawns + OWNS the session via the driver; captures the session id; publishes stream-json events to the bus (→ capture + outbound); health + **restart with `resume`** on an unexpected (crash) stream end (FI), bounded against crash-loops. |
| **Permission router** | `src/permission-router.ts` | **The FC-1 killer.** Allow-list fast-path · deny-list · safety-floor → route over the channel and **block on the user's reply**; fail-safe **deny on timeout**. Pure + unit-tested. |
| **Channel permission** | `src/channel-permission.ts` | The route-out + await-reply round-trip: sends `🔐 Approve '<tool>'? allow/deny <code>`, one-shot waiter resolved by a recognized inbound reply; fail-safe timeout. |
| **Session host** | `src/session-host.ts` | Composes lifecycle + router + channel into the supervisor's host inbound hook (**replaces** the Phase-1 log/echo hook): inbound → user turn; permission reply intercepted; session output → channel. |

### How it eliminates FC-1 (the invisible permission prompt)

A gated tool the hosted session wants to run hits the SDK's `canUseTool` →
normalized to the router. Allow-listed tools pass with no prompt; everything else
is **sent to the user over Telegram** (`🔐 Approve 'Bash'? allow ab12`) and the
session **blocks** on the reply. There is no terminal prompt to be invisible, no
30-min sweep, no synthesized keystroke. No reply in the window → fail-safe deny.

### How it obsoletes the two monkey-patches

- **`apply_telegram_patch.py` (inbox-queue)** → `DeliveryQueue`: every gate-approved
  inbound is persisted to `<state>/queue/telegram/msg-*.json` (the same
  `{content, meta}` shape) **before** the handler runs, and acked only after it
  succeeds. A crash between receive and handle replays the item on next start.
- **`apply_telegram_voice_patch.py` (sendVoice)** → `fileKindFor()` + the adapter's
  outbound path: `.ogg/.oga/.opus` send as a Telegram **voice note** natively;
  outbound `modality: 'voice'` renders text→OGG via TTS first.
- **`transcribe_voice.py` / `tts_voice.py`** → re-homed behind `VoiceCodec` as
  out-of-process helpers (logic preserved, not re-ported).

The plugin's `server.ts` is **not** modified by any of this — the behaviors live in
the adapter.

---

## ⚠️ CRITICAL SAFETY — do not sever the live channel

Telegram permits **exactly one `getUpdates` poller per bot token**. The running
orchestrator holds the production token's poller. A second poller on that token
returns **409 Conflict** and would **sever the user's live channel**.

The supervisor is built so this **cannot happen by accident**:

- **Default (no `--live`):** the Telegram adapter runs on the **loopback**
  transport — in-memory, no network, no poller. The shell runs, the bus +
  capture + panel work, nothing touches the live bot.
- **`--live` only starts a real poller against a DEDICATED token** read from
  `SUPERVISOR_TELEGRAM_TOKEN`. It **never** uses the plugin's production
  `TELEGRAM_BOT_TOKEN`. If the dedicated token is absent, it logs a warning and
  falls back to loopback.

The supervisor also uses its **own** state dir (`~/.claude/supervisor` by default)
for its queue + capture; it reads the live plugin's `access.json` **read-only** and
never writes any plugin/channel file.

**The live-production cut-over (the supervisor owning the production channel) is a
Phase-3 step.** Phase 1 validates the contract + queue-replay + voice + capture
**deterministically** (loopback transport + the test suite).

---

## Build & run

Requires Node ≥ 20.

```bash
cd tools/supervisor
npm install          # grammy + typescript + @types/node (lean); the Agent SDK is an OPTIONAL dep
npm run build        # tsc → dist/
npm test             # build + node --test (95 tests)

# Run the shell (SAFE — loopback transport, no live poller, no hosted session):
node dist/index.js
node dist/index.js --panel 8790        # also serve the read-only panel
#   → http://127.0.0.1:8790/  · /api/health · /api/capture

# Live poller ONLY against a dedicated token (NEVER the production token):
SUPERVISOR_TELEGRAM_TOKEN="<dedicated-bot-token>" node dist/index.js --live

# Connectivity test — echo each inbound back (dev/test; text + voice round-trip).
SUPERVISOR_TELEGRAM_TOKEN="<dedicated-bot-token>" node dist/index.js --live --echo --panel 8790

# Phase 2 — HOST a real Claude Code session (subprocess ownership). Inbound →
# session turns; session output → channel; gated tools routed to the user (FC-1).
# Needs the optional @anthropic-ai/claude-agent-sdk installed. Use the DEDICATED
# test bot for any live run — never the production token.
SUPERVISOR_TELEGRAM_TOKEN="<dedicated-bot-token>" node dist/index.js --live --session --panel 8790
```

### Echo mode (`--echo` / `SUPERVISOR_ECHO=1`) — a DEV/TEST affordance

Echo mode wires the supervisor's host inbound hook to echo each inbound straight
back through the adapter (`src/echo.ts`): a text message comes back as
`Echo: <text>`, and a **voice note round-trips both directions** (the inbound's
downloaded OGG is sent back as a voice bubble). It exists ONLY so a live Telegram
round-trip is demonstrable against a dedicated test bot. **It is not the real
host** — Phase 2 replaces the host hook with the hosted Claude Code session.
Default runs never enable it.

### Input & output channels (voice + modality)

The supervisor owns BOTH directions of the channel (proposal §B.4):

**Input channel — auto-STT.** An inbound voice note is downloaded and transcribed
by the **adapter** (`transcribe_voice.py` faster-whisper, via `VoiceCodec`)
*before* it reaches the hosted session — so the session receives the **transcribed
text** as the message body (the `.oga` path is preserved on `voicePath`). STT
failure degrades gracefully to the `(voice message)` placeholder; the inbound path
never crashes. (`src/adapters/telegram.ts` `resolveVoiceIfPending`.)

**Output channel — switchable modality.** The orchestrator's substantive replies
are sent in one of three modes, held as in-memory state in the SessionHost:

| Mode | Behaviour |
|---|---|
| `text` (**default**) | text only (current behaviour) |
| `voice` | a TTS voice note ONLY (`tts_voice.py` edge-tts → OGG → `sendVoice` bubble) |
| `dual` | BOTH the text AND a TTS voice note |

The startup default is **`text`** (env `SUPERVISOR_OUTPUT_MODE=text|voice|dual`
overrides it; `config.ts` `outputModeDefault`). Control messages — permission
prompts, the `/mode` ack, system notices — always go as **text** (never voiced).
TTS is skipped for empty replies; on TTS unavailability a `voice`/`dual` reply
still reaches the user as text (never lost, never double-sent).

**Switch command — `/mode`.** Inbound `/mode text | /mode voice | /mode dual`
(case/space-insensitive) is **intercepted by the supervisor** (same seam as
`/channel-check`): it flips the modality state, ACKs the user (`Output mode →
voice`), and is **NOT forwarded** to the orchestrator. Bare/invalid `/mode`
replies with the current mode + the valid options. (`src/session-host.ts`
`parseModeCommand` / `handleModeCommand`.)

Voice helpers shell out to the repo's Python scripts. `config.ts` resolves them
from its OWN module location (cwd-independent): the **tools dir** defaults to the
repo `tools/` (where `transcribe_voice.py` / `tts_voice.py` live) and the **python
interpreter** defaults to the repo venv (`PianoidCore/.venv/.../python`) — the
validated `faster-whisper` (STT) + `edge-tts`/`ffmpeg` (TTS) environment — falling
back to a bare `python`/`python3` only if the venv is absent. Both are overridable:
`SUPERVISOR_TOOLS_DIR` (script dir) and `SUPERVISOR_PYTHON` (interpreter); the
production launcher (`launch-prod-orch.mjs`) pins both belt-and-suspenders. Without
a working interpreter+script, voice degrades gracefully (inbound → `(voice
message)`; outbound → text).

> **★ Inbound-STT fix (2026-06-19):** the running supervisor delivered the literal
> `(voice message)` placeholder instead of the transcript because the OLD defaults
> were wrong — the tools dir defaulted to `~/.claude` (the scripts are NOT there →
> `isSttAvailable()` false → silent placeholder) and python to a bare `python`
> (lacks `faster-whisper` → `transcribe()` throws → placeholder). The repo-`tools/`
> + venv-python defaults above fix it; `src/test/voice-stt-isolation.test.ts`
> proves the REAL `VoiceCodec` (built from `loadConfig()` defaults) transcribes the
> captured sample `.oga` end-to-end through the adapter.

> **Note (file size):** `src/session-host.ts` is 838 LOC (YELLOW, > 500). The
> modality work kept the parser a standalone exported pure fn (`parseModeCommand`);
> a future split of the lifecycle-restart / liveness-ping concerns out of the host
> is the next reduction (not bundled with this feature).

---

## Acceptance — all demonstrated by the test suite

**Phase 1:**

| Criterion | Proven by |
|---|---|
| (a) A Telegram message round-trips through the adapter contract incl. a **voice note both directions**, with **no plugin patch** | `src/test/telegram-adapter.test.ts` |
| (b) Inbound **survives an adapter restart** (queue replay; nothing dropped) | `src/test/queue-replay.test.ts` |
| (c) The **capture store** holds a full replayable event stream | `src/test/supervisor-e2e.test.ts` + `src/test/panel.test.ts` |
| Loopback-safety (live poller only on a dedicated token) | `src/test/transport-policy.test.ts` |

**Phase 2:**

| Criterion | Proven by |
|---|---|
| **FC-1**: a gated tool is **routed to the user over the channel and the session BLOCKS** until the reply (no terminal prompt) | `src/test/session-host.test.ts` (route→allow, route→deny, allow-listed not routed) + `src/test/permission-router.test.ts` (incl. timeout→fail-safe-deny) |
| **FI**: killing the session mid-task → **restart + `resume`** the same session id and continue | `src/test/lifecycle.test.ts` (crash→restart-with-resume; clean stop no restart; bounded crash-loop) |
| **stream-json on the bus**: `system_init`/`assistant`/`result` captured; session id captured | `src/test/lifecycle.test.ts` + `src/test/sdk-session-driver.test.ts` (message mapping + canUseTool adaptation + resume/systemPrompt pass-through) |

**Input & output channels (voice + modality):**

| Criterion | Proven by |
|---|---|
| **Input**: inbound voice → **auto-STT** → transcribed text delivered (voicePath preserved); STT-fail → `(voice message)` placeholder, no crash | `src/test/telegram-adapter.test.ts` ("VOICE IN …") |
| **Input (REAL wiring)**: `config.ts` defaults resolve the repo `tools/` script + venv python (not `~/.claude`/bare python); env overrides; the REAL `VoiceCodec` transcribes the captured sample `.oga` end-to-end → real transcript, NOT `(voice message)` | `src/test/voice-stt-isolation.test.ts` |
| **Output `voice`**: reply rendered TTS → `sendVoice` bubble; TTS-unavailable → text fallback | `src/test/telegram-adapter.test.ts` ("VOICE OUT …") |
| **Output `dual`**: reply sent as BOTH text AND a voice bubble; TTS-fail keeps text (no double-send); empty text skips TTS | `src/test/telegram-adapter.test.ts` ("DUAL OUT …") |
| **`/mode` switch** intercepted (state flips, ACK sent, NOT forwarded); bare/invalid → query; modality carried onto the substantive reply; default = `text` | `src/test/voice-modality.test.ts` |

Run `npm test` → **219/219 green**. (Most logic is proven against a deterministic
`FakeSessionDriver` + a loopback transport + a fake `VoiceCodec` — no SDK, no
network, no real Telegram. The ONE exception is `voice-stt-isolation.test.ts`,
which deliberately spawns the REAL `transcribe_voice.py` via the venv python on the
captured sample `.oga` to prove the inbound-STT wiring; it SKIPS cleanly on a box
without the sample/venv.) A live end-to-end smoke boots the shell on the loopback
transport with zero risk to the live channel; a live SDK round-trip is optional and
uses the dedicated test bot.

---

## What's stubbed / deferred

Phase 1 + Phase 2 are **built** (above). The code plugs into the existing bus +
capture + registry + session-driver seams; the remaining work:

**Phase 2 — DONE** (subprocess ownership, the `canUseTool` router, stream-json on
the bus, restart+`resume`). Carried-forward inside Phase 2 (small, non-blocking):
- **`hooks` + `mcpServers`** are accepted by the `SessionStartOptions`/SDK boundary
  but the **controller marker hook** itself (Campaign P4) is wired in a later pass —
  it depends on this Phase-2 plumbing, which now exists.
- **Partial/streaming assistant deltas**: the driver maps whole `assistant`/`result`
  messages; token-level partials (`includePartialMessages`) are not surfaced yet
  (doc-FLAGGED option; add when needed).
- The **operator** is single (the latest inbound user), matching the plugin's
  single-user model; multi-operator routing is later.

**Phase 3 — retire the glue + self-context-clean + live cut-over:**
- Make the supervisor the default host; **delete** `cli_control.ps1` + the
  `/cli-control` skill + both `apply_telegram_*` patches + the detached-Start-Process
  pattern; switch the controller to the captured bus.
- **Self-context-clean** (end-session → new-session-from-snapshot → resume).
- Panel to operator-grade (approve-click + cost/tier/stall/verification views).
- **The live-production Telegram cut-over** (supervisor owns the production token's
  poller, replacing the plugin) happens here — not before.

**Repo home:** staged in-repo under `tools/supervisor/` (OD-2); extraction to the
new public kit repo is **P5** (per proposal PART F).

### Known limitations / carried-forward (from the Phase-1 code review)

- **Text chunking is whitespace-safe, not MarkdownV2-entity-aware.** `chunkText`
  (`adapters/telegram.ts`) splits long replies on a newline/space boundary near
  4096 and never cuts a UTF-16 surrogate pair, but it does NOT yet avoid splitting
  *inside* a MarkdownV2 entity. Plain text is safe; `format:'markdown'` over 4096
  chars could still break an entity. Full MarkdownV2-aware chunking is a Phase-2
  follow-up.
- **Voice durability** now sits inside the durable boundary: the raw inbound is
  enqueued *before* download + STT, and the transcript is memoized back into the
  queue item, so a crash mid-STT replays the item and STT is not re-run
  (`queue-replay.test.ts`). The grammY transport's own at-least-once redelivery is
  therefore a backstop, not the primary guarantee.

---

## Design principles honored

- **P1 (Authority):** each piece of state has one owner — `DeliveryQueue` owns its
  queue dir, `CaptureStore` owns its log (append-only, sole writer), the
  `Supervisor` owns the adapter registry, the `IoBus` owns fan-out. The live
  plugin's `access.json`/`.env`/`inbox/` are **read-only** references.
- **P2 (Concern):** one job per module (transport moves bytes; gate decides
  allow/drop; queue persists/acks/replays; codec converts voice↔text; capture
  persists; bus fans out; supervisor orchestrates).
- **Cross-platform:** pure Node + config-resolved paths; the most
  Windows-specific glue (keystroke window-driving) is **not** ported here — it is
  deleted in Phase 3.
