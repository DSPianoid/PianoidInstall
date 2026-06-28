# SESSION HANDOFF — 2026-06-17 (orchestrator, pre-reload)

## Why this exists
The Telegram plugin (bun bot + MCP) disconnected mid-session; the orchestrator went
**outbound-only** via the Bot API (curl; token in `~/.claude/channels/telegram/.env`,
chat_id `178036990`). A **VS Code reload** (to restore Telegram two-way) will restart the
orchestrator. This note lets the next orchestrator pick up seamlessly. The authoritative
artifact is the architecture review (linked below) + this file.

## Session arc (2026-06-17)
1. Orchestrator started; controller `ctrl-e558` spawned.
2. **Audit** of the M12 test-dialog self-diagnoses (read-only) — 9 problems: 2 fixed / 3 partial / 4 open.
3. **Pull + rebuild** PianoidCore/Tunner/Basic (user request) — DONE: clean fast-forward pulls =
   the `dev-excenergy` "physics-based excitation energy (B2)" feature; `--heavy --both` rebuild
   SUCCESS; L2 smoke PASS; stack left running on the fresh build. (First agent wedged on spawn →
   replaced with a non-team agent.) FF pull = nothing to push. **Bookkeeping cleanup DEFERRED**:
   `upd-rebuild`'s MODULE_LOCKS rows (Core/Basic/Tunner) + WIP row + log
   (`logs/upd-rebuild-2026-06-17-070010.md`) are still registered — clean up at wrap.
4. **M12 debugging** (user: "pick up debugging") — dev-m12p3a RESUMED (reused ID + log). Closed the
   audit's open items: #1 stale-answer `d5056cf` (live re-test PASS), #5 inbound-drop `8bb5f74`,
   #8 heartbeat `e946c44` + #5×#8 `7745cc0` + edge docs `30a5868`, #2 worktree isolation `80380c2`
   (live-verified). 191/191.
5. **User real-channel test found LOST MESSAGES** → diagnosed 2 regressions from #1/#5 misfiring
   under real long-turn timing (84s-think → empty outbound; 60s no-deadlock → dropped inbound).
   Fixed: `c30ad11` (activity-gate the destructive timeouts), 194/194, **live self-verify PASS**
   under real Opus timing. + `d1ab619` (docs/log).
6. **USER PIVOT**: "this is a simple task; the architecture is overcomplicated; review deeply." →
   commissioned a deep architecture review.
7. **Architecture review DONE** → `docs/development/reviews/m12-supervisor-architecture-review-2026-06-17.md`.

## THE PENDING DECISION (resolve with the user first)
Review recommendation (strong, evidence-based): **replace the PTY/TUI-screen-scraping I/O driver with
the structured SDK driver** (Option A — already built+tested+live-validated this session), **+ keep a
`claude -p --output-format stream-json` driver as a hedge** (Option B) behind the existing
`SessionDriver` seam. Retire the PTY trio (`pty-session-driver`, `pty-grid`, `pty-render-parser`) +
~47 render-heuristic tests.
- **Linchpin**: the premise that forced PTY ("SDK forces API billing → must scrape the TUI for
  subscription") is FALSE. Verified 4 ways that BOTH the SDK `query()` AND `claude -p
  --output-format stream-json` run on the **subscription** today (`~/.claude.json` billingType
  `stripe_subscription`, no API key; `claude -p` `apiKeySource:"none"`; SDK official subscription
  support; the June-2026 billing split is PAUSED). Caveat: paused ≠ cancelled → hence the `-p` hedge.
- ~9 of 26 debug iterations were the same defect class (scraping a human TUI for machine state).
- Reuse: ~144/191 tests + all 10 driver-agnostic modules unchanged; ONE driver construction site
  (`index.ts`) = low blast radius.
- Counter-case: `c30ad11` DOES make the PTY path work (verified PASS) → "keep + merge the patched
  PTY" is a viable-but-churny fallback if the user prefers no rewrite.

**USER CHOOSES**: (a) approve the pivot — build SDK-driver default + `-p` hedge, retire scraping
(RECOMMENDED); or (b) keep + merge the patched PTY (`c30ad11`). Pushed to the user via the Bot API;
awaiting their reply (needs the reload for inbound).

## Current state
- **dev-m12p3a**: HELD (post-verify hold), standing by to build the chosen architecture. Branch
  `feature/m12-supervisor-phase3a`; commits d5056cf/8bb5f74/e946c44/7745cc0/f20d025/30a5868/80380c2/
  c30ad11/d1ab619; 194/194; NOT merged; holds lock `tools/supervisor/**`. `c30ad11` = the real-timing
  fix (committed-unmerged-annotated HELD).
- **controller**: `ctrl-e558`, alive (read-only monitor).
- **upd-rebuild**: returned (done); bookkeeping cleanup deferred (§3).
- **Telegram**: bun bot + MCP DOWN; outbound-only via curl. Reload restores two-way.
- **Pianoid stack**: was up on the fresh build (3000/3001/5000); M12 test supervisor (8790) down.
- **Merge**: HELD (M12 not merged; awaits the architecture decision).

## On restart (next orchestrator)
1. Run Step 0/1/1.5/1.7 normally; you'll find dev-m12p3a held + the review doc + upd-rebuild's stale
   bookkeeping.
2. Telegram is back after the reload; greet the user. The pending item is the **architecture pivot
   decision** above — read the review doc, present (a) vs (b), get their call.
3. If (a): dev-m12p3a builds the SDK-driver default + `-p` hedge (reuse the seam; retire the PTY
   trio). If (b): merge `c30ad11`.
4. Then clean up `upd-rebuild` bookkeeping + do the M12 Phase-2 wrap once a direction is approved.
