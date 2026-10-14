export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => Bun.sleep(ms);

/** Exponential backoff with ±20% jitter: base * 2^attempt, capped at max. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(maxMs, exp + jitter)));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}
