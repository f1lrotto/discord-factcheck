import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { NewsHttp } from '../../src/news/http.js';
import {
  createDenniknSource,
  denniknListingUrl,
  parseDennikn,
} from '../../src/news/sources/dennikn.js';
import { continuousEligible, observeStory, publicationKey } from '../../src/news/policy.js';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const captured = read('publishers/dennikn-initial-state.html');
const post = JSON.parse(read('dennikn/synthetic-post.json')) as Record<string, unknown>;
const key = 'getInfinitePosts({"important":1,"language":"sk"})';
const envelope = (posts: unknown[], extra: Record<string, unknown> = {}) =>
  `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ postsApi: { queries: { [key]: { data: { pages: [{ posts }] } }, ...extra } } }).replaceAll('<', '\\u003c')};</script>`;
const signal = new AbortController().signal;
const now = new Date('2026-09-14T10:00:00Z');

describe('Denník strict source data parsing', () => {
  it('normalizes all 50 actual captured IDs with original timestamps and publisher metadata', () => {
    const stories = parseDennikn(captured);
    expect(stories).toHaveLength(50);
    expect(stories[0]).toMatchObject({
      id: '5559444',
      publishedAt: new Date('2026-09-14T08:45:35+02:00'),
      important: true,
      title:
        'Švédski Sociálni demokrati dosiahli vo voľbách najhorší výsledok za posledné desaťročia.',
    });
    expect(stories.find(({ id }) => id === '5559393')).toMatchObject({
      title:
        'Rektor UMB Vladimír Hiadlovský požiadal o bezodkladné odvolanie profesora Jaroslava Klátika zo všetkých funkcií,',
      tags: expect.arrayContaining(['Školstvo']),
    });
    expect(stories.some((story) => story.image?.url.startsWith('https://img.projektn.sk/'))).toBe(
      true,
    );
    expect(
      stories.every((story) => story.revision.length === 64 && !story.description?.includes('<p>')),
    ).toBe(true);
  });
  it('supports explicit title, opening bold fallback, linked/plain first sentence, and bounded unsentential text', () => {
    expect(parseDennikn(envelope([{ ...post, title: '<b>Explicitný titul</b>' }]))[0]?.title).toBe(
      'Explicitný titul',
    );
    expect(parseDennikn(envelope([post]))[0]?.title).toBe('Prvá syntetická správa.');
    expect(
      parseDennikn(
        envelope([
          { ...post, excerpt: '<p><a href="https://evil.test/">Prvá veta.</a> Ďalšia veta.</p>' },
        ]),
      )[0]?.title,
    ).toBe('Prvá veta.');
    expect(
      parseDennikn(
        envelope([{ ...post, excerpt: '<p>Prvá veta. <strong>Neskorší dôraz.</strong></p>' }]),
      )[0]?.title,
    ).toBe('Prvá veta.');
    expect(parseDennikn(envelope([{ ...post, excerpt: 'A'.repeat(500) }]))[0]?.title).toHaveLength(
      256,
    );
  });
  it('removes executable markup and normalizes whitespace/entities without evaluating scripts', () => {
    const html = envelope([
      {
        ...post,
        excerpt:
          '<script>throw new Error("executed")</script><p>Správa &amp; téma.<br>Opis.</p><style>hidden</style>',
      },
    ]);
    expect(parseDennikn(html)[0]).toMatchObject({
      title: 'Správa & téma.',
      description: 'Správa & téma. Opis.',
    });
  });
  it('keeps required data when optional title/excerpt/tags/image are missing or unusable', () => {
    expect(
      parseDennikn(
        envelope([
          {
            ...post,
            excerpt: undefined,
            title: 'Only title',
            tags: null,
            image: { sizes: [{ url: 'https://evil.test/x', width: 720 }] },
          },
        ]),
      )[0],
    ).toMatchObject({ title: 'Only title' });
    const story = parseDennikn(envelope([post]))[0]!;
    expect(story).not.toHaveProperty('tags');
    expect(story).not.toHaveProperty('image');
    expect(
      parseDennikn(
        envelope([
          {
            ...post,
            tags: [{ name: '<b>Tag</b>' }, { name: 'Tag' }, null],
            image: {
              sizes: [
                { url: 'https://img.projektn.sk/wp-static/2026/09/a.jpg', width: 200 },
                { url: 'https://img.projektn.sk/wp-static/2026/09/b.jpg', width: 720 },
              ],
            },
          },
        ]),
      )[0],
    ).toMatchObject({
      tags: ['Tag'],
      image: { url: 'https://img.projektn.sk/wp-static/2026/09/b.jpg' },
    });
  });
  it('handles braces and escaped quotes in JSON strings, extra scripts/state, and reordered query arguments', () => {
    const html = envelope([{ ...post, title: 'A {brace} and "quote" and \\ slash' }], {
      unrelated: { arbitrary: true },
    }).replace(
      key.replaceAll('"', '\\"'),
      'getInfinitePosts({\\"language\\":\\"sk\\",\\"important\\":1})',
    );
    expect(
      parseDennikn(`<script>throw new Error('never executed')</script>${html}`)[0]?.title,
    ).toContain('{brace}');
    expect(parseDennikn(html.replace(';</script>', '; otherJavascript();</script>'))).toHaveLength(
      1,
    );
  });
  it.each([
    '',
    '<p>Challenge</p>',
    '<script>window.__INITIAL_STATE__ = {broken:1};</script>',
    '<script>window.__INITIAL_STATE__ = {"x":[];</script>',
    '<script>window.__INITIAL_STATE__ = [];</script>',
    '<script>window.__INITIAL_STATE__ = {};</script>',
    envelope([post]) + envelope([post]),
    'x'.repeat(3_000_001),
  ])('rejects missing/broken/ambiguous/oversized state', (html) =>
    expect(() => parseDennikn(html)).toThrow(),
  );
  it.each([
    { [key]: {} },
    { [key]: { data: { pages: [] } } },
    { [key]: { data: { pages: [{}] } } },
    { 'getInfinitePosts(bad)': { data: { pages: [{ posts: [] }] } } },
    { 'getInfinitePosts({"important":0,"language":"sk"})': { data: { pages: [{ posts: [] }] } } },
    { [key]: { data: { pages: [{ posts: Array.from({ length: 1001 }, () => post) }] } } },
  ])('rejects schema drift rather than treating it as empty', (queries) => {
    expect(() =>
      parseDennikn(
        `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ postsApi: { queries } })};</script>`,
      ),
    ).toThrow();
  });
  it.each([
    { id: 0 },
    { id: '90001' },
    { url: 'https://evil.test/minuta/90001/' },
    { url: 'https://dennikn.sk/minuta/42/' },
    { isImportant: 'true' },
    { published_at: 'yesterday' },
    { published_at: '2026-09-14T08:00:00' },
    { published_at: '2026-02-30T08:00:00Z' },
    { published_at: '2026-09-14T24:00:00Z' },
    { published_at_date: 123 },
    { published_at: undefined },
    { excerpt: '', title: '' },
  ])('rejects malformed required field %j', (change) =>
    expect(() => parseDennikn(envelope([{ ...post, ...change }]))).toThrow(),
  );
  it('deduplicates exact IDs, is stable under reordered snapshots, and rejects conflicting duplicates', () => {
    const other = { ...post, id: 90002, url: 'https://dennikn.sk/minuta/90002/' };
    expect(parseDennikn(envelope([post, post]))).toHaveLength(1);
    expect(parseDennikn(envelope([other, post]))).toEqual(parseDennikn(envelope([post, other])));
    expect(() =>
      parseDennikn(envelope([post, { ...post, excerpt: 'Conflicting revision' }])),
    ).toThrow();
  });
  it('preserves false observations, delayed importance and revised content without changing publication identity', () => {
    const initial = parseDennikn(envelope([{ ...post, isImportant: false }]))[0]!;
    const promoted = parseDennikn(
      envelope([{ ...post, excerpt: 'Corrected important story.' }]),
    )[0]!;
    const before = observeStory(initial, {
      sequence: 1,
      collectedAt: new Date('2026-09-14T06:20:00Z'),
    });
    const after = observeStory(promoted, { sequence: 2, collectedAt: now }, before);
    expect(before.firstImportantAt).toBeUndefined();
    expect(after.firstSeenAt).toEqual(before.firstSeenAt);
    expect(after.firstImportantAt).toEqual(now);
    expect(continuousEligible(after, { sequence: 1, collectedAt: before.firstSeenAt }, now)).toBe(
      true,
    );
    expect(promoted.revision).not.toBe(initial.revision);
    expect(publicationKey('guild', promoted)).toBe(publicationKey('guild', initial));
  });
});

describe('Denník one-request collector and cache proposals', () => {
  it('returns stories including false records and commits validators only after valid parsing', async () => {
    const http = vi
      .fn<NewsHttp>()
      .mockResolvedValue({
        outcome: 'ok',
        html: envelope([{ ...post, isImportant: false }]),
        url: denniknListingUrl,
        validators: { etag: 'new' },
      });
    const result = await createDenniknSource(http).collect({
      now,
      cache: { listing: { etag: 'old' } },
      signal,
    });
    expect(result).toMatchObject({
      outcome: 'stories',
      stories: [{ important: false }],
      cache: { listing: { etag: 'new' } },
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith({
      url: denniknListingUrl,
      source: 'dennikn',
      signal,
      validators: { etag: 'old' },
    });
  });
  it('distinguishes empty valid structure, unchanged and malformed without poisoning good cache', async () => {
    const http = vi
      .fn<NewsHttp>()
      .mockResolvedValueOnce({
        outcome: 'ok',
        html: envelope([]),
        url: denniknListingUrl,
        validators: { etag: 'empty' },
      })
      .mockResolvedValueOnce({ outcome: 'unchanged', validators: { etag: 'same' } })
      .mockResolvedValueOnce({
        outcome: 'ok',
        html: '<p>Missing schema</p>',
        url: denniknListingUrl,
        validators: { etag: 'poison' },
      });
    const source = createDenniknSource(http);
    const cache = Object.freeze({ listing: Object.freeze({ etag: 'good' }) });
    expect(await source.collect({ now, cache, signal })).toEqual({
      outcome: 'empty',
      cache: { listing: { etag: 'empty' } },
    });
    expect(await source.collect({ now, cache, signal })).toEqual({
      outcome: 'unchanged',
      cache: { listing: { etag: 'same' } },
    });
    expect(await source.collect({ now, cache, signal })).toEqual({ outcome: 'malformed' });
    expect(cache.listing.etag).toBe('good');
  });
  it.each([
    'access-denied',
    'rate-limited',
    'timeout',
    'cancelled',
    'unavailable',
    'malformed',
  ] as const)('preserves finite transport outcome %s', async (outcome) => {
    const failure = { outcome, retryAt: new Date(+now + 1000) };
    const http = vi.fn<NewsHttp>().mockResolvedValue(failure);
    expect(await createDenniknSource(http).collect({ now, cache: {}, signal })).toEqual(failure);
  });
  it('rejects a listing redirected to a story even if it contains recognizable state', async () => {
    const http = vi
      .fn<NewsHttp>()
      .mockResolvedValue({
        outcome: 'ok',
        html: captured,
        url: 'https://dennikn.sk/minuta/90001/',
        validators: {},
      });
    expect(await createDenniknSource(http).collect({ now, cache: {}, signal })).toEqual({
      outcome: 'malformed',
    });
  });
  it('does not parse a late successful result after cancellation', async () => {
    const http = vi
      .fn<NewsHttp>()
      .mockResolvedValue({ outcome: 'ok', html: captured, url: denniknListingUrl, validators: {} });
    const source = createDenniknSource(http);
    expect(await source.collect({ now, cache: {}, signal: AbortSignal.abort() })).toEqual({
      outcome: 'cancelled',
    });
    expect(http).not.toHaveBeenCalled();
    const controller = new AbortController();
    http.mockImplementationOnce(async () => {
      controller.abort();
      return { outcome: 'ok', html: captured, url: denniknListingUrl, validators: {} };
    });
    expect(await source.collect({ now, cache: {}, signal: controller.signal })).toEqual({
      outcome: 'cancelled',
    });
  });
});
