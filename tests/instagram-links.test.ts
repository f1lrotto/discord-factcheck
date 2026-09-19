import { describe, expect, it } from 'vitest';
import { parseInstagramReels } from '../src/instagram-links.js';

describe('Instagram links', () => {
  const url = 'https://www.instagram.com/reel/DcjOE3QxRqW/';
  it('canonicalizes shares, punctuation, markdown, aliases, and deduplicates', () => {
    expect(
      parseInstagramReels(
        `[watch](${url}?stkn=secret#fragment), ${url} https://m.instagram.com/reels/other_-/!`,
      ),
    ).toEqual([
      { platform: 'instagram' as const, shortcode: 'DcjOE3QxRqW', url },
      {
        platform: 'instagram' as const,
        shortcode: 'other_-',
        url: 'https://www.instagram.com/reel/other_-/',
      },
    ]);
  });
  it.each([
    '`URL`',
    '```ts\nURL\n```',
    '```URL',
    '||URL||',
    '||URL',
    '<URL>',
    'before ``URL`` after',
  ])('ignores protected form %s', (form) => {
    expect(parseInstagramReels(form.replace('URL', url))).toEqual([]);
  });
  it.each([
    'http://instagram.com/reel/id',
    'https://instagram.com.evil.test/reel/id',
    'https://evilinstagram.com/reel/id',
    'https://user:pass@instagram.com/reel/id',
    'https://instagram.com:444/reel/id',
    'https://instagram.com/reel/id/extra',
    'https://instagram.com/reel/a%2Fb',
    'https://instagram.com/reel/ä',
    'https://instagram.com/share/id',
    'https://instagram.com/x/../reel/id',
    'https://instagram.com/reel/' + 'a'.repeat(65),
    'https://instagram.com/reel/abc\\def',
  ])('rejects %s', (value) => expect(parseInstagramReels(value)).toEqual([]));
  it('bounds message and result sizes', () => {
    expect(parseInstagramReels('a'.repeat(20_001))).toEqual([]);
    expect(
      parseInstagramReels(
        Array.from({ length: 8 }, (_, i) => `https://instagram.com/reel/${i}`).join(' '),
      ),
    ).toHaveLength(4);
    expect(parseInstagramReels(`https://instagram.com/reel/${'a'.repeat(64)}`)).toHaveLength(1);
  });
});

it('recognizes the entire Instagram carousel and strips slide/tracking parameters', () => {
  expect(
    parseInstagramReels('https://www.instagram.com/p/DdTfQ2SjrBf/?img_index=5&stkn=secret'),
  ).toEqual([
    {
      platform: 'instagram',
      shortcode: 'DdTfQ2SjrBf',
      url: 'https://www.instagram.com/p/DdTfQ2SjrBf/',
    },
  ]);
  expect(
    parseInstagramReels('https://instagram.com/p/id https://m.instagram.com/p/id/?img_index=2'),
  ).toHaveLength(1);
});
