/**
 * Structured logger for the main process.
 *
 * Every message passes through `redactSecrets` before it reaches a sink, so a
 * provider that echoes an Authorization header into an error body cannot put the
 * key in the log file. Header maps and request bodies are never passed here.
 *
 * Design: one `LogSink` owns the file handle and the level; loggers are cheap
 * (sink, scope) pairs, so `child()` never opens a second handle to the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '@shared/errors';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  child(scope: string): Logger;
  setLevel(level: LogLevel): void;
  level(): LogLevel;
  close(): void;
}

export interface LoggerOptions {
  filePath: string | null;
  level?: LogLevel;
  /** Mirror to stdout; development only. */
  echo?: boolean;
  /** Rotate to `<file>.1` once the file exceeds this size. */
  maxBytes?: number;
}

function serialiseContext(context: LogContext | undefined): string {
  if (!context) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    let rendered: string;
    if (value instanceof Error) {
      rendered = value.message;
    } else if (typeof value === 'object' && value !== null) {
      try {
        rendered = JSON.stringify(value);
      } catch {
        rendered = '[unserialisable]';
      }
    } else {
      rendered = String(value);
    }
    parts.push(`${key}=${redactSecrets(rendered).slice(0, 500)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

class LogSink {
  private readonly filePath: string | null;
  private readonly echo: boolean;
  private readonly maxBytes: number;
  private handle: number | null = null;
  private written = 0;
  private currentLevel: LogLevel;

  constructor(options: LoggerOptions) {
    this.filePath = options.filePath;
    this.echo = options.echo ?? false;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.currentLevel = options.level ?? 'info';
    if (this.filePath) this.open();
  }

  private open(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.handle = fs.openSync(this.filePath, 'a');
      this.written = fs.statSync(this.filePath).size;
    } catch {
      // A logger that throws would take the app down. Degrade to echo-only.
      this.handle = null;
    }
  }

  private rotateIfNeeded(): void {
    if (!this.filePath || this.handle === null) return;
    if (this.written < this.maxBytes) return;
    try {
      fs.closeSync(this.handle);
      const backup = `${this.filePath}.1`;
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(this.filePath, backup);
    } catch {
      return;
    }
    this.open();
  }

  getLevel(): LogLevel {
    return this.currentLevel;
  }

  setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  write(level: LogLevel, scope: string | null, message: string, context?: LogContext): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[this.currentLevel]) return;
    const timestamp = new Date().toISOString();
    const scopeLabel = scope ? ` [${scope}]` : '';
    const line = `${timestamp} ${level.toUpperCase()}${scopeLabel} ${redactSecrets(message)}${serialiseContext(context)}`;
    if (this.echo) process.stdout.write(`${line}\n`);
    if (!this.filePath) return;
    try {
      if (this.handle === null) this.open();
      if (this.handle === null) return;
      fs.writeSync(this.handle, `${line}\n`);
      this.written += Buffer.byteLength(line, 'utf8') + 1;
      this.rotateIfNeeded();
    } catch {
      /* logging must never throw into a request path */
    }
  }

  close(): void {
    if (this.handle === null) return;
    try {
      fs.closeSync(this.handle);
    } catch {
      /* already closed */
    }
    this.handle = null;
  }
}

class ScopedLogger implements Logger {
  constructor(private readonly sink: LogSink, private readonly scope: string | null = null) {}

  error(message: string, context?: LogContext): void {
    this.sink.write('error', this.scope, message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.sink.write('warn', this.scope, message, context);
  }

  info(message: string, context?: LogContext): void {
    this.sink.write('info', this.scope, message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.sink.write('debug', this.scope, message, context);
  }

  child(scope: string): Logger {
    const name = this.scope ? `${this.scope}:${scope}` : scope;
    return new ScopedLogger(this.sink, name);
  }

  setLevel(level: LogLevel): void {
    this.sink.setLevel(level);
  }

  level(): LogLevel {
    return this.sink.getLevel();
  }

  close(): void {
    this.sink.close();
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new ScopedLogger(new LogSink(options));
}

/** Used by tests and by code paths that run before a log path is known. */
export function createNullLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    child: () => logger,
    setLevel: noop,
    level: () => 'error',
    close: noop,
  };
  return logger;
}
