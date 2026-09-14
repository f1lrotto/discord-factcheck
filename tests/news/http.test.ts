import type { LookupAllOptions, LookupAddress } from 'node:dns';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { request, RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNewsHttp,
  createNewsLookup,
  publicNewsAddress,
  validateNewsUrl,
} from '../../src/news/http.js';

const url = 'https://dennikn.sk/minuta/dolezite';
const now = new Date('2026-09-14T18:00:00Z');
const input = { url, source: 'dennikn' as const, signal: new AbortController().signal };
type Reply = {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string | Buffer | Buffer[];
  complete?: boolean;
  error?: boolean;
  stall?: 'headers' | 'body';
  delay?: number;
};

// No server, sockets or real DNS: exercise Node's request/stream interface in memory.
const fixture = (
  replies: Reply[],
  options: Parameters<typeof createNewsHttp>[0] = {},
  useDns = false,
) => {
  const requests: { url: URL; options: RequestOptions; request: ClientRequest }[] = [];
  const responses: IncomingMessage[] = [];
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
            headers: reply.headers ?? { 'content-type': 'text/html; charset=utf-8' },
            complete: reply.complete ?? true,
          }) as unknown as IncomingMessage;
          responses.push(response);
          callback(response);
          queueMicrotask(() => {
            const body = reply.body ?? '<p>Správy</p>';
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
    requests.push({ url: target, options: settings, request: req as unknown as ClientRequest });
    return req as unknown as ClientRequest;
  }) as typeof request;
  return {
    fetch: createNewsHttp({ request: transport, now: () => now, ...options }),
    requests,
    responses,
  };
};

afterEach(() => vi.useRealTimers());

describe('publisher URL boundaries', () => {
  it.each([
    [url, 'dennikn', 'page'],
    ['https://e.dennikn.sk/minuta/5558475/', 'dennikn', 'page'],
    ['https://www.dennikn.sk/minuta/5559444/#section', 'dennikn', 'page'],
    ['https://www.aktuality.sk/spravy/denny-vyber-sprav/', 'aktuality', 'page'],
    ['https://aktuality.sk/clanok/hAUs7Al/denny-vyber/', 'aktuality', 'page'],
    ['https://img.projektn.sk/wp-static/2026/09/photo.jpg?w=200', 'dennikn', 'image'],
    [
      'https://img.aktuality.sk/foto/story/encoded-localhost-transform?st=signature',
      'aktuality',
      'image',
    ],
  ] as const)('accepts %s', (value, source, kind) => {
    expect(validateNewsUrl(value, source, kind).href).toBe(value.split('#')[0]);
  });
  it.each([
    'invalid',
    'http://dennikn.sk/minuta/dolezite',
    'https://dennikn.sk:444/minuta/dolezite',
    'https://user:secret@dennikn.sk/minuta/dolezite',
    'https://dennikn.sk.evil.test/minuta/dolezite',
    'https://evildennikn.sk/minuta/dolezite',
    'https://e.dennikn.sk.evil.test/minuta/5558475/',
    'https://127.0.0.1/minuta/dolezite',
    'https://dennikn.sk/admin',
    'https://dennikn.sk/minuta/dolezite?redirect=private',
    'https://dennikn.sk/minuta/%2fdolezite',
    'https://dennikn.sk\\minuta\\dolezite',
    ' https://dennikn.sk/minuta/dolezite',
    'https://dennikn.sk/minuta/1/#' + 'x'.repeat(2048),
    'https://www.aktuality.sk/clanok/id/slug/',
  ])('rejects %s', (value) => expect(() => validateNewsUrl(value, 'dennikn')).toThrow('malformed'));
  it.each([
    ['https://img.projektn.sk/other/image.jpg', 'dennikn'],
    ['https://img.projektn.sk.evil.test/wp-static/2026/09/image.jpg', 'dennikn'],
    ['https://img.aktuality.sk/other/image.jpg', 'aktuality'],
    ['https://img.projektn.sk/wp-static/2026/09/image.jpg', 'aktuality'],
    ['https://www.aktuality.sk/login', 'aktuality'],
  ] as const)('rejects foreign image/path %s', (value, source) =>
    expect(() => validateNewsUrl(value, source, 'image')).toThrow('malformed'),
  );
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '192.0.2.1',
    '100.64.0.1',
    '224.0.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    'not-ip',
  ])('rejects nonpublic DNS address %s', (address) =>
    expect(publicNewsAddress(address)).toBe(false),
  );
  it('accepts public IPv4 and IPv6', () => {
    expect(publicNewsAddress('8.8.8.8')).toBe(true);
    expect(publicNewsAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe('DNS pinning', () => {
  const publicAddresses = [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  const resolver = () =>
    vi.fn<(host: string, options: LookupAllOptions) => Promise<LookupAddress[]>>();
  it('supplies only checked addresses directly to both socket callback forms', async () => {
    const resolve = resolver().mockResolvedValue(publicAddresses);
    const dns = createNewsLookup(resolve);
    const all = vi.fn();
    dns('dennikn.sk', { all: true }, all);
    await vi.waitFor(() => expect(all).toHaveBeenCalledWith(null, publicAddresses));
    const single = vi.fn();
    dns('dennikn.sk', { family: 6 }, single);
    await vi.waitFor(() =>
      expect(single).toHaveBeenCalledWith(null, publicAddresses[1]!.address, 6),
    );
    expect(resolve).toHaveBeenCalledWith('dennikn.sk', { all: true, verbatim: true });
  });
  it.each(['empty', 'private', 'mixed', 'family', 'error'])('fails closed for %s', async (mode) => {
    const resolve = resolver().mockResolvedValue(
      mode === 'empty'
        ? []
        : mode === 'family'
          ? publicAddresses.slice(0, 1)
          : [...(mode === 'mixed' ? publicAddresses : []), { address: '127.0.0.1', family: 4 }],
    );
    if (mode === 'error') resolve.mockRejectedValue(new Error('secret DNS details'));
    const callback = vi.fn();
    createNewsLookup(resolve)('dennikn.sk', { family: mode === 'family' ? 6 : 0 }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 4));
  });
  it('uses one validated lookup per connection and rejects a later rebinding answer', async () => {
    const resolve = resolver()
      .mockResolvedValueOnce(publicAddresses)
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const f = fixture([{}, {}], { lookup: createNewsLookup(resolve) }, true);
    expect((await f.fetch(input)).outcome).toBe('ok');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await f.fetch(input)).toEqual({ outcome: 'malformed' });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(f.responses).toHaveLength(1);
    expect(f.requests.every(({ options }) => options.agent === false)).toBe(true);
  });
  it('bounds stalled DNS by the total deadline', async () => {
    vi.useFakeTimers();
    const f = fixture(
      [{}],
      { lookup: createNewsLookup(() => new Promise(() => undefined)), timeoutMs: 25 },
      true,
    );
    const result = f.fetch(input);
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toEqual({ outcome: 'timeout' });
    expect(f.requests[0]!.request.destroyed).toBe(true);
  });
});

describe('conditional anonymous retrieval', () => {
  it('returns 200 body and proposed bounded validators without mutating cache', async () => {
    const cache = Object.freeze({ etag: '"old"', lastModified: 'Sun, 13 Sep 2026 12:00:00 GMT' });
    const f = fixture([
      {
        headers: {
          'content-type': 'text/html',
          etag: '"new"',
          'last-modified': 'Mon, 14 Sep 2026 12:00:00 GMT',
          'set-cookie': ['tracking=secret'],
        },
      },
    ]);
    expect(await f.fetch({ ...input, validators: cache })).toEqual({
      outcome: 'ok',
      html: '<p>Správy</p>',
      url,
      validators: { etag: '"new"', lastModified: 'Mon, 14 Sep 2026 12:00:00 GMT' },
    });
    expect(cache.etag).toBe('"old"');
    expect(f.requests[0]!.options.headers).toEqual({
      'User-Agent': 'JolandaNews/1.0',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Encoding': 'identity',
      'If-None-Match': '"old"',
      'If-Modified-Since': cache.lastModified,
    });
    expect(f.responses[0]!.destroyed).toBe(true);
  });
  it('accepts 304 only with sent validators, retaining absent response validators', async () => {
    const f = fixture([
      { status: 304, headers: { etag: '"new"' } },
      { status: 304, headers: {} },
    ]);
    expect(
      await f.fetch({ ...input, validators: { etag: '"old"', lastModified: 'yesterday' } }),
    ).toEqual({ outcome: 'unchanged', validators: { etag: '"new"', lastModified: 'yesterday' } });
    expect(await f.fetch(input)).toEqual({ outcome: 'malformed' });
  });
  it('drops oversized/control-bearing cache headers on input and output', async () => {
    const f = fixture([
      {
        headers: {
          'content-type': 'application/xhtml+xml',
          etag: 'x'.repeat(1025),
          'last-modified': 'bad\r\nCookie: secret',
        },
      },
    ]);
    const result = await f.fetch({
      ...input,
      validators: { etag: 'bad\n', lastModified: 'x'.repeat(1025) },
    });
    expect(result).toMatchObject({ outcome: 'ok', validators: {} });
    expect(f.requests[0]!.options.headers).not.toHaveProperty('If-None-Match');
    expect(f.requests[0]!.options.headers).not.toHaveProperty('If-Modified-Since');
  });
  it('does not expose failed-response validators or transport errors', async () => {
    const f = fixture([{ headers: { etag: '"bad"' } }, { error: true }]);
    const cache = { etag: '"good"' };
    expect(await f.fetch({ ...input, validators: cache })).toEqual({ outcome: 'malformed' });
    expect(cache).toEqual({ etag: '"good"' });
    expect(await f.fetch(input)).toEqual({ outcome: 'unavailable' });
  });
});

describe('redirect budget and validation', () => {
  it('follows a valid redirect and never forwards validators or response cookies', async () => {
    const f = fixture([
      { status: 302, headers: { location: '/minuta/5559444/', 'set-cookie': ['session=secret'] } },
      {},
    ]);
    expect(await f.fetch({ ...input, validators: { etag: '"listing"' } })).toMatchObject({
      outcome: 'ok',
      url: 'https://dennikn.sk/minuta/5559444/',
    });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.options.headers).not.toHaveProperty('If-None-Match');
    expect(f.requests[1]!.options.headers).not.toHaveProperty('Cookie');
  });
  it.each([
    undefined,
    '/minuta/dolezite',
    'https://evil.test/minuta/1/',
    '/admin',
    'http://dennikn.sk/minuta/1/',
    'https://127.0.0.1/minuta/1/',
    'https://www.aktuality.sk/clanok/id/slug/',
    'https://user:secret@dennikn.sk/minuta/1/',
  ])('rejects redirect %s before a second request', async (location) => {
    const f = fixture([{ status: 301, headers: location ? { location } : {} }]);
    expect(await f.fetch(input)).toEqual({ outcome: 'malformed' });
    expect(f.requests).toHaveLength(1);
  });
  it('caps acyclic redirects at three hops', async () => {
    const f = fixture(
      [1, 2, 3, 4].map((id) => ({ status: 307, headers: { location: `/minuta/${id}/` } })),
    );
    expect(await f.fetch(input)).toEqual({ outcome: 'malformed' });
    expect(f.requests).toHaveLength(4);
    expect(f.responses.every((response) => response.destroyed)).toBe(true);
  });
  it('does not accept a target 304 after dropping original-resource validators', async () => {
    const f = fixture([
      { status: 308, headers: { location: '/minuta/1/' } },
      { status: 304, headers: {} },
    ]);
    expect(await f.fetch({ ...input, validators: { etag: '"listing"' } })).toEqual({
      outcome: 'malformed',
    });
  });
});

describe('bounded bodies and outcomes', () => {
  it.each([
    [{}, 'malformed'],
    [{ 'content-type': 'application/json' }, 'malformed'],
    [{ 'content-type': 'text/htmlish' }, 'malformed'],
    [{ 'content-type': 'text/html;charset=windows-1250' }, 'malformed'],
    [{ 'content-type': 'text/html', 'content-encoding': 'gzip' }, 'malformed'],
    [{ 'content-type': 'text/html', 'content-length': '21' }, 'malformed'],
    [{ 'content-type': 'text/html', 'content-length': '-1' }, 'malformed'],
    [{ 'content-type': 'text/html', 'content-length': '15' }, 'unavailable'],
  ])('rejects invalid headers %j', async (headers, outcome) => {
    const f = fixture([{ headers: headers as IncomingHttpHeaders }], { maximumBytes: 20 });
    expect(await f.fetch(input)).toEqual({ outcome });
    expect(f.responses[0]!.destroyed).toBe(true);
  });
  it('counts actual bytes with or without declared length', async () => {
    const body = '<p>é</p>';
    const f = fixture(
      [
        {
          body,
          headers: {
            'content-type': 'TEXT/HTML; charset="UTF-8"',
            'content-length': String(Buffer.byteLength(body)),
          },
        },
        { body: [Buffer.alloc(5), Buffer.alloc(6)] },
      ],
      { maximumBytes: 10 },
    );
    expect(await f.fetch(input)).toMatchObject({ outcome: 'ok', html: body });
    expect(await f.fetch(input)).toEqual({ outcome: 'malformed' });
  });
  it.each([{ body: '' }, { body: Buffer.from([0xff]) }, { complete: false }, { error: true }])(
    'rejects empty, invalid UTF-8 or partial body %j',
    async (reply) => {
      const f = fixture([reply]);
      expect(await f.fetch(input)).toEqual({
        outcome: reply.complete === false || reply.error ? 'unavailable' : 'malformed',
      });
    },
  );
  it.each([
    [401, 'access-denied'],
    [403, 'access-denied'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [500, 'unavailable'],
    [404, 'unavailable'],
  ])('classifies HTTP %s', async (status, outcome) => {
    expect(await fixture([{ status: status as number }]).fetch(input)).toEqual({ outcome });
  });
  it.each([403, 429, 503])('honors delta and date Retry-After on %s', async (status) => {
    const f = fixture([
      { status, headers: { 'retry-after': '120' } },
      { status, headers: { 'retry-after': 'Mon, 14 Sep 2026 19:00:00 GMT' } },
    ]);
    expect(await f.fetch(input)).toMatchObject({ retryAt: new Date('2026-09-14T18:02:00Z') });
    expect(await f.fetch(input)).toMatchObject({ retryAt: new Date('2026-09-14T19:00:00Z') });
  });
  it.each([
    'bad',
    '-1',
    '0',
    '999999999999999999999',
    'Sun, 13 Sep 2026 12:00:00 GMT',
    '1'.repeat(129),
  ])('ignores unusable Retry-After %s', async (value) => {
    expect(
      await fixture([{ status: 429, headers: { 'retry-after': value } }]).fetch(input),
    ).toEqual({ outcome: 'rate-limited' });
  });
  it.each(['headers', 'body'] as const)(
    'enforces its own total deadline during %s',
    async (stall) => {
      vi.useFakeTimers();
      const f = fixture([{ stall }], { timeoutMs: 50 });
      const pending = f.fetch(input);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toEqual({ outcome: 'timeout' });
      expect(f.requests[0]!.request.destroyed).toBe(true);
      expect(f.responses.every((response) => response.destroyed)).toBe(true);
    },
  );
  it('does not restart the deadline on redirects', async () => {
    vi.useFakeTimers();
    const f = fixture(
      [{ status: 302, headers: { location: '/minuta/1/' }, delay: 20 }, { delay: 20 }],
      { timeoutMs: 25 },
    );
    const pending = f.fetch(input);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ outcome: 'timeout' });
    expect(f.requests).toHaveLength(2);
  });
  it.each(['headers', 'body'] as const)(
    'cancels during %s and cleans up promptly',
    async (stall) => {
      const controller = new AbortController();
      const f = fixture([{ stall }]);
      const pending = f.fetch({ ...input, signal: controller.signal });
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      expect(await pending).toEqual({ outcome: 'cancelled' });
      expect(f.requests[0]!.request.destroyed).toBe(true);
    },
  );
  it('makes no request on pre-abort or an unsafe URL', async () => {
    const f = fixture([]);
    expect(await f.fetch({ ...input, signal: AbortSignal.abort() })).toEqual({
      outcome: 'cancelled',
    });
    expect(await f.fetch({ ...input, url: 'https://evil.test/' })).toEqual({
      outcome: 'malformed',
    });
    expect(f.requests).toHaveLength(0);
  });
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { timeoutMs: 25_001 },
    { maximumBytes: 0 },
    { maximumBytes: 3_000_001 },
  ])('rejects invalid bounds %j', (options) => expect(() => createNewsHttp(options)).toThrow());
});

describe('captured fixture provenance', () => {
  it('keeps the reconstructed Denník envelope strict JSON and matches the real minimized state', async () => {
    const root = new URL('./fixtures/publishers/', import.meta.url);
    const html = await readFile(new URL('dennikn-initial-state.html', root), 'utf8');
    const state = JSON.parse(await readFile(new URL('dennikn-initial-state.json', root), 'utf8'));
    expect(
      JSON.parse(html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/)![1]!),
    ).toEqual(state);
    expect(
      state.postsApi.queries['getInfinitePosts({"important":1,"language":"sk"})'].data.pages[0]
        .posts[0].published_at,
    ).toBe('2026-09-14T08:45:35+02:00');
  });
});
