// Structured JSON-lines logger that never prints registered secrets.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export function isLogLevel(value: string): value is LogLevel {
  return value in LEVELS;
}

const secrets = new Set<string>();
let minLevel: number = LEVELS.info;
let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

export function setLogLevel(level: LogLevel): void {
  minLevel = LEVELS[level];
}

/** Replace the output sink (used by tests). Returns a function restoring the previous sink. */
export function setLogSink(next: (line: string) => void): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

/** Register a value that must never appear in logs. Also covers its HTTP Basic encodings. */
export function registerSecret(value: string, basicAuthUser?: string): void {
  if (value.length < 4) return;
  secrets.add(value);
  secrets.add(encodeURIComponent(value));
  if (basicAuthUser !== undefined) secrets.add(btoa(`${basicAuthUser}:${value}`));
}

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

export function redact(text: string): string {
  let out = text.replace(URL_USERINFO, "$1***@");
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("***");
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

type Fields = Record<string, unknown>;

function emit(level: LogLevel, msg: string, fields?: Fields): void {
  if (LEVELS[level] < minLevel) return;
  const record: Fields = { ts: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      record[key] = value instanceof Error ? errorMessage(value) : value;
    }
  }
  sink(redact(JSON.stringify(record)));
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
