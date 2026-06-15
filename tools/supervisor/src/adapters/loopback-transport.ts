/**
 * LOOPBACK Telegram transport — deterministic, in-memory, NO network.
 *
 * The Phase-1 acceptance drives the Telegram adapter through this transport so
 * the contract round-trip (incl. voice both directions), the queue replay, and
 * the capture store are all proven WITHOUT opening a getUpdates poller on the
 * live production token (which would 409-sever the orchestrator's channel).
 *
 * - `inject(raw)` simulates an inbound message arriving from Telegram.
 * - every `sendText`/`sendFile` is recorded in `sent` for assertions.
 * - `downloadFile` copies a pre-seeded local fixture (registered via
 *   `seedDownload`) to the destination dir, mimicking fetching an inbound file.
 *
 * Concern (P2): be a faithful, inspectable stand-in for the Telegram wire.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  FileSendKind,
  RawInbound,
  RawSendOptions,
  TelegramTransport,
} from './telegram-transport.js';

/** A recorded outbound send (for test assertions). */
export interface SentRecord {
  kind: 'text' | 'file';
  chatId: string;
  /** Text body (kind==='text') or file path (kind==='file'). */
  body: string;
  /** File send kind, when kind==='file'. */
  fileKind?: FileSendKind;
  opts?: RawSendOptions;
  messageId: string;
}

export class LoopbackTelegramTransport implements TelegramTransport {
  /** Every outbound send, in order. Inspect this in tests. */
  readonly sent: SentRecord[] = [];

  private onUpdate: ((raw: RawInbound) => void | Promise<void>) | null = null;
  private running = false;
  private msgSeq = 1000;
  /** fileId → local fixture path, for downloadFile. */
  private readonly downloadSeeds = new Map<string, string>();

  async start(onUpdate: (raw: RawInbound) => void | Promise<void>): Promise<void> {
    this.onUpdate = onUpdate;
    this.running = true;
  }

  /**
   * Simulate an inbound update arriving. Awaits the adapter's handler so a test
   * can assert on the post-delivery state synchronously. Mirrors the real
   * transport, which invokes the same handler from its poll loop.
   */
  async inject(raw: RawInbound): Promise<void> {
    if (!this.running || !this.onUpdate) {
      throw new Error('loopback transport not started');
    }
    await this.onUpdate(raw);
  }

  /** Register a local fixture to be returned by downloadFile for this fileId. */
  seedDownload(fileId: string, localFixturePath: string): void {
    this.downloadSeeds.set(fileId, localFixturePath);
  }

  async sendText(chatId: string, text: string, opts?: RawSendOptions): Promise<string> {
    const messageId = String(this.msgSeq++);
    this.sent.push({ kind: 'text', chatId, body: text, opts, messageId });
    return messageId;
  }

  async sendFile(
    chatId: string,
    filePath: string,
    kind: FileSendKind,
    opts?: RawSendOptions,
  ): Promise<string> {
    const messageId = String(this.msgSeq++);
    this.sent.push({ kind: 'file', chatId, body: filePath, fileKind: kind, opts, messageId });
    return messageId;
  }

  async downloadFile(fileId: string, destDir: string): Promise<string> {
    const seed = this.downloadSeeds.get(fileId);
    if (!seed || !existsSync(seed)) {
      throw new Error(`loopback: no seeded download for fileId=${fileId}`);
    }
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, `${Date.now()}-${basename(seed)}`);
    copyFileSync(seed, dest);
    return dest;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.onUpdate = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  statusDetail(): string {
    return 'loopback (deterministic, no network)';
  }

  /** Convenience for tests: the last outbound send. */
  get lastSent(): SentRecord | undefined {
    return this.sent[this.sent.length - 1];
  }
}
