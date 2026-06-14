# Generic Agentic-Development Methodology (project-agnostic)

> This file holds the **reusable** dev methodology — it names no specific project. Project facts
> (build, ports, repos, venv, endpoints, frontend stack, …) live in the **active project's**
> `docs/PROJECT_CONFIG.md`, resolved per [Config resolution](#config-resolution). This file is the
> liftable core: it is `@`-imported by a project's `.claude/CLAUDE.md` now, and moves to
> `~/.claude/CLAUDE.md` (user level, every project) at the hoist step.

## Config resolution {#config-resolution}

Every generic skill operates on an **active project**. Resolve its config before using any project fact:

1. **`PROJECT_ROOT`** = the `PROJECT_ROOT` given in the dispatch brief, if present; else the repo root
   of the current working directory (the directory at/above cwd that contains a `docs/PROJECT_CONFIG.md`
   or a `.claude/` dir).
2. **Project config** = `PROJECT_ROOT/docs/PROJECT_CONFIG.md`. Read facts from its anchors
   (`#ports`, `#interpreters`, `#repos`, `#docs-first-build--run`, `#rest-endpoints`,
   `#verification-surfaces`, `#key-paths`, `#frontend-stack`, `#team`, `#channel`, `#build-holders`,
   `#rebuild-matrix`, `#doc-hierarchy`, `#defaults`, `#data-model-facts`, `#process-sweep`).
3. **If `PROJECT_CONFIG.md` is NOT found (graceful-no-config):** do NOT assume any project's facts.
   - Tell the user: *"No `docs/PROJECT_CONFIG.md` for this project — I'll use generic defaults; give me
     the build / test / run commands + repo layout, or run the project-init wizard."*
   - Fall back to **detected** generics: build = a `Makefile` target if present else none; test = the
     detected runner (`pytest`/`jest`/`go test`/`cargo test`); run = a detected start script; ports =
     none assumed; verification = "run the app and observe behaviour" (the generic verify stance).
   - Proceed with what the user supplies; offer to scaffold a minimal `PROJECT_CONFIG.md`.
   - **Never** apply one project's facts (build cmd, ports) to another when config is absent.

> Tooling: the `tools/dev-pipeline/` scripts take the active project via the `DEVKIT_PROJECT_ROOT` env
> var (back-compat alias accepted); set it to `PROJECT_ROOT` before invoking them.

## Autonomy — the three roles

1. **The coordinator coordinates; it never executes.** Receive → classify → spawn a sub-agent with a
   complete brief → relay results/decisions → repeat. Don't read source, grep, build, test, or manage
   the stack directly — that burns the context that lets the session run for hours.
2. **The sub-agent owns the COMPLETE task loop, autonomously** — env setup, reproduce, diagnose
   (measure, don't guess), implement, verify with evidence, clean up. An *operational* blocker (server
   won't start, tab needs reload, process must be killed) is resolved by the agent via the documented
   procedure — never bounced to the user.
3. **The user provides DECISIONS, APPROVALS, INFORMATION — never operations.** Never ask the user to
   start/stop servers, refresh tabs, run captures, paste logs, or drive a repro. Before relaying any
   "agent blocked" to the user, check: (a) is it a silent CLI-permission stall (route around it per
   [permission gaps](#permission-gaps))? (b) is there a documented procedure the agent should follow?

## Debugging-reproduction stance (the central "test yourself" tenet)

**When something is wrong, do NOT ask the user to test it, reproduce it, narrow it down, or paste logs.
Reproduce the user's experience EXACTLY yourself, observe the failure first-hand, and debug from that
reproduction.** This is the autonomy principle applied to failure. Enablement: the
config-resolution capability doctor (reproduce, or PROMPT the user to upgrade the env when a surface
is unreachable). Enforcement: the verification gate ([Verification-Surface Rule](#verification-surface-rule)).

## No direct skill execution (for a coordinator)

A coordinator NEVER invokes a skill via the Skill tool in its own context — that expands the skill into
the coordinator's context AND renders confirmation prompts only in the terminal (invisible to a remote
user). Always spawn a sub-agent that invokes the skill inside its own context.

## Sub-agent permission rule + known gaps {#permission-gaps}

A coordinator's sub-agents run **permission-suppressed** (every spawn passes the bypass mode) — their
prompts render only in the local CLI, invisible to a remote user, so an unallowed tool call stalls
silently. **Blanket-allow BOTH shells + the core tools** in the project allow-list (specific command
patterns are whack-a-mole). Transitive: sub-agents that spawn sub-sub-agents pass the same.

**Known gaps that gate REGARDLESS of permission mode — route around them, never relay the invisible
prompt to the user:**
- **Long-running starters** (a command that spawns detached/long-running children) — use a detached
  hidden-window process with redirected output, or the project's start API.
- **TTY-openers** (anything expecting keyboard input) — use the non-interactive equivalent, or route via
  the user's `! <command>` prefix.
- **System-PID kills** — scope by image name or kill-tree, or run in the coordinator's own context.
- **MCP re-auth flows** — relay the OAuth step to the user, then retry.

(The full failure-mode catalogue + the read-only compliance **controller** that detects stalls live in
the kit's controller spec — the project references it.)

## Auto-trigger rules

A code-change request (bug fix, feature, refactor, optimization) auto-invokes the `/dev` workflow —
don't wait to be asked, including the investigation→implementation transition. **Compiled-language
edits** (the project's compiled file types — see the project's CLAUDE.md / `PROJECT_CONFIG.md`) MUST go
through `/dev` (they need the build the workflow handles). Investigation→implementation handoff inside
`/dev`: a hypothesis drives *measurement*, never a *code edit*, until confirmed.

## Documentation-First rule

Before answering "how does X work / what shape is X / how do I run X / where is X configured" — and
ESPECIALLY when debugging — consult the project's docs BEFORE grepping/reading source. The doc hierarchy
IS the context; read it top-down (the active project's `PROJECT_CONFIG.md#doc-hierarchy`). **High-stakes
data-model facts** (axis semantics, dimension ordering, index conventions, stored-vs-effective, unit
ranges, same-name-different-thing) need explicit doc support or measurement-against-the-engine BEFORE an
edit — never source-inference alone (the active project's `PROJECT_CONFIG.md#data-model-facts`).

## Verification-Surface rule {#verification-surface-rule}

A change to output X is verified on the **surface that observes X**, with measured before/after evidence
— the surface you reproduce a bug on and re-observe to confirm the fix (an offline render, an HTTP 200 +
payload assertion, a screenshot diff, a benchmark delta, a golden-file compare, a recording). The
project declares its surfaces + which change-class maps to which (the active project's
`PROJECT_CONFIG.md#verification-surfaces`). Do not claim an output-affecting change works without
reproducing + re-observing on its surface.

## Documentation links

When citing docs in reports, link via the project's served docs URL (the active project's
`PROJECT_CONFIG.md` doc-server entry), not file paths.

## Self-update

Config (skills, MCP templates, memory, the generic core) syncs from a versioned config repo via the
self-update skill. When the user asks for any kind of update, use it.
