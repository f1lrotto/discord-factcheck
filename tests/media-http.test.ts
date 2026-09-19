import { createServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import type { request } from 'node:https';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMediaLookup,
  createInstagramPageFetcher,
  createTikTokResolver,
  createTikTokPageFetcher,
  createMediaTransfer,
  publicMediaAddress,
  validateMediaUrl,
} from '../src/media-http.js';
const resources: { root: string; server: Server }[] = [];
afterEach(async () => {
  for (const { root, server } of resources.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
const fixture = async (handler: RequestListener) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const root = await mkdtemp(join(tmpdir(), 'media-http-'));
  resources.push({ root, server });
  const fakeRequest = ((
    url: URL,
    options: Parameters<typeof request>[1],
    callback: Parameters<typeof request>[2],
  ) => {
    void options;
    return httpRequest(
      `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
      {
        signal: (options as { signal: AbortSignal }).signal,
        method: (options as { method?: string }).method,
        headers: (options as { headers?: Record<string, string> }).headers,
      },
      callback,
    );
  }) as typeof request;
  const transfer = createMediaTransfer({ request: fakeRequest, lookup: createMediaLookup() });
  const input = {
    url: 'https://video.cdninstagram.com/a',
    path: join(root, 'video.mp4'),
    maximumBytes: 10,
    signal: AbortSignal.timeout(2000),
  };
  return {
    transfer,
    input,
    fetchInstagram: createInstagramPageFetcher({
      request: fakeRequest,
      lookup: createMediaLookup(),
    }),
    fetchPage: createTikTokPageFetcher({ request: fakeRequest, lookup: createMediaLookup() }),
    resolve: createTikTokResolver({ request: fakeRequest, lookup: createMediaLookup() }),
  };
};
describe('media network boundaries', () => {
  it.each(['https://video.cdninstagram.com/x', 'https://a.fbcdn.net/x'])('accepts %s', (url) =>
    expect(validateMediaUrl(url).href).toBe(url),
  );
  it.each([
    'invalid',
    'http://a.fbcdn.net/x',
    'https://a.fbcdn.net:444/x',
    'https://user@a.fbcdn.net/x',
    'https://fbcdn.net.evil.test/x',
    'https://evilfbcdn.net/x',
    'https://127.0.0.1/x',
  ])('rejects %s', (url) => expect(() => validateMediaUrl(url)).toThrow('unsupported_media'));
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '192.0.2.1',
    '224.0.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    'not-ip',
  ])('rejects reserved or mapped address %s', (address) =>
    expect(publicMediaAddress(address)).toBe(false),
  );
  it('pins validated DNS answers for both lookup callback forms', async () => {
    const resolve = vi
      .fn<NonNullable<Parameters<typeof createMediaLookup>[0]>>()
      .mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ]);
    const dns = createMediaLookup(resolve);
    const callback = vi.fn();
    dns('a.fbcdn.net', { family: 4 }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4));
    callback.mockClear();
    dns('a.fbcdn.net', { all: true }, callback);
    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith(
        null,
        expect.arrayContaining([{ address: '8.8.8.8', family: 4 }]),
      ),
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it.each(['private', 'empty', 'family', 'failure'])('fails DNS closed: %s', async (mode) => {
    const resolve = vi
      .fn<NonNullable<Parameters<typeof createMediaLookup>[0]>>()
      .mockResolvedValue(
        mode === 'empty'
          ? []
          : [{ address: mode === 'private' ? '127.0.0.1' : '8.8.8.8', family: 4 }],
      );
    if (mode === 'failure') resolve.mockRejectedValue(new Error('DNS'));
    const callback = vi.fn();
    createMediaLookup(resolve)('a.fbcdn.net', { family: mode === 'family' ? 6 : 0 }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 4));
  });
});
describe('bounded streaming', () => {
  it('streams missing length through a validated redirect', async () => {
    const { transfer, input } = await fixture((req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { location: '/b' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.write('video');
        res.end();
      }
    });
    expect(await transfer(input)).toBe(5);
    expect(await readFile(input.path, 'utf8')).toBe('video');
  });
  it.each([
    'declared',
    'streamed',
    'html',
    'empty',
    'redirect_loop',
    'redirect_private',
    'missing_location',
    '429',
    '403',
    '500',
  ])('rejects %s', async (mode) => {
    const { transfer, input } = await fixture((_req, res) => {
      if (mode === 'declared') res.writeHead(200, { 'content-length': '20' });
      else if (mode === 'html') res.writeHead(200, { 'content-type': 'text/html' });
      else if (mode.startsWith('redirect'))
        res.writeHead(302, {
          location: mode === 'redirect_private' ? 'https://127.0.0.1/x' : '/a',
        });
      else if (mode === 'missing_location') res.writeHead(302);
      else if (/^\d+$/.test(mode)) res.writeHead(Number(mode));
      else res.writeHead(200);
      res.write(mode === 'empty' ? '' : 'x'.repeat(mode === 'streamed' ? 11 : 5));
      res.end();
    });
    if (mode === 'declared' || mode === 'streamed') {
      await expect(transfer(input)).rejects.toMatchObject({
        category: 'too_large',
        size: mode === 'declared' ? { bytes: 20 } : { bytes: 11, atLeast: true },
      });
    } else await expect(transfer(input)).rejects.toThrow();
  });
  it('aborts stalled responses and contains write errors', async () => {
    const { transfer, input } = await fixture((_req, res) => {
      res.writeHead(200);
      res.write('x');
    });
    await expect(transfer({ ...input, signal: AbortSignal.timeout(50) })).rejects.toThrow();
    await expect(
      transfer({ ...input, path: '/no/such/directory/file', signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
  });
});

describe('TikTok network boundaries', () => {
  it.each([
    'tiktokcdn.com',
    'tiktokcdn-us.com',
    'tiktokcdn-eu.com',
    'tiktokv.com',
    'tiktokv.us',
    'byteoversea.com',
    'ibytedtos.com',
  ])('accepts bounded TikTok CDN %s only for TikTok', (host) => {
    const url = `https://video.${host}/video.mp4`;
    expect(validateMediaUrl(url, 'tiktok').href).toBe(url);
    expect(() => validateMediaUrl(url)).toThrow('unsupported_media');
  });
  it.each([
    'https://tiktokcdn.com.evil.test/a',
    'https://eviltiktokcdn.com/a',
    'http://video.tiktokcdn.com/a',
    'https://user@video.tiktokcdn.com/a',
    'https://video.cdninstagram.com/a',
  ])('rejects %s for TikTok', (url) => {
    expect(() => validateMediaUrl(url, 'tiktok')).toThrow('unsupported_media');
  });
  it('streams TikTok media and rejects cross-platform redirects', async () => {
    const s = await fixture((req, res) => {
      if (req.url === '/bad') res.writeHead(302, { location: 'https://video.cdninstagram.com/a' });
      else res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end('video');
    });
    expect(
      await s.transfer({ ...s.input, platform: 'tiktok', url: 'https://video.tiktokcdn.com/good' }),
    ).toBe(5);
    await expect(
      s.transfer({ ...s.input, platform: 'tiktok', url: 'https://video.tiktokcdn.com/bad' }),
    ).rejects.toThrow('unsupported_media');
  });
  it('resolves short links to a canonical video before extraction', async () => {
    const paths: string[] = [];
    const s = await fixture((req, res) => {
      paths.push(req.url!);
      expect(req.method).toBe('HEAD');
      res.writeHead(302, {
        location:
          req.url === '/ABC/'
            ? 'https://www.tiktok.com/t/DEF/'
            : 'https://www.tiktok.com/@creator/video/123?tracking=private',
      });
      res.end();
    });
    expect(await s.resolve('https://vm.tiktok.com/ABC/', s.input.signal)).toEqual({
      platform: 'tiktok',
      shortcode: 'tiktok:video:123',
      url: 'https://www.tiktok.com/@creator/video/123',
    });
    expect(paths).toEqual(['/ABC/', '/t/DEF/']);
  });
  it.each(['private', 'foreign', 'profile', 'loop', 'missing', '429', '200'])(
    'rejects unsafe or unavailable short-link redirect: %s',
    async (kind) => {
      let requests = 0;
      const targets: Record<string, string> = {
        private: 'https://127.0.0.1/x',
        foreign: 'https://evil.test/x',
        profile: 'https://www.tiktok.com/@creator',
        loop: '/ABC/',
      };
      const s = await fixture((_req, res) => {
        requests++;
        res.writeHead(
          kind === '429' ? 429 : kind === '200' ? 200 : 302,
          targets[kind] ? { location: targets[kind] } : {},
        );
        res.end();
      });
      await expect(s.resolve('https://vm.tiktok.com/ABC/', s.input.signal)).rejects.toThrow();
      expect(requests).toBe(kind === 'loop' ? 3 : 1);
    },
  );
  it('aborts stalled share resolution', async () => {
    const s = await fixture(() => undefined);
    await expect(
      s.resolve('https://vm.tiktok.com/ABC/', AbortSignal.timeout(50)),
    ).rejects.toThrow();
  });
});

describe('TikTok photo pages and guest media requests', () => {
  it('resolves photo shares and fetches the same post using its video page', async () => {
    const s = await fixture((req, res) => {
      if (req.method === 'HEAD')
        res.writeHead(301, { location: 'https://www.tiktok.com/@creator/photo/123?tracking=1' });
      else {
        expect(req.url).toBe('/@creator/video/123');
        res.writeHead(200, { 'content-type': 'text/html' });
      }
      res.end('<html>data</html>');
    });
    const post = await s.resolve('https://vm.tiktok.com/ABC/', s.input.signal);
    expect(post.shortcode).toBe('tiktok:photo:123');
    expect(await s.fetchPage(post.url, s.input.signal)).toBe('<html>data</html>');
  });
  it.each(['foreign', 'wrong_id', 'loop', 'mime', 'encoding', 'declared', 'streamed', '429'])(
    'rejects unsafe photo page: %s',
    async (kind) => {
      const s = await fixture((_req, res) => {
        if (['foreign', 'wrong_id', 'loop'].includes(kind))
          res.writeHead(302, {
            location:
              kind === 'foreign'
                ? 'https://evil.test/x'
                : `https://www.tiktok.com/@creator/video/${kind === 'wrong_id' ? '999' : '123'}`,
          });
        else
          res.writeHead(kind === '429' ? 429 : 200, {
            'content-type': kind === 'mime' ? 'application/json' : 'text/html',
            ...(kind === 'encoding' ? { 'content-encoding': 'gzip' } : {}),
            ...(kind === 'declared' ? { 'content-length': '9999999' } : {}),
          });
        res.end(kind === 'streamed' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'body');
      });
      await expect(
        s.fetchPage('https://www.tiktok.com/@creator/photo/123', s.input.signal),
      ).rejects.toThrow();
    },
  );
  it('preserves the anonymous session on TikTok hosts and strips cookies on a CDN redirect', async () => {
    const requests: Record<string, unknown>[] = [];
    const s = await fixture((req, res) => {
      requests.push(req.headers);
      if (req.url === '/start') res.writeHead(302, { location: 'https://v16.tiktokcdn.com/end' });
      else res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end('video');
    });
    await s.transfer({
      ...s.input,
      platform: 'tiktok',
      url: 'https://v16-webapp-prime.tiktok.com/start',
      request: {
        userAgent: 'extractor-agent',
        referer: 'https://www.tiktok.com/@creator/video/123',
        cookie: 'tt_chain_token=guest',
      },
    });
    expect(requests[0]).toMatchObject({
      cookie: 'tt_chain_token=guest',
      'user-agent': 'extractor-agent',
      referer: 'https://www.tiktok.com/@creator/video/123',
    });
    expect(requests[1]).not.toHaveProperty('cookie');
  });
  it.each([
    'tiktok.com',
    'new-media.tiktok.com',
    'video.region.tiktok.com',
    'v16-webapp-prime.tiktok.com',
    'v19-webapp-prime.tiktok.com',
    'webapp-sg.tiktok.com',
  ])('accepts observed TikTok media host %s only for TikTok', (host) => {
    expect(validateMediaUrl(`https://${host}/video`, 'tiktok').hostname).toBe(host);
    expect(() => validateMediaUrl(`https://${host}/video`)).toThrow();
    expect(() => validateMediaUrl(`https://${host}.evil.test/video`, 'tiktok')).toThrow();
    expect(() => validateMediaUrl('https://eviltiktok.com/video', 'tiktok')).toThrow();
  });
});

describe('Instagram public embed requests', () => {
  const post = 'https://www.instagram.com/p/DdTfQ2SjrBf/';
  it('requests only the canonical embed with no account cookies', async () => {
    const s = await fixture((req, res) => {
      expect(req.url).toBe('/p/DdTfQ2SjrBf/embed/captioned/');
      expect(req.headers.cookie).toBeUndefined();
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>metadata</html>');
    });
    expect(await s.fetchInstagram(post, s.input.signal)).toBe('<html>metadata</html>');
    await expect(s.fetchInstagram('https://evil.test/p/id/', s.input.signal)).rejects.toThrow(
      'photos_unavailable',
    );
    await expect(s.fetchInstagram(post + '?tracking=1', s.input.signal)).rejects.toThrow(
      'photos_unavailable',
    );
    await expect(
      s.fetchInstagram('https://www.instagram.com/reel/id/', s.input.signal),
    ).rejects.toThrow('photos_unavailable');
  });
  it.each([
    'redirect',
    'rate_limit',
    'login',
    'mime',
    'encoding',
    'declared_size',
    'streamed_size',
  ])('rejects %s responses without following redirects', async (mode) => {
    let requests = 0;
    const s = await fixture((_req, res) => {
      requests++;
      res.writeHead(
        mode === 'redirect' ? 302 : mode === 'rate_limit' ? 429 : mode === 'login' ? 403 : 200,
        {
          'content-type': mode === 'mime' ? 'application/json' : 'text/html',
          ...(mode === 'encoding' ? { 'content-encoding': 'gzip' } : {}),
          ...(mode === 'declared_size' ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}),
          ...(mode === 'redirect' ? { location: 'https://evil.test/login' } : {}),
        },
      );
      res.end(mode === 'streamed_size' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'unavailable');
    });
    await expect(s.fetchInstagram(post, s.input.signal)).rejects.toThrow(
      mode === 'rate_limit' ? 'rate_limited' : 'photos_unavailable',
    );
    expect(requests).toBe(1);
  });
  it('cancels a stalled embed request', async () => {
    const s = await fixture(() => undefined);
    await expect(s.fetchInstagram(post, AbortSignal.timeout(20))).rejects.toThrow();
  });
});
