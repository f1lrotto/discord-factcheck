import type { IncomingMessage } from 'node:http';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import ipaddr from 'ipaddr.js';
import type { TikTokMediaRequest } from './tiktok-request.js';
import { parseTikTokPosts } from './tiktok-links.js';
import { parseInstagramReels } from './instagram-links.js';
import { reelLimits } from './reel-limits.js';
import { ReelError, type ReelPlatform } from './reel-types.js';

const mediaHosts = {
  instagram: ['cdninstagram.com', 'fbcdn.net'],
  tiktok: [
    'tiktok.com',
    'tiktokcdn.com',
    'tiktokcdn-us.com',
    'tiktokcdn-eu.com',
    'tiktokv.com',
    'tiktokv.us',
    'byteoversea.com',
    'ibytedtos.com',
  ],
};

export const validateMediaUrl = (value: string, platform: ReelPlatform = 'instagram') => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReelError('unsupported_media');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !mediaHosts[platform].some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  )
    throw new ReelError('unsupported_media');
  return url;
};
export const publicMediaAddress = (address: string) =>
  ipaddr.isValid(address) && ipaddr.parse(address).range() === 'unicast';

export const createMediaLookup =
  (
    resolve: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]> = lookup,
  ): NonNullable<RequestOptions['lookup']> =>
  (hostname, options, callback) => {
    void resolve(hostname, { all: true, verbatim: true }).then(
      (addresses) => {
        if (!addresses.length || addresses.some(({ address }) => !publicMediaAddress(address))) {
          callback(new ReelError('unsupported_media'), '', 4);
          return;
        }
        const first = addresses.find(({ family }) => !options.family || family === options.family);
        if (!first) {
          callback(new ReelError('unsupported_media'), '', 4);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      },
      () => callback(new ReelError('unavailable'), '', 4),
    );
  };

const discardResponse = async (response: IncomingMessage) => {
  response.destroy();
  await finished(response, { cleanup: true }).catch(() => undefined);
};

export const createMediaTransfer =
  (dependencies = { request, lookup: createMediaLookup() }) =>
  async (input: {
    url: string;
    path: string;
    maximumBytes: number;
    signal: AbortSignal;
    platform?: ReelPlatform;
    kind?: 'image';
    request?: TikTokMediaRequest;
  }) => {
    let url = validateMediaUrl(input.url, input.platform);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = dependencies.request(
          url,
          {
            agent: false,
            lookup: dependencies.lookup,
            signal: input.signal,
            headers: {
              'User-Agent':
                input.platform === 'tiktok'
                  ? (input.request?.userAgent ?? 'Mozilla/5.0')
                  : 'Mozilla/5.0',
              Referer:
                input.platform === 'tiktok'
                  ? (input.request?.referer ?? 'https://www.tiktok.com/')
                  : 'https://www.instagram.com/',
              'Accept-Encoding': 'identity',
              ...(input.platform === 'tiktok' && input.request
                ? {
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-us,en;q=0.5',
                    'Sec-Fetch-Mode': 'navigate',
                  }
                : {}),
              ...(input.platform === 'tiktok' &&
              (url.hostname === 'tiktok.com' || url.hostname.endsWith('.tiktok.com')) &&
              input.request?.cookie
                ? { Cookie: input.request.cookie }
                : {}),
            },
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
      // A response can error before pipeline attaches (e.g. while validating headers).
      response.on('error', () => undefined);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        await discardResponse(response);
        if (!response.headers.location || redirects === 3) throw new ReelError('unsupported_media');
        url = validateMediaUrl(new URL(response.headers.location, url).href, input.platform);
        continue;
      }
      const contentType = response.headers['content-type']?.split(';')[0]?.trim();
      if (
        status !== 200 ||
        (contentType &&
          !(
            input.kind === 'image'
              ? [
                  'image/jpeg',
                  'image/png',
                  'image/webp',
                  'application/octet-stream',
                  'binary/octet-stream',
                ]
              : ['video/mp4', 'application/octet-stream', 'binary/octet-stream']
          ).includes(contentType))
      ) {
        await discardResponse(response);
        throw new ReelError(
          status === 429
            ? 'rate_limited'
            : status === 401 || status === 403
              ? 'unavailable'
              : 'unsupported_media',
        );
      }
      const declaredBytes = Number(response.headers['content-length']);
      if (declaredBytes > input.maximumBytes) {
        await discardResponse(response);
        throw new ReelError('too_large', { bytes: declaredBytes });
      }
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > input.maximumBytes
              ? new ReelError('too_large', { bytes, atLeast: true })
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        response,
        counter,
        createWriteStream(input.path, { flags: 'wx', mode: 0o600 }),
        { signal: input.signal },
      );
      if (!bytes) throw new ReelError('unsupported_media');
      return bytes;
    }
    throw new ReelError('unsupported_media');
  };

// Resolve short shares before extraction so every redirect is checked and DNS-pinned.
export const createTikTokResolver =
  (dependencies = { request, lookup: createMediaLookup() }) =>
  async (value: string, signal: AbortSignal) => {
    let url = value;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const link = parseTikTokPosts(url)[0];
      if (!link) throw new ReelError('unsupported_media');
      if (!link.shortcode.startsWith('tiktok:share:')) return link;
      if (redirects === 3) throw new ReelError('unsupported_media');
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = dependencies.request(
          new URL(link.url),
          {
            method: 'HEAD',
            agent: false,
            lookup: dependencies.lookup,
            signal,
            headers: { 'User-Agent': 'facebookexternalhit/1.1' },
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
      response.on('error', () => undefined);
      await discardResponse(response);
      if (response.statusCode === 429) throw new ReelError('rate_limited');
      if (
        ![301, 302, 303, 307, 308].includes(response.statusCode ?? 0) ||
        !response.headers.location
      )
        throw new ReelError('unavailable');
      url = new URL(response.headers.location, link.url).href;
    }
    throw new ReelError('unsupported_media');
  };

// Fetch only the canonical public embed, with no cookies or redirects to login/other hosts.
export const createInstagramPageFetcher =
  (dependencies = { request, lookup: createMediaLookup() }) =>
  async (value: string, signal: AbortSignal) => {
    const post = parseInstagramReels(value)[0];
    if (!post || post.url !== value || !new URL(value).pathname.startsWith('/p/'))
      throw new ReelError('photos_unavailable');
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = dependencies.request(
        new URL(`${post.url}embed/captioned/`),
        {
          agent: false,
          lookup: dependencies.lookup,
          signal,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' },
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
    response.on('error', () => undefined);
    if (
      response.statusCode !== 200 ||
      !response.headers['content-type']?.toLowerCase().startsWith('text/html') ||
      !['identity', undefined].includes(response.headers['content-encoding']) ||
      Number(response.headers['content-length']) > reelLimits.pageBytes
    ) {
      await discardResponse(response);
      throw new ReelError(response.statusCode === 429 ? 'rate_limited' : 'photos_unavailable');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > reelLimits.pageBytes) throw new ReelError('photos_unavailable');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

// Photo data is present on the /video/ rendering of the same public TikTok post.
export const createTikTokPageFetcher =
  (dependencies = { request, lookup: createMediaLookup() }) =>
  async (value: string, signal: AbortSignal) => {
    const original = parseTikTokPosts(value)[0];
    if (!original || original.url !== value || original.shortcode.startsWith('tiktok:share:'))
      throw new ReelError('photos_unavailable');
    let url = original.url.replace('/photo/', '/video/');
    for (let redirects = 0; redirects <= 3; redirects++) {
      const link = parseTikTokPosts(url)[0];
      if (!link || link.shortcode.split(':').at(-1) !== original.shortcode.split(':').at(-1))
        throw new ReelError('photos_unavailable');
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = dependencies.request(
          new URL(link.url),
          {
            agent: false,
            lookup: dependencies.lookup,
            signal,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' },
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
      response.on('error', () => undefined);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        await discardResponse(response);
        if (!response.headers.location || redirects === 3)
          throw new ReelError('photos_unavailable');
        url = new URL(response.headers.location, link.url).href;
        continue;
      }
      if (
        status !== 200 ||
        !response.headers['content-type']?.toLowerCase().startsWith('text/html') ||
        !['identity', undefined].includes(response.headers['content-encoding']) ||
        Number(response.headers['content-length']) > reelLimits.pageBytes
      ) {
        await discardResponse(response);
        throw new ReelError(status === 429 ? 'rate_limited' : 'photos_unavailable');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > reelLimits.pageBytes) throw new ReelError('photos_unavailable');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    throw new ReelError('photos_unavailable');
  };
