# OpenAI Gate Proposal — Claude Code → OpenAI Services

**Status:** draft / awaiting decisions
**Author:** research agent
**Date:** 2026-05-05

## 1. Problem

Claude Code agents (and the Telegram-driven `/orchestrator`) need on-demand access to OpenAI services that are *not* available natively from inside a Claude Code session:

- **Code-gen** — the user said "Codex". OpenAI's modern code-tuned models (`codex-1` reasoning model, GPT-5.2-Codex, GPT-5.5) sit behind the Responses API and are useful as a second opinion / agentic coding helper.
- **Speech-to-text (Whisper)** — currently the orchestrator transcribes Telegram voice messages with **local `faster-whisper` `small`** (`tools/transcribe_voice.py`). Hosted OpenAI Whisper would give higher accuracy on long-form / accented audio.
- **Text-to-speech (TTS)** — no path exists today. Useful for spoken Telegram replies, audio summaries, accessibility.

The gate must be **invokable as MCP tools** from within Claude Code (so the agent can call them mid-task), **API-key-aware** (no key in plaintext config files), and have **lightweight cost / safety controls** since TTS bills per character and code completions can run away.

## 2. Naming clarification — "Codex"

The user's brief said "Codex (code-gen)". To avoid confusion:

| Codex era | Status |
|-----------|--------|
| Original Codex API (`code-davinci-002`, etc., 2021–2023) | **Deprecated.** Removed long ago. |
| `codex-mini-latest` (2024–25) | **Deprecated 2026-02-12.** |
| **Modern "Codex"** = the OpenAI **Codex agentic coding product** (codex-1 / GPT-5.2-Codex / GPT-5.5 routed through the Responses API or the [Codex CLI](https://developers.openai.com/codex/) ) | **Current.** This is what we map to. |

**Recommended default code-gen model:** `gpt-5.5` for complex reasoning, `gpt-5.4-mini` for cheap iterations, `codex-1` if/when it's exposed in the API. Configurable per call.

> Confirm with the user (Q2 below) — do they specifically need the Codex CLI agent loop, or just code-quality completions from a strong model?

## 3. Recommended approach

**Build a thin custom MCP server** (Python, ~150 LOC) tailored to Pianoid's needs. Reasons:

| Option | Why not |
|--------|---------|
| `mzxrai/mcp-openai` (chat only, gpt-4o/o1 family) | Outdated model list (no GPT-5.x), chat-only, no audio. |
| `arcaputo3/mcp-server-whisper` | **Deprecated**, moved to `TJC-LP/sanzaru`. |
| `TJC-LP/sanzaru` | Full multimodal (Sora video, image, audio). 80% of features we don't need; pulls heavy deps. |
| `nakamurau1/tts-mcp` | TTS-only, Node/TypeScript. Good fallback if we want a quick win. |
| `blacktop/mcp-tts` | Multi-provider TTS in Go. Heavy and provider-mixed. |
| **Custom thin wrapper** | **Recommended.** ~150 LOC Python, three tools, exact gate semantics, env-var key, audit log. Mirrors the existing `setup-hostinger-email` pattern. |

A custom wrapper costs <1 day to build, gives us the exact "gate" semantics the user asked for, has zero unused tools cluttering the MCP surface, and stays consistent with the project's other MCP servers (`hostinger-email`, `whatsapp`, `google-workspace` are all minimal-surface wrappers).

**Fallback if the user wants to ship faster:** install `nakamurau1/tts-mcp` for TTS + `mzxrai/mcp-openai` for chat, skip Whisper (keep local). This is two off-the-shelf installs, ~10 minutes, but no gate / audit / cost cap.

## 4. Tool surface

Three tools, deliberately minimal. Tool names use the `openai_` prefix so they don't collide with the existing `mcp__hostinger-email__*` / `mcp__whatsapp__*` namespaces.

### 4.1 `openai_complete` — chat / code completion

```python
openai_complete(
    messages: list[dict],           # [{"role": "user", "content": "..."}]
    model: str = "gpt-5.4-mini",    # see allowlist below
    max_output_tokens: int = 4096,  # hard cap, gate-enforced
    temperature: float = 0.7,
    reasoning_effort: str | None = None,  # "low" | "medium" | "high" — only for o-series / GPT-5.x
    response_format: dict | None = None,  # for JSON mode
) -> dict  # {content, usage, model, finish_reason}
```

**Default model:** `gpt-5.4-mini` (cheap, capable). Override with `model="gpt-5.5"` for complex tasks.

**Allowlist (gate):** `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.2-codex`, `o3`, `codex-1` (if available). Anything else is rejected with a clear error.

### 4.2 `openai_transcribe` — Whisper STT

```python
openai_transcribe(
    audio_file_path: str,            # absolute path to local audio
    model: str = "gpt-4o-mini-transcribe",  # or "whisper-1", "gpt-4o-transcribe"
    language: str | None = None,     # ISO-639-1 hint
    prompt: str | None = None,       # vocabulary hint
    response_format: str = "text",   # "text" | "json" | "verbose_json" | "srt" | "vtt"
    timestamp_granularities: list[str] | None = None,  # ["word", "segment"]
) -> dict  # {text, language, duration_sec, cost_estimate_usd}
```

**Model choice:**
- **Default `gpt-4o-mini-transcribe`** — newest, ~22% lower WER than Whisper, same $0.006/min price.
- **`whisper-1`** — keep available for word-level timestamps and SRT/VTT output (the gpt-4o variants don't support those).
- **`gpt-4o-transcribe`** — heavier flagship, use for difficult / noisy audio.

**File size cap (gate):** 25 MB (OpenAI's hard limit anyway), enforced before upload.

**Language hint default:** none (auto-detect). The orchestrator can pass `language="ru"` or `"en"` for known Telegram users.

### 4.3 `openai_tts` — text-to-speech

```python
openai_tts(
    text: str,                       # input, max 4096 chars (gate-enforced)
    output_path: str,                # absolute path, .mp3 / .wav / .opus / .aac / .flac / .pcm
    voice: str = "nova",             # alloy|ash|ballad|coral|echo|fable|nova|onyx|sage|shimmer|verse|marin|cedar
    model: str = "gpt-4o-mini-tts",  # or "tts-1", "tts-1-hd"
    instructions: str | None = None, # tone / style guidance (gpt-4o-mini-tts only)
    speed: float = 1.0,              # 0.25 to 4.0
) -> dict  # {output_path, duration_sec, char_count, cost_estimate_usd}
```

**Model choice:**
- **Default `gpt-4o-mini-tts`** — supports the `instructions` parameter (tone control: "speak warmly", "sound urgent", etc.). Highest quality.
- **`tts-1`** — cheapest, fastest, no instructions support.
- **`tts-1-hd`** — older HD model, no instructions support.

**Voice default:** `nova` (warm female, neutral). User can override per call.

**Character cap (gate):** 4096 chars per call. Above that, the gate rejects rather than splitting silently — caller decides whether to chunk.

## 5. Model & cost cheat-sheet

(Sources at the bottom of this doc.)

| Service | Model | Price | Notes |
|---------|-------|-------|-------|
| Chat / code | `gpt-5.4-mini` | input ~$0.4 / 1M, output ~$1.6 / 1M | default |
| Chat / code | `gpt-5.5` | input ~$2.5 / 1M, output ~$10 / 1M | flagship |
| Code-tuned | `gpt-5.2-codex` | tbd | best on SWE-Bench |
| STT | `whisper-1` | $0.006 / min | timestamps, SRT/VTT |
| STT | `gpt-4o-mini-transcribe` | $0.006 / min | better WER, no timestamps |
| STT | `gpt-4o-transcribe` | ~$0.006 / min | flagship transcription |
| TTS | `tts-1` | $15 / 1M chars | $0.000015 / char |
| TTS | `tts-1-hd` | $30 / 1M chars | $0.00003 / char |
| TTS | `gpt-4o-mini-tts` | between tts-1 and hd | tone control |

**Worst-case daily ballpark:**
- 10 voice messages × 30 sec each = 5 min STT = **$0.03 / day**
- 10 TTS replies × 200 chars each = 2 K chars TTS = **$0.06 / day**
- 50 chat completions × 1 K input + 500 output tokens with `gpt-5.4-mini` = **$0.06 / day**

A single runaway loop calling `gpt-5.5` could blow $10+ in minutes — hence the cost gate (§ 7).

## 6. API key handling

**Storage hierarchy (most → least preferred):**

1. **OS env var `OPENAI_API_KEY`** — set once via `setx` (Windows) or `~/.bashrc` (Linux). The MCP server reads it at startup. **Recommended.**
2. **`~/.claude/secrets/openai.env`** — a chmod-600 dotenv file the wrapper sources. Useful when env vars are inconvenient.
3. **`~/.claude.json` `mcpServers.openai-gate.env.OPENAI_API_KEY`** — last resort. Plaintext in a JSON file the user already has open. **Discouraged but supported** (the existing `hostinger-email` entry stores its password this way, so we mirror the option).

The MCP wrapper checks in that order and refuses to start if no key is found.

### Example `~/.claude.json` entry (option 1, env var)

```json
"openai-gate": {
  "command": "C:\\Users\\astri\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\uv.exe",
  "args": [
    "--directory",
    "C:\\Users\\astri\\openai-gate",
    "run",
    "server.py"
  ]
}
```

(The server inherits `OPENAI_API_KEY` from the parent shell. No env block in the JSON — the key never lands in a config file.)

### Example with explicit env block (option 3, fallback)

```json
"openai-gate": {
  "command": "...",
  "args": ["..."],
  "env": {
    "OPENAI_API_KEY": "sk-...",
    "OPENAI_GATE_AUDIT_LOG": "C:\\Users\\astri\\.claude\\logs\\openai-gate.jsonl",
    "OPENAI_GATE_DAILY_USD_CAP": "5.00"
  }
}
```

## 7. Security gate — policy controls

Lightweight, all enforceable in <50 LOC. Each is independent and individually toggleable via env var.

### 7.1 Per-tool model allowlist (always on)

Hardcoded list per tool. Anything outside it is rejected with a clear error message. Prevents accidental use of a deprecated or expensive model.

### 7.2 Input size caps (always on)

- `openai_complete` — `max_output_tokens` capped at 8192 (configurable via `OPENAI_GATE_MAX_OUTPUT_TOKENS`).
- `openai_transcribe` — file size capped at 25 MB.
- `openai_tts` — text length capped at 4096 characters.

### 7.3 Daily USD cap (opt-in via `OPENAI_GATE_DAILY_USD_CAP`)

Per-day rolling cost tally written to `~/.claude/state/openai-gate-spend-YYYY-MM-DD.json`. When the day's spend exceeds the cap, all new tool calls return `{error: "daily cap exceeded"}` until the next day. The cost estimate is computed from the local pricing table and the actual `usage` returned by OpenAI.

### 7.4 Audit log (opt-in via `OPENAI_GATE_AUDIT_LOG`)

Every call appends one JSON line:

```json
{"ts": "2026-05-05T14:23:11Z", "tool": "openai_tts", "model": "gpt-4o-mini-tts",
 "input_chars": 184, "output_bytes": 8421, "cost_usd": 0.0028, "agent": "orchestrator"}
```

Useful for cost tracking and post-incident review.

### 7.5 Confirmation prompt (opt-in via `OPENAI_GATE_REQUIRE_CONFIRM`)

If set, the wrapper writes the planned call to `~/.claude/state/openai-gate-pending.json` and refuses to execute until the user touches `~/.claude/state/openai-gate-confirm` (a sentinel file). **Probably not needed** — for a single user this is friction, not safety. List it for completeness but default to off.

## 8. Coexistence with local `faster-whisper`

The orchestrator's existing voice-message handler at `tools/transcribe_voice.py` is **NOT replaced**. Both paths stay. Routing is the orchestrator's call, but the recommended rule:

| Audio | Path | Why |
|-------|------|-----|
| Telegram voice ≤ 30 sec | **Local `faster-whisper`** (current default) | Fast, free, no network, no API key. The model is already cached. |
| Telegram voice > 30 sec | Either, configurable | Local is still fine; OpenAI is more accurate on long form. |
| Long-form audio (interview, meeting) | **OpenAI `gpt-4o-mini-transcribe`** | Better WER, handles backgrounds. |
| Audio in unsupported language for `faster-whisper-small` | **OpenAI** | Whisper's full model is hosted; local `small` is limited. |
| Privacy-sensitive audio | **Local** | Never hits OpenAI servers. |

Implementation: the orchestrator script keeps calling `transcribe_voice.py` by default. A separate prompt-level decision (or an env var like `PIANOID_USE_OPENAI_STT_THRESHOLD_SEC=30`) routes the longer ones to `openai_transcribe`. **No code change required for an MVP — the agent just chooses which tool to call.**

## 9. Setup — what the user runs

### Option A — env-var key (recommended)

```bash
# 1. Set the API key once (Windows PowerShell)
setx OPENAI_API_KEY "sk-proj-..."
# Or Linux:
# echo 'export OPENAI_API_KEY="sk-proj-..."' >> ~/.bashrc && source ~/.bashrc

# 2. Install the gate (clone from this repo's claude-config)
cd ~
git clone <wherever the wrapper lives> openai-gate
cd openai-gate
uv sync

# 3. Smoke test
uv run server.py --selftest
# Expects: ✓ key loaded, ✓ chat round-trip, ✓ audio dirs writable

# 4. Add to ~/.claude.json under mcpServers
# (use the JSON in §6)

# 5. Reload VS Code
# Ctrl+Shift+P → "Developer: Reload Window" → start new chat

# 6. Verify in Claude Code
# Ask: "List the tools available from openai-gate"
# Expect: openai_complete, openai_transcribe, openai_tts
```

### Option B — drop-in community MCPs (no custom code)

```bash
# 1. Set key
setx OPENAI_API_KEY "sk-..."

# 2. Add chat-only OpenAI server
# (~/.claude.json mcpServers entry)
"openai-chat": {
  "command": "npx",
  "args": ["-y", "@mzxrai/mcp-openai@latest"]
}

# 3. Add TTS server
"openai-tts": {
  "command": "npx",
  "args": ["-y", "tts-mcp"]
}

# 4. Reload, verify
```

This skips Whisper (use the existing local script) and skips the gate / audit / cap features. **Trade simplicity now for needing to migrate later** if cost guards become important.

## 10. Skill scaffolding

If we go with **Option A (custom wrapper)**, mirror the existing pattern by adding a `setup-openai-gate` skill to `~/claude-config/skills/`:

```
claude-config/skills/setup-openai-gate/
└── SKILL.md
```

Skeleton (mirrors `setup-hostinger-email/SKILL.md`):

```markdown
---
name: setup-openai-gate
description: Set up the OpenAI gate MCP server (Codex chat, Whisper STT, TTS).
user-invocable: true
argument-hint: []
---

# OpenAI Gate MCP Setup

## Prerequisites
- Python 3.12 + uv installed
- An OpenAI API key (https://platform.openai.com/api-keys)

## Steps

### 1. Get the API key
Ask the user to paste their key. Set it via setx (Windows) or ~/.bashrc (Linux).

### 2. Clone and install the wrapper
git clone https://github.com/DSPianoid/openai-gate ~/openai-gate
cd ~/openai-gate && uv sync

### 3. Smoke test
uv run server.py --selftest

### 4. Register in ~/.claude.json
(see template below)

### 5. Reload VS Code, verify tools

### 6. Optional: enable audit + cap
Set OPENAI_GATE_AUDIT_LOG and OPENAI_GATE_DAILY_USD_CAP envs.
```

Add a template `~/claude-config/mcp/openai-gate.json` that mirrors `hostinger-email.json`:

```json
{
  "openai-gate": {
    "command": "<uv path>",
    "args": ["--directory", "~/openai-gate", "run", "server.py"]
  }
}
```

The skill is run with `/setup-openai-gate` after `/self-update`.

## 11. Open questions for the user

These need answers before implementation. Numbered for easy reply.

**Q1. Build vs install.** Do you want the **custom thin wrapper (§3 recommended)** or the **two-community-MCP shortcut (Option B in §9)**? The wrapper takes ~1 day, the shortcut takes ~10 minutes but skips Whisper + gate.

**Q2. "Codex" intent.** Did you mean "OpenAI's coding-tuned models for code completion" (mapped to `gpt-5.5` / `codex-1` / `gpt-5.2-codex` via the chat tool), or specifically "the Codex agentic CLI loop" (a separate product that runs `codex exec` and may need its own MCP integration)? The wrapper's default is the former.

**Q3. Whisper routing.** Three options:
- **(a)** Keep local `faster-whisper` as the default for everything; OpenAI Whisper only when the agent explicitly chooses.
- **(b)** Threshold-based: short clips → local, long → OpenAI (rule baked into orchestrator.md).
- **(c)** Switch fully to hosted Whisper, retire `transcribe_voice.py`.

**Q4. TTS use case.** What are you actually going to use TTS for? Knowing this changes the defaults:
- Telegram voice replies → `gpt-4o-mini-tts`, `nova`, mp3, ~150 chars typical.
- Inline doc audio / accessibility → `tts-1-hd`, `alloy`, mp3.
- Quick voice notes during dev work → `tts-1`, default voice.

**Q5. Audit logging.** Required (always on) or opt-in via env var? Default in proposal: **opt-in**.

**Q6. Cost guardrails.** Hard daily cap (calls fail past $X) or just warning logs? Default in proposal: **opt-in hard cap via `OPENAI_GATE_DAILY_USD_CAP`**.

**Q7. Project-level vs user-level.** Should the gate live at the user level (`~/.claude.json`, `~/openai-gate/`) like the other MCP servers, or in the Pianoid repo? Default in proposal: **user-level** (so it's reusable across projects, mirroring `hostinger-email`).

## 12. References

- [OpenAI Models API](https://developers.openai.com/api/docs/models/all) — current model list
- [OpenAI Pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI Audio Models announcement](https://openai.com/index/introducing-our-next-generation-audio-models/) — `gpt-4o-mini-tts`, `gpt-4o-transcribe`
- [OpenAI Codex Developers](https://developers.openai.com/codex/) — current Codex product
- [OpenAI Codex MCP](https://developers.openai.com/codex/mcp) — Codex's *own* MCP support
- [`mzxrai/mcp-openai`](https://github.com/mzxrai/mcp-openai) — reference implementation, chat-only
- [`TJC-LP/sanzaru`](https://github.com/TJC-LP/sanzaru) — successor to `arcaputo3/mcp-server-whisper`, full multimodal
- [`nakamurau1/tts-mcp`](https://github.com/nakamurau1/tts-mcp) — community TTS MCP
- [`blacktop/mcp-tts`](https://github.com/blacktop/mcp-tts) — multi-provider TTS MCP
- Local STT script: `tools/transcribe_voice.py`
- MCP-server template pattern: `~/claude-config/skills/setup-hostinger-email/SKILL.md`, `~/claude-config/mcp/hostinger-email.json`
