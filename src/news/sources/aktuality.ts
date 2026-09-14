import { createNewsHttp, type NewsHttp } from '../http.js';
import { isCurrentDailyEdition } from '../policy.js';
import type { NewsEdition, NewsSource, NewsSourceCache } from '../types.js';
import { malformed, page, plainText, publishedDate, record, revision, safeUrl } from './parse.js';

export const aktualityListingUrl = 'https://www.aktuality.sk/spravy/denny-vyber-sprav/';
const folded = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const editionKind = (value: string) => {
  const text = folded(value).replace(/-/g, ' ');
  return /vyber tyzdna|tyzdenny vyber/.test(text)
    ? 'weekly'
    : /denny vyber/.test(text)
      ? 'daily'
      : undefined;
};
const articleUrl = (value: unknown) => {
  const url = safeUrl(value, 'aktuality');
  return url && new URL(url).pathname.startsWith('/clanok/') ? url : undefined;
};
const articleId = (url: string) => new URL(url).pathname.split('/')[2]!;

export const parseAktualityListing = (html: string) => {
  const $ = page(html);
  const entries = $('a[href]')
    .toArray()
    .flatMap((anchor) => {
      const href = $(anchor).attr('href')!;
      if (!href.includes('/clanok/')) return [];
      const kind = editionKind(`${plainText($(anchor).html(), 2048)} ${href}`);
      if (!kind) return [];
      let url: string | undefined;
      try {
        url = articleUrl(new URL(href, aktualityListingUrl).href);
      } catch {
        throw malformed();
      }
      if (!url) throw malformed();
      return [{ url, kind }];
    });
  // Weekly-only is an observed, intelligible missing-daily result. No recognizable
  // roundup structure is parser drift, not proof that the publisher has no edition.
  if (!entries.length) throw malformed();
  return entries.find(({ kind }) => kind === 'daily')?.url ?? null;
};

export const parseAktualityEdition = (html: string, requestedUrl: string): NewsEdition => {
  const url = articleUrl(requestedUrl);
  if (!url) throw malformed();
  const $ = page(html);
  const meta = (name: string) =>
    $(`meta[property="${name}"],meta[name="${name}"]`)
      .toArray()
      .map((node) => $(node).attr('content'))
      .filter((value): value is string => value !== undefined);
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 10 || nodes.length > 1000) throw malformed();
    if (Array.isArray(value)) {
      value.forEach((node) => visit(node, depth + 1));
      return;
    }
    const node = record(value);
    if (!node) return;
    nodes.push(node);
    if (node['@graph']) visit(node['@graph'], depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, script) => {
    let value: unknown;
    try {
      value = JSON.parse($(script).html() ?? '');
    } catch {
      return;
    }
    visit(value);
  });
  const articles = nodes
    .filter((node) =>
      (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).includes('NewsArticle'),
    )
    .filter(
      (node) =>
        !node.url || (articleUrl(node.url) && articleId(String(node.url)) === articleId(url)),
    );
  const article = articles.length === 1 ? articles[0] : undefined;
  const canonical = [
    ...meta('og:url'),
    ...$('link[rel="canonical"]')
      .toArray()
      .map((node) => $(node).attr('href') ?? ''),
  ];
  if (canonical.some((value) => !articleUrl(value) || articleId(value) !== articleId(url)))
    throw malformed();
  const dates = meta('article:published_time');
  const published = dates.length ? dates : [article?.datePublished];
  const publishedAt = publishedDate(published[0]);
  if (published.some((value) => +publishedDate(value) !== +publishedAt)) throw malformed();
  const title = plainText(
    meta('og:title')[0] ?? article?.headline ?? $('h1').first().html(),
    256,
  ).replace(/\s*\|\s*Aktuality\.sk\s*$/i, '');
  if (!title || editionKind(`${title} ${url} ${canonical.join(' ')}`) !== 'daily')
    throw malformed();
  const content = $('#articleContent');
  const headings = content.find('h2').toArray();
  if (content.length !== 1 || !headings.length || headings.length > 50) throw malformed();
  const sections = headings.map((heading) => {
    const title = plainText($(heading).html(), 500);
    if (!title) throw malformed();
    const anchors = $(heading)
      .find('a[href]')
      .add($(heading).nextUntil('h2').find('a[href]'))
      .toArray();
    const link = anchors.flatMap((anchor) => {
      try {
        return articleUrl(new URL($(anchor).attr('href')!, url).href) ?? [];
      } catch {
        return [];
      }
    })[0];
    return { title, ...(link ? { url: link } : {}) };
  });
  const description = plainText(
    meta('og:description')[0] ?? meta('description')[0] ?? article?.description,
    1500,
  );
  const image = safeUrl(meta('og:image')[0], 'aktuality', 'image');
  const tags = [
    ...new Set(
      meta('article:tag')
        .map((tag) => plainText(tag, 80))
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, 8);
  const normalized = {
    kind: 'edition' as const,
    source: 'aktuality' as const,
    id: articleId(url),
    title,
    url,
    publishedAt,
    sections,
    ...(description ? { description } : {}),
    ...(image ? { image: { url: image } } : {}),
    ...(tags.length ? { tags } : {}),
  };
  return { ...normalized, revision: revision(normalized) };
};

export const createAktualitySource = (http: NewsHttp = createNewsHttp()): NewsSource => ({
  id: 'aktuality',
  collect: async ({ now, cache, signal }) => {
    if (signal.aborted) return { outcome: 'cancelled' };
    const listing = await http({
      url: aktualityListingUrl,
      source: 'aktuality',
      signal,
      ...(cache.listing ? { validators: cache.listing } : {}),
    });
    if (listing.outcome !== 'ok' && listing.outcome !== 'unchanged') return listing;
    if (signal.aborted) return { outcome: 'cancelled' };
    let candidate: string | null;
    try {
      if (
        listing.outcome === 'ok' &&
        (!safeUrl(listing.url, 'aktuality') ||
          new URL(listing.url).pathname.replace(/\/$/, '') !== '/spravy/denny-vyber-sprav')
      )
        throw malformed();
      candidate =
        listing.outcome === 'ok'
          ? parseAktualityListing(listing.html)
          : (cache.candidate?.url ?? null);
      if (candidate && !articleUrl(candidate)) throw malformed();
    } catch {
      return { outcome: 'malformed' };
    }
    if (!candidate) return { outcome: 'empty', cache: { listing: listing.validators } };
    const previous = cache.candidate?.url === candidate ? cache.candidate : undefined;
    const response = await http({
      url: candidate,
      source: 'aktuality',
      signal,
      // A validator without parsed content cannot satisfy an article 304.
      ...(previous?.edition && previous.validators ? { validators: previous.validators } : {}),
    });
    if (response.outcome !== 'ok' && response.outcome !== 'unchanged') return response;
    if (signal.aborted) return { outcome: 'cancelled' };
    try {
      const edition =
        response.outcome === 'ok'
          ? parseAktualityEdition(response.html, response.url)
          : previous?.edition;
      if (!edition) throw malformed();
      const updated: NewsSourceCache = {
        listing: listing.validators,
        candidate: {
          url: response.outcome === 'ok' ? response.url : candidate,
          validators: response.validators,
          edition,
        },
      };
      return isCurrentDailyEdition(edition, now)
        ? { outcome: 'edition', edition, cache: updated }
        : { outcome: 'stale', cache: updated };
    } catch {
      return { outcome: 'malformed' };
    }
  },
});
