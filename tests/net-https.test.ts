import type { LookupAddress } from 'node:dns';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { request, RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGuardedLookup,
  createJsonHttp,
  publicUnicastAddress,
  retryAfterDate,
} from '../src/net/https.js';

const now = new Date('2026-09-15T18:00:00Z');
const url = 'https://api.open-meteo.com/v1/forecast?latitude=48';
const validateUrl = (value: string) => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.open-meteo.com')
    throw new Error('malformed');
  return parsed;
};

type Reply = {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string | Buffer[];
  complete?: boolean;
  error?: boolean;
  stall?: 'headers' | 'body';
  delay?: number;
};

// No sockets or real DNS: Node's request/stream interface is driven in memory.
const fixture = (
  replies: Reply[],
  options: Partial<Parameters<typeof createJsonHttp>[0]> = {},
  useDns = false,
) => {
  const requests: { url: URL; options: RequestOptions }[] = [];
  const transport = ((
    target: URL,
    settings: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    const reply = replies[requests.length] ?? {};
    const req = Object.assign(new EventEmitter(), {
      end: () => {
        const respond = () => {
          if (reply.stall === 'headers' || req.destroyed) return;
          const response = Object.assign(new PassThrough(), {
            statusCode: reply.status ?? 200,
            headers: reply.headers ?? { 'content-type': 'application/json; charset=utf-8' },
            complete: reply.complete ?? true,
          }) as unknown as IncomingMessage;
          callback(response);
          queueMicrotask(() => {
            const body = reply.body ?? '{"ok":true}';
            const stream = response as unknown as PassThrough;
            for (const chunk of Array.isArray(body) ? body : [body]) stream.write(chunk);
            if (reply.error) stream.destroy(new Error('private transport details'));
            else if (reply.stall !== 'body') stream.end();
          });
        };
        queueMicrotask(() => {
          if (useDns)
            settings.lookup!(target.hostname, { all: true }, (error) => {
              if (error) req.emit('error', error);
              else respond();
            });
          else if (reply.delay) setTimeout(respond, reply.delay);
          else respond();
        });
      },
      destroyed: false,
      destroy: vi.fn(() => {
        req.destroyed = true;
        return req;
      }),
    });
    requests.push({ url: target, options: settings });
    return req as unknown as ClientRequest;
  }) as typeof request;
  return {
    fetch: createJsonHttp({
      validateUrl,
      userAgent: 'JolandaBriefing/1.0',
      request: transport,
      now: () => now,
      ...options,
    }),
    requests,
  };
};

afterEach(() => vi.useRealTimers());

describe('bounded JSON retrieval', () => {
  const signal = () => new AbortController().signal;

  it('parses an allowlisted JSON response and sends read-only headers', async () => {
    const f = fixture([{ body: '{"daily":{"temperature_2m_max":[23.4]}}' }]);
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({
      outcome: 'ok',
      json: { daily: { temperature_2m_max: [23.4] } },
    });
    expect(f.requests[0]?.options.headers).toMatchObject({
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': 'JolandaBriefing/1.0',
    });
    expect(f.requests[0]?.options.agent).toBe(false);
  });

  it('rejects a host outside the allowlist before opening a socket', async () => {
    const f = fixture([{}]);
    await expect(
      f.fetch({ url: 'https://metadata.google.internal/v1/forecast', signal: signal() }),
    ).resolves.toEqual({ outcome: 'malformed' });
    expect(f.requests).toHaveLength(0);
  });

  it.each([
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [403, 'access-denied'],
    [401, 'access-denied'],
    [500, 'unavailable'],
    [204, 'unavailable'],
  ])('maps status %s to %s', async (status, outcome) => {
    const f = fixture([{ status }]);
    await expect(f.fetch({ url, signal: signal() })).resolves.toMatchObject({ outcome });
  });

  it('honors a numeric Retry-After on a rate limit', async () => {
    const f = fixture([{ status: 429, headers: { 'retry-after': '120' } }]);
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({
      outcome: 'rate-limited',
      retryAt: new Date(+now + 120_000),
    });
  });

  it.each([
    ['text/html; charset=utf-8', { 'content-type': 'text/html; charset=utf-8' }],
    ['a non-utf8 charset', { 'content-type': 'application/json; charset=iso-8859-1' }],
    ['a compressed body', { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
    [
      'an oversized declared length',
      { 'content-type': 'application/json', 'content-length': '999999999' },
    ],
  ])('refuses %s', async (_label, headers) => {
    const f = fixture([{ headers }]);
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({ outcome: 'malformed' });
  });

  it('refuses a redirect instead of following it', async () => {
    const f = fixture([{ status: 302, headers: { location: 'https://api.open-meteo.com/v2' } }]);
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({ outcome: 'unavailable' });
    expect(f.requests).toHaveLength(1);
  });

  it.each([
    ['unparseable JSON', 'not json at all'],
    ['an empty body', ''],
  ])('refuses %s', async (_label, body) => {
    const f = fixture([{ body }]);
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({ outcome: 'malformed' });
  });

  it('refuses a body beyond the configured limit', async () => {
    const f = fixture([{ body: [Buffer.alloc(200), Buffer.alloc(200)] }], { maximumBytes: 256 });
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({ outcome: 'malformed' });
  });

  it('reports a truncated response as unavailable rather than malformed', async () => {
    const f = fixture([{ complete: false }]);
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({ outcome: 'unavailable' });
  });

  it('reports its own deadline as a timeout', async () => {
    vi.useFakeTimers();
    const f = fixture([{ stall: 'headers' }], { timeoutMs: 25 });
    const pending = f.fetch({ url, signal: signal() });
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toEqual({ outcome: 'timeout' });
  });

  it('reports caller cancellation as cancelled, before and during the request', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const f = fixture([{}]);
    await expect(f.fetch({ url, signal: aborted.signal })).resolves.toEqual({
      outcome: 'cancelled',
    });
    expect(f.requests).toHaveLength(0);

    const midFlight = new AbortController();
    const g = fixture([{ stall: 'body' }]);
    const pending = g.fetch({ url, signal: midFlight.signal });
    queueMicrotask(() => midFlight.abort());
    await expect(pending).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('never leaks a transport error message', async () => {
    const f = fixture([{ error: true }]);
    const result = await f.fetch({ url, signal: signal() });
    expect(JSON.stringify(result)).not.toContain('private transport details');
    expect(result.outcome).toBe('unavailable');
  });

  it('refuses a private DNS answer through the shared guard', async () => {
    const resolve = async (): Promise<LookupAddress[]> => [
      { address: '169.254.169.254', family: 4 },
    ];
    const f = fixture([{}], { lookup: createGuardedLookup(resolve) }, true);
    await expect(f.fetch({ url, signal: signal() })).resolves.toEqual({ outcome: 'malformed' });
  });

  it.each([
    [0, 'deadline'],
    [25_001, 'deadline'],
  ])('rejects an invalid deadline of %s', (timeoutMs) => {
    expect(() =>
      createJsonHttp({ validateUrl, userAgent: 'x', timeoutMs, maximumBytes: 1_000 }),
    ).toThrow('Invalid JSON HTTP deadline');
  });

  it('rejects an invalid body limit', () => {
    expect(() => createJsonHttp({ validateUrl, userAgent: 'x', maximumBytes: 3_000_001 })).toThrow(
      'Invalid JSON HTTP body limit',
    );
  });
});

describe('shared network guards', () => {
  it.each(['127.0.0.1', '169.254.169.254', '10.0.0.5', '::1', 'not-an-address'])(
    'treats %s as non-public',
    (address) => expect(publicUnicastAddress(address)).toBe(false),
  );

  it('accepts public unicast addresses', () => {
    expect(publicUnicastAddress('8.8.8.8')).toBe(true);
    expect(publicUnicastAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('ignores an unusable Retry-After value', () => {
    expect(retryAfterDate(undefined, now)).toBeUndefined();
    expect(retryAfterDate('x'.repeat(200), now)).toBeUndefined();
    expect(retryAfterDate('not-a-date', now)).toBeUndefined();
    // A past instant is not a usable retry point.
    expect(retryAfterDate(new Date(+now - 60_000).toUTCString(), now)).toBeUndefined();
    expect(retryAfterDate(new Date(+now + 60_000).toUTCString(), now)).toBeInstanceOf(Date);
  });

  it('reports a resolver failure as unavailable', async () => {
    const guarded = createGuardedLookup(async () => {
      throw new Error('resolver down');
    });
    const error = await new Promise<Error | null>((resolve) =>
      guarded('api.open-meteo.com', { all: true }, (failure) => resolve(failure as Error | null)),
    );
    expect(error?.message).toBe('unavailable');
  });

  it('returns a single checked address when all is not requested', async () => {
    const guarded = createGuardedLookup(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const picked = await new Promise<string>((resolve) =>
      guarded('api.open-meteo.com', { family: 6 }, (_error, address) => resolve(String(address))),
    );
    expect(picked).toBe('2606:4700:4700::1111');
  });
});
