# Pianoid Supervisor — M12 Host/Supervisor app (Phase 1)

> **Status: Phase 1 (additive, zero-disruption shell).** This is the runtime +
> I/O-control module from the M12 proposal
> (`docs/proposals/m12-host-supervisor-app-2026-06-14.md`). Phase 1 stands up the
> supervisor skeleton + the M10 channel-adapter contract + the Telegram reference
> adapter (folding in the inbox-queue and voice STT/TTS, so **both** Telegram
> monkey-patches are obsoleted **without patching the plugin**) + a durable,
> replayable stream-json/transcript **capture store**. It does **not** yet own the
> Claude Code subprocess — that is **Phase 2**.

A standalone TypeScript/Node app. It is built **alongside** today's in-CLI
orchestrator and retires nothing — the live orchestrator keeps running unchanged.

---

## What's built (Phase 1)

| Module | File | Role |
|---|---|---|
| **Supervisor** | `src/supervisor.ts` | Lifecycle + adapter registry + wires bus↔capture↔adapters. Routes inbound→bus (captured)→host hook; routes outbound back through the originating adapter. *Does not own the Claude subprocess yet.* |
| **I/O bus** | `src/io-bus.ts` | In-memory, captured fan-out broker. Monotonic `seq`, fail-soft fan-out. The spine of FC-3 ("every byte on a captured bus"). |
| **Channel-adapter contract (M10)** | `src/contract.ts` | The interface the supervisor codes to: `start(onInbound)`, `outbound(handle, msg)`, `stop()`, `health()`; normalized inbound `{text?, voicePath?, attachments[], user, ts, replyHandle}`; outbound `{text?, voiceOggPath?, files[]}`. Queued + recoverable + voice-aware. |
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
| **Config** | `src/config.ts` | Resolves the supervisor's **own** state dir (never the live plugin's), token source, helper-script paths. Secret-safe (`hasToken` only). |
| **Logger** | `src/logger.ts` | Dependency-free NDJSON logger. |
| **Entrypoint** | `src/index.ts` | Wires it all; **loopback-safe by default** (see Safety). |

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
npm install          # grammy + typescript + @types/node (lean)
npm run build        # tsc → dist/
npm test             # build + node --test (68 tests)

# Run the Phase-1 shell (SAFE — loopback transport, no live poller):
node dist/index.js
node dist/index.js --panel 8790        # also serve the read-only panel
#   → http://127.0.0.1:8790/  · /api/health · /api/capture

# Live poller ONLY against a dedicated token (NEVER the production token):
SUPERVISOR_TELEGRAM_TOKEN="<dedicated-bot-token>" node dist/index.js --live

# Connectivity test — echo each inbound back (dev/test; text + voice round-trip).
# Use a DEDICATED test bot token; --echo also works on loopback for local checks.
SUPERVISOR_TELEGRAM_TOKEN="<dedicated-bot-token>" node dist/index.js --live --echo --panel 8790
```

### Echo mode (`--echo` / `SUPERVISOR_ECHO=1`) — a DEV/TEST affordance

Echo mode wires the supervisor's host inbound hook to echo each inbound straight
back through the adapter (`src/echo.ts`): a text message comes back as
`Echo: <text>`, and a **voice note round-trips both directions** (the inbound's
downloaded OGG is sent back as a voice bubble). It exists ONLY so a live Telegram
round-trip is demonstrable against a dedicated test bot. **It is not the real
host** — Phase 2 replaces the host hook with the hosted Claude Code session.
Default runs never enable it.

### Voice helpers (optional)

STT/TTS shell out to the repo's Python helpers. With them on the resolved path
(`transcribe_voice.py`, `tts_voice.py` — `config.ts` resolves these), inbound
voice notes are transcribed and outbound `modality:'voice'` renders a voice note.
Without them, voice degrades gracefully (inbound → `(voice message)`; outbound →
text fallback). They need `faster-whisper` (STT) and `edge-tts` + `ffmpeg` (TTS),
as the existing orchestrator setup already provides.

---

## Acceptance (Phase 1 — all demonstrated by the test suite)

| Criterion | Proven by |
|---|---|
| (a) A Telegram message round-trips through the adapter contract incl. a **voice note both directions**, with **no plugin patch** | `src/test/telegram-adapter.test.ts` (text round-trip, voice-in STT, voice-out sendVoice, degrade paths, chunking) |
| (b) Inbound **survives an adapter restart** (queue replay; nothing dropped) | `src/test/queue-replay.test.ts` (crash-before-ack → fresh adapter replays; acked item not replayed; voice durable + STT memoized) |
| (c) The **capture store** holds a full replayable event stream | `src/test/supervisor-e2e.test.ts` (lifecycle + inbound + outbound captured, durable re-read) + `src/test/panel.test.ts` |
| Loopback-safety (the live poller can only start on a dedicated token) | `src/test/transport-policy.test.ts` (all 3 branches + the production token never reaching a transport) |

Run `npm test` → **64/64 green**. A live end-to-end smoke (`node dist/index.js
--panel …`) boots the shell on the loopback transport and serves `/api/health`
with zero risk to the live channel.

---

## What's stubbed / deferred (Phase 2 & 3)

This is the **additive shell**; the following land in later phases (per the
proposal PART E) and the code is structured so they plug into the existing bus +
capture + registry seams:

**Phase 2 — subprocess ownership (FC-1, FC-3 eliminated):**
- Lifecycle manager that **spawns and owns** headless Claude Code via the Agent
  SDK (`@anthropic-ai/claude-agent-sdk` `query()`), with M1 as the system prompt;
  capture the session id from `system/init`.
- `canUseTool` **permission router**: allow-list fast-path + **route safety-floor
  decisions over the channel** and block on the user's reply (no terminal prompt).
- **stream-json bidirectional I/O** on the bus (inject user turns; consume
  `system/init`/`assistant`/`tool_*`/`result`); the `BusEvent` envelope already
  models these.
- **Health-check + `--resume` restart** (FI) wired to the wait→wake (FO).
- Programmatic **hooks + `mcpServers`** as SDK options (the controller marker hook).
- In Phase 1, the host inbound hook just logs ("no session hosted yet"); Phase 2
  replaces it with the session.

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
