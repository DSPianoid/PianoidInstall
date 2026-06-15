/**
 * The PERMISSION ROUTER — the FC-1 (invisible-prompt) eliminator.
 *
 * Every gated tool the hosted session wants to run passes through here BEFORE it
 * executes (the SDK's `canUseTool` callback, normalized via the SessionDriver
 * seam). The router decides:
 *   1. ALLOW-LIST fast-path — a tool/pattern on the policy allow-list is allowed
 *      with no prompt (the common case; zero user friction).
 *   2. DENY-LIST — a tool/pattern on the deny-list is denied with a reason.
 *   3. SAFETY FLOOR (everything else) — the decision is ROUTED OUT OVER THE
 *      CHANNEL to the user and the router BLOCKS on their reply. This is the
 *      structural fix for the dominant stall: there is no terminal prompt to be
 *      invisible — the supervisor sees the request, asks the user over Telegram,
 *      and awaits allow/deny. On timeout (no reply) it DENIES (fail-safe).
 *
 * Concern (P2): the allow/deny/route DECISION only. It does not own the channel
 * (it depends on a `PermissionChannel` the supervisor implements) and does not
 * run tools.
 *
 * Authority (P1): the router owns the policy evaluation; the supervisor owns the
 * channel round-trip. Clean split → the router is pure + unit-testable with a
 * fake channel.
 *
 * Traces: proposal PART E Phase 2 deliverable 2 + PART A FC-1 ("see+route every
 * prompt") + the safety-floor (CP7) routing mandate.
 */

import type { PermissionDecision, PermissionRequest } from './session-driver.js';

/**
 * The channel round-trip the router uses to ask a human. The supervisor
 * implements this by sending an outbound permission prompt and resolving when a
 * matching inbound reply arrives (a one-shot waiter). Returns the human's
 * verdict, or 'timeout' if none arrived in time.
 */
export interface PermissionChannel {
  /**
   * Ask the user to allow/deny `req`. Resolves with their decision, or
   * 'timeout' if no reply within the channel's window. MUST NOT throw for a
   * normal no-reply (return 'timeout'); the router maps that to deny.
   */
  askUser(req: PermissionRequest): Promise<'allow' | 'deny' | 'timeout'>;
}

export interface PermissionPolicy {
  /**
   * Tools/patterns auto-allowed with no prompt. Supports exact names and a
   * trailing `*` wildcard (e.g. 'Read', 'mcp__telegram__*'). The allow-list is
   * a SUPERVISOR POLICY (the proposal's replacement for the bypassPermissions
   * whack-a-mole), not a blanket bypass.
   */
  allow: string[];
  /** Tools/patterns always denied (takes precedence over allow). */
  deny?: string[];
  /**
   * What to do for a tool matching NEITHER list:
   *  - 'route' (default): ask the user over the channel, block on reply.
   *  - 'deny': deny without asking (a locked-down policy).
   *  - 'allow': allow without asking (a trusting policy; discouraged).
   */
  fallback?: 'route' | 'deny' | 'allow';
}

/** Match a tool name against a pattern list (exact or trailing-`*` wildcard). */
function matches(name: string, patterns: string[] | undefined): boolean {
  if (!patterns) return false;
  for (const p of patterns) {
    if (p === name) return true;
    if (p.endsWith('*') && name.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

export class PermissionRouter {
  private readonly policy: PermissionPolicy;
  private readonly channel: PermissionChannel;
  /** Optional log callback (never receives secrets). */
  private readonly onDecision?: (note: string, fields: Record<string, unknown>) => void;

  /** Counters for observability/health. */
  private stats = { allowed: 0, denied: 0, routed: 0, timedOut: 0 };

  constructor(opts: {
    policy: PermissionPolicy;
    channel: PermissionChannel;
    onDecision?: (note: string, fields: Record<string, unknown>) => void;
  }) {
    this.policy = opts.policy;
    this.channel = opts.channel;
    this.onDecision = opts.onDecision;
    // M1 — fail-LOUD on the discouraged allow-fallback. Auto-allowing every
    // ungated tool defeats the safety floor (the whole point of the router); if a
    // policy ships with fallback:'allow' we surface it unmistakably at construction
    // (and again on every firing in decide()), so it can never pass silently.
    if (this.policy.fallback === 'allow') {
      this.onDecision?.(
        '⚠️ DANGER: permission policy fallback=ALLOW — every ungated tool is auto-allowed with NO user approval (safety floor DISABLED). This is discouraged; prefer fallback=route.',
        { fallback: 'allow' },
      );
    }
  }

  /**
   * Decide a permission request. This IS the `PermissionHandler` the
   * SessionDriver calls; bind it as `router.decide`.
   */
  decide = async (req: PermissionRequest): Promise<PermissionDecision> => {
    // Deny-list wins.
    if (matches(req.toolName, this.policy.deny)) {
      this.stats.denied++;
      this.onDecision?.('permission: deny (deny-list)', { tool: req.toolName });
      return { behavior: 'deny', message: `Tool '${req.toolName}' is denied by policy.` };
    }
    // Allow-list fast-path.
    if (matches(req.toolName, this.policy.allow)) {
      this.stats.allowed++;
      this.onDecision?.('permission: allow (allow-list)', { tool: req.toolName });
      return { behavior: 'allow' };
    }
    // Safety floor: route to the user (or apply the configured fallback).
    const fallback = this.policy.fallback ?? 'route';
    if (fallback === 'allow') {
      this.stats.allowed++;
      // M1 — fail-LOUD: an auto-allow of an UNGATED tool is a safety-relevant
      // event; log it at a level that stands out (never silent).
      this.onDecision?.('⚠️ permission: AUTO-ALLOW ungated tool (fallback=allow, no user approval)', { tool: req.toolName });
      return { behavior: 'allow' };
    }
    if (fallback === 'deny') {
      this.stats.denied++;
      this.onDecision?.('permission: deny (fallback)', { tool: req.toolName });
      return { behavior: 'deny', message: `Tool '${req.toolName}' requires approval; denied by policy.` };
    }
    // fallback === 'route' → ask the user, BLOCK on reply.
    this.stats.routed++;
    this.onDecision?.('permission: routing to user', { tool: req.toolName });
    const verdict = await this.channel.askUser(req);
    if (verdict === 'allow') {
      this.stats.allowed++;
      this.onDecision?.('permission: allow (user)', { tool: req.toolName });
      return { behavior: 'allow' };
    }
    if (verdict === 'timeout') {
      this.stats.timedOut++;
      this.onDecision?.('permission: deny (no reply / timeout)', { tool: req.toolName });
      return { behavior: 'deny', message: `No approval received for '${req.toolName}' in time; denied (fail-safe).` };
    }
    this.stats.denied++;
    this.onDecision?.('permission: deny (user)', { tool: req.toolName });
    return { behavior: 'deny', message: `User denied '${req.toolName}'.` };
  };

  /** Decision counters (for health/observability). */
  getStats(): Readonly<typeof this.stats> {
    return { ...this.stats };
  }
}
