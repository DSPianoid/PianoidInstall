/**
 * CHANNEL PERMISSION — the bridge that lets the PermissionRouter route a
 * safety-floor decision out over the M10 channel and BLOCK on the user's reply.
 *
 * This is the supervisor-side glue the router depends on (the router holds a
 * `PermissionChannel`; this is the production impl). Flow:
 *   1. `askUser(req)` mints a short code, sends an outbound prompt over the
 *      channel ("🔐 Allow <tool>? reply: allow <code> / deny <code>"), and
 *      registers a one-shot waiter keyed by the code; returns a Promise.
 *   2. When the user replies, the supervisor's inbound parser recognizes a
 *      permission reply (`allow <code>` / `deny <code>`) and calls
 *      `submitReply(code, verdict)`, which resolves the waiter.
 *   3. If no reply arrives within `timeoutMs`, the waiter resolves to 'timeout'
 *      (the router maps that to a fail-safe deny).
 *
 * This mirrors the plugin's `y/n xxxxx` permission-reply convention, but the
 * decision is now OWNED by the supervisor (no terminal prompt to be invisible).
 *
 * Concern (P2): the prompt-out + await-reply round-trip ONLY. It does not decide
 * policy (the router does) and does not parse raw inbound (the supervisor routes
 * a recognized reply here).
 *
 * Traces: proposal PART E Phase 2 deliverable 2 (route safety-floor over the
 * channel + block on reply) + PART A FC-1.
 */

import { randomBytes } from 'node:crypto';
import type { ReplyHandle } from './contract.js';
import type { PermissionChannel } from './permission-router.js';
import type { PermissionRequest } from './session-driver.js';

/** A pending permission ask awaiting the user's reply. */
interface Waiter {
  resolve: (verdict: 'allow' | 'deny' | 'timeout') => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
}

/** How the channel sends the outbound prompt (the supervisor's sendOutbound, bound). */
export type SendPrompt = (handle: ReplyHandle, text: string) => Promise<unknown>;

export interface ChannelPermissionOptions {
  /** Send an outbound message over the channel (bound supervisor.sendOutbound). */
  send: SendPrompt;
  /** The reply handle to address permission prompts to (the operator's chat). */
  operator: ReplyHandle;
  /** Reply window in ms before a fail-safe timeout→deny. Default 300000 (5 min). */
  timeoutMs?: number;
  /** Optional log callback (never receives secrets). */
  onAsk?: (note: string, fields: Record<string, unknown>) => void;
}

export class ChannelPermission implements PermissionChannel {
  private readonly opts: ChannelPermissionOptions;
  private readonly timeoutMs: number;
  private readonly waiters = new Map<string, Waiter>();

  constructor(opts: ChannelPermissionOptions) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  /** Ask the user; resolves with their verdict or 'timeout'. (PermissionChannel) */
  askUser(req: PermissionRequest): Promise<'allow' | 'deny' | 'timeout'> {
    const code = randomBytes(2).toString('hex'); // 4 hex chars
    const prompt =
      `🔐 Approve tool '${req.toolName}'?\n` +
      `Reply: allow ${code}   (or)   deny ${code}\n` +
      `(no reply in ${Math.round(this.timeoutMs / 1000)}s → denied)`;
    this.opts.onAsk?.('permission prompt sent', { tool: req.toolName, code });

    return new Promise<'allow' | 'deny' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(code);
        resolve('timeout');
      }, this.timeoutMs);
      // unref so a pending prompt never keeps the process alive on its own.
      if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
      this.waiters.set(code, { resolve, timer, toolName: req.toolName });
      // Fire the outbound; if it fails, deny immediately (can't ask → fail-safe).
      void this.opts.send(this.opts.operator, prompt).catch((err) => {
        const w = this.waiters.get(code);
        if (w) {
          clearTimeout(w.timer);
          this.waiters.delete(code);
          this.opts.onAsk?.('permission prompt send failed → deny', { tool: req.toolName, err: String(err) });
          resolve('timeout');
        }
      });
    });
  }

  /**
   * Resolve a pending ask from a recognized inbound reply. Returns true if the
   * code matched a pending waiter. Called by the supervisor's inbound parser.
   */
  submitReply(code: string, verdict: 'allow' | 'deny'): boolean {
    const w = this.waiters.get(code);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(code);
    this.opts.onAsk?.('permission reply received', { code, verdict, tool: w.toolName });
    w.resolve(verdict);
    return true;
  }

  /**
   * Resolve the SINGLE pending ask from a bare verdict (no code). This is the UX
   * affordance the live demo surfaced: a user naturally replies "deny" (not
   * "deny 55c3"). Only valid when EXACTLY ONE ask is pending — with 0 there is
   * nothing to answer, and with >1 the bare reply is ambiguous (the coded form is
   * required to disambiguate). Returns true if it resolved the single pending ask.
   */
  submitBareReply(verdict: 'allow' | 'deny'): boolean {
    if (this.waiters.size !== 1) return false;
    const [code, w] = [...this.waiters.entries()][0]!;
    clearTimeout(w.timer);
    this.waiters.delete(code);
    this.opts.onAsk?.('permission bare-reply received', { code, verdict, tool: w.toolName });
    w.resolve(verdict);
    return true;
  }

  /** Count of pending asks (for health). */
  get pendingCount(): number {
    return this.waiters.size;
  }

  /** Parse an inbound text for a CODED permission reply. Returns code+verdict or null. */
  static parseReply(text: string): { code: string; verdict: 'allow' | 'deny' } | null {
    const m = /^\s*(allow|deny|y|n|yes|no)\s+([0-9a-f]{4})\s*$/i.exec(text);
    if (!m) return null;
    return { code: m[2]!.toLowerCase(), verdict: ChannelPermission.wordToVerdict(m[1]!) };
  }

  /**
   * Parse an inbound text for a BARE permission verdict (no code) — "allow",
   * "deny", "y", "n", "yes", "no" (case-insensitive, surrounding whitespace ok).
   * Returns the verdict or null. The caller only applies this when exactly one
   * ask is pending (see `submitBareReply`).
   */
  static parseBareReply(text: string): { verdict: 'allow' | 'deny' } | null {
    const m = /^\s*(allow|deny|y|n|yes|no)\s*$/i.exec(text);
    if (!m) return null;
    return { verdict: ChannelPermission.wordToVerdict(m[1]!) };
  }

  /** Map an allow/deny/y/n/yes/no word to a verdict. */
  private static wordToVerdict(word: string): 'allow' | 'deny' {
    const w = word.toLowerCase();
    return w === 'allow' || w === 'y' || w === 'yes' ? 'allow' : 'deny';
  }
}
