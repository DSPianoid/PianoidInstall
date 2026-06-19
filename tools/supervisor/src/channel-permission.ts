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
 * PRIMARY UX = native inline-keyboard BUTTONS. `askUser` attaches a ✅ Allow / ❌
 * Deny inline keyboard whose `callback_data` encodes the decision + the code
 * (`perm:allow:<code>` / `perm:deny:<code>`). A tapped button comes back as an
 * inbound callback the supervisor parses ({@link parseCallbackData}) and resolves
 * via {@link submitReply} — then ACKs + edits the prompt to show the outcome. The
 * `allow/deny <code>` TEXT parser ({@link parseReply}/{@link parseBareReply}) is
 * kept as a backstop for clients that can't tap.
 *
 * Concern (P2): the prompt-out + await-reply round-trip ONLY. It does not decide
 * policy (the router does) and does not parse raw inbound (the supervisor routes
 * a recognized reply here).
 *
 * Traces: proposal PART E Phase 2 deliverable 2 (route safety-floor over the
 * channel + block on reply) + PART A FC-1.
 */

import { randomBytes } from 'node:crypto';
import type { InlineButton, ReplyHandle } from './contract.js';
import type { PermissionChannel } from './permission-router.js';
import type { PermissionRequest } from './session-driver.js';

/** A pending permission ask awaiting the user's reply. */
interface Waiter {
  resolve: (verdict: 'allow' | 'deny' | 'timeout') => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
  /** Id of the outbound prompt message (so a resolved ask can be edited). */
  messageId?: string;
}

/** The result of sending a prompt: the channel-native message id, if known. */
export interface SendPromptResult {
  /** Message id of the sent prompt (lets the resolver edit it to show the outcome). */
  messageId?: string;
}

/**
 * How the channel sends the outbound prompt (the supervisor's sendOutbound, bound).
 * `buttons`, when present, attach a native inline keyboard. Returns the sent
 * message id (best-effort) so a decided prompt can be edited to its outcome.
 */
export type SendPrompt = (
  handle: ReplyHandle,
  text: string,
  buttons?: InlineButton[],
) => Promise<SendPromptResult | void>;

/** Prefix for the inline-button callback_data scheme: `perm:<verdict>:<code>`. */
export const PERM_CALLBACK_PREFIX = 'perm';

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
    // PRIMARY UX: native inline buttons (tap ✅/❌). The text still spells out the
    // `allow/deny <code>` fallback for clients that can't render buttons.
    const buttons: InlineButton[] = [
      { text: '✅ Allow', callbackData: `${PERM_CALLBACK_PREFIX}:allow:${code}` },
      { text: '❌ Deny', callbackData: `${PERM_CALLBACK_PREFIX}:deny:${code}` },
    ];
    const prompt =
      `🔐 Approve tool '${req.toolName}'?\n` +
      `Tap a button below — or reply: allow ${code} / deny ${code}\n` +
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
      // Fire the outbound WITH the buttons; capture the message id so a resolved ask
      // can edit the prompt to show its outcome. If the send fails, deny immediately
      // (can't ask → fail-safe).
      void this.opts
        .send(this.opts.operator, prompt, buttons)
        .then((res) => {
          const w = this.waiters.get(code);
          // Only record the id if still pending (a fast tap could have resolved it).
          if (w && res && res.messageId) w.messageId = res.messageId;
        })
        .catch((err) => {
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
    return this.submitReplyDetailed(code, verdict).resolved;
  }

  /**
   * Like {@link submitReply} but returns the resolved ask's details — its prompt
   * `messageId` and `toolName` — so a caller (the button-tap path) can edit the
   * prompt message to show the outcome. `resolved` is false (others undefined) if
   * the code matched nothing.
   */
  submitReplyDetailed(
    code: string,
    verdict: 'allow' | 'deny',
  ): { resolved: boolean; messageId?: string; toolName?: string } {
    const w = this.waiters.get(code);
    if (!w) return { resolved: false };
    clearTimeout(w.timer);
    this.waiters.delete(code);
    this.opts.onAsk?.('permission reply received', { code, verdict, tool: w.toolName });
    w.resolve(verdict);
    return { resolved: true, ...(w.messageId ? { messageId: w.messageId } : {}), toolName: w.toolName };
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

  /** Snapshot of pending asks (code + tool) for the operator panel (no secrets). */
  pendingAsks(): { code: string; toolName: string }[] {
    return [...this.waiters.entries()].map(([code, w]) => ({ code, toolName: w.toolName }));
  }

  /**
   * Parse an inline-button tap's `callback_data` (the BUTTON path). Recognizes the
   * `perm:allow:<code>` / `perm:deny:<code>` scheme {@link askUser} mints (code =
   * 4 hex). Returns code+verdict, or null if it's not a permission callback (so a
   * sibling feature's callback_data is left alone). The whole string is ≤ 15 bytes,
   * well under Telegram's 64-byte callback_data cap.
   */
  static parseCallbackData(data: string): { code: string; verdict: 'allow' | 'deny' } | null {
    const m = new RegExp(`^${PERM_CALLBACK_PREFIX}:(allow|deny):([0-9a-f]{4})$`, 'i').exec(data.trim());
    if (!m) return null;
    return { code: m[2]!.toLowerCase(), verdict: m[1]!.toLowerCase() as 'allow' | 'deny' };
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
