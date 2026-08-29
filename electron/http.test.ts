import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, HttpError } from './http';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('fetchWithRetry', () => {
  it('returns parsed JSON on first success', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as typeof fetch;
    const r = await fetchWithRetry<{ ok: boolean }>({ url: 'https://x' });
    expect(r.ok).toBe(true);
  });

  it('retries on 503 then succeeds', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      if (n === 1) return textResponse('down', 503);
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const r = await fetchWithRetry<{ ok: boolean }>({ url: 'https://x', retries: 2, baseBackoffMs: 1 });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });

  it('throws HttpError after exhausting retries on 5xx', async () => {
    globalThis.fetch = vi.fn(async () => textResponse('boom', 500)) as typeof fetch;
    await expect(fetchWithRetry({ url: 'https://x', retries: 1, baseBackoffMs: 1 })).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('does not retry on 400-class non-throttle errors', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return textResponse('bad', 400);
    }) as typeof fetch;
    await expect(fetchWithRetry({ url: 'https://x', retries: 5, baseBackoffMs: 1 })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(calls).toBe(1);
  });

  it('respects Retry-After header in seconds', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return textResponse('rate', 429, { 'retry-after': '0' });
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const r = await fetchWithRetry<{ ok: boolean }>({ url: 'https://x', retries: 2, baseBackoffMs: 1 });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
