/**
 * The M10 channel-adapter CONTRACT.
 *
 * An adapter is an *interface*, not a channel. The supervisor codes to this —
 * never to Telegram. Telegram is the reference implementation (see
 * `adapters/telegram.ts`); email / WhatsApp / a future web chat are siblings
 * behind the same contract.
 *
 * Traces: proposal PART B.2 "The channel-adapter contract (M10), made concrete":
 *   inbound  → {text?, voice_path?, attachments[], user, ts, reply_handle}
 *   outbound(reply_handle, {text?, voice_ogg_path?, files[]})
 *   plus start()/stop()/health().
 *
 * Two cross-cutting guarantees the contract bakes in:
 *  - **Queued + recoverable** delivery: inbound persists to a durable queue
 *    until acked (the inbox-queue patch's job, now a first-class adapter
 *    responsibility — see `delivery-queue.ts`). FC-2.
 *  - **Voice** is an adapter concern: STT-in / TTS-out live behind the contract
 *    (see `voice.ts`), so a `voicePath` inbound and a `voiceOggPath` outbound
 *    are first-class — not a plugin monkey-patch.
 */

/** An inbound attachment the adapter surfaced but did not necessarily inline. */
export interface InboundAttachment {
  /** Logical kind: 'document' | 'voice' | 'audio' | 'video' | 'photo' | 'sticker' | … */
  kind: string;
  /** Channel-native handle to fetch the bytes (e.g. a Telegram file_id). */
  handle: string;
  /** Local path if the adapter already downloaded it (e.g. a photo), else undefined. */
  localPath?: string;
  sizeBytes?: number;
  mime?: string;
  name?: string;
}

/**
 * A normalized inbound message. Channel-agnostic: every adapter maps its native
 * event onto this shape. `replyHandle` is the opaque token the caller passes
 * back to `outbound()` to address the reply on the originating channel.
 */
export interface InboundMessage {
  /** The text body (already STT-transcribed if the source was a voice note). */
  text?: string;
  /** Local path to an inbound voice note (OGG/OPUS), if one was attached. */
  voicePath?: string;
  /** Non-voice attachments. */
  attachments: InboundAttachment[];
  /** Display handle of the sender (username or id). */
  user: string;
  /** Stable per-user id (for allow-listing / addressing). */
  userId?: string;
  /** ISO-8601 receive timestamp. */
  ts: string;
  /** Opaque reply token — pass back to outbound(). Channel-specific contents. */
  replyHandle: ReplyHandle;
  /**
   * Channel name that produced this message ('telegram', 'loopback', …).
   * Set by the registry on delivery; adapters may leave it undefined.
   */
  channel?: string;
}

/**
 * Opaque reply addressing token. The Telegram adapter encodes `{chatId,
 * messageId}`; other channels encode whatever they need. Callers MUST treat it
 * as opaque and round-trip it unchanged.
 */
export interface ReplyHandle {
  /** Primary address on the channel (e.g. Telegram chat_id). */
  to: string;
  /** Optional message id to thread/quote-reply under. */
  replyToMessageId?: string;
  /** Free-form channel-specific extras. */
  [k: string]: unknown;
}

/** An outbound payload. At least one of text / voiceOggPath / files should be set. */
export interface OutboundMessage {
  /** Plain text to send. Long text is chunked by the adapter. */
  text?: string;
  /**
   * Path to an OGG/OPUS voice note to send as a playable bubble (the sendVoice
   * behavior — built into the adapter, not a plugin patch). The adapter may
   * also render TTS from `text` when `voice` is requested; see `OutboundOptions`.
   */
  voiceOggPath?: string;
  /** Absolute file paths to attach (images→inline, voice→bubble, else document). */
  files?: string[];
  /** Delivery options (modality, formatting). */
  options?: OutboundOptions;
}

export interface OutboundOptions {
  /**
   * Modality. 'text' = send `text` as-is. 'voice' = render `text` to a voice
   * note via TTS (honors the §0.10g on-the-fly switch). 'auto' = voice iff the
   * inbound was voice (caller may pre-resolve). Default: 'text'.
   */
  modality?: 'text' | 'voice' | 'auto';
  /** Rendering mode for text channels that support it. */
  format?: 'text' | 'markdown';
}

/** Result of an outbound send. */
export interface OutboundResult {
  ok: boolean;
  /** Channel-native ids of the message(s) produced. */
  sentIds: string[];
  /** Error detail when ok === false. */
  error?: string;
}

/** Liveness/health of an adapter. */
export interface AdapterHealth {
  /** Adapter channel name. */
  channel: string;
  /** True once start() has connected the transport and it is serving. */
  running: boolean;
  /** Pending (un-acked) inbound items in the durable queue. */
  queueDepth: number;
  /** Free-form per-adapter detail (e.g. 'polling as @bot', '409 conflict'). */
  detail?: string;
}

/**
 * The handler the supervisor registers to receive normalized inbound messages.
 * Returning normally ACKs the queue item (durable-delivery contract); throwing
 * leaves it queued for replay. Adapters MUST route every gate-approved inbound
 * through their DeliveryQueue so a crash between receive and handle replays it.
 */
export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;

/**
 * The channel-adapter contract. The supervisor depends ONLY on this surface.
 */
export interface ChannelAdapter {
  /** Channel name ('telegram', 'loopback', …). Stable; used as a registry key. */
  readonly channel: string;

  /**
   * Register the inbound handler and connect the transport. After start()
   * resolves, the adapter delivers inbound via the handler and replays any
   * queued (un-acked) items from a prior run.
   */
  start(onInbound: InboundHandler): Promise<void>;

  /** Send a reply addressed by a ReplyHandle obtained from an inbound message. */
  outbound(handle: ReplyHandle, msg: OutboundMessage): Promise<OutboundResult>;

  /** Disconnect the transport gracefully. Safe to call when not started. */
  stop(): Promise<void>;

  /** Current health snapshot. */
  health(): AdapterHealth;
}
