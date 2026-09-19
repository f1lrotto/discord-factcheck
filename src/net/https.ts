import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import ipaddr from 'ipaddr.js';

export const malformedRequest = () => new Error('malformed');

export const publicUnicastAddress = (address: string) =>
  ipaddr.isValid(address) && ipaddr.parse(address).range() === 'unicast';

// Resolve inside the socket lookup, returning exactly the checked answers. There is no
// separate preflight lookup for an attacker to rebind between validation and connection.
export const createGuardedLookup =
  (
    resolve: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]> = lookup,
  ): NonNullable<RequestOptions['lookup']> =>
  (hostname, options, callback) => {
    void resolve(hostname, { all: true, verbatim: true }).then(
      (addresses) => {
        const first = addresses.find(({ family }) => !options.family || family === options.family);
        if (!first || addresses.some(({ address }) => !publicUnicastAddress(address))) {
          callback(malformedRequest(), '', 4);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      },
      () => callback(new Error('unavailable'), '', 4),
    );
  };

export const retryAfterDate = (value: string | undefined, now: Date) => {
  if (!value || value.length > 128) return undefined;
  const milliseconds = /^\d+$/.test(value.trim())
    ? now.getTime() + Number(value.trim()) * 1000
    : Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > now.getTime() && milliseconds <= 8.64e15
    ? new Date(milliseconds)
    : undefined;
};

export type JsonHttpOutcome =
  'malformed' | 'access-denied' | 'rate-limited' | 'unavailable' | 'timeout' | 'cancelled';

export type JsonHttpResult =
  { outcome: 'ok'; json: unknown } | { outcome: JsonHttpOutcome; retryAt?: Date };

export type JsonHttp = (input: { url: string; signal: AbortSignal }) => Promise<JsonHttpResult>;

/**
 * A bounded read-only JSON GET sharing the SSRF guards used for publisher retrieval.
 * Redirects are rejected rather than followed: the allowlisted JSON providers do not
 * redirect, so a redirect is a signal something is wrong rather than a path to chase.
 */
export const createJsonHttp = (input: {
  validateUrl: (value: string) => URL;
  userAgent: string;
  request?: typeof request;
  lookup?: NonNullable<RequestOptions['lookup']>;
  now?: () => Date;
  timeoutMs?: number;
  maximumBytes?: number;
}): JsonHttp => {
  const send = input.request ?? request;
  const dns = input.lookup ?? createGuardedLookup();
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maximumBytes = input.maximumBytes ?? 256_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000)
    throw new Error('Invalid JSON HTTP deadline');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 3_000_000)
    throw new Error('Invalid JSON HTTP body limit');

  return async (call) => {
    if (call.signal.aborted) return { outcome: 'cancelled' };
    const controller = new AbortController();
    let timedOut = false;
    let activeRequest: ClientRequest | undefined;
    let activeResponse: IncomingMessage | undefined;
    const cancel = () => controller.abort();
    call.signal.addEventListener('abort', cancel, { once: true });
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

    const retrieve = async (): Promise<JsonHttpResult> => {
      const url = input.validateUrl(call.url);
      signal.throwIfAborted();
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        activeRequest = send(
          url,
          {
            agent: false,
            lookup: dns,
            signal,
            maxHeaderSize: 16_384,
            headers: {
              'User-Agent': input.userAgent,
              Accept: 'application/json',
              'Accept-Encoding': 'identity',
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
      if ([401, 403, 429, 503].includes(status)) {
        response.destroy();
        const retryAt = retryAfterDate(response.headers['retry-after'], now());
        return {
          outcome:
            status === 429 ? 'rate-limited' : status === 503 ? 'unavailable' : 'access-denied',
          ...(retryAt ? { retryAt } : {}),
        };
      }
      if (status !== 200) {
        response.destroy();
        return { outcome: 'unavailable' };
      }
      const body = await readBoundedBody(response, signal, maximumBytes, ['application/json']);
      if (!body) return { outcome: 'unavailable' };
      try {
        return {
          outcome: 'ok',
          json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown,
        };
      } catch {
        throw malformedRequest();
      }
    };

    try {
      return await Promise.race([retrieve(), stopped]);
    } catch (error) {
      return {
        outcome: timedOut
          ? 'timeout'
          : call.signal.aborted
            ? 'cancelled'
            : error instanceof Error && error.message === 'malformed'
              ? 'malformed'
              : 'unavailable',
      };
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener('abort', cancel);
      activeResponse?.destroy();
      activeRequest?.destroy();
    }
  };
};

export const readBoundedBody = async (
  response: IncomingMessage,
  signal: AbortSignal,
  maximumBytes: number,
  contentTypes: string[],
) => {
  const [mime, ...parameters] = (response.headers['content-type'] ?? '').toLowerCase().split(';');
  const length = response.headers['content-length'];
  if (
    !contentTypes.includes(mime!.trim()) ||
    parameters.some(
      (parameter) =>
        /^\s*charset\s*=/.test(parameter) &&
        !/^\s*charset\s*=\s*"?(?:utf-8|utf8|us-ascii)"?\s*$/.test(parameter),
    ) ||
    ![undefined, 'identity'].includes(response.headers['content-encoding']) ||
    (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximumBytes))
  )
    throw malformedRequest();
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > maximumBytes) throw malformedRequest();
    chunks.push(chunk);
  }
  if (!response.complete || (length !== undefined && bytes !== Number(length))) return null;
  if (!bytes) throw malformedRequest();
  return Buffer.concat(chunks);
};
