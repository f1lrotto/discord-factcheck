import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { validateNewsUrl } from '../http.js';
import type { NewsSourceId } from '../types.js';

export const malformed = () => new Error('malformed');
export const record = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export const boundedText = (value: string, limit: number) =>
  value
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit)
    .replace(/[\uD800-\uDBFF]$/u, '');
export const page = (html: string) => {
  if (!html || Buffer.byteLength(html) > 3_000_000) throw malformed();
  return load(html);
};
export const plainText = (value: unknown, limit: number) => {
  if (typeof value !== 'string') return '';
  const $ = load(value, null, false);
  $('script,style,noscript,template,iframe,svg,math').remove();
  $('br').replaceWith(' ');
  $('p,div,li,h1,h2,h3,h4,blockquote').append(' ');
  return boundedText($.root().text(), limit);
};
export const safeUrl = (value: unknown, source: NewsSourceId, kind: 'page' | 'image' = 'page') => {
  if (typeof value !== 'string') return undefined;
  try {
    return validateNewsUrl(value, source, kind).href;
  } catch {
    return undefined;
  }
};
export const publishedDate = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw malformed();
  const date = new Date(value);
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (
    !Number.isFinite(+date) ||
    Number(value.slice(11, 13)) > 23 ||
    !Number.isFinite(+day) ||
    day.toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    throw malformed();
  return date;
};
export const revision = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
