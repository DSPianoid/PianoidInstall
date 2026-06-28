/**
 * REAL grammY Telegram transport.
 *
 * Wraps a grammY `Bot` and lifts the polling + per-type message handling + the
 * Bot-API send paths from the plugin's `server.ts`. It surfaces every raw
 * inbound update to the adapter (which gates + normalizes) and sends text/files
 * via the Bot API — routing `.ogg/.oga/.opus` through `sendVoice` (the voice
 * bubble the `apply_telegram_voice_patch.py` patch added, now native here).
 *
 * ⚠️ SAFETY: constructing + starting this opens a getUpdates poller, which
 * Telegram permits only ONE of per token. NEVER start this on the live
 * production token while the orchestrator's own poller is running — it would
 * 409-sever the user's channel. Use a DEDICATED test token for any live
 * round-trip, or use `LoopbackTelegramTransport` for automated acceptance.
 *
 * Concern (P2): Telegram wire I/O ONLY (poll, send, download). No gating,
 * normalization, queueing, or voice conversion — those are the adapter's.
 *
 * Traces: plugin server.ts (grammy Bot, message handlers, reply file loop) +
 * PART D row "apply_telegram_voice_patch.py → Telegram adapter's native
 * voice-out path".
 */

import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import type { Context } from 'grammy';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type {
  FileSendKind,
  RawAttachment,
  RawInbound,
  RawSendOptions,
  TelegramTransport,
} from './telegram-transport.js';

export interface GrammyTransportOptions {
  /** The bot token. MUST be a dedicated/test token for automated acceptance. */
  token: string;
  /** Backoff cap for poll retries, ms. Default 15000. */
  maxBackoffMs?: number;
}

/**
 * Build a grammY InlineKeyboard from the transport-layer buttons, laid out at most
 * `perRow` buttons per row. `perRow` omitted / ≤ 0 → a SINGLE row (the prior
 * behavior — keeps a 2-button permission Allow/Deny prompt byte-for-byte). `perRow`
 * > 0 → wrap the flat list into rows of at most N (the readable grid for a long
 * menu like `/control`). Pure aside from constructing the keyboard.
 */
export function buildInlineKeyboard(
  buttons: { text: string; callbackData: string }[],
  perRow?: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const n = perRow && perRow > 0 ? Math.floor(perRow) : buttons.length || 1;
  buttons.forEach((b, i) => {
    if (i > 0 && i % n === 0) kb.row(); // start a new row every N buttons
    kb.text(b.text, b.callbackData);
  });
  return kb;
}

export class GrammyTelegramTransport implements TelegramTransport {
  private readonly bot: Bot;
  private readonly token: string;
  private readonly maxBackoffMs: number;
  private running = false;
  private username = '';

  constructor(opts: GrammyTransportOptions) {
    if (!opts.token) throw new Error('GrammyTelegramTransport requires a token');
    this.token = opts.token;
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.bot = new Bot(this.token);
  }

  async start(onUpdate: (raw: RawInbound) => void | Promise<void>): Promise<void> {
    const deliver = (raw: RawInbound): void => {
      void Promise.resolve(onUpdate(raw)).catch((err) => {
        process.stderr.write(`telegram transport: inbound handler error: ${err}\n`);
      });
    };

    this.bot.on('message:text', (ctx) => deliver(this.toRaw(ctx, ctx.message.text)));
    this.bot.on('message:voice', (ctx) =>
      deliver(
        this.toRaw(ctx, ctx.message.caption, {
          kind: 'voice',
          fileId: ctx.message.voice.file_id,
          sizeBytes: ctx.message.voice.file_size,
          mime: ctx.message.voice.mime_type,
        }),
      ),
    );
    this.bot.on('message:document', (ctx) =>
      deliver(
        this.toRaw(ctx, ctx.message.caption, {
          kind: 'document',
          fileId: ctx.message.document.file_id,
          sizeBytes: ctx.message.document.file_size,
          mime: ctx.message.document.mime_type,
          name: ctx.message.document.file_name,
        }),
      ),
    );
    this.bot.on('message:photo', (ctx) => {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      deliver(
        this.toRaw(ctx, ctx.message.caption, {
          kind: 'photo',
          fileId: best?.file_id ?? '',
          sizeBytes: best?.file_size,
        }),
      );
    });
    // INLINE-BUTTON tap (callback_query with data) — the native tap-to-decide path
    // (e.g. a ✅ Allow / ❌ Deny permission button). Surfaced as a RawInbound carrying
    // a `callbackQuery` (no text/attachment); the adapter routes it to the pending
    // decision, then ACKs (answerCallback) + edits the source message. We do NOT
    // answerCallbackQuery here — the adapter/supervisor does, after resolving, so the
    // toast can reflect the outcome.
    this.bot.on('callback_query:data', (ctx) => {
      const cq = ctx.callbackQuery;
      deliver(
        this.toRaw(ctx, undefined, undefined, {
          id: cq.id,
          data: cq.data,
          ...(cq.message?.message_id != null ? { messageId: String(cq.message.message_id) } : {}),
        }),
      );
    });

    // Without a catch handler, any throw stops polling permanently.
    this.bot.catch((err) => {
      process.stderr.write(`telegram transport: handler error (polling continues): ${err.error}\n`);
    });

    // Start polling with backoff (mirrors server.ts's resilient loop). We await
    // the first onStart so callers know we're live; the loop continues in the
    // background and retries transient failures.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      void (async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            await this.bot.start({
              onStart: (info) => {
                this.username = info.username;
                this.running = true;
                if (!settled) {
                  settled = true;
                  resolve();
                }
              },
            });
            return; // stop() was called — clean exit
          } catch (err) {
            if (!this.running && !settled) {
              // Failed before ever connecting — surface to the caller.
              settled = true;
              reject(err);
              return;
            }
            const is409 = err instanceof GrammyError && err.error_code === 409;
            const delay = Math.min(1000 * attempt, this.maxBackoffMs);
            process.stderr.write(
              `telegram transport: ${is409 ? '409 Conflict' : `poll error: ${err}`}, retrying in ${delay / 1000}s\n`,
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      })();
    });
  }

  private toRaw(
    ctx: Context,
    text: string | undefined,
    attachment?: RawAttachment,
    callbackQuery?: RawInbound['callbackQuery'],
  ): RawInbound {
    const chat = ctx.chat!;
    const from = ctx.from!;
    return {
      chatId: String(chat.id),
      chatType: chat.type,
      messageId: ctx.message?.message_id != null ? String(ctx.message.message_id) : undefined,
      fromUser: from.username ?? String(from.id),
      fromUserId: String(from.id),
      dateSec: ctx.message?.date ?? ctx.callbackQuery?.message?.date ?? 0,
      text,
      attachment,
      callbackQuery,
    };
  }

  async sendText(chatId: string, text: string, opts?: RawSendOptions): Promise<string> {
    const sent = await this.bot.api.sendMessage(chatId, text, {
      ...(opts?.replyToMessageId
        ? { reply_parameters: { message_id: Number(opts.replyToMessageId) } }
        : {}),
      ...(opts?.format === 'markdown' ? { parse_mode: 'MarkdownV2' as const } : {}),
      ...(opts?.inlineButtons && opts.inlineButtons.length > 0
        ? { reply_markup: buildInlineKeyboard(opts.inlineButtons, opts.buttonsPerRow) }
        : {}),
    });
    return String(sent.message_id);
  }

  /** ACK a button tap (dismiss the spinner; optional toast). Best-effort. */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackId, text ? { text } : undefined);
  }

  /** Replace a message's text and DROP its inline keyboard. Best-effort. */
  async editMessageText(chatId: string, messageId: string, text: string): Promise<void> {
    // No reply_markup passed → the keyboard is removed (buttons disappear).
    await this.bot.api.editMessageText(chatId, Number(messageId), text);
  }

  async sendFile(
    chatId: string,
    filePath: string,
    kind: FileSendKind,
    opts?: RawSendOptions,
  ): Promise<string> {
    const input = new InputFile(filePath);
    const sendOpts = opts?.replyToMessageId
      ? { reply_parameters: { message_id: Number(opts.replyToMessageId) } }
      : undefined;
    let messageId: number;
    if (kind === 'photo') {
      messageId = (await this.bot.api.sendPhoto(chatId, input, sendOpts)).message_id;
    } else if (kind === 'voice') {
      messageId = (await this.bot.api.sendVoice(chatId, input, sendOpts)).message_id;
    } else {
      messageId = (await this.bot.api.sendDocument(chatId, input, sendOpts)).message_id;
    }
    return String(messageId);
  }

  async downloadFile(fileId: string, destDir: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram returned no file_path (expired?)');
    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin';
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, `${Date.now()}-${(file.file_unique_id ?? 'dl').replace(/[^a-zA-Z0-9_-]/g, '')}.${ext}`);
    writeFileSync(dest, buf);
    return dest;
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.bot.stop();
    } catch {
      // stop() mid-setup rejects with grammy's "Aborted delay" — expected.
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  statusDetail(): string {
    return this.running ? `polling as @${this.username}` : 'not started';
  }
}
