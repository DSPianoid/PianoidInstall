/**
 * The TELEGRAM REFERENCE ADAPTER.
 *
 * The reference implementation of the M10 ChannelAdapter contract. It composes:
 *   - a TelegramTransport (real grammY, or the loopback test transport),
 *   - an AccessGate (drops non-allowlisted senders — preserves plugin security),
 *   - a DeliveryQueue (durable, ack'd, replayable inbound — the inbox-queue
 *     patch, now first-class),
 *   - an optional VoiceCodec (STT in / TTS out — the voice patch + transcribe/
 *     tts helpers, now native).
 *
 * This adapter therefore obsoletes BOTH monkey-patches (`apply_telegram_patch.py`
 * inbox-queue + `apply_telegram_voice_patch.py` sendVoice) WITHOUT patching the
 * plugin — the behaviors are built in here.
 *
 * INBOUND flow (per message):
 *   transport raw → gate → [voice? download+STT] → normalize → enqueue(durable)
 *   → handler → ack. A crash before ack replays the item on next start().
 *
 * OUTBOUND flow:
 *   {text?, voiceOggPath?, files[]} + modality → chunk text / TTS-render /
 *   route files by ext (voice→sendVoice bubble) → transport send.
 *
 * Concern (P2): be the Telegram adapter — wire the contract to the transport via
 * gate+queue+voice. It owns no bus and no capture (the supervisor wires those).
 * Authority (P1): it owns its DeliveryQueue dir + the voice tmp dir (via the
 * codec); it reads access.json read-only via the gate.
 *
 * Traces: proposal PART B.2 (Telegram = reference impl), PART D (both patches
 * RETIRE/RE-HOME), PART E Phase-1 acceptance (round-trip incl. voice, no patch;
 * inbound survives restart; native voice).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterHealth,
  ChannelAdapter,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
  OutboundResult,
  ReplyHandle,
} from '../contract.js';
import { DeliveryQueue } from '../delivery-queue.js';
import type { VoiceProvider } from '../voice.js';
import { AccessGate } from './access-gate.js';
import {
  fileKindFor,
  type RawInbound,
  type RawSendOptions,
  type TelegramTransport,
} from './telegram-transport.js';

/** The persisted queue payload — mirrors the plugin's {content, meta} shape. */
export interface TelegramQueuePayload {
  content: string;
  meta: {
    chat_id: string;
    message_id?: string;
    user: string;
    user_id: string;
    ts: string;
    voice_path?: string;
    attachment_kind?: string;
    attachment_file_id?: string;
    attachment_size?: string;
    attachment_mime?: string;
    attachment_name?: string;
    /**
     * True between enqueue and voice-resolution: a voice note whose download +
     * STT has NOT happened yet. The raw payload is persisted FIRST (review M2 —
     * the durable boundary now wraps the download/STT), then `deliver` resolves
     * it and clears this flag, memoizing the transcript back into the item so a
     * replay does not re-run STT.
     */
    voice_pending?: boolean;
  };
}

/** Telegram's hard per-message character cap (UTF-16 code units). */
const MAX_CHUNK = 4096;

/**
 * Split `text` into pieces no longer than `limit`, preferring a SAFE boundary
 * (last newline, else last space) in the back portion of the window, and never
 * cutting through a UTF-16 surrogate pair (review M4). Plain hard-cut only when
 * no whitespace boundary exists in range. (MarkdownV2-entity-aware splitting is
 * a documented carry-forward; this mitigates the surrogate/word-break case the
 * lifted plugin code shared.)
 */
export function chunkText(text: string, limit = MAX_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    // Avoid splitting a surrogate pair at the hard boundary.
    const codeAt = rest.charCodeAt(cut - 1);
    if (codeAt >= 0xd800 && codeAt <= 0xdbff) cut -= 1; // high surrogate → back up
    // Prefer a newline, then a space, in the back half of the window.
    const nl = rest.lastIndexOf('\n', cut);
    const sp = rest.lastIndexOf(' ', cut);
    if (nl > limit / 2) cut = nl + 1;
    else if (sp > limit / 2) cut = sp + 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export interface TelegramAdapterOptions {
  /** The transport (grammY or loopback). */
  transport: TelegramTransport;
  /** The access gate (allow/drop). */
  gate: AccessGate;
  /** Absolute path to this adapter's durable delivery-queue directory. */
  queueDir: string;
  /** Optional voice provider for STT/TTS. If absent, voice degrades gracefully. */
  voice?: VoiceProvider;
  /** Directory for downloaded inbound files (voice notes). */
  downloadDir: string;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'telegram';

  private readonly transport: TelegramTransport;
  private readonly gate: AccessGate;
  private readonly queue: DeliveryQueue<TelegramQueuePayload>;
  private readonly voice?: VoiceProvider;
  private readonly downloadDir: string;
  private onInbound: InboundHandler | null = null;

  constructor(opts: TelegramAdapterOptions) {
    this.transport = opts.transport;
    this.gate = opts.gate;
    this.voice = opts.voice;
    this.downloadDir = opts.downloadDir;
    this.queue = new DeliveryQueue<TelegramQueuePayload>({ dir: opts.queueDir });
    mkdirSync(this.downloadDir, { recursive: true });
  }

  async start(onInbound: InboundHandler): Promise<void> {
    this.onInbound = onInbound;
    // Replay any items left un-acked from a prior run BEFORE accepting new
    // traffic — the FC-2 guarantee: nothing dropped across a restart.
    await this.queue.replayPending((payload, item) => this.deliver(payload, item.id));
    await this.transport.start((raw) => this.handleRaw(raw));
  }

  /**
   * Handle one raw inbound from the transport: gate → build RAW payload (no
   * download/STT yet) → enqueue (durable) → deliver (resolves voice INSIDE the
   * durable boundary) → ack. (review M2: the voice download + STT now happen
   * after the item is persisted, so a crash mid-STT replays from the queue.)
   */
  private async handleRaw(raw: RawInbound): Promise<void> {
    if (this.gate.decide(raw) === 'drop') return;

    // BUTTON TAP (callback_query): a transient decision signal, NOT a durable
    // message — route it straight to the handler as an InboundMessage carrying
    // `callback` (no inbox-queue persistence; there is no content to replay, and the
    // supervisor resolves the matching pending ask in-memory). The text + the
    // `allow/deny <code>` fallback remain the durable path for everything else.
    if (raw.callbackQuery) {
      if (!this.onInbound) throw new Error('telegram adapter: no inbound handler registered');
      await this.onInbound(this.toCallbackInbound(raw));
      return;
    }

    const payload = this.toRawPayload(raw);

    // Durable-first: persist the RAW payload BEFORE any download/STT or handling,
    // so a crash anywhere downstream replays it.
    const item = this.queue.enqueue(payload);
    try {
      await this.deliver(payload, item.id);
      this.queue.ack(item.id);
    } catch (err) {
      // Leave it queued for replay; surface the failure.
      process.stderr.write(`telegram adapter: deliver failed (left queued): ${err}\n`);
    }
  }

  /**
   * Build the durable payload from a raw inbound WITHOUT any network/STT — just
   * text + attachment metadata. A voice attachment is marked `voice_pending` so
   * `deliver` resolves it after the durable write.
   */
  private toRawPayload(raw: RawInbound): TelegramQueuePayload {
    const meta: TelegramQueuePayload['meta'] = {
      chat_id: raw.chatId,
      ...(raw.messageId ? { message_id: raw.messageId } : {}),
      user: raw.fromUser,
      user_id: raw.fromUserId,
      ts: new Date((raw.dateSec || 0) * 1000).toISOString(),
    };
    if (raw.attachment) {
      const a = raw.attachment;
      meta.attachment_kind = a.kind;
      meta.attachment_file_id = a.fileId;
      if (a.sizeBytes != null) meta.attachment_size = String(a.sizeBytes);
      if (a.mime) meta.attachment_mime = a.mime;
      if (a.name) meta.attachment_name = a.name;
      if (a.kind === 'voice') meta.voice_pending = true;
    }
    return { content: raw.text ?? '', meta };
  }

  /**
   * Resolve a pending voice note (download + STT) IN PLACE on the payload, then
   * persist the enriched payload back to the queue item (so a replay reuses the
   * transcript instead of re-running STT — review M2). Mutates `payload`.
   */
  private async resolveVoiceIfPending(payload: TelegramQueuePayload, id?: string): Promise<void> {
    const m = payload.meta;
    if (!m.voice_pending || !m.attachment_file_id) return;
    try {
      const localPath = await this.transport.downloadFile(m.attachment_file_id, this.downloadDir);
      m.voice_path = localPath;
      if (this.voice?.isSttAvailable()) {
        const transcript = await this.voice.transcribe(localPath);
        if (transcript) payload.content = transcript;
        else if (!payload.content) payload.content = '(voice message)';
      } else if (!payload.content) {
        payload.content = '(voice message)';
      }
    } catch (err) {
      process.stderr.write(`telegram adapter: voice STT failed: ${err}\n`);
      if (!payload.content) payload.content = '(voice message)';
    }
    // Clear the flag and memoize the resolved payload back into the durable item.
    m.voice_pending = false;
    if (id) this.queue.update(id, payload);
  }

  /**
   * Resolve voice (inside the durable boundary), normalize, and hand to the
   * registered inbound handler. `id` (when present) lets the resolved transcript
   * be persisted back to the queue item.
   */
  private async deliver(payload: TelegramQueuePayload, id?: string): Promise<void> {
    if (!this.onInbound) throw new Error('telegram adapter: no inbound handler registered');
    await this.resolveVoiceIfPending(payload, id);
    const msg = this.toInbound(payload);
    await this.onInbound(msg);
  }

  /** Map a raw callback_query (button tap) to a normalized InboundMessage. */
  private toCallbackInbound(raw: RawInbound): InboundMessage {
    const cq = raw.callbackQuery!;
    const replyHandle: ReplyHandle = {
      to: raw.chatId,
      ...(raw.messageId ? { replyToMessageId: raw.messageId } : {}),
    };
    return {
      attachments: [],
      callback: {
        id: cq.id,
        data: cq.data,
        ...(cq.messageId ? { messageId: cq.messageId } : {}),
      },
      user: raw.fromUser,
      userId: raw.fromUserId,
      ts: new Date((raw.dateSec || 0) * 1000).toISOString(),
      replyHandle,
      channel: this.channel,
    };
  }

  /** Map a durable payload to the contract's normalized InboundMessage. */
  private toInbound(payload: TelegramQueuePayload): InboundMessage {
    const m = payload.meta;
    const replyHandle: ReplyHandle = {
      to: m.chat_id,
      ...(m.message_id ? { replyToMessageId: m.message_id } : {}),
    };
    const attachments =
      m.attachment_kind && m.attachment_file_id && m.attachment_kind !== 'voice'
        ? [
            {
              kind: m.attachment_kind,
              handle: m.attachment_file_id,
              ...(m.attachment_size ? { sizeBytes: Number(m.attachment_size) } : {}),
              ...(m.attachment_mime ? { mime: m.attachment_mime } : {}),
              ...(m.attachment_name ? { name: m.attachment_name } : {}),
            },
          ]
        : [];
    return {
      text: payload.content,
      ...(m.voice_path ? { voicePath: m.voice_path } : {}),
      attachments,
      user: m.user,
      userId: m.user_id,
      ts: m.ts,
      replyHandle,
      channel: this.channel,
    };
  }

  /**
   * Send a reply. Honors modality:
   *  - 'text' (default, or 'auto' answering a text inbound): chunked text.
   *  - 'voice': render `text` → TTS voice note (sendVoice bubble) ONLY; falls
   *    back to text if TTS is unavailable/fails so a reply is never lost.
   *  - 'dual': send BOTH the chunked text AND a TTS voice note. A TTS failure
   *    here leaves the text (already sent) standing — no fallback double-text.
   * Then any explicit pre-rendered `voiceOggPath` + `files` are sent.
   * Empty/whitespace `text` skips TTS (nothing to synthesize).
   */
  async outbound(handle: ReplyHandle, msg: OutboundMessage): Promise<OutboundResult> {
    const sentIds: string[] = [];
    const opts: RawSendOptions = {
      ...(handle.replyToMessageId ? { replyToMessageId: handle.replyToMessageId } : {}),
      ...(msg.options?.format === 'markdown' ? { format: 'markdown' as const } : {}),
      // Inline buttons attach to the TEXT send only (a voice bubble can't carry them).
      ...(msg.options?.buttons && msg.options.buttons.length > 0
        ? { inlineButtons: msg.options.buttons.map((b) => ({ text: b.text, callbackData: b.callbackData })) }
        : {}),
    };

    try {
      const modality = msg.options?.modality ?? 'text';
      const wantVoice = modality === 'voice' || modality === 'dual';
      const wantText = modality === 'text' || modality === 'dual' || modality === 'auto';
      const hasText = !!msg.text && msg.text.trim() !== '';

      // TEXT first (so in 'dual' the bubble follows the readable text). 'voice'
      // mode skips this — voice-only — unless the TTS fallback below restores it.
      let textSent = false;
      if (wantText && msg.text) {
        sentIds.push(...(await this.sendTextChunks(handle.to, msg.text, opts)));
        textSent = true;
      }

      // VOICE-out: render text → OGG and send as a bubble. Skip empty text (nothing
      // to synthesize). On TTS unavailable/failure, fall back to a text send ONLY if
      // the text was not already sent (i.e. 'voice' mode) — so a reply is never lost
      // and 'dual' never double-sends text.
      if (wantVoice && hasText) {
        if (this.voice?.isTtsAvailable()) {
          try {
            const ogg = await this.voice.synthesize(msg.text!);
            sentIds.push(await this.transport.sendFile(handle.to, ogg, 'voice', opts));
          } catch (err) {
            process.stderr.write(`telegram adapter: TTS failed${textSent ? '' : ', falling back to text'}: ${err}\n`);
            if (!textSent) sentIds.push(...(await this.sendTextChunks(handle.to, msg.text!, opts)));
          }
        } else if (!textSent) {
          // TTS capability absent → ensure the reply still reaches the user as text.
          sentIds.push(...(await this.sendTextChunks(handle.to, msg.text!, opts)));
        }
      }

      // An explicit pre-rendered voice OGG (voiceOggPath) always sends as a bubble.
      if (msg.voiceOggPath) {
        sentIds.push(await this.transport.sendFile(handle.to, msg.voiceOggPath, 'voice', opts));
      }

      // Other files: route by extension (image→inline, voice→bubble, else→doc).
      for (const f of msg.files ?? []) {
        sentIds.push(await this.transport.sendFile(handle.to, f, fileKindFor(f), opts));
      }

      return { ok: true, sentIds };
    } catch (err) {
      return {
        ok: false,
        sentIds,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Split text into <=4096-char chunks (safe boundary) and send each. */
  private async sendTextChunks(
    to: string,
    text: string,
    opts: RawSendOptions,
  ): Promise<string[]> {
    const ids: string[] = [];
    const chunks = chunkText(text, MAX_CHUNK);
    for (let i = 0; i < chunks.length; i++) {
      // Only thread the FIRST chunk under the reply target (matches plugin default).
      const chunkOpts = i === 0 ? opts : { ...opts, replyToMessageId: undefined };
      ids.push(await this.transport.sendText(to, chunks[i]!, chunkOpts));
    }
    return ids;
  }

  async stop(): Promise<void> {
    await this.transport.stop();
    this.onInbound = null;
  }

  /**
   * CHANNEL REPAIR (D2): re-establish the transport (stop → start) to recover a
   * wedged/dropped connection or re-acquire the single getUpdates poller. The
   * supervisor re-supplies the inbound handler.
   */
  async reconnect(onInbound: InboundHandler): Promise<void> {
    await this.stop();
    await this.start(onInbound);
  }

  /**
   * CHANNEL REPAIR (D2): drop all un-acked INBOUND items from the durable inbox queue;
   * returns the count dropped. ⚠️ Discards pending inbound user messages (NOT an
   * outbound backlog — there is none). Use to clear a wedged inbound replay.
   */
  flush(): number {
    return this.queue.clear();
  }

  /** ACK a button tap (dismiss the client spinner; optional toast). Best-effort. */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.transport.answerCallback(callbackId, text);
  }

  /**
   * Replace a previously-sent message's text + DROP its inline keyboard (so a
   * decided permission prompt shows its outcome and the buttons disappear).
   */
  async editMessage(handle: ReplyHandle, messageId: string, text: string): Promise<void> {
    await this.transport.editMessageText(handle.to, messageId, text);
  }

  health(): AdapterHealth {
    return {
      channel: this.channel,
      running: this.transport.isRunning(),
      queueDepth: this.queue.depth(),
      detail: this.transport.statusDetail(),
    };
  }
}
