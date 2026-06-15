/**
 * The ACCESS GATE — inbound authorization policy for the Telegram adapter.
 *
 * Lifted from the plugin `server.ts` `gate()` so the adapter preserves the
 * exact security model: non-allowlisted senders are DROPPED before their
 * message is queued or delivered. Without this, the adapter would relay from
 * anyone who messages the bot — a regression vs the plugin.
 *
 * Phase-1 scope: the READ side of the gate (allowlist + group policy +
 * disabled). The plugin's *pairing* flow (minting + replying codes, mutating
 * access.json) stays with the live plugin / `/telegram:access` skill — the
 * supervisor does not mint pairings in Phase 1 (it reads access.json
 * read-only). A sender not yet paired is simply DROPPED here (the plugin will
 * still handle pairing on its own poller until Phase 3 cut-over).
 *
 * Concern (P2): the allow/drop decision ONLY. No transport, no delivery.
 * Authority (P1): read-only over access.json — the gate never writes it (the
 * live plugin owns that file).
 *
 * Traces: plugin server.ts gate()/loadAccess()/isMentioned() (lines 119-311) +
 * the orchestrator brief "Do NOT touch … the telegram plugin files".
 */

import { existsSync, readFileSync } from 'node:fs';
import type { RawInbound } from './telegram-transport.js';

export interface GroupPolicy {
  requireMention: boolean;
  allowFrom: string[];
}

export interface AccessConfig {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  mentionPatterns?: string[];
}

export type GateDecision = 'deliver' | 'drop';

/** A default that denies everything (safe when access.json is absent/corrupt). */
function emptyAccess(): AccessConfig {
  return { dmPolicy: 'disabled', allowFrom: [], groups: {} };
}

export class AccessGate {
  private readonly accessFile?: string;
  /** Static config override (used by tests + when reading the live file is undesired). */
  private readonly staticConfig?: AccessConfig;
  /** Bot username for mention checks (group policy). */
  private botUsername = '';

  constructor(opts: { accessFile?: string; staticConfig?: AccessConfig; botUsername?: string }) {
    this.accessFile = opts.accessFile;
    this.staticConfig = opts.staticConfig;
    if (opts.botUsername) this.botUsername = opts.botUsername;
  }

  setBotUsername(username: string): void {
    this.botUsername = username;
  }

  /** Load the current access policy (static override > file > deny-all). */
  load(): AccessConfig {
    if (this.staticConfig) return this.staticConfig;
    if (!this.accessFile || !existsSync(this.accessFile)) return emptyAccess();
    try {
      const parsed = JSON.parse(readFileSync(this.accessFile, 'utf8')) as Partial<AccessConfig>;
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        groups: parsed.groups ?? {},
        mentionPatterns: parsed.mentionPatterns,
      };
    } catch {
      // Corrupt file → deny-all (don't fail open).
      return emptyAccess();
    }
  }

  /**
   * Decide whether to deliver or drop a raw inbound. Mirrors server.ts gate()'s
   * READ logic (DM allowlist; group allowFrom + requireMention; disabled).
   * Pairing-mode DMs from an unpaired sender → 'drop' (the live plugin handles
   * pairing until cut-over).
   */
  decide(raw: RawInbound): GateDecision {
    const access = this.load();
    if (access.dmPolicy === 'disabled') return 'drop';

    if (raw.chatType === 'private') {
      if (access.allowFrom.includes(raw.fromUserId)) return 'deliver';
      // allowlist or pairing: an un-listed sender is dropped here.
      return 'drop';
    }

    if (raw.chatType === 'group' || raw.chatType === 'supergroup') {
      const policy = access.groups[raw.chatId];
      if (!policy) return 'drop';
      const groupAllow = policy.allowFrom ?? [];
      if (groupAllow.length > 0 && !groupAllow.includes(raw.fromUserId)) return 'drop';
      if ((policy.requireMention ?? true) && !this.isMentioned(raw, access.mentionPatterns)) {
        return 'drop';
      }
      return 'deliver';
    }

    return 'drop';
  }

  /**
   * Whether the bot is mentioned in a group message. Simplified vs the plugin
   * (which inspects Telegram entities): here we match `@username` or a
   * configured pattern against the text. Adequate for the gate; the live plugin
   * keeps the entity-precise check until Phase 3.
   */
  private isMentioned(raw: RawInbound, extraPatterns?: string[]): boolean {
    const text = raw.text ?? '';
    if (this.botUsername && text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`)) {
      return true;
    }
    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(text)) return true;
      } catch {
        // Invalid user-supplied regex — skip.
      }
    }
    return false;
  }
}
