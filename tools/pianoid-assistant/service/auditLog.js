/**
 * The assistant's on-disk audit log (dev-auto1): an append-only JSONL file of every tool call, policy decision,
 * confirm answer, result and setting change (the activity entries + their updates), so an Autonomous-mode
 * session stays reviewable after the service restarts (the pane's activity list is in memory, last 200).
 *
 *   <root>\audit\audit.jsonl          the current file (one JSON object per line: {ts, event, ...fields})
 *   <root>\audit\audit.<n>.jsonl      rotated files, 1 = newest; a file is rotated when it would pass
 *                                     `maxBytes` (5 MB), `keep` (5) rotated files are kept, older ones deleted
 * Only the session writes it (the activity owner). A write failure never blocks a tool call: it is counted and
 * the first error is kept (`lastError`) for the pane.
 */
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_FILE = 'audit.jsonl';
export const MAX_BYTES = 5 * 1024 * 1024;
export const KEEP = 5;

export class AuditLog {
  /** `dir` null = disabled (no assistant home, e.g. unit tests without one). */
  constructor({ dir, maxBytes = MAX_BYTES, keep = KEEP, now = () => new Date() } = {}) {
    Object.assign(this, { dir, maxBytes, keep, now });
    this.file = dir ? path.join(dir, AUDIT_FILE) : null;
    this.size = null;
    this.failures = 0;
    this.lastError = null;
  }

  rotated(n) { return path.join(this.dir, `audit.${n}.jsonl`); }

  rotate() {
    fs.rmSync(this.rotated(this.keep), { force: true });
    for (let n = this.keep - 1; n >= 1; n -= 1) {
      if (fs.existsSync(this.rotated(n))) fs.renameSync(this.rotated(n), this.rotated(n + 1));
    }
    fs.renameSync(this.file, this.rotated(1));
    this.size = 0;
  }

  /** Append one record ({ts, event, ...fields}); returns true when written. */
  write(event, fields = {}) {
    if (!this.file) return false;
    try {
      const line = `${JSON.stringify({ ts: this.now().toISOString(), event, ...fields })}\n`;
      if (this.size === null) {
        fs.mkdirSync(this.dir, { recursive: true });
        this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      }
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line);
      this.size += bytes;
      return true;
    } catch (e) {
      this.failures += 1;
      this.lastError = this.lastError || e.message;
      this.size = null;                      // re-stat on the next write
      return false;
    }
  }
}
