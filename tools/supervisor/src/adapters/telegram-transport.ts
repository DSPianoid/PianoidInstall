/**
 * The Telegram TRANSPORT abstraction.
 *
 * This is the seam that makes the Telegram adapter testable WITHOUT opening a
 * live getUpdates poller on the production bot token. Telegram permits exactly
 * ONE getUpdates consumer per token; a second poller returns 409 Conflict and
 * would SEVER the live orchestrator's own channel. So the adapter never talks to
 * grammY directly — it talks to this transport, which has two implementations:
 *
 *   - `GrammyTelegramTransport` (real): wraps a grammY `Bot`, polls, and sends
 *     via the Bot API. Used ONLY against a dedicated/test token, never the live
 *     production token during automated acceptance.
 *   - `LoopbackTelegramTransport` (test/deterministic): an in-memory transport
 *     that injects inbound updates and records outbound sends. The Phase-1
 *     acceptance drives the adapter through THIS, proving the contract + queue
 *     replay + voice + capture deterministically.
 *
 * Concern (P2): move raw text/file payloads to/from a Telegram-shaped wire.
 * It performs NO gating, normalization, queueing, or voice — those are the
 * adapter's concern.
 *
 * Traces: proposal PART I risk "Telegram adapter lift" + the orchestrator
 * brief's CRITICAL SAFETY ("Do NOT start a second poller on the production bot
 * token"; "validate the contract + queue-replay + voice + capture
 * deterministically (mock/loopback transport + unit tests)").
 */

/** A raw inbound update as the transport surfaces it (pre-normalization). */
export interface RawInbound {
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  messageId?: string;
  /** Sender display handle. */
  fromUser: string;
  fromUserId: string;
  /** Unix epoch seconds of the message (Telegram's `date`). */
  dateSec: number;
  /** Text or caption. */
  text?: string;
  /** Attachment, if any (voice/document/photo/…). */
  attachment?: RawAttachment;
  /**
   * A button tap — present when this update is a Telegram `callback_query` (the
   * user tapped an inline-keyboard button) rather than a normal message. Carries
   * the data the button held + the ids needed to ACK + edit the source message.
   */
  callbackQuery?: RawCallbackQuery;
}

/** A raw inline-button tap (Telegram `callback_query`), pre-normalization. */
export interface RawCallbackQuery {
  /** `callback_query.id` — needed to answerCallbackQuery (dismiss the spinner). */
  id: string;
  /** The opaque `callback_data` the tapped button carried. */
  data: string;
  /** Id of the message the keyboard was attached to (to edit it after deciding). */
  messageId?: string;
}

export interface RawAttachment {
  kind: string;
  fileId: string;
  sizeBytes?: number;
  mime?: string;
  name?: string;
}

/** A single inline-keyboard button at the transport layer. */
export interface RawInlineButton {
  text: string;
  callbackData: string;
}

/** Options for an outbound send through the transport. */
export interface RawSendOptions {
  /** Message id to thread/quote-reply under. */
  replyToMessageId?: string;
  /** 'markdown' enables MarkdownV2 on text channels. */
  format?: 'text' | 'markdown';
  /**
   * Inline-keyboard buttons to attach. The transport builds the channel-native
   * keyboard (Telegram `reply_markup`). Honored by `sendText` only. Laid out per
   * {@link buttonsPerRow} (default: a single row).
   */
  inlineButtons?: RawInlineButton[];
  /**
   * Buttons per keyboard row. Omitted / ≤ 0 → all {@link inlineButtons} in ONE row
   * (the prior behavior). N > 0 → the transport wraps the flat list into rows of at
   * most N (the readable-grid layout for long menus like `/control`).
   */
  buttonsPerRow?: number;
}

/** The kind of a file send, so the transport picks photo/voice/document. */
export type FileSendKind = 'photo' | 'voice' | 'document';

/** Extensions that map to a Telegram voice note (waveform bubble). */
const VOICE_EXTS = new Set(['.ogg', '.oga', '.opus']);
/** Extensions that map to an inline photo. */
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/**
 * Map a local file path to its Telegram send-kind by extension. Shared by the
 * adapter so the routing (voice→bubble, image→inline, else→document) is
 * transport-independent. `.ogg/.oga/.opus` → voice is exactly the
 * apply_telegram_voice_patch.py rule, now native.
 */
export function fileKindFor(filePath: string): FileSendKind {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  if (VOICE_EXTS.has(ext)) return 'voice';
  if (PHOTO_EXTS.has(ext)) return 'photo';
  return 'document';
}

/**
 * The transport contract the Telegram adapter depends on. Both the real grammY
 * transport and the loopback test transport implement this.
 */
export interface TelegramTransport {
  /** Register the handler that receives raw inbound updates, then connect. */
  start(onUpdate: (raw: RawInbound) => void | Promise<void>): Promise<void>;

  /** Send a text message; returns the produced message id. */
  sendText(chatId: string, text: string, opts?: RawSendOptions): Promise<string>;

  /**
   * Send a file by local path with an explicit kind (photo→inline,
   * voice→waveform bubble via sendVoice, document→raw). Returns the message id.
   */
  sendFile(
    chatId: string,
    filePath: string,
    kind: FileSendKind,
    opts?: RawSendOptions,
  ): Promise<string>;

  /**
   * Download an attachment (by the transport-native handle/file_id) to a local
   * path under `destDir`. Returns the local path. Used to fetch inbound voice
   * notes for STT.
   */
  downloadFile(fileId: string, destDir: string): Promise<string>;

  /**
   * Acknowledge a button tap (Telegram `answerCallbackQuery`) — dismisses the
   * client spinner; optional `text` shows a brief toast. Best-effort.
   */
  answerCallback(callbackId: string, text?: string): Promise<void>;

  /**
   * Replace a message's text and DROP its inline keyboard (Telegram
   * `editMessageText` with no reply_markup) — so a decided prompt shows its
   * outcome and the buttons disappear. Best-effort.
   */
  editMessageText(chatId: string, messageId: string, text: string): Promise<void>;

  /** Disconnect gracefully. Safe to call when not started. */
  stop(): Promise<void>;

  /** Whether the transport is connected and serving. */
  isRunning(): boolean;

  /** Human-readable status detail (e.g. 'polling as @bot', 'loopback'). */
  statusDetail(): string;
}
