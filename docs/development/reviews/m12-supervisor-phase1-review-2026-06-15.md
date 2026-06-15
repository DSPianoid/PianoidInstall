# Code Review — M12 Host/Supervisor App, Phase 1 (`tools/supervisor/`)

**Level:** MODULE (greenfield TypeScript/Node subsystem)
**Date:** 2026-06-15
**Scope:** `tools/supervisor/src/**` — 16 source + 11 test TS files (3280 LOC total).
**Spec:** `docs/proposals/m12-host-supervisor-app-2026-06-14.md` PART E Phase 1 (deliverables + acceptance), PART B (architecture), PART D (subsume/retire).
**Mode:** READ-ONLY. No source edited. The building agent (dev-m12p1) holds the locks.

---

## Verdict

**Phase 1 is sound enough to commit/merge.** The architecture matches PART B cleanly, the
separation of concerns is exemplary (one job per module, no god-objects, smallest file-set that
satisfies the spec), the durable-delivery and capture invariants are correctly implemented, and the
loopback-safe-by-default guarantee holds. **No Critical findings. No High findings that block the
commit.**

There is **one High-severity observability gap** (H1 — buffered capture is invisible to the
read-only panel/replay until `close()` in the live default) that is a real defect but **does not
threaten the live channel, lose data, or break Phase-1 acceptance** — it degrades the Phase-1
"operator can watch the shell work" story. It is a 1-line fix (`writeFileSync` for the live capture,
or flush-on-read) and **should be fixed in this PR or logged as a fast follow**, not gated behind a
re-review.

The remaining findings are Medium/Low polish: a latent secret-handling footgun (`getToken` export),
a durability nuance in the voice/STT boundary, an id-collision edge in the queue, and a few naming /
dead-surface nits.

**Counts:** Critical 0 · High 1 · Medium 4 · Low 5.

---

## Top 5 Files in Scope by LOC

| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | `src/adapters/telegram.ts` | 303 | — (well under 500) |
| 2 | `src/adapters/grammy-transport.ts` | 218 | — |
| 3 | `src/supervisor.ts` | 192 | — |
| 4 | `src/voice.ts` | 156 | — |
| 5 | `src/contract.ts` | 155 | — |

Every source file is **< 500 LOC** — no YELLOW, no RED. The README's "<500 LOC" claim is **verified**
(largest source file is 303). C4 god-object rule: **PASS**. The module is split by concern into the
exact set PART B names; no file is doing two jobs.

---

## Architectural Consistency

**Layer audit: PASS.** This is a standalone Node app (the M12 "runtime + I/O-control" layer), not part
of the Pianoid 4-layer engine/middleware/frontend stack. It correctly owns **no project logic** — it
hosts (Phase 2) the orchestrator rather than re-implementing it. The TS↔Python boundary the proposal
mandates (PART C.1) is respected: the supervisor shell is TS; the STT/TTS leaf utilities stay Python
and are invoked out-of-process via `VoiceCodec` (`voice.ts:134` `spawn`). No business logic leaked
into TS; no ML re-port.

**Server audit: N/A.** The supervisor is single-process; it does not import or cross into the
main/modal Pianoid servers. It reads the live plugin's `access.json` **read-only** and writes only its
own state dir (`config.ts:85` `stateDir`), so there is no process-crossing authority leak with the
running orchestrator.

**Match to PART B.2 component borders:** every component in the diagram has a 1:1 module and stays
inside its border:

| PART B component | Module | Border honored? |
|---|---|---|
| I/O bus (marshal + fan-out, no interpretation) | `io-bus.ts` | Yes — pure in-memory broker, never mutates payload, holds no durable state |
| Channel-adapter registry | `supervisor.ts` (the `adapters` map) | Yes — sole owner, dup-registration rejected |
| Channel-adapter contract (M10) | `contract.ts` | Yes — supervisor depends only on this interface |
| Telegram reference adapter | `adapters/telegram.ts` | Yes — composes transport+gate+queue+voice, owns no bus/capture |
| Transport seam | `adapters/telegram-transport.ts` + grammy/loopback | Yes — wire I/O only, no gating/normalization |
| Local panel (read-only) | `panel.ts` | Yes — GET-only, mutates nothing, binds loopback |
| Capture (durable observability) | `capture-store.ts` | Yes — append-only, sole writer |
| Delivery queue (FC-2) | `delivery-queue.ts` | Yes — persist/ack/replay only |

The Phase-2/3 seams (subprocess ownership, `canUseTool` router, stream-json) are correctly **absent**
and the bus envelope (`BusEvent.type`/`payload`) is generic enough to carry them later — as the spec
intends. No speculative Phase-2 code shipped (S1 clean).

---

## Authority Violations (P1)

| # | State | Owner | Violating Writer | Severity |
|---|-------|-------|------------------|----------|
| — | — | — | None found | — |

P1 is **clean**. Each piece of state has exactly one writer:
- `DeliveryQueue` is the sole writer of its queue dir (`delivery-queue.ts`); `ack()` archives/deletes,
  `enqueue()` writes — no other module touches those files.
- `CaptureStore` is the sole writer of its NDJSON log, append-only, never rewrites in place
  (`capture-store.ts:76` `record`).
- `Supervisor` solely owns the adapter registry map; adapters never self-register
  (`supervisor.ts:74` `register`).
- `IoBus` owns its subscriber set; producers publish, the bus assigns `seq`/`ts` and never mutates the
  event (`io-bus.ts:79`).
- The live plugin's `access.json`/`.env` are treated **read-only** — the gate never writes
  (`access-gate.ts:64` `load` is read-only; documented at the class border).
- The supervisor uses its **own** state dir, so it does not contend for write authority over any file
  the running orchestrator owns.

---

## Concern Violations (P2)

| # | Module | Stated Concern | Concern Added/Widened | Severity |
|---|--------|---------------|----------------------|----------|
| — | — | — | None found | — |

P2 is **clean** — this is the module's strongest dimension. Every module has a one-sentence concern
and holds to it (transport moves bytes; gate decides allow/drop; queue persists/acks/replays; codec
converts voice↔text; capture persists; bus fans out; supervisor orchestrates; panel presents). No
grab-bag "manager" doing three things. The `Supervisor` class is the one orchestrator and it delegates
rather than absorbing transport/persistence logic.

---

## Patch / Workaround Findings

**TODO/FIXME/HACK/XXX count in scope: 0.** None anywhere in the source. (S5 clean on this axis.)

Every `catch {}` block (7 total) is **commented and justified** — none is a silent swallow:

| File:Line | Pattern | Assessment |
|---|---|---|
| `access-gate.ts:75` | corrupt `access.json` → deny-all | **Correct** — fail-closed, the secure default (does not fail open) |
| `access-gate.ts:125` | invalid user regex → skip pattern | **Correct** — a bad user-supplied mention pattern must not crash the gate |
| `config.ts:78` | unreadable `.env` → no token | **Correct** — degrades to loopback (the safe path) |
| `capture-store.ts:103` | torn final NDJSON line → skip | **Correct** — the documented torn-line tolerance |
| `delivery-queue.ts:114` | unreadable/partial queue file → skip | **Correct** — never abort the whole replay for one bad file |
| `delivery-queue.ts:141` | handler throws on replay → leave queued | **Correct** — the fail-safe "never drop" guarantee |
| `grammy-transport.ts:206` | `stop()` mid-setup rejects → ignore | **Correct** — grammY's expected "Aborted delay" on abort |

No sleep-based synchronization in production paths (the only `setTimeout` is the legitimate poll
backoff in `grammy-transport.ts:134` and the voice-helper timeout in `voice.ts:140`). No legacy/migration
shims. No "just in case" dead branches.

---

## Correctness Findings (the highest-value section)

### H1 — Buffered capture is invisible to the panel/replay until `close()` (live default) — **High**, confidence 90

**Where:** `capture-store.ts:51-108`, `supervisor.ts:58-63`, `index.ts:67`, `panel.ts:77`.

**Mechanism.** `CaptureStore` defaults to `buffered: true` (`capture-store.ts:59`), which writes through
a Node `createWriteStream` (`capture-store.ts:64`). But `replay()` and `query()` read the file **directly
from disk** via `readFileSync` (`capture-store.ts:97`) — they do **not** drain the write stream. The live
entrypoint constructs the supervisor **without** `unbufferedCapture` (`index.ts:67`), so the live capture
is buffered. The read-only panel's `/api/capture` calls `supervisor.captureStore.replay()`
(`panel.ts:77`). Node stream writes are buffered in memory and flushed asynchronously; until a flush (or
`close()`), recent events are **not yet on disk**, so the panel and any `replay()` will under-report —
showing stale or empty capture while the shell is actually processing traffic.

**Why it matters.** Phase-1 acceptance (c) is "the capture store holds a complete, replayable record"
and OD-3's Phase-1 panel exists precisely to **watch the shell work live**. With buffered capture, the
live operator view lags arbitrarily behind reality (worst case: shows nothing until shutdown). The
**tests pass** because every test constructs the store with `buffered: false` / `unbufferedCapture:
true` (`capture-store.test.ts:14`, `supervisor-e2e.test.ts:28`, `panel.test.ts:24`) — so the defect is
**masked by the test configuration** and never exercised in the buffered mode that production uses. This
is a coverage blind spot as much as a code bug (see TG1).

**Not a data-loss bug.** On a clean shutdown the stream is flushed (`close()` awaits `stream.end`,
`capture-store.ts:130`), so the durable record is complete at rest. The gap is **live read-back**, not
persistence. That is why this is High, not Critical.

**Recommended fix (pick one):**
1. Make the live entrypoint pass `unbufferedCapture: true` (simplest; capture volume in Phase 1 is low —
   lifecycle + channel I/O, not yet the stream-json firehose), **or**
2. Have `replay()`/`query()` flush the stream before reading (e.g. an explicit `flush()` the panel calls),
   **or**
3. Keep an in-memory ring of recent records for the panel and reserve disk read for cold replay.

Given Phase-1 event volume, option (1) is the right call now; option (3) is the Phase-3 operator-grade
answer.

### M1 — `getToken()` is an exported production-token accessor with no caller — latent secret footgun — **Medium**, confidence 85

**Where:** `config.ts:111-114` (export), `index.ts` (never imports it).

`getToken()` returns the **raw production `TELEGRAM_BOT_TOKEN`**. Nothing in Phase 1 calls it — the live
transport correctly reads the **dedicated** `SUPERVISOR_TELEGRAM_TOKEN` instead (`index.ts:132`). So today
the production token is never materialized into a running value at all (good). But shipping an exported,
un-consumed `getToken()` that yields the production secret is a footgun: a future Phase-2 author wiring
"the real channel" will reach for the obvious `getToken()` and, in one line, undo the entire
loopback-safety architecture (it would let a poller start on the production token). S1 (lean: no
unused surface) and S5b-style "make the dangerous path hard" both argue against exporting it.

**Recommended fix:** delete `getToken()` until a caller exists (Phase 3 cut-over), **or** rename +
document it as `getProductionTokenForCutoverOnly()` and add a guard comment that it must never feed a
live poller before Phase 3. At minimum, the `loadConfig` `hasToken` computation (`config.ts:98`) already
gives the only thing Phase 1 needs (a boolean), so the accessor is pure dead weight now.

### M2 — Voice download + STT happen OUTSIDE the durable boundary — **Medium**, confidence 75

**Where:** `telegram.ts:120-134` (`handleRaw`) and `telegram.ts:137-175` (`toPayload`).

The durable contract is "enqueue **before** handle, ack **after** success." In `handleRaw`, the order is:
`gate → toPayload(raw) → enqueue → deliver → ack`. But `toPayload` performs the **voice download + STT**
(`telegram.ts:158-161`) — i.e. a network fetch and a 120 s-timeout Python subprocess run **before** the
item is persisted. If the process crashes mid-STT, the item was never enqueued. On the **real** grammY
transport this is recoverable (the Telegram `getUpdates` offset isn't advanced until the handler returns,
so the update is re-fetched on restart) — but that recovery path is **implicit and untested**, and the
durable-queue guarantee the README sells ("a crash between receive and handle replays the item") does
**not** cover the download/STT window. The transcript is also re-computed on every replay (STT is not
memoized into the queue payload), so a flaky STT could loop.

**Why only Medium:** for the loopback transport (all Phase-1 tests) there is no real fetch; for grammY,
Telegram's offset semantics do provide at-least-once. But the boundary is worth tightening so the
guarantee is explicit, not incidental.

**Recommended fix:** enqueue the **raw** payload first (chat/message/attachment handle), then do
download+STT inside `deliver` (after the durable write), persisting the transcript back into the item on
success — OR document explicitly that voice STT relies on the transport's at-least-once redelivery and add
a test that kills mid-STT on a real-transport stub.

### M3 — `DeliveryQueue` id uses an in-process `seq` that resets on restart → same-millisecond collision risk — **Medium**, confidence 70

**Where:** `delivery-queue.ts:59,75` — `id = msg-${Date.now()}-${seq++}` with `seq` starting at 0 each
process.

The id combines wall-clock ms with a per-process counter. Across a restart the counter resets to 0, so if
two items are enqueued in the **same millisecond** in two different process lifetimes (e.g. a fast crash
loop, or replay-then-new-inbound within 1 ms), the ids can collide — and `enqueue` would overwrite the
earlier file (same `finalPath`). The atomic tmp-rename protects against torn writes but **not** against id
reuse. Low probability, but the consequence (a silently dropped queue item) violates the never-drop
invariant.

**Recommended fix:** add a process-random or monotonic-counter suffix that does not reset (e.g. append a
short `randomBytes` token, or seed `seq` from the count of existing files on construction). Cheap
insurance for a durability primitive.

### M4 — `sendTextChunks` splits on a fixed 4096 byte/char boundary; multi-byte + entity risk — **Medium**, confidence 65

**Where:** `telegram.ts:266-283`, `MAX_CHUNK = 4096`.

Chunking slices `text` by JS string index (`rest.slice(0, 4096)`). Telegram's 4096 limit is on **UTF-16
code units** as Telegram counts them, and a naive slice can (a) split a surrogate pair / grapheme, and
(b) for `format: 'markdown'`, split **inside** a MarkdownV2 entity, producing a parse error or a
mid-entity break that grammY rejects. The plugin's original sender had the same simplification, so this
is **parity, not a regression** — but it is a latent correctness bug the lift carries forward.

**Recommended fix:** for the text path, splitting on a character boundary near 4096 (last newline/space)
is the low-cost mitigation; full MarkdownV2-aware chunking can defer. Note it explicitly so it isn't
assumed solved.

---

## Quality / Lesser Findings

### L1 — `Logger.child()` uses an `as unknown as {...}` cast to share the stream — **Low**, confidence 80
`logger.ts:46` writes the private `stream` of a freshly-constructed child via a double cast. It works and
is commented, but it punctures the type and the encapsulation. Cleaner: accept an optional shared
`stream`/parent in the constructor. Cosmetic; not load-bearing.

### L2 — `access.json` is re-read and re-parsed on **every** inbound (`decide` → `load`) — **Low**, confidence 80
`access-gate.ts:64,88` — `decide()` calls `load()`, which `readFileSync`+`JSON.parse`es the file per
message. Correct (always-fresh policy, and the plugin owns writes so there is no staleness model), but at
volume this is avoidable I/O. Acceptable for Phase 1; consider an mtime-cached read if inbound rate grows.
Note: a static-config gate (the test path) does not hit disk, so this only affects live.

### L3 — `index.ts` `parseArgs` silently ignores unknown flags and a bare `--panel` with no value → port 0 — **Low**, confidence 70
`index.ts:44-52` — `--panel` with a non-numeric/absent next arg falls through to `0` (disabled) with no
warning; unknown flags are dropped. Minor UX/robustness; an operator typo disables the panel silently.

### L4 — Health type uses an inline structural return instead of a named interface — **Low**, confidence 60
`supervisor.ts:150` returns `{ started; capturedEvents; adapters }` as an inline type. A named
`SupervisorHealth` interface would match the rest of the file's discipline (everything else is a named
interface) and read better at the panel boundary. Naming/structural-consistency nit (N1/C5).

### L5 — `TelegramAdapter.queueDepth` getter duplicates `health().queueDepth` — **Low**, confidence 70
`telegram.ts:300-302` exposes a `queueDepth` getter, but `health()` (`telegram.ts:290`) already returns
`queueDepth`, and that getter has no caller in the codebase. Minor S1 dead-surface; drop it or document
the intended external consumer.

---

## Test Coverage Adequacy

**47 tests** across 11 files. The risk surface is **well covered** with the following concrete gaps.

**Covered (strong):**
- **Crash-before-ack replay** — `queue-replay.test.ts` (handler throws → item stays queued → fresh adapter
  over the same dir replays it; acked item NOT replayed). This is the FC-2 core and it is proven end-to-end
  through the adapter, not just the queue.
- **Queue never-drop on replay-handler throw** — `delivery-queue.test.ts:69`.
- **Torn final NDJSON line** — `capture-store.test.ts:32` (partial line appended → replay yields the prior
  records, skips the torn one).
- **Capture append-survives-restart + ordering (monotonic seq)** — `capture-store.test.ts:49`,
  `supervisor-e2e.test.ts:67`.
- **Gate bypass** — `access-gate.test.ts` covers allowlist deliver/drop, disabled, pairing-unpaired-drop,
  group requireMention, group allowFrom, and **missing-file → deny-all (does not fail open)**. Plus the
  adapter-level "non-allowlisted inbound never even queued" (`telegram-adapter.test.ts:59`). Good.
- **Secret hygiene** — `config.test.ts:23,39` assert the secret never appears in the serialized config and
  that env wins over file. Directly tests the no-leak claim.
- **Bus fail-soft** — `io-bus.test.ts:27` (throwing subscriber isolated, good subscriber still receives,
  error surfaced; publish does not throw).
- **Voice both directions + degrade** — `telegram-adapter.test.ts` (voice-in STT, STT-unavailable
  placeholder, voice-out sendVoice bubble, TTS-unavailable text fallback, pre-rendered OGG bubble).
- **Chunking** — `telegram-adapter.test.ts:178` (3 chunks for 2×4096+10).
- **Panel read-only** — `panel.test.ts:91` (POST → 405).

**Concrete gaps (name them):**

- **TG1 (ties to H1) — buffered capture is never tested.** Every capture/e2e/panel test forces
  `buffered:false` / `unbufferedCapture:true`. The **production default (buffered)** path — and therefore
  the panel's live read-back lag — has **zero coverage**. Add a test that records under `buffered:true`
  and asserts what `replay()` returns before `close()` (this test will expose H1).
- **TG2 — loopback-safety is not unit-tested.** The single most important safety property
  (`resolveTransport` returns loopback unless `--live` AND `SUPERVISOR_TELEGRAM_TOKEN` is set, and falls
  back to loopback otherwise) lives in `index.ts:127` and has **no test** — it's asserted only by prose in
  the README. `resolveTransport` is currently a private function in `index.ts`; extract it (or export it)
  and test all three branches: no-`--live`→loopback, `--live` without dedicated token→loopback+warn,
  `--live` with dedicated token→grammy. This is the highest-value missing test given the stakes.
- **TG3 — no test that the production token never reaches a transport.** Complementary to TG2: assert that
  even with `TELEGRAM_BOT_TOKEN` set in env, no grammy transport is constructed without
  `SUPERVISOR_TELEGRAM_TOKEN`.
- **TG4 — torn line in the DELIVERY QUEUE replay is untested.** `capture-store` tests a torn line, but the
  analogous `delivery-queue.ts:114` skip-bad-file path (a half-written `msg-*.json`) has no test. The
  atomic tmp-rename makes a torn final file unlikely, but the skip path should still be covered.
- **TG5 — concurrent append / interleaving not tested.** Both the queue and capture assume single-process
  append; there is no test of two writers (which Phase 1 doesn't have, but the durability claims invite
  it). Acceptable to defer given the single-writer design, but worth a note.
- **TG6 — STT-mid-crash (M2) untested.** No test kills the process between download and enqueue; the
  implicit at-least-once reliance is unverified.

Coverage on the **stated** Phase-1 acceptance (a/b/c) is **complete and convincing**. The gaps above are
about the **production-mode** and **safety-lever** paths that the test harness configures around.

---

## Quality Summary

- **Error handling:** excellent — fail-closed gate, never-drop queue, torn-line tolerance, graceful voice
  degrade, fail-soft bus. Every catch is justified. No swallowed errors.
- **Naming / terminology:** consistent camelCase, PascalCase classes, clear noun-phrase module names. Minor
  nits (L4). Matches the project's N1 conventions.
- **Dead code:** minimal — `getToken` (M1) and `queueDepth` getter (L5) are the only un-consumed surfaces.
- **File sizes:** all < 500 LOC; the module is the smallest split that satisfies the spec. README claim
  verified.
- **Dependency leanness:** **excellent** — a single production dependency (`grammy`), dev-deps are just
  `typescript` + `@types/node`. Logger/panel/capture are dependency-free by design. Matches the proposal's
  "keep deps lean."
- **TS strictness:** **strong** — `strict: true`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `forceConsistentCasingInFileNames`. One gap: `exactOptionalPropertyTypes: false` (the code uses the
  `...(cond ? {k:v} : {})` spread idiom to avoid `undefined`-assignment, which works but would be even
  safer with the flag on — defer, it's a known-noisy flag). Type-only imports used correctly throughout.
- **Secret hygiene:** the token is never serialized into config/capture/logs; `index.ts:60` logs only
  `hasProductionToken` (boolean). Verified by grep and by `config.test.ts`. The one caveat is the
  **latent** M1 footgun, not an actual leak.

---

## Recommended Actions (priority order)

1. **H1** — make live capture readable in real time (pass `unbufferedCapture: true` in `index.ts`, or
   flush-on-read). Fix in this PR or as an immediate fast-follow. Add **TG1** to lock it.
2. **TG2 + TG3** — extract/export `resolveTransport` and unit-test all three loopback-safety branches +
   the "production token never reaches a transport" assertion. Highest-value missing test.
3. **M1** — remove or rename+guard the exported `getToken()` production-token accessor before Phase 2.
4. **M2 / TG6** — tighten the durable boundary so voice download+STT sit *after* enqueue (or document +
   test the at-least-once reliance).
5. **M3** — make the queue id collision-proof across restart (non-resetting suffix).
6. **M4, L1–L5, TG4–TG5** — opportunistic polish; none blocks the commit.

---

## Notes for the merge

- Nothing in this change touches the live plugin, the running orchestrator, or any Pianoid engine path.
  It is additive and isolated, exactly as PART D's migration-safety mandates ("runs alongside, retires
  nothing"). The retire/delete of the keystroke + monkey-patch glue is correctly deferred to Phase 3.
- The `.js` extension on relative imports (`./contract.js` etc.) is correct for `module: NodeNext` ESM
  output — not a bug.
- Verdict stands: **commit/merge Phase 1.** H1 is the one item I'd want addressed in or right after this
  PR; everything else is tracked debt, not a blocker.
