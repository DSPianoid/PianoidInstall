/**
 * ECHO host-hook — a DEV/TEST connectivity affordance.
 *
 * ⚠️ This is NOT the real host. In Phase 2 the supervisor's inbound hook is the
 * hosted Claude Code session (M1). `makeEchoHook` is a throwaway stand-in whose
 * only purpose is to make a LIVE Telegram round-trip demonstrable end-to-end
 * against a DEDICATED test bot: it echoes each inbound straight back out through
 * the adapter's `outbound(replyHandle, …)`.
 *
 * Echo rules:
 *  - a VOICE inbound (has `voicePath`) → echo it back as a VOICE note
 *    (`voiceOggPath` = the inbound's downloaded OGG) so a voice note round-trips
 *    both directions; prefix any transcribed text in the log only, not the audio.
 *  - otherwise → echo the text back (`Echo: <text>`).
 *
 * It is enabled ONLY behind the `--echo` flag / `SUPERVISOR_ECHO=1` gate in the
 * entrypoint; default runs never wire it.
 *
 * Pure + testable: it takes the `send` function (the supervisor's
 * `sendOutbound` bound) so a loopback test can assert the wiring without the
 * full entrypoint or any network.
 */

import type { InboundMessage, OutboundResult, ReplyHandle } from './contract.js';
import type { SupervisorInboundHook } from './supervisor.js';

/** The outbound sender the echo hook drives (matches Supervisor.sendOutbound). */
export type EchoSender = (
  channel: string,
  handle: ReplyHandle,
  msg: { text?: string; voiceOggPath?: string },
) => Promise<OutboundResult>;

export interface EchoHookOptions {
  /** Optional log callback (e.g. logger.info) — never receives secrets. */
  onEcho?: (note: string, fields: Record<string, unknown>) => void;
  /** Prefix for echoed text. Default 'Echo: '. */
  textPrefix?: string;
}

/**
 * Build the dev/test echo host-hook. Returns a `SupervisorInboundHook` that
 * echoes each inbound back through `send`.
 */
export function makeEchoHook(send: EchoSender, opts: EchoHookOptions = {}): SupervisorInboundHook {
  const prefix = opts.textPrefix ?? 'Echo: ';
  return async (msg: InboundMessage): Promise<void> => {
    const channel = msg.channel ?? 'telegram';
    if (msg.voicePath) {
      // Round-trip a voice note: send the same OGG back as a voice bubble.
      opts.onEcho?.('echo: voice note', { channel, user: msg.user, hasTranscript: !!msg.text });
      await send(channel, msg.replyHandle, { voiceOggPath: msg.voicePath });
      return;
    }
    const text = `${prefix}${msg.text ?? ''}`;
    opts.onEcho?.('echo: text', { channel, user: msg.user });
    await send(channel, msg.replyHandle, { text });
  };
}
