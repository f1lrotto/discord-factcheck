import { createNewsHttp, type NewsHttp } from '../http.js';
import type { NewsSource, NewsStory } from '../types.js';
import { malformed, page, plainText, publishedDate, record, revision, safeUrl } from './parse.js';

export const denniknListingUrl = 'https://dennikn.sk/minuta/dolezite';

// Locate JSON's balanced boundary, ignoring braces inside strings. Never evaluate scripts.
const initialState = (html: string) => {
  const $ = page(html);
  const assignments = $('script')
    .toArray()
    .flatMap((script) => {
      const text = $(script).html() ?? '';
      const match = /(?:^|[;\n])\s*window\.__INITIAL_STATE__\s*=\s*/.exec(text);
      return match ? [text.slice(match.index + match[0].length)] : [];
    });
  if (assignments.length !== 1 || assignments[0]![0] !== '{') throw malformed();
  const text = assignments[0]!;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        try {
          return record(JSON.parse(text.slice(0, index + 1)));
        } catch {
          throw malformed();
        }
      }
    }
  }
  throw malformed();
};

const importantQuery = (key: string) => {
  const match = /^getInfinitePosts\((.*)\)$/.exec(key);
  if (!match) return false;
  try {
    const args = record(JSON.parse(match[1]!));
    return args?.important === 1 && args.language === 'sk';
  } catch {
    return false;
  }
};

const normalizePost = (value: unknown): NewsStory => {
  const post = record(value);
  if (
    !post ||
    !Number.isSafeInteger(post.id) ||
    Number(post.id) < 1 ||
    typeof post.isImportant !== 'boolean'
  )
    throw malformed();
  const id = String(post.id);
  const url = safeUrl(post.url, 'dennikn');
  if (!url || new URL(url).pathname.replace(/\/$/, '') !== `/minuta/${id}`) throw malformed();
  const publishedAt = publishedDate(post.published_at);
  if (post.published_at_date !== undefined && post.published_at_date !== +publishedAt)
    throw malformed();
  const excerpt = plainText(post.excerpt, 2000);
  const $ = page(typeof post.excerpt === 'string' && post.excerpt ? post.excerpt : '<p></p>');
  const bold = plainText($('strong,b').first().html(), 256);
  const title =
    plainText(post.title, 256) ||
    (bold && excerpt.startsWith(bold)
      ? bold
      : plainText(excerpt.match(/^.*?[.!?](?:\s|$)/u)?.[0] ?? excerpt, 256));
  if (!title) throw malformed();
  const tags = [
    ...new Set(
      (Array.isArray(post.tags) ? post.tags : [])
        .map((tag) => plainText(record(tag)?.name, 80))
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, 8);
  const sizes = record(post.image)?.sizes;
  const imageUrl = (Array.isArray(sizes) ? sizes : [])
    .flatMap((size) => {
      const data = record(size);
      const image = safeUrl(data?.url, 'dennikn', 'image');
      return image &&
        typeof data?.width === 'number' &&
        Number.isFinite(data.width) &&
        data.width > 0
        ? [{ url: image, width: data.width }]
        : [];
    })
    .sort((a, b) => b.width - a.width || a.url.localeCompare(b.url))[0]?.url;
  const normalized = {
    kind: 'story' as const,
    source: 'dennikn' as const,
    id,
    title,
    url,
    publishedAt,
    important: post.isImportant,
    ...(excerpt ? { description: excerpt } : {}),
    ...(tags.length ? { tags } : {}),
    ...(imageUrl ? { image: { url: imageUrl } } : {}),
  };
  return { ...normalized, revision: revision(normalized) };
};

export const parseDennikn = (html: string) => {
  const queries = record(record(initialState(html)?.postsApi)?.queries);
  const entries = Object.entries(queries ?? {}).filter(([key]) => importantQuery(key));
  if (!entries.length) throw malformed();
  const posts = entries.flatMap(([, value]) => {
    const pages = record(record(value)?.data)?.pages;
    if (!Array.isArray(pages) || !pages.length || pages.length > 20) throw malformed();
    return pages.flatMap((value) => {
      const posts = record(value)?.posts;
      if (!Array.isArray(posts) || posts.length > 1000) throw malformed();
      return posts;
    });
  });
  if (posts.length > 1000) throw malformed();
  const stories = posts.map(normalizePost);
  const unique = new Map<string, NewsStory>();
  for (const story of stories) {
    const duplicate = unique.get(story.id);
    // Conflicting same-snapshot versions lack a reliable source modification ordering.
    if (duplicate && duplicate.revision !== story.revision) throw malformed();
    unique.set(story.id, story);
  }
  return [...unique.values()].sort(
    (a, b) => +b.publishedAt - +a.publishedAt || a.id.localeCompare(b.id),
  );
};

export const createDenniknSource = (http: NewsHttp = createNewsHttp()): NewsSource => ({
  id: 'dennikn',
  collect: async ({ cache, signal }) => {
    if (signal.aborted) return { outcome: 'cancelled' };
    const result = await http({
      url: denniknListingUrl,
      source: 'dennikn',
      signal,
      ...(cache.listing ? { validators: cache.listing } : {}),
    });
    if (result.outcome === 'unchanged')
      return { outcome: 'unchanged', cache: { listing: result.validators } };
    if (result.outcome !== 'ok') return result;
    if (signal.aborted) return { outcome: 'cancelled' };
    try {
      if (
        !safeUrl(result.url, 'dennikn') ||
        new URL(result.url).pathname.replace(/\/$/, '') !== '/minuta/dolezite'
      )
        throw malformed();
      const stories = parseDennikn(result.html);
      const updated = { listing: result.validators };
      return stories.length
        ? { outcome: 'stories', stories, cache: updated }
        : { outcome: 'empty', cache: updated };
    } catch {
      return { outcome: 'malformed' };
    }
  },
});
