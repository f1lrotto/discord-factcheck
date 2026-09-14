import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const [mode, ...extra] = process.argv.slice(2);
if (!['--fixtures', '--live'].includes(mode) || extra.length)
  throw new Error('Choose --fixtures (offline previews) or --live (bounded publisher GETs).');

const [{ createNewsHttp }, { createDenniknSource, denniknListingUrl }, aktuality, { renderNews }] =
  await Promise.all([
    import('../dist/news/http.js'),
    import('../dist/news/sources/dennikn.js'),
    import('../dist/news/sources/aktuality.js'),
    import('../dist/news/render.js'),
  ]);
const fixture = (name) =>
  readFile(new URL(`../tests/news/fixtures/publishers/${name}`, import.meta.url), 'utf8');
const fixtureHttp = async ({ url }) => {
  const metadata = JSON.parse(await fixture('aktuality-edition-metadata.json'));
  const candidate = metadata.metadata.find((entry) => entry.property === 'og:url').content;
  const name =
    url === denniknListingUrl
      ? 'dennikn-initial-state.html'
      : url === aktuality.aktualityListingUrl
        ? 'aktuality-listing.html'
        : url === candidate
          ? 'aktuality-edition.html'
          : null;
  if (!name) throw new Error('Unexpected fixture request');
  return { outcome: 'ok', url, html: await fixture(name), validators: {} };
};
const live = mode === '--live';
const retrieve = live ? createNewsHttp() : fixtureHttp;
const requests = [];
const http = async (input) => {
  const started = Date.now();
  const result = await retrieve(input);
  requests.push({
    source: input.source,
    url: input.url,
    outcome: result.outcome,
    elapsedMs: Date.now() - started,
  });
  return result;
};
const now = live ? new Date() : new Date('2026-09-14T07:39:32.136Z');
const sources = [createDenniknSource(http), aktuality.createAktualitySource(http)];
const results = await Promise.all(
  sources.map(async (source) => {
    try {
      const result = await source.collect({
        now,
        cache: {},
        signal: globalThis.AbortSignal.timeout(55_000),
      });
      const sample =
        result.outcome === 'stories'
          ? result.stories.find((story) => story.important)
          : result.outcome === 'edition'
            ? result.edition
            : 'cache' in result
              ? result.cache.candidate?.edition
              : undefined;
      if (!['stories', 'edition', 'empty', 'stale', 'unchanged'].includes(result.outcome))
        process.exitCode = 1;
      return {
        source: source.id,
        outcome: result.outcome,
        ...(result.outcome === 'stories'
          ? { importantStories: result.stories.filter((story) => story.important).length }
          : {}),
        ...(source.id === 'aktuality'
          ? { freshEditionCollected: result.outcome === 'edition' }
          : {}),
        ...(sample
          ? {
              samplePublishedAt: sample.publishedAt.toISOString(),
              preview: renderNews(sample),
            }
          : {}),
      };
    } catch {
      process.exitCode = 1;
      return { source: source.id, outcome: 'smoke_failed' };
    }
  }),
);
process.stdout.write(
  `${JSON.stringify(
    {
      mode: live ? 'live-read-only' : 'fixtures',
      checkedAt: now.toISOString(),
      network: live ? 'publisher GETs from this host' : 'none',
      storage: 'not opened',
      discord: 'not opened; previews only, including stale samples',
      requests,
      results,
    },
    null,
    2,
  )}\n`,
);
