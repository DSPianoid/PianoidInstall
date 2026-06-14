# Recovery

Correct copies of CLAUDE.md, for restoring after the 2026-06-14 incident where the
machine-global `~/.claude/CLAUDE.md` was reset to default following an "unexpected EOF"
error on orchestrator start (after a `git pull` + VS Code/orchestrator restart).

## Restore the GLOBAL user-level instructions
Copy `recovery/global-CLAUDE.md` to your machine-global Claude config, then reload VS Code:
- Windows: `C:\Users\<you>\.claude\CLAUDE.md`
- Linux/Mac: `~/.claude/CLAUDE.md`

This file is the exact content verified live + working on the primary machine on 2026-06-14.

## Project CLAUDE.md (tracked in the repo)
`.claude/CLAUDE.md` is the self-contained Pianoid project instructions (versioned). The generic
methodology now lives MACHINE-GLOBAL at `~/.claude/CLAUDE.md`, distributed via `~/claude-config` +
`/self-update` (not in this repo). If the project file looks wrong, restore it from origin:

    git checkout origin/master -- .claude/CLAUDE.md
