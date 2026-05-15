// HTTP helper with timeout, retry with exponential backoff, and Retry-After
// awareness. Used by skill connectors so a transient 429 / 503 doesn't kill
// a sync. Pure function over global fetch; no extra deps.

export interface FetchOptions {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
  retries?: number;
  retryOnStatus?: (status: number) => boolean;
  baseBackoffMs?: number;
}

const defaultRetryOnStatus = (s: number): boolean => s === 408 || s === 425 || s === 429 || s >= 500;

export class HttpError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
  }
}

export async function fetchWithRetry<T = unknown>(opts: FetchOptions): Promise<T> {
  const {
    url,
    init = {},
    timeoutMs = 15_000,
    retries = 3,
    retryOnStatus = defaultRetryOnStatus,
    baseBackoffMs = 500,
  } = opts;

  let attempt = 0;
  let lastErr: Error | null = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) return (await res.json()) as T;
        return (await res.text()) as unknown as T;
      }

      if (!retryOnStatus(res.status) || attempt === retries) {
        const body = await res.text().catch(() => '');
        throw new HttpError(res.status, body, `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      }

      // Honor Retry-After when present (seconds or HTTP-date).
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const backoff = retryAfter ?? backoffFor(attempt, baseBackoffMs);
      await sleep(backoff);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      const isAbort = (err as { name?: string }).name === 'AbortError';
      const isHttp = err instanceof HttpError;
      if (isHttp || attempt === retries) throw err;
      // Network or timeout: backoff and retry.
      await sleep(backoffFor(attempt, baseBackoffMs));
      if (!isAbort) lastErr = err instanceof Error ? err : new Error(String(err));
    }
    attempt++;
  }

  throw lastErr ?? new Error(`fetchWithRetry: exhausted retries for ${url}`);
}

function backoffFor(attempt: number, base: number): number {
  // Exponential with jitter: base * 2^attempt * random(0.5..1.5)
  const exp = base * Math.pow(2, attempt);
  const jitter = 0.5 + Math.random();
  return Math.round(exp * jitter);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const t = Date.parse(value);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
