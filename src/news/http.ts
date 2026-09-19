import type { ClientRequest, IncomingMessage } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import {
  readBoundedBody,
  createGuardedLookup,
  malformedRequest,
  publicUnicastAddress,
  retryAfterDate,
} from '../net/https.js';
import type { NewsCacheValidators, NewsSourceId, NewsSourceResult } from './types.js';

export type NewsHttpFailure = Extract<
  NewsSourceResult,
  {
    outcome:
      'malformed' | 'access-denied' | 'rate-limited' | 'unavailable' | 'timeout' | 'cancelled';
  }
>;
export type NewsHttpResult =
  | { outcome: 'ok'; html: string; url: string; validators: NewsCacheValidators }
  | { outcome: 'unchanged'; validators: NewsCacheValidators }
  | NewsHttpFailure;
export type NewsHttp = (input: {
  url: string;
  source: NewsSourceId;
  signal: AbortSignal;
  validators?: NewsCacheValidators;
}) => Promise<NewsHttpResult>;

const invalid = malformedRequest;

// Shared by adapters/rendering. Images are validated metadata, never fetched here.
export const validateNewsUrl = (
  value: string,
  source: NewsSourceId,
  kind: 'page' | 'image' = 'page',
) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const allowed =
    kind === 'image'
      ? source === 'dennikn'
        ? url.hostname === 'img.projektn.sk' && /^\/wp-static\/\d{4}\/\d{2}\/.+/.test(url.pathname)
        : url.hostname === 'img.aktuality.sk' && /^\/foto\/.+/.test(url.pathname)
      : source === 'dennikn'
        ? ['dennikn.sk', 'www.dennikn.sk', 'e.dennikn.sk'].includes(url.hostname) &&
          /^\/minuta\/(?:dolezite|\d+)\/?$/.test(url.pathname)
        : ['aktuality.sk', 'www.aktuality.sk'].includes(url.hostname) &&
          /^\/(?:spravy\/denny-vyber-sprav|clanok\/[a-z0-9]+\/[a-z0-9-]+)\/?$/i.test(url.pathname);
  if (
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (kind === 'page' && url.search) ||
    !allowed
  )
    throw invalid();
  url.hash = '';
  return url;
};

// Retained names: the news adapters and their tests are the original callers of these guards.
export const publicNewsAddress = publicUnicastAddress;
export const createNewsLookup = createGuardedLookup;

const headerValue = (value: string | undefined) =>
  value && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value) ? value : undefined;
const validatorsFrom = (values: NewsCacheValidators) => {
  const etag = headerValue(values.etag);
  const lastModified = headerValue(values.lastModified);
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
};

const retryAfter = (value: string | undefined, now: Date) => {
  const retryAt = retryAfterDate(value, now);
  return retryAt ? { retryAt } : {};
};

export const createNewsHttp = (
  dependencies: {
    request?: typeof request;
    lookup?: NonNullable<RequestOptions['lookup']>;
    now?: () => Date;
    timeoutMs?: number;
    maximumBytes?: number;
  } = {},
): NewsHttp => {
  const send = dependencies.request ?? request;
  const dns = dependencies.lookup ?? createNewsLookup();
  const now = dependencies.now ?? (() => new Date());
  const timeoutMs = dependencies.timeoutMs ?? 25_000;
  const maximumBytes = dependencies.maximumBytes ?? 3_000_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000)
    throw new Error('Invalid news HTTP deadline');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 3_000_000)
    throw new Error('Invalid news HTTP body limit');

  return async (input) => {
    if (input.signal.aborted) return { outcome: 'cancelled' };
    const controller = new AbortController();
    let timedOut = false;
    let activeRequest: ClientRequest | undefined;
    let activeResponse: IncomingMessage | undefined;
    const cancel = () => controller.abort();
    input.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const signal = controller.signal;
    const stopped = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          activeRequest?.destroy();
          activeResponse?.destroy();
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
    const retrieve = async (): Promise<NewsHttpResult> => {
      let url = validateNewsUrl(input.url, input.source);
      const visited = new Set<string>();
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        if (visited.has(url.href) || redirects > 3) throw invalid();
        visited.add(url.href);
        // Validators belong to the requested resource, not a redirect target.
        const conditional = redirects === 0 ? validatorsFrom(input.validators ?? {}) : {};
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          activeRequest = send(
            url,
            {
              agent: false,
              lookup: dns,
              signal,
              maxHeaderSize: 16_384,
              headers: {
                'User-Agent': 'JolandaNews/1.0',
                Accept: 'text/html,application/xhtml+xml',
                'Accept-Encoding': 'identity',
                ...(conditional.etag ? { 'If-None-Match': conditional.etag } : {}),
                ...(conditional.lastModified
                  ? { 'If-Modified-Since': conditional.lastModified }
                  : {}),
              },
            },
            (received) => {
              received.on('error', () => undefined);
              if (signal.aborted) received.destroy();
              resolve(received);
            },
          );
          activeRequest.on('error', reject);
          activeRequest.end();
        });
        activeResponse = response;
        signal.throwIfAborted();
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (!response.headers.location) throw invalid();
          url = validateNewsUrl(new URL(response.headers.location, url).href, input.source);
          continue;
        }
        if (status === 403 || status === 401 || status === 429 || status === 503) {
          return {
            outcome:
              status === 429 ? 'rate-limited' : status === 503 ? 'unavailable' : 'access-denied',
            ...retryAfter(response.headers['retry-after'], now()),
          };
        }
        const validators = validatorsFrom({
          ...(response.headers.etag ? { etag: response.headers.etag } : {}),
          ...(response.headers['last-modified']
            ? { lastModified: response.headers['last-modified'] }
            : {}),
        });
        if (status === 304) {
          if (!conditional.etag && !conditional.lastModified) throw invalid();
          return { outcome: 'unchanged', validators: { ...conditional, ...validators } };
        }
        if (status !== 200) return { outcome: 'unavailable' };
        const body = await readBoundedBody(response, signal, maximumBytes, [
          'text/html',
          'application/xhtml+xml',
        ]);
        if (!body) return { outcome: 'unavailable' };
        let html: string;
        try {
          html = new TextDecoder('utf-8', { fatal: true }).decode(body);
        } catch {
          throw invalid();
        }
        // These are proposals only: adapters commit them only after a successful parse.
        return { outcome: 'ok', html, url: url.href, validators };
      }
    };
    try {
      return await Promise.race([retrieve(), stopped]);
    } catch (error) {
      return {
        outcome: timedOut
          ? 'timeout'
          : input.signal.aborted
            ? 'cancelled'
            : error instanceof Error && error.message === 'malformed'
              ? 'malformed'
              : 'unavailable',
      };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', cancel);
      activeResponse?.destroy();
      activeRequest?.destroy();
    }
  };
};
