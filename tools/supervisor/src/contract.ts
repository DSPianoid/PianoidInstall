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
 * An inbound BUTTON-TAP (a Telegram `callback_query`, or a sibling channel's
 * equivalent). When an inbound message carries this, the user tapped an inline
 * keyboard button the adapter previously sent (e.g. a ✅ Allow / ❌ Deny
 * permission button). The supervisor parses `data` to resolve the matching
 * pending action, then ACKs via the adapter (`answerCallback`) and edits the
 * source message (`editMessage`) so the buttons disappear and a record remains.
 */
export interface InboundCallback {
  /** Channel-native id needed to ACK the tap (Telegram `callback_query.id`). */
  id: string;
  /** The opaque `callback_data` the button carried (e.g. 'perm:allow:ab12'). */
  data: string;
  /** Id of the message the keyboard was attached to (so the adapter can edit it). */
  messageId?: string;
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
  /**
   * An inbound BUTTON-TAP (a Telegram callback_query) — set when the user tapped
   * an inline-keyboard button instead of typing. The supervisor routes this to
   * the pending action (e.g. a permission decision) BEFORE any text handling.
   */
  callback?: InboundCallback;
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
 * One inline-keyboard button: a visible `text` label + the opaque `callbackData`
 * the channel echoes back when the user taps it. The supervisor encodes its
 * decision + the pending code into `callbackData` (e.g. 'perm:allow:ab12') and
 * recognizes it on the inbound `callback`. Telegram caps `callbackData` at 64
 * bytes — keep it short.
 */
export interface InlineButton {
  text: string;
  callbackData: string;
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

/**
 * Outbound modality (the §0.10g on-the-fly switch the adapter honors):
 *  - 'text'  — send `text` as-is (the default).
 *  - 'voice' — render `text` to a voice note via TTS and send ONLY the bubble.
 *  - 'dual'  — send BOTH the text AND a TTS voice note (each reply twice over).
 *  - 'auto'  — voice iff the inbound was voice (caller may pre-resolve).
 * The switchable supervisor-level state is held by the SessionHost (set via the
 * intercepted `/mode` command); the adapter just renders per this field.
 */
export type OutboundModality = 'text' | 'voice' | 'dual' | 'auto';

export interface OutboundOptions {
  /**
   * Modality. See {@link OutboundModality}. 'text' = send `text` as-is; 'voice' =
   * TTS bubble only; 'dual' = text AND a TTS bubble; 'auto' = voice iff the inbound
   * was voice. Default: 'text'.
   */
  modality?: OutboundModality;
  /** Rendering mode for text channels that support it. */
  format?: 'text' | 'markdown';
  /**
   * Inline-keyboard buttons to attach to the (text) message — the native
   * tap-to-decide UX (e.g. ✅ Allow / ❌ Deny for a permission prompt). A tapped
   * button comes back as an inbound {@link InboundCallback}. Channels without inline
   * keyboards ignore this (the text + the `allow/deny <code>` fallback still work).
   * Only honored on a TEXT send (modality text/dual), never on a voice bubble.
   *
   * Row layout is controlled by {@link buttonsPerRow}: by default the adapter renders
   * all buttons in a SINGLE row (the permission Allow/Deny prompt — 2 buttons — is
   * fine that way); set `buttonsPerRow` to wrap a longer keyboard (e.g. the `/control`
   * menu's 14 actions) into a readable grid so labels are not squeezed to 1/N width.
   */
  buttons?: InlineButton[];
  /**
   * Buttons PER ROW for the inline keyboard (the layout hint the adapter honors). When
   * omitted or ≤ 0, all {@link buttons} render in a SINGLE row (the previous behavior —
   * byte-for-byte for the permission prompt). When set to N > 0, the adapter chunks the
   * flat button list into rows of at most N (e.g. N=2 → a 14-button menu becomes 7 rows
   * of 2 → readable labels). Channels without inline keyboards ignore it.
   */
  buttonsPerRow?: number;
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

  /**
   * CHANNEL REPAIR (D2, optional). Re-establish the transport (stop → start) to
   * recover a dropped/wedged connection or re-acquire a single-poller token. The
   * supervisor re-supplies the inbound handler. NOTE: on start() the adapter REPLAYS
   * its un-acked durable INBOUND queue, so reconnect re-delivers any pending inbound.
   * Adapters that can't reconnect omit this.
   */
  reconnect?(onInbound: InboundHandler): Promise<void>;

  /**
   * CHANNEL REPAIR (D2, optional). Drop all PENDING (un-acked) INBOUND items from the
   * durable inbox queue and return how many were dropped. ⚠️ This discards inbound user
   * messages that have NOT yet been acked (e.g. a poison message wedged in replay) — it
   * is NOT an outbound backlog (outbound sends directly; there is no outbound queue).
   * Use to clear a wedged inbound replay. Adapters with no inbox queue omit this.
   */
  flush?(): number;

  /**
   * INLINE-BUTTON ACK (optional). Acknowledge a button tap (Telegram
   * `answerCallbackQuery`) — dismisses the client's loading spinner and optionally
   * shows a toast. Best-effort; channels without inline keyboards omit this.
   */
  answerCallback?(callbackId: string, text?: string): Promise<void>;

  /**
   * INLINE-BUTTON FOLLOW-UP (optional). Replace a previously-sent message's text
   * (and DROP its inline keyboard) so a decided permission prompt shows its outcome
   * and the buttons disappear. `handle` addresses the chat; `messageId` is the
   * message to edit. Best-effort; channels that can't edit omit this.
   */
  editMessage?(handle: ReplyHandle, messageId: string, text: string): Promise<void>;

  /**
   * MESSAGE DELETE (optional). Remove a previously-received/-sent message from the chat
   * (Telegram `deleteMessage`). `handle` addresses the chat; `messageId` is the message to
   * delete. Used by the `/setkey` in-channel secret-intake so the plaintext key does NOT linger
   * in the chat history after it has been stored. Best-effort; channels that can't delete omit
   * this (the key is still redacted from capture + never echoed regardless). DORMANT until the
   * `/setkey` path is wired (P6).
   */
  deleteMessage?(handle: ReplyHandle, messageId: string): Promise<void>;
}
