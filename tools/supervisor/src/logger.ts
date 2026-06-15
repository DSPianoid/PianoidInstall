/**
 * Structured logging — a thin, dependency-free NDJSON logger.
 *
 * Concern (P2): emit structured log lines. Nothing else. Kept tiny on purpose
 * (the proposal's "keep deps lean"): no winston/pino, just JSON to a stream.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Minimum level to emit. Default 'info'. */
  level?: LogLevel;
  /** Optional file to also write NDJSON lines to (appended). */
  filePath?: string;
  /** Write human lines to stderr too. Default true. */
  stderr?: boolean;
  /** Component tag included in every line. */
  component?: string;
}

export class Logger {
  private readonly minLevel: number;
  private readonly stderr: boolean;
  private readonly component: string;
  private stream: WriteStream | null = null;

  constructor(opts: LoggerOptions = {}) {
    this.minLevel = LEVEL_ORDER[opts.level ?? 'info'];
    this.stderr = opts.stderr ?? true;
    this.component = opts.component ?? 'supervisor';
    if (opts.filePath) {
      mkdirSync(dirname(opts.filePath), { recursive: true });
      this.stream = createWriteStream(opts.filePath, { flags: 'a' });
    }
  }

  /** Child logger with a different component tag (shares the stream config). */
  child(component: string): Logger {
    const c = new Logger({ level: this.levelName(), stderr: this.stderr, component });
    // Share the same file stream so a child doesn't open a second handle.
    (c as unknown as { stream: WriteStream | null }).stream = this.stream;
    return c;
  }

  private levelName(): LogLevel {
    return (Object.keys(LEVEL_ORDER) as LogLevel[]).find((k) => LEVEL_ORDER[k] === this.minLevel) ?? 'info';
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const rec = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(fields ?? {}),
    };
    const line = JSON.stringify(rec);
    if (this.stream) this.stream.write(line + '\n');
    if (this.stderr) {
      const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
      process.stderr.write(`[${rec.ts}] ${level.toUpperCase()} ${this.component}: ${message}${extra}\n`);
    }
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields);
  }

  async close(): Promise<void> {
    if (this.stream) {
      await new Promise<void>((resolve) => this.stream!.end(resolve));
      this.stream = null;
    }
  }
}
