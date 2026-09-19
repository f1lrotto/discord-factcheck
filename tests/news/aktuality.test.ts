import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import type { NewsHttp, NewsHttpResult } from '../../src/news/http.js';
import type { NewsSourceCache } from '../../src/news/types.js';
import { dailyCollectionSlot } from '../../src/news/policy.js';
import {
  aktualityListingUrl,
  createAktualitySource,
  parseAktualityEdition,
  parseAktualityListing,
} from '../../src/news/sources/aktuality.js';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const listing = read('publishers/aktuality-listing.html');
const captured = read('publishers/aktuality-edition.html');
const older = read('publishers/aktuality-edition-older.html');
const weekly = read('aktuality/weekly-only.html');
const alternate = read('aktuality/alternate-edition.html');
const candidate = load(captured)('meta[property="og:url"]').attr('content')!;
const olderUrl = load(older)('meta[property="og:url"]').attr('content')!;
const syntheticUrl = 'https://www.aktuality.sk/clanok/Test123/synteticky-denny-vyber/';
const now = new Date('2026-09-14T18:00:00Z');
const signal = new AbortController().signal;
const mutate = (html: string, change: (document: ReturnType<typeof load>) => void) => {
  const $ = load(html);
  change($);
  return $.html();
};
const fresh = mutate(captured, ($) => {
  $('meta[name="article:published_time"]').attr('content', '2026-09-14T17:13:38Z');
});
const ok = (html: string, url = aktualityListingUrl, etag = 'etag'): NewsHttpResult => ({
  outcome: 'ok',
  html,
  url,
  validators: { etag },
});
const transport = (...results: NewsHttpResult[]) => {
  const http = vi.fn<NewsHttp>();
  results.forEach((result) => http.mockResolvedValueOnce(result));
  return http;
};
const input = (cache: NewsSourceCache = {}) => ({ now, signal, cache });

// Mutated dates/markup below are synthetic; the original two captured editions stay unchanged.
describe('Aktuality editorial selection and pure edition parsing', () => {
  it('allows yesterday only for an explicit latest-edition collection, with a 48-hour bound', async () => {
    for (const [hours, latest, outcome] of [
      [24, false, 'stale'],
      [24, true, 'edition'],
      [72, true, 'stale'],
    ] as const) {
      const source = createAktualitySource(transport(ok(listing), ok(fresh, candidate)));
      expect(
        (await source.collect({ ...input(), now: new Date(+now + hours * 3600000), latest }))
          .outcome,
      ).toBe(outcome);
    }
  });
  it('skips the real weekly newest link and selects the first actual daily candidate', () => {
    expect(parseAktualityListing(listing)).toBe(candidate);
    expect(parseAktualityListing(weekly)).toBeNull();
  });
  it('recognizes daily markers from source URL and handles duplicate and relative anchors', () => {
    expect(
      parseAktualityListing(
        `<a href="/clanok/Test123/denny-vyber/">A headline</a><a href="/clanok/Test123/denny-vyber/">duplicate</a>`,
      ),
    ).toBe('https://www.aktuality.sk/clanok/Test123/denny-vyber/');
  });
  it.each([
    '',
    '<html>Login challenge</html>',
    '<a href="/spravy/denny-vyber-sprav/">Denný výber</a>',
    '<a href="https://evil.test/clanok/Test/denny-vyber/">Denný výber</a>',
    '<a href="https://www.aktuality.sk/clanok/Test/denny-vyber/?cookie=secret">Denný výber</a>',
    '<a href="https://[/clanok/Test/denny-vyber/">Denný výber</a>',
  ])('rejects broken/unsafe listing instead of silently returning empty', (html) =>
    expect(() => parseAktualityListing(html)).toThrow(),
  );
  it.each([
    [captured, candidate, 'hAUs7Al', '2026-09-11T17:13:38.000Z'],
    [older, olderUrl, 'E0rnklb', '2026-09-10T17:13:20.000Z'],
  ])(
    'normalizes real edition metadata and all seven observed headings',
    (html, url, id, publishedAt) => {
      const edition = parseAktualityEdition(html!, url!);
      expect(edition).toMatchObject({
        kind: 'edition',
        source: 'aktuality',
        id,
        url,
        publishedAt: new Date(publishedAt!),
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(edition.sections).toHaveLength(7);
      expect(edition.sections.every((section) => section.title && !section.url)).toBe(true);
      expect(edition.title).not.toContain('| Aktuality.sk');
      expect(edition.image?.url).toMatch(/^https:\/\/img\.aktuality\.sk\/foto\//);
      expect(edition.description).toBeTruthy();
    },
  );
  it('accepts alternate name/property placement and JSON-LD graph/array publication metadata', () => {
    const swapped = mutate(captured, ($) => {
      $('meta[name="article:published_time"]')
        .attr('property', 'article:published_time')
        .removeAttr('name');
    });
    expect(parseAktualityEdition(swapped, candidate).publishedAt).toEqual(
      new Date('2026-09-11T17:13:38Z'),
    );
    const fallback = mutate(captured, ($) => {
      $('meta').remove();
    });
    expect(parseAktualityEdition(fallback, candidate)).toMatchObject({
      id: 'hAUs7Al',
      publishedAt: new Date('2026-09-11T17:13:38Z'),
    });
    const edition = parseAktualityEdition(alternate, syntheticUrl);
    expect(edition).toMatchObject({
      title: 'Syntetický denný výber',
      publishedAt: new Date('2026-09-14T17:15:00Z'),
      description: 'Syntetický úvod.',
    });
    expect(edition.sections).toEqual([
      {
        title: 'Prvá syntetická téma',
        url: 'https://www.aktuality.sk/clanok/TestLink/prva-sprava/',
      },
      { title: 'Druhá syntetická téma' },
    ]);
    expect(
      parseAktualityEdition(
        alternate.replace('{"@graph":[', '[').replace('}]}', '}]'),
        syntheticUrl,
      ).sections,
    ).toHaveLength(2);
  });
  it('allows variable nonempty heading counts, omits bad optional images/links and retains bounded tags', () => {
    const html = mutate(captured, ($) => {
      $('meta[property="og:image"]').attr('content', 'https://evil.test/image');
      $('head').append(
        '<meta name="article:tag" content="Tag"><meta property="article:tag" content="Tag">',
      );
      $('#articleContent').html('<h2><a href="https://evil.test/path">Only heading</a></h2>');
    });
    const edition = parseAktualityEdition(html, candidate);
    expect(edition.sections).toEqual([{ title: 'Only heading' }]);
    expect(edition).not.toHaveProperty('image');
    expect(edition.tags).toEqual(['Tag']);
    expect(
      parseAktualityEdition(
        mutate(html, ($) => {
          $('#articleContent').append('<h2>More</h2>'.repeat(8));
        }),
        candidate,
      ).sections,
    ).toHaveLength(9);
  });
  it('preserves only explicit validated section links, including an adjacent source card', () => {
    const html = mutate(captured, ($) => {
      $('#articleContent').html(
        '<h2>Headline</h2><p><a href="/clanok/Link123/detail/">Read more</a></p><h2>Another headline</h2>',
      );
    });
    expect(parseAktualityEdition(html, candidate).sections).toEqual([
      { title: 'Headline', url: 'https://www.aktuality.sk/clanok/Link123/detail/' },
      { title: 'Another headline' },
    ]);
  });
  it('handles unrelated/malformed JSON-LD and HTML text without executing or leaking scripts', () => {
    const html = mutate(captured, ($) => {
      $('head').append('<script type="application/ld+json">{broken</script>');
      $('#articleContent h2')
        .first()
        .html('<script>throw new Error("execute")</script>News &amp; more');
    });
    expect(parseAktualityEdition(html, candidate).sections[0]?.title).toBe('News & more');
  });
  it.each([
    ($: ReturnType<typeof load>) => {
      $('#articleContent').remove();
    },
    ($: ReturnType<typeof load>) => {
      $('#articleContent h2').remove();
    },
    ($: ReturnType<typeof load>) => {
      $('#articleContent h2').first().empty();
    },
    ($: ReturnType<typeof load>) => {
      $('#articleContent').append('<h2>More</h2>'.repeat(50));
    },
    ($: ReturnType<typeof load>) => {
      $('meta[name="article:published_time"]').attr('content', '2026-02-30T08:00:00Z');
    },
    ($: ReturnType<typeof load>) => {
      $('meta[name="article:published_time"]').attr('content', 'not a date');
    },
    ($: ReturnType<typeof load>) => {
      $('meta[name="article:published_time"],script[type="application/ld+json"]').remove();
    },
    ($: ReturnType<typeof load>) => {
      $('meta[property="og:url"]').attr('content', olderUrl);
    },
    ($: ReturnType<typeof load>) => {
      $('meta[property="og:url"]').attr('content', 'https://evil.test/');
    },
    ($: ReturnType<typeof load>) => {
      $('head').append('<meta property="article:published_time" content="2026-09-12T17:00:00Z">');
    },
    ($: ReturnType<typeof load>) => {
      $('meta[property="og:title"]').attr('content', 'Týždenný výber');
    },
    ($: ReturnType<typeof load>) => {
      $('meta[property="og:title"]').attr('content', '');
    },
  ])('rejects incomplete/conflicting required fields and weekly editions', (change) =>
    expect(() => parseAktualityEdition(mutate(captured, change), candidate)).toThrow(),
  );
  it('rejects invalid candidate URLs and recognizes weekly identity even with a misleading daily title', () => {
    expect(() => parseAktualityEdition(captured, aktualityListingUrl)).toThrow();
    const weeklyUrl = 'https://www.aktuality.sk/clanok/hAUs7Al/vyber-tyzdna/';
    expect(() =>
      parseAktualityEdition(
        mutate(captured, ($) => {
          $('meta[property="og:url"]').attr('content', weeklyUrl);
        }),
        weeklyUrl,
      ),
    ).toThrow();
  });
  it('updates revision when editorial headings change without changing the edition ID', () => {
    const before = parseAktualityEdition(captured, candidate);
    const after = parseAktualityEdition(
      mutate(captured, ($) => {
        $('#articleContent h2').first().text('Corrected heading');
      }),
      candidate,
    );
    expect(after.id).toBe(before.id);
    expect(after.revision).not.toBe(before.revision);
  });
});

describe('Aktuality daily request budget, freshness and fallback cache', () => {
  it('makes exactly listing plus one daily article request, never fetching the weekly or linked sections', async () => {
    const http = transport(ok(listing), ok(fresh, candidate, 'article'));
    const result = await createAktualitySource(http).collect(input());
    expect(result).toMatchObject({
      outcome: 'edition',
      edition: { id: 'hAUs7Al', publishedAt: new Date('2026-09-14T17:13:38Z') },
      cache: {
        listing: { etag: 'etag' },
        candidate: { url: candidate, validators: { etag: 'article' } },
      },
    });
    expect(http.mock.calls.map(([request]) => request.url)).toEqual([
      aktualityListingUrl,
      candidate,
    ]);
    if (result.outcome !== 'edition') throw new Error('Expected edition');
    expect(
      dailyCollectionSlot(new Date('2026-09-14T19:00:00Z'), {
        attemptedSlots: [],
        collectedEdition: result.edition,
      }),
    ).toBeNull();
  });
  it.each([
    ['2026-09-13T19:00:00+02:00', 'stale'],
    ['2026-09-14T20:01:00+02:00', 'stale'],
    ['2026-09-15T19:00:00+02:00', 'stale'],
    ['2026-09-13T22:30:00Z', 'edition'],
  ])('uses Slovak publication date and excludes future publication %s', async (date, outcome) => {
    const html = mutate(captured, ($) => {
      $('meta[name="article:published_time"]').attr('content', date);
      $('meta[name="article:modified_time"]').attr('content', now.toISOString());
    });
    expect(
      await createAktualitySource(transport(ok(listing), ok(html, candidate))).collect(input()),
    ).toMatchObject({ outcome });
  });
  it('reports both actual September 10/11 editions stale on capture day and retains parsed candidate metadata', async () => {
    for (const [html, url] of [
      [captured, candidate],
      [older, olderUrl],
    ]) {
      const list = `<a href="${url}">Denný výber</a>`;
      const result = await createAktualitySource(transport(ok(list), ok(html!, url))).collect(
        input(),
      );
      expect(result).toMatchObject({
        outcome: 'stale',
        cache: { candidate: { url, edition: { sections: expect.any(Array) } } },
      });
    }
  });
  it('performs one fallback after a weekly-only primary, then collects a newly available synthetic fresh edition', async () => {
    const http = transport(
      ok(weekly, aktualityListingUrl, 'no-daily'),
      ok(listing),
      ok(fresh, candidate),
    );
    const source = createAktualitySource(http);
    const primary = await source.collect(input());
    expect(primary).toEqual({ outcome: 'empty', cache: { listing: { etag: 'no-daily' } } });
    if (!('cache' in primary)) throw new Error('Expected cache');
    const fallback = await source.collect({
      ...input(primary.cache),
      now: new Date('2026-09-14T19:00:00Z'),
    });
    expect(fallback.outcome).toBe('edition');
    expect(http).toHaveBeenCalledTimes(3);
  });
  it('revalidates a cached candidate after listing 304 and preserves a parsed edition through article 304', async () => {
    const edition = parseAktualityEdition(fresh, candidate);
    const cache: NewsSourceCache = {
      listing: { etag: 'listing' },
      candidate: { url: candidate, validators: { etag: 'article' }, edition },
    };
    const http = transport(
      { outcome: 'unchanged', validators: { etag: 'listing' } },
      { outcome: 'unchanged', validators: { etag: 'article2' } },
    );
    const result = await createAktualitySource(http).collect(input(cache));
    expect(result).toEqual({
      outcome: 'edition',
      edition,
      cache: { ...cache, candidate: { ...cache.candidate, validators: { etag: 'article2' } } },
    });
    expect(http.mock.calls[1]?.[0]).toMatchObject({
      url: candidate,
      validators: { etag: 'article' },
    });
    expect(cache.candidate?.validators?.etag).toBe('article');
  });
  it('does not treat an unchanged stale candidate as a current edition; still revalidates its body when changed', async () => {
    const staleEdition = parseAktualityEdition(captured, candidate);
    const cache = {
      listing: { etag: 'list' },
      candidate: { url: candidate, validators: { etag: 'old-article' }, edition: staleEdition },
    };
    const http = transport(
      { outcome: 'unchanged', validators: { etag: 'list' } },
      { outcome: 'unchanged', validators: { etag: 'old-article' } },
      { outcome: 'unchanged', validators: { etag: 'list' } },
      ok(fresh, candidate, 'new-article'),
    );
    const source = createAktualitySource(http);
    expect(await source.collect(input(cache))).toMatchObject({
      outcome: 'stale',
      cache: { candidate: { edition: staleEdition } },
    });
    expect(await source.collect(input(cache))).toMatchObject({
      outcome: 'edition',
      cache: { candidate: { validators: { etag: 'new-article' } } },
    });
    expect(http).toHaveBeenCalledTimes(4);
  });
  it('returns empty for unchanged known weekly-only listing and avoids article validators without parsed content', async () => {
    const http = transport(
      { outcome: 'unchanged', validators: { etag: 'list' } },
      { outcome: 'unchanged', validators: { etag: 'list' } },
      ok(fresh, candidate),
    );
    const source = createAktualitySource(http);
    expect(await source.collect(input({ listing: { etag: 'list' } }))).toEqual({
      outcome: 'empty',
      cache: { listing: { etag: 'list' } },
    });
    expect(
      await source.collect(
        input({
          listing: { etag: 'list' },
          candidate: { url: candidate, validators: { etag: 'unusable' } },
        }),
      ),
    ).toMatchObject({ outcome: 'edition' });
    expect(http.mock.calls[2]?.[0]).not.toHaveProperty('validators');
  });
  it('rejects article 304 without a parsed candidate and fences unsafe persisted candidates', async () => {
    expect(
      await createAktualitySource(
        transport(ok(listing), { outcome: 'unchanged', validators: {} }),
      ).collect(input()),
    ).toEqual({ outcome: 'malformed' });
    const http = transport({ outcome: 'unchanged', validators: {} });
    expect(
      await createAktualitySource(http).collect(
        input({ candidate: { url: 'https://evil.test/path' } }),
      ),
    ).toEqual({ outcome: 'malformed' });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('rejects a listing redirected to an article before candidate retrieval', async () => {
    const http = transport(ok(listing, candidate));
    expect(await createAktualitySource(http).collect(input())).toEqual({ outcome: 'malformed' });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('discards a late article response after cancellation', async () => {
    const controller = new AbortController();
    const http = transport(ok(listing));
    http.mockImplementationOnce(async () => {
      controller.abort();
      return ok(fresh, candidate);
    });
    expect(
      await createAktualitySource(http).collect({ ...input(), signal: controller.signal }),
    ).toEqual({ outcome: 'cancelled' });
    expect(http).toHaveBeenCalledTimes(2);
  });
  it('does not commit listing or article validators after a parser failure', async () => {
    const cache = {
      listing: { etag: 'good' },
      candidate: {
        url: candidate,
        validators: { etag: 'good-article' },
        edition: parseAktualityEdition(captured, candidate),
      },
    };
    const http = transport(
      ok('<p>Broken listing</p>', aktualityListingUrl, 'poison'),
      ok(listing, aktualityListingUrl, 'new'),
      ok('<p>Broken article</p>', candidate, 'poison'),
    );
    const source = createAktualitySource(http);
    expect(await source.collect(input(cache))).toEqual({ outcome: 'malformed' });
    expect(await source.collect(input(cache))).toEqual({ outcome: 'malformed' });
    expect(cache.listing.etag).toBe('good');
    expect(cache.candidate.validators.etag).toBe('good-article');
  });
  it.each([
    'access-denied',
    'rate-limited',
    'timeout',
    'cancelled',
    'unavailable',
    'malformed',
  ] as const)(
    'preserves %s and retry date at either retrieval step without extra retries',
    async (outcome) => {
      const failure = { outcome, retryAt: new Date(+now + 60_000) };
      const http = transport(failure, ok(listing), failure);
      const source = createAktualitySource(http);
      expect(await source.collect(input())).toEqual(failure);
      expect(await source.collect(input())).toEqual(failure);
      expect(http).toHaveBeenCalledTimes(3);
    },
  );
  it('cancels before starting or between listing and article without extra requests', async () => {
    const http = transport();
    const source = createAktualitySource(http);
    expect(await source.collect({ ...input(), signal: AbortSignal.abort() })).toEqual({
      outcome: 'cancelled',
    });
    expect(http).not.toHaveBeenCalled();
    const controller = new AbortController();
    http.mockImplementationOnce(async () => {
      controller.abort();
      return ok(listing);
    });
    expect(await source.collect({ ...input(), signal: controller.signal })).toEqual({
      outcome: 'cancelled',
    });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
