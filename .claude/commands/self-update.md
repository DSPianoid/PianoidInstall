---
name: self-update
description: Pull latest config from GitHub, install/update skills and MCP servers.
user-invocable: true
argument-hint: [all|skills|mcp|memory]
---

# Self-Update

Pull from `https://github.com/DSPianoid/claude-config` and sync skills, MCP servers, and memory files to the local machine.

Parse `$ARGUMENTS` to determine scope: `all` (default if empty), `skills`, `mcp`, or `memory`.

## Config

| Item | Repo Path | Local Path |
|------|-----------|------------|
| Skills | `skills/<name>/SKILL.md` | `~/.claude/commands/<name>.md` |
| MCP templates | `mcp/<name>.json` | `~/.claude.json` → `mcpServers` |
| Memory | `memory/*.md` | `~/.claude/projects/C--Users-astri/memory/` |
| Projects | `projects/` | `~/.claude/projects/C--Users-astri/memory/projects/` |

---

## Step 1: Pull latest

```bash
cd ~/claude-config && git pull --ff-only
```

If `~/claude-config` doesn't exist:
```bash
git clone https://github.com/DSPianoid/claude-config.git ~/claude-config
```

---

## Step 2: Update Skills (if scope includes `skills` or `all`)

For each `skills/<name>/SKILL.md` in the repo:

1. Compare with `~/.claude/commands/<name>.md`
2. If the local file is missing → **install** (copy)
3. If the files differ → **update** (copy, show diff summary to user)
4. If identical → skip

```bash
for d in ~/claude-config/skills/*/; do
  name=$(basename "$d")
  repo_file="$d/SKILL.md"
  local_file=~/.claude/commands/${name}.md
  if [ ! -f "$local_file" ]; then
    echo "NEW: $name"
  elif ! diff -q "$repo_file" "$local_file" > /dev/null 2>&1; then
    echo "CHANGED: $name"
  fi
done
```

After showing the list, copy all new/changed files:
```bash
cp "$repo_file" "$local_file"
```

---

## Step 3: Update MCP Servers (if scope includes `mcp` or `all`)

For each `mcp/<name>.json` in the repo:

1. Read the repo template JSON — it may have placeholder values like `<your-client-id>`
2. Read the current `~/.claude.json` → `mcpServers.<server-name>`
3. Apply this merge logic:

### Merge Rules

- **New server** (not in local config): Add it. If it has placeholder values (strings matching `<...>`), warn the user they need to fill in credentials.
- **Existing server** — merge carefully:
  - **`command`**: Update from repo only if the local value looks like a placeholder or if the repo changed the binary/package.
  - **`args`**: Take the repo version (structural changes like new flags). This is safe because args don't contain secrets.
  - **`env`**: Merge key by key:
    - New env var in repo → add it (warn if placeholder)
    - Existing env var locally → **keep local value** (preserves real credentials)
    - Env var removed in repo → keep local (don't delete)
  - **Other keys** (e.g. `disabled`): Keep local.

### Implementation

Read `~/.claude.json` as JSON. For each server in the repo template:
1. Parse the template JSON to get server configs
2. For each server name in the template:
   - If not in local `mcpServers` → add entire block, flag placeholders
   - If in local `mcpServers`:
     - Update `args` from repo
     - For `env`: add new keys from repo, keep existing local values
     - Update `command` only if repo value is not a placeholder
3. Write back `~/.claude.json` preserving all other content

**CRITICAL:** Use `Read` then `Edit` on `~/.claude.json` — never overwrite the whole file. Parse JSON carefully, modify only `mcpServers`, preserve everything else.

After changes, list what was added/updated and remind user to reload VS Code.

---

## Step 4: Update Memory (if scope includes `memory` or `all`)

Copy memory files from repo to local:
```bash
cp ~/claude-config/memory/*.md ~/.claude/projects/C--Users-astri/memory/
```

Copy project files if any:
```bash
if [ -d ~/claude-config/projects ]; then
  cp -r ~/claude-config/projects/* ~/.claude/projects/C--Users-astri/memory/projects/ 2>/dev/null
fi
```

---

## Step 5: Ensure MkDocs (if scope includes `all`)

Check if `mkdocs` and the Material theme are installed. If not, install them:

```bash
pip show mkdocs-material > /dev/null 2>&1 || pip install mkdocs-material
```

Verify:
```bash
mkdocs --version
```

If install failed, warn the user but don't abort — MkDocs is optional for documentation browsing.

---

## Step 6: Report

Print a summary table:

```
=== Self-Update Summary ===
Skills:  2 installed, 1 updated, 3 unchanged
MCP:     0 new, 1 updated (google-workspace: added drive tool)
Memory:  3 files synced
Projects: 0 synced
MkDocs:  installed (v1.6.1, material v9.7.4)

⚠ Reload VS Code to pick up MCP changes.
```

If any MCP servers were added/changed, remind the user:
- `Ctrl+Shift+P` → "Developer: Reload Window"
- New servers with placeholders need credentials filled in `~/.claude.json`

---

## General Rules

- Never overwrite real credentials with placeholders
- Show diffs/changes before applying — don't silently overwrite
- `--ff-only` pull to avoid merge conflicts; if it fails, warn the user
- This skill itself can be updated by pulling — the new version takes effect next invocation
