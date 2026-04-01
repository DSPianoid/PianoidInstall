---
name: project-management
description: Manage projects — create, track, update from email/WhatsApp, identify actions, sync to GitHub.
user-invocable: true
argument-hint: [list|new|show|update|actions|sync|archive] <name>
---

# Project Management

Manage projects stored in `~/.claude/projects/C--Users-astri/memory/projects/`. Each project is a folder with two files and optional attachments.

Parse `$ARGUMENTS` to determine the subcommand and project name.

## Subcommands

| Command | Usage |
|---------|-------|
| `list` | List all projects with status |
| `new <name>` | Create project from template |
| `show <name>` | Display project summary |
| `update <name>` | Scan email + WhatsApp for new messages |
| `actions <name>` | Identify action items, draft responses |
| `sync` | Push all projects to GitHub |
| `archive <name>` | Mark project as archived |

If `$ARGUMENTS` is empty, show this table and ask what to do.

---

## Project Structure

```
projects/<project-name>/
  project.md       # Summary, contacts, goals, timeline
  actions.md       # Action plan, updates log, pending items
  attachments/     # Small local files only (bulky files → Google Drive)
```

### `project.md` Template

```markdown
# <Project Name>

**Status:** Planning | Active | On Hold | Completed | Archived
**Created:** YYYY-MM-DD
**Last Updated:** YYYY-MM-DD
**Last Scan:** YYYY-MM-DDTHH:MM:SS

## Summary

Brief description. Current state.

## Contacts

| Name | Role | Phone | Email | Gmail | WA |
|------|------|-------|-------|-------|----|

> Phone: country code, no symbols (e.g. 1234567890)
> Email: Hostinger address (if any)
> Gmail: Gmail address (if any)
> WA: personal | work | both | —
> Role: Client, Partner, Vendor, Team, etc.

## Goals & Rules

- ...

### Timeline

| Milestone | Target | Status |
|-----------|--------|--------|

### Drive

Link to Google Drive folder for bulky attachments (if created).
```

### `actions.md` Template

```markdown
# <Project Name> — Actions

## Action Plan

- [ ] Task 1
- [ ] Task 2

## Deferred / Calendar

Items posted to Google Calendar:
| Action | Date | Calendar Event |
|--------|------|----------------|

## Updates

### YYYY-MM-DD
- Source: Email/WhatsApp/Manual
- Summary
```

---

## Command: `list`

1. Read all `projects/*/project.md` files
2. Extract project name, status, last updated
3. Display as table with status indicators:
   - `●` Active, `◐` On Hold, `○` Planning, `✓` Completed, `▪` Archived

---

## Command: `new <name>`

1. Sanitize name to lowercase-kebab-case
2. Create folder: `~/.claude/projects/C--Users-astri/memory/projects/<name>/`
3. Write `project.md` and `actions.md` from templates above, filling in today's date
4. Ask user for initial summary, contacts, and goals
5. Confirm creation

---

## Command: `show <name>`

1. Read `project.md` and display it
2. Show count of open action items from `actions.md`
3. Include ASCII infographic in summary if data supports it (progress bars, status charts)

---

## Command: `update <name>`

Scan all communication channels for new messages related to this project.

### Steps

1. Read `project.md` — extract contacts table and `Last Scan` timestamp
2. Set `since` = Last Scan value (ISO-8601)

### For each contact:

**Hostinger Email** (if contact has Email):
- `mcp__hostinger-email__search_by_sender(sender=<email>, startDate=<since>)`
- `mcp__hostinger-email__search_by_recipient(recipient=<email>, startDate=<since>)`

**Gmail** (if contact has Gmail):
- Use Google Workspace Gmail tools to search for messages from/to the Gmail address since `<since>`

**WhatsApp** (if contact has Phone + WA account):
- Personal (`mcp__whatsapp__list_messages`): `after=<since>, sender_phone_number=<phone>`
- Work (`mcp__whatsapp-work__list_messages`): `after=<since>, sender_phone_number=<phone>`
- Use the WA column to decide which account(s) to search

### After scanning:

3. For each channel, run searches in parallel where possible
4. Summarize findings concisely — group by contact, then by channel
5. Append summary to `## Updates` in `actions.md` under today's date header
6. Update `Last Scan` in `project.md` to current ISO-8601 timestamp
7. Update `Last Updated` to today's date
8. If summary section benefits from it, add/update ASCII infographic (progress bars, counters)

### Semantic search (optional):

If the project has keywords or topics in Goals & Rules, also run:
- `mcp__hostinger-email__search_by_subject(subject=<keyword>, startDate=<since>)`
- `mcp__hostinger-email__search_by_body(text=<keyword>, startDate=<since>)`
- WhatsApp `list_messages(query=<keyword>, after=<since>)`

---

## Command: `actions <name>`

1. Read both `project.md` and `actions.md`
2. Analyze recent updates for:
   - Unanswered questions or requests
   - Approaching deadlines (cross-ref with Timeline)
   - Commitments made that need follow-up
   - Blocked items in Action Plan
3. Output:
   - **Actionable items** — numbered list with priority
   - **Suggested next steps** — what to do about each
   - **Draft messages** — ready-to-send email or WhatsApp drafts (show recipient, channel, message text)
4. Ask user which actions to take:
   - Send drafted messages (via email/WhatsApp MCP tools)
   - Add to Google Calendar (for deferred/scheduled actions)
   - Add to Action Plan in `actions.md`
   - Dismiss

### Google Calendar integration:

When user chooses to defer an action or schedule an event:
- Use Google Workspace Calendar tools to create an event
- Record the event in `## Deferred / Calendar` table in `actions.md`

---

## Command: `sync`

1. Check if `~/claude-config` exists locally, if not: `git clone https://github.com/DSPianoid/claude-config.git ~/claude-config`
2. Copy all project folders from `~/.claude/projects/C--Users-astri/memory/projects/` to `~/claude-config/projects/`
3. Update `~/claude-config/README.md` — add/update projects section listing all projects with status
4. `cd ~/claude-config && git add projects/ README.md && git commit -m "Update projects" && git push`

---

## Command: `archive <name>`

1. Set status to `Archived` in `project.md`
2. Update `Last Updated`
3. Confirm to user

---

## General Rules

- **Concise:** Prefer tables and bullets over prose. Summaries should be scannable.
- **Minimal files:** Two files per project (`project.md` + `actions.md`). No extras unless needed.
- **Infographics:** Add ASCII progress bars, status charts, or diagrams in Summary when data supports it. Examples:
  ```
  Progress: [████████░░] 80%
  Budget:   [██████░░░░] 60%  ($12k / $20k)
  ```
- **Incremental scans:** Always use `Last Scan` timestamp — never re-process old messages.
- **Google Drive:** For large attachments (images, PDFs, videos), upload to Google Drive and link in project.md under `### Drive` section. Keep `attachments/` for small local files only.
- **Google Calendar:** Post deferred actions and scheduled events to Google Calendar. Track them in `actions.md` under `## Deferred / Calendar`.
- **Dual mailbox:** Always check BOTH Hostinger email AND Gmail for each contact that has addresses in both.
- **Draft before send:** Never send messages without explicit user approval. Always show drafts first.
