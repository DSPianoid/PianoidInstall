# Recovery

Correct copies of CLAUDE.md, for restoring after the 2026-06-14 incident where the
machine-global `~/.claude/CLAUDE.md` was reset to default following an "unexpected EOF"
error on orchestrator start (after a `git pull` + VS Code/orchestrator restart).

## Restore the GLOBAL user-level instructions
Copy `recovery/global-CLAUDE.md` to your machine-global Claude config, then reload VS Code:
- Windows: `C:\Users\<you>\.claude\CLAUDE.md`
- Linux/Mac: `~/.claude/CLAUDE.md`

This file is the exact content verified live + working on the primary machine on 2026-06-14.

## Project CLAUDE.md files (already tracked in the repo)
`.claude/CLAUDE.md` (project) and `.claude/CLAUDE.generic.md` (generic methodology, @-imported
by the project file) are versioned. If they look wrong, restore them from origin:

    git checkout origin/master -- .claude/CLAUDE.md .claude/CLAUDE.generic.md
