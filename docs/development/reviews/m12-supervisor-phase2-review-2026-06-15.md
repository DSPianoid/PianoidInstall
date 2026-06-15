# M12 Supervisor — Phase 2 (subprocess ownership) Code Review

**Date:** 2026-06-15
**Scope:** MODULE-level review of the M12 supervisor **Phase 2** additions under `tools/supervisor/` —
subprocess ownership: lifecycle manager, `canUseTool` permission router, channel-permission round-trip,
session-driver seam (real SDK + fake), stream-json→bus, session host. Security-sensitive TypeScript.
**Mode:** READ-ONLY. Building agent `dev-m12p1` holds the locks; no source edited.
**State reviewed:** **working tree** (Phase-2 files are uncommitted — branch `feature/m12-supervisor-phase2`
currently points at the same commit as `master`, `4c56aa4`; the 6 new src + 6 new test files are `??`/`M`
in `git status`, actively being written). This review is of the on-disk Phase-2 code, not a committed diff.
**Reference:** proposal `docs/proposals/m12-host-supervisor-app-2026-06-14.md` PART E Phase 2 + PART B;
`tools/supervisor/README.md`; `docs/development/CODE_QUALITY.md`; sibling `m12-supervisor-phase1-review-2026-06-15.md`.

---

## Verdict

**SOUND TO COMMIT with one High fix recommended first (H1), and one High to confirm-or-ticket (H2).**

- **No Critical findings.** The two Critical triggers in the brief are both clean:
  - **Tool-permission bypass / unapproved-tool-slip:** none found. The router denies on deny-list, allows
    only on explicit allow-list match, and routes everything else; there is no code path where a
    safety-floor tool runs without an explicit `allow` (from list or user). ✔
  - **Fail-open on timeout/error:** none found. Timeout → deny; send-failure → deny; no-operator → deny;
    deny-list → deny; user "deny"/"no" → deny. Every failure mode is fail-**safe**. ✔
- The deny-precedence, wildcard-match, allow-list fast-path, crash→restart-with-resume, clean-stop-no-restart,
  bounded-crash-loop, stream-json→bus mapping, optional-dep SDK confinement, secret hygiene, and additive/
  no-cutover defaults are all **correct**.
- The **one** real security weakness (H1) is that a routed permission prompt is authenticated only to the
  **allow-list**, not to the **specific operator** it was sent to — so with a multi-user allow-list or an
  allow-listed group, an allow-listed user *other than the intended operator* can approve a prompt. A
  **non**-allow-listed sender cannot (the access gate drops them first), which is why this is High, not Critical.
  Given the documented single-user model it is bounded today, but it is a latent privilege gap that should be
  closed (or explicitly ticketed) before the allow-list ever grows past one user or a group is added.

Counts: **Critical 0 · High 2 · Medium 4 · Low 5.**

---

## CRITICAL

None.

(Explicitly checked and clear: unapproved-tool-slip; fail-open on timeout/error; over-broad wildcard bypass;
non-allowlisted-sender approval; production-token reaching a poller; session auto-start by default.)

---

## HIGH

### H1 — Permission reply is authenticated to the allow-list, not to the routed operator (privilege gap with a multi-user / group allow-list)

**Files:** `src/session-host.ts:110-133` + `src/channel-permission.ts:97-105` (`submitReply`) +
`src/session-host.ts:57-81` (the router's `PermissionChannel` shim).

**What happens.** When a gated tool is routed, `ChannelPermission.askUser` sends the prompt to
`this.operator` and registers a one-shot waiter keyed only by a 4-hex `code`. Any **subsequent inbound**
whose text parses as `allow <code>` / `deny <code>` resolves that waiter — `SessionHost.handleInbound`
(line 126) calls `submitReply(code, verdict)` regardless of *who* sent it. Two coupled problems:

1. **No replier-identity binding.** `submitReply` does not check that the replying user/chat is the same
   one the prompt was routed to. The only authentication is upstream: `AccessGate.decide` (correctly) drops
   any sender not on `access.allowFrom` (DM) or the group's `allowFrom`+mention. So the reply is gated to
   *an* allow-listed user, **not** to *the* operator. With `allowFrom = [userA, userB]`, or an allow-listed
   **group**, userB (or any allow-listed group member) can approve a `Bash` prompt that the session raised
   while serving userA.
2. **Operator is overwritten on every inbound** (`session-host.ts:111` `this.operator = msg.replyHandle`).
   The "operator" is whoever messaged most recently. In a shared/group context this both mis-addresses the
   *next* prompt and the session's result text, and compounds (1): the last speaker becomes the approver/recipient.

**Why High (not Critical).** The brief's Critical trigger is *"could a non-allowlisted sender approve a tool?"*
— answer **NO**: the access gate drops non-allow-listed senders before the session host is ever reached
(`telegram.ts:160` → `access-gate.ts:87-109`, deny-all on missing/corrupt `access.json`). The exposure is
strictly *among already-trusted users*. With the **current single-user** allow-list (the plugin's model, which
the README states the host matches) it cannot fire. It becomes exploitable the moment the allow-list has >1
entry or a group is allow-listed — which the contract explicitly supports (`access-gate.ts` group policy).

**Secondary (same root):** the code is `randomBytes(2)` = 16 bits (65 536 values) and `submitReply` has **no
attempt cap / rate-limit**. An allow-listed-but-different user who does *not* see the prompt could brute the
code within the 5-min window (bounded, but unthrottled). The realistic vector, though, is simply *seeing* the
prompt in a shared chat — identity binding is the fix, not entropy.

**Fix.** Bind the waiter to the routed recipient and stop blindly trailing the operator:
- Capture `operator` (and ideally `userId`) **at the time the session is started / the turn that triggered the
  tool**, not on every inbound; or carry the intended-approver identity into the `Waiter`.
- In `submitReply` (or in `SessionHost.handleInbound` before calling it), require that the replying
  `msg.userId`/`replyHandle.to` matches the waiter's recipient; drop+log a mismatched reply instead of resolving.
- Add an attempt cap (e.g. invalidate the code after N wrong `submitReply`s) for defense-in-depth.

If the team decides single-operator is an acceptable Phase-2 constraint, that is defensible — but then the
gap must be an explicit, named WIP item (the README's "multi-operator is later" line is not enough; the code
*silently accepts* multi-user approvals today rather than rejecting them, which is the opposite of fail-safe).

### H2 — `interrupt()` is wired through the whole seam but never invoked; no stuck-turn / cancel path (confirm or ticket)

**Files:** `src/session-driver.ts:149` (contract), `src/adapters/sdk-session-driver.ts:254`,
`src/test/fake-session-driver.ts:105` — all implement `interrupt()`; **no caller** anywhere
(`grep interrupt` outside the seam = none).

**Why it matters.** The lifecycle manager treats a stream that ends **without** a `result` as a crash and
restarts+resumes (good). But there is **no path to interrupt a turn that is wedged but still "running"** — a
hosted session stuck mid-tool (or a runaway turn) is neither restarted (the stream hasn't ended) nor
cancellable (nothing calls `interrupt()`/`stop()` on a timeout). The FI story covers *crash*, not *hang*.
Phase-2 acceptance ("killing the child mid-task → restart+resume") is met; a *hang* is not addressed.

**Fix.** Either (a) wire a turn-level watchdog (no events for N seconds while a turn is open → `interrupt()`
then escalate to restart), or (b) if hang-handling is deliberately deferred to Phase 3, delete the unused
`interrupt()` implementations for now (S1 lean-code) and record the hang-recovery gap as a named WIP item.
Leaving a fully-plumbed-but-never-called control path is the worst of both (dead code *and* a missing
capability that looks present).

---

## MEDIUM

### M1 — `fallback: 'allow'` exists as a one-line global tool-bypass footgun

**File:** `src/permission-router.ts:61, 112-115`.
The policy supports `fallback: 'allow'` → every unmatched tool is allowed with no prompt and no log-of-note
beyond a debug line. This is the exact "blanket bypass" the proposal's router is meant to *replace*
(PART D: "the allow-list becomes a supervisor policy, **not** a blanket bypass"). It is not used by the
default policy (`index.ts:123-126` uses `fallback:'route'`), and the docstring calls it "discouraged" — but a
single config flip silently disarms FC-1 for all non-allow-listed tools. **Fix:** either remove `'allow'`
entirely (the allow-list already expresses "auto-allow these"), or gate it behind an explicit, loud
`SUPERVISOR_INSECURE_ALLOW_ALL`-style opt-in that logs a `warn` on every allowed call. At minimum, a
fail-loud log on each fallback-allow.

### M2 — Permission policy is hard-coded in the entrypoint, not config-resolved (A1/A4)

**File:** `src/index.ts:122-126`. The allow-list (`['Read','Glob','Grep','mcp__telegram__*']`) and
`fallback:'route'` are literals in `main()`. For a security control this is the single most important policy
in the app; it should come from the supervisor's config (one owner, one definition — A1/A4), not be edited in
code. The comment even says "Tune via project policy later." **Fix:** lift the policy into `SupervisorConfig`
(file/env-resolved) so it is auditable and testable as data; keep the conservative default. (Not blocking
for an additive Phase-2, but it should land before any real-token run.)

### M3 — Bus `direction` is mislabeled for outbound stream events (observability correctness)

**File:** `src/lifecycle.ts:171-178`. `publish()` sets `direction: type === 'lifecycle' ? 'internal' :
'inbound'` — so `stream.assistant` and `stream.result`, which conceptually flow **outbound** to the user, are
recorded as `'inbound'`. The capture store / future controller read `direction`; this makes the captured
byte-stream's direction semantics wrong for assistant/result. Functionally harmless now (capture still holds
everything), but it is exactly the observability surface §2c is being built for. **Fix:** label
system_init/assistant/result/tool_result per their true direction (session→user = outbound for
assistant/result; tool flow = internal), or drop the field to `'internal'` for all stream events rather than
mislabeling half of them `'inbound'`.

### M4 — `firstStartSettled()` 10 ms poll loop instead of an event/Promise (S5)

**File:** `src/lifecycle.ts:86-95`. `start()` waits for the first event via a `setTimeout(check, 10)` poll on
`this.sessionId || !this.running`. CODE_QUALITY S5 explicitly calls out "replace the sleep with an event or
ack, don't poll." It works and is bounded (resolves on first `system_init` or on `running=false`), but it is
a poll where a `Promise`/one-shot resolver (resolved from `handleEvent`'s `system_init` case, and from the
run-loop's terminal `running=false`) would be exact and idiomatic. **Fix:** resolve a stored promise when
`system_init` is handled or the loop exits, instead of polling.

---

## LOW

### L1 — `interrupt()` dead-code (folded into H2)
Covered by H2; listed here only so the S1 (lean-code) angle is explicit if H2 is resolved by "defer hang
handling" → then delete the three unused `interrupt()` bodies.

### L2 — `randomBytes(2)` = 16-bit permission code, no attempt cap
Folded into H1's secondary note. On its own (single-user model) it is Low: 65 536-space code, 5-min window,
one-shot. Raise to `randomBytes(4)` and/or cap wrong-`submitReply` attempts when H1 is addressed.

### L3 — `parseReply` accepts `y/n/yes/no` globally — collision risk with normal chat
**File:** `src/channel-permission.ts:113-119`. A normal message like `y 0f0f` (unlikely but possible) that
happens to match a *pending* code would be consumed as an approval. `submitReply` only resolves if the code
matches a live waiter, so the blast radius is "only when a matching ask is pending" — acceptable, but worth a
note. The single-letter `y`/`n` forms widen the surface marginally. Consider requiring the explicit
`allow`/`deny` words once H1's identity binding is in (keeps the convenience without ambiguity).

### L4 — `LifecycleManager.publish` always tags `source:'session'` even for `'lifecycle'` events
**File:** `src/lifecycle.ts:171-178`. Lifecycle/restart events (`restarting`, `restart_exhausted`) are
emitted with `source:'session'`; arguably they are the lifecycle manager's own. Cosmetic; affects capture
filtering only.

### L5 — `SdkSessionDriver.adaptPermission` always echoes `updatedInput` on allow (defensive, FLAGGED)
**File:** `src/adapters/sdk-session-driver.ts:187-191`. On allow it returns `{behavior:'allow',
updatedInput: input}` even when the router did not modify the input, "since some SDK versions require it."
This is a reasonable FLAGGED defensive assumption, but if the SDK treats a returned `updatedInput` as
"the tool input was rewritten," echoing the original is a no-op only if the SDK does an equality check.
Acceptable for now (clearly FLAGGED to verify in the live shakedown); just confirm against the real SDK that
echoing identical input is inert.

---

## Focus-area checklist (brief §1–6)

**1. Permission router (security-critical).**
- Allow-list fast-path correct ✔ (`permission-router.ts:104-109`); exact + trailing-`*` wildcard.
- Deny-list precedence correct ✔ — deny checked **before** allow (`:98-103`), and the test asserts
  deny-wins-over-allow (`permission-router.test.ts:31-37`).
- Wildcard match has **no over-broad/bypass hole** ✔ — `matches()` (`:65-72`) only treats a *trailing* `*`
  as a prefix wildcard and otherwise requires exact equality; `'mcp__telegram__*'` does not match
  `'mcp__github__issue'` (tested `:89-94`). No regex, no substring, no leading/middle wildcard. A bare `'*'`
  in `allow` would match everything (prefix `''`), but that is an explicit operator choice, not a hole.
- Route-over-channel + block-on-reply spoofing → **see H1** (gated to allow-list, not to the operator).
- Timeout/error → **fail-safe DENY** ✔ everywhere: router timeout→deny (`:131-135`, tested
  `permission-router.test.ts:55-62`); channel send-failure→timeout→deny (`channel-permission.ts:81-89`,
  tested `:68-78`); no-operator→timeout→deny (`session-host.ts:71-76`).
- No path where a safety-floor tool runs without explicit approval ✔ (only allow-list or user-`allow` yields
  `behavior:'allow'`; `fallback:'allow'` is the only escape and is the M1 footgun, not a default).

**2. LifecycleManager.**
- Crash→restart **with `resume:<sessionId>`** ✔ (`lifecycle.ts:130-145` sets `resume` from the captured id;
  tested `lifecycle.test.ts:60-92` asserts `startOpts[1].resume === 'sess-A'`).
- Clean stop → no restart ✔ (`stop()` sets `stopping`; run-loop breaks on `endedCleanly`; tested
  `lifecycle.test.ts:94-112`).
- `maxRestarts` bounds the crash-loop ✔ (`:109-114`; tested `:114-137`, initial+2 = 3 starts then gives up).
- No leak ✔ — no `setInterval`; the two `setTimeout`s are awaited inline; `stop()` awaits the run-loop;
  driver `stop()` closes the queue/query. The **permission-timer keep-alive fix is correct** —
  `channel-permission.ts:78` `unref()`s the timeout so a pending ask never holds the process open, and the
  test documents the keep-alive nuance (`channel-permission.test.ts:39-49`).
- **Gap:** hang (stream open but wedged) is not handled — **H2**.

**3. SessionDriver seam.**
- Clean real/fake split ✔ — both implement `SessionDriver`; lifecycle/router/host depend only on the seam;
  Phase-2 logic is proven against `FakeSessionDriver` with no SDK/subprocess/network.
- SDK assumptions clearly FLAGGED + reasonable ✔ — three explicit ⚠️ FLAGGED blocks
  (`sdk-session-driver.ts:60-69` streaming pump, `:166-179` `canUseTool` shape, `:196-207` message field
  names), each saying "fix HERE only." Defensive runtime reads (missing fields → undefined, never throw).
- SDK truly confined ✔ — it is the **only** SDK-coupled file; dynamic import via an indirect
  `new Function('s','return import(s)')` specifier (`:125-131`) so the file type-checks/loads without the
  package; `@anthropic-ai/claude-agent-sdk` is an **optionalDependency** (`package.json:25-27`), not a hard dep.

**4. stream-json → bus.**
- `system_init`/`assistant`/`result` reach the bus + capture ✔ (`lifecycle.ts:148-168` publishes each;
  tested `lifecycle.test.ts:25-58`). `tool_result` is published when emitted (`:159-161`).
- **Minor loss:** `SdkSessionDriver.mapMessage` (`:208-247`) maps `system`/`assistant`/`result` but returns
  `null` for standalone `tool_result`/`user`/partial messages (documented `:245`). Tool results are only
  surfaced when embedded as the fake's separate `tool_result` event; from the **real** SDK, tool_result
  blocks arrive inside `user`/`tool` messages that the mapper drops, so `stream.tool_result` may not fire in
  production. Partials (`includePartialMessages`) are explicitly deferred. Both are documented carry-forwards,
  not regressions — flagging so "every event reaches the bus" is understood as *every modeled* event.
  (Recommend a Phase-2 follow-up to map real SDK tool_result, or confirm it rides `assistant.toolUses`.)

**5. Additive / no-cutover.**
- No session auto-starts by default ✔ — precedence session>echo>log (`index.ts:113-147`); default branch
  just logs inbound. `--session`/`SUPERVISOR_SESSION=1` is strictly opt-in (`:59, 114`).
- Production poller/token never touched ✔ — `resolveTransport` feeds the **pure** `resolveTransportDecision`
  which sees only `--live` + the **dedicated** `SUPERVISOR_TELEGRAM_TOKEN`, never `TELEGRAM_BOT_TOKEN`
  (`transport-policy.ts` + `index.ts:178-189`); `config.ts` deliberately exposes **no** production-token
  accessor (`:114-121`). Loopback is the default; live refuses without the dedicated token.

**6. Secret hygiene / coverage / naming / dead code / file sizes / TS strictness.**
- Secret hygiene ✔ — `config` returns only `productionTokenFilePresent` (boolean); no secret logged/serialized;
  three config tests assert the secret never appears in `JSON.stringify(cfg)` (`config.test.ts:13-59`).
  Permission `code` is logged but it is an ephemeral approval nonce, not a secret.
- **Test coverage of the router security surface — adequate EXCEPT the H1 case.** Covered: deny-precedence,
  wildcard non-match, timeout→fail-safe-deny, send-fail→deny, route→allow/deny, allow-listed-not-routed,
  fallback modes, crash→restart-with-resume, clean-stop, **bounded crash-loop**, session-id capture, SDK
  mapping + canUseTool adaptation + resume/systemPrompt pass-through. **Missing:** (a) a **spoofed/unauthorized
  reply** test — a *different* user (or non-recipient) submitting `allow <code>` should be **rejected**; today
  no test exercises >1 user, and the behavior it would document is itself the H1 bug; (b) a turn-**hang**
  test (H2). Add both (the first must be added *with* the H1 fix).
- Naming ✔ — N1 conventions honored (PascalCase classes, camelCase methods, UPPER_SNAKE consts).
- Dead code — `interrupt()` (H2/L1); otherwise lean (no TODO/FIXME/HACK; no `any`/`as any`/`eslint-disable`
  in the Phase-2 src).
- **File sizes ✔ all < 500 LOC** — `session-driver.ts` 157, `sdk-session-driver.ts` 268, `lifecycle.ts` 208,
  `permission-router.ts` 145, `channel-permission.ts` 120, `session-host.ts` 169. No C4 flag.
- TS strictness ✔ — discriminated unions for `SessionEvent`/`PermissionDecision`; no `any`; defensive
  `unknown`→narrow in the SDK mapper; `Record<string, unknown>` for loose SDK fields, validated at runtime.

---

## Recommended action before commit/merge

1. **H1** — bind the permission reply to the routed operator (and stop trailing `operator` on every inbound),
   OR record single-operator-only as an explicit, named WIP constraint *and* make `submitReply` reject a
   non-recipient reply (fail-safe) rather than silently accept any allow-listed user's. Add the
   spoofed-reply test.
2. **H2** — wire a hang watchdog using the already-present `interrupt()`, or delete the unused `interrupt()`
   bodies and ticket hang-recovery for Phase 3.
3. **M1/M2** — remove or fail-loud the `fallback:'allow'` bypass; lift the permission policy into config.
   Both should precede any live-token run; neither blocks an additive, loopback-default Phase-2 commit.
4. M3/M4 + Lows are cleanup; safe to defer.

Given the additive, loopback-default, opt-in-`--session` posture and 95/95 green tests, the branch is **safe
to commit** as Phase-2 work-in-progress; H1 (and the spoofed-reply test) should be closed before the
allow-list is ever expanded beyond one user or a group, and before the Phase-3 production cut-over.
