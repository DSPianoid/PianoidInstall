/**
 * The assistant's notes / hand-off memory (dev-mem1, user approval 2026-10-25). The ONLY writer of the notes
 * folder: the service (the model calls save_note / update_note through the policy, the user edits / deletes in the
 * pane). The sandbox never sees it; it lives in the isolated home, never in ~/.claude (D1).
 *
 *   <root>\memory\notes\<id>.md     one note: a front-matter block (title, created, updated, kind handoff | fact,
 *                                   tainted, session, author assistant | user, pinned) then the body
 *   <root>\memory\notes\index.json  {version: 1, notes: [front-matter + bytes]} (rebuilt from the .md files when
 *                                   missing or corrupt)
 * Every write is atomic (a temp file in the same folder, then rename). Caps: BODY_MAX bytes per note, MAX_NOTES
 * notes, TOTAL_MAX bytes in all; when over, the oldest (by `updated`) non-pinned notes are pruned first. The latest
 * hand-off note is pinned (saving a new one moves the pin). lintNote() rejects obvious secrets / credentials and
 * large parameter dumps before anything is written.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../analysis/store.js';

export const NOTE_ID = /^n-\d{14}-[0-9a-f]{6}$/;
export const KINDS = ['handoff', 'fact'];
export const TITLE_MAX = 120;
export const BODY_MAX = 4096;
export const MAX_NOTES = 50;
export const TOTAL_MAX = 64 * 1024;
const MAX_NUMBERS = 200;
const INDEX = 'index.json';
const FIELDS = ['title', 'created', 'updated', 'kind', 'tainted', 'session', 'author', 'pinned'];

const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'an API key (sk-...)'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT / OAuth token'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, 'a bearer token'],
  [/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S{6,}/i, 'a credential assignment'],
];

/** A long token with upper + lower case and digits that is not words joined by _ / - (base64 / hex keys). */
const highEntropy = (text) => (text.match(/[A-Za-z0-9+/=_-]{40,}/g) || []).some((t) => /[A-Z]/.test(t) && /[a-z]/.test(t)
  && (t.match(/\d/g) || []).length >= 4 && !t.split(/[_\-/]/).every((w) => w.length <= 20));

/** Why a note may not be saved (null = fine). Applies to the model's notes and to the user's edits alike. */
export function lintNote({ title, body, kind } = {}) {
  if (typeof title !== 'string' || !title.trim()) return 'title: a non-empty string is required';
  if (title.length > TITLE_MAX) return `title: at most ${TITLE_MAX} characters`;
  if (/[\r\n]/.test(title)) return 'title: one line';
  if (typeof body !== 'string' || !body.trim()) return 'body: a non-empty string is required';
  const bytes = Buffer.byteLength(body);
  if (bytes > BODY_MAX) return `body: ${bytes} bytes, at most ${BODY_MAX}: keep notes short; keep data in a saved output (export: true) and name its id`;
  if (!KINDS.includes(kind)) return `kind: one of ${KINDS.join(', ')}`;
  const text = `${title}\n${body}`;
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return `refused: the note looks like it contains ${what}; never store secrets or credentials in notes`;
  if (highEntropy(text)) return 'refused: the note contains a long key-like token (a secret?); never store secrets or credentials in notes';
  const numbers = (body.match(/-?\d+(\.\d+)?(e[+-]?\d+)?/gi) || []).length;
  if (numbers > MAX_NUMBERS) return `refused: ${numbers} numbers look like a parameter dump; keep values in a saved output (export: true) and note its id`;
  return null;
}

/** Atomic write: temp file in the same folder + rename over the target. */
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** `---\nkey: <JSON value>\n...\n---\n<body>` (values JSON-encoded: one line each, no YAML parser needed). */
export function serialize(note) {
  return `---\n${FIELDS.map((k) => `${k}: ${JSON.stringify(note[k] ?? null)}`).join('\n')}\n---\n${note.body}`;
}

export function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(String(text).replace(/\r\n/g, '\n'));
  if (!m) return null;
  const front = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+): (.*)$/.exec(line);
    if (!kv || !FIELDS.includes(kv[1])) continue;
    try { front[kv[1]] = JSON.parse(kv[2]); } catch (e) { return null; }
  }
  if (typeof front.title !== 'string' || !KINDS.includes(front.kind) || typeof front.created !== 'string') return null;
  return { ...front, tainted: front.tainted !== false, pinned: front.pinned === true, body: m[2] };
}

const summary = ({ body, ...n }) => ({ ...n, bytes: Buffer.byteLength(body) });

export class NotesStore {
  /** `dir` null = disabled (no assistant home): every call answers "no notes". */
  constructor({ dir, now = () => new Date() } = {}) {
    Object.assign(this, { dir, now });
  }

  file(id) { return path.join(this.dir, `${id}.md`); }

  /** Every note in full (front-matter + body), newest `updated` first; a corrupt .md is skipped. */
  all() {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    const notes = [];
    for (const name of fs.readdirSync(this.dir)) {
      const id = name.slice(0, -3);
      if (!name.endsWith('.md') || !NOTE_ID.test(id)) continue;
      let note = null;
      try { note = parse(fs.readFileSync(this.file(id), 'utf8')); } catch (e) { /* unreadable: skipped */ }
      if (note) notes.push({ id, ...note });
    }
    return notes.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? 1 : -1));
  }

  /** The index (summaries, newest first): index.json, rebuilt from the files when missing / corrupt / stale. */
  list() {
    if (!this.dir) return [];
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(this.dir, INDEX), 'utf8'));
      if (idx?.version === 1 && Array.isArray(idx.notes) && idx.notes.every((n) => NOTE_ID.test(n.id) && fs.existsSync(this.file(n.id)))) return idx.notes;
    } catch (e) { /* rebuilt below */ }
    return this.writeIndex(this.all());
  }

  get(id) {
    if (!this.dir || !NOTE_ID.test(String(id))) return null;
    try {
      const note = parse(fs.readFileSync(this.file(id), 'utf8'));
      return note ? { id, ...note } : null;
    } catch (e) {
      return null;
    }
  }

  /** The pinned (latest) hand-off note, or null. */
  handoff() { return this.all().find((n) => n.kind === 'handoff' && n.pinned) || null; }

  writeIndex(notes) {
    const rows = notes.map(summary);
    fs.mkdirSync(this.dir, { recursive: true });
    atomicWrite(path.join(this.dir, INDEX), `${JSON.stringify({ version: 1, notes: rows }, null, 1)}\n`);
    return rows;
  }

  /** A new note. meta: {tainted, session, author}. Returns {note, pruned: [ids]} or {error}. */
  save({ title, body, kind }, { tainted = false, session = null, author = 'assistant' } = {}) {
    if (!this.dir) return { error: 'notes are not available (no assistant home)' };
    const why = lintNote({ title, body, kind });
    if (why) return { error: why };
    const at = this.now().toISOString();
    const note = { id: newId('n', this.now()), title: title.trim(), created: at, updated: at, kind, tainted: tainted === true, session, author, pinned: kind === 'handoff', body };
    fs.mkdirSync(this.dir, { recursive: true });
    if (note.pinned) this.unpinOthers(note.id);
    atomicWrite(this.file(note.id), serialize(note));
    return { note, pruned: this.enforceCaps() };
  }

  /**
   * Change a note's title and / or body. meta = who changes it: a user edit is the user's and untainted; an
   * assistant update carries the turn's taint. Returns {note} or {error}.
   */
  update(id, { title, body }, { tainted = false, session = null, author = 'assistant' } = {}) {
    const old = this.get(id);
    if (!old) return { error: `no note ${String(id).slice(0, 40)}` };
    const next = { ...old, title: typeof title === 'string' ? title.trim() : old.title, body: typeof body === 'string' ? body : old.body };
    const why = lintNote(next);
    if (why) return { error: why };
    Object.assign(next, { updated: this.now().toISOString(), tainted: author === 'user' ? false : tainted === true || old.tainted, session: session ?? old.session, author });
    atomicWrite(this.file(id), serialize(next));
    this.writeIndex(this.all());
    return { note: next };
  }

  /** Delete one note (the pane only; the model has no delete tool). */
  remove(id) {
    if (!this.get(id)) return { error: `no note ${String(id).slice(0, 40)}` };
    fs.rmSync(this.file(id), { force: true });
    this.writeIndex(this.all());
    return { ok: true };
  }

  unpinOthers(keepId) {
    for (const n of this.all()) {
      if (n.pinned && n.id !== keepId) atomicWrite(this.file(n.id), serialize({ ...n, pinned: false }));
    }
  }

  /** Prune the oldest non-pinned notes until MAX_NOTES / TOTAL_MAX hold; rewrites the index. Returns the pruned ids. */
  enforceCaps() {
    const notes = this.all();
    const pruned = [];
    let total = notes.reduce((n, x) => n + Buffer.byteLength(x.body), 0);
    for (let i = notes.length - 1; i >= 0 && (notes.length - pruned.length > MAX_NOTES || total > TOTAL_MAX); i -= 1) {
      if (notes[i].pinned) continue;
      fs.rmSync(this.file(notes[i].id), { force: true });
      total -= Buffer.byteLength(notes[i].body);
      pruned.push(notes[i].id);
    }
    this.writeIndex(notes.filter((n) => !pruned.includes(n.id)));
    return pruned;
  }
}
