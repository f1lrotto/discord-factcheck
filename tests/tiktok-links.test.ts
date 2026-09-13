import { describe, expect, it } from 'vitest';
import { parseTikTokPosts } from '../src/tiktok-links.js';
import { parseRepostLinks } from '../src/repost-links.js';

const url = 'https://www.tiktok.com/@creator.name/video/123456789';
describe('TikTok links', () => {
  it('recognizes photo posts without confusing their IDs with videos', () => {
    expect(parseTikTokPosts('https://www.tiktok.com/@a/photo/123?tracking=1')).toEqual([
      {
        platform: 'tiktok',
        shortcode: 'tiktok:photo:123',
        url: 'https://www.tiktok.com/@a/photo/123',
      },
    ]);
  });
  it('canonicalizes aliases and tracking parameters and deduplicates video IDs', () => {
    expect(
      parseTikTokPosts(
        `[watch](${url}?share=private#fragment), ${url} https://m.tiktok.com/@other/video/123456789/`,
      ),
    ).toEqual([
      {
        platform: 'tiktok',
        shortcode: 'tiktok:video:123456789',
        url: 'https://www.tiktok.com/@other/video/123456789',
      },
    ]);
  });
  it.each([
    'https://vm.tiktok.com/ABC/',
    'https://vt.tiktok.com/ABC/',
    'https://www.tiktok.com/t/ABC/',
  ])('accepts share %s', (share) => {
    expect(parseTikTokPosts(`${share}?tracking=private`)[0]).toMatchObject({
      platform: 'tiktok',
      url: share,
    });
  });
  it.each(['`URL`', '```URL', '||URL||', '||URL', '<URL>'])('ignores protected form %s', (form) => {
    expect(parseTikTokPosts(form.replace('URL', url))).toEqual([]);
  });
  it.each([
    'http://www.tiktok.com/@a/video/123',
    'https://www.tiktok.com.evil.test/@a/video/123',
    'https://eviltiktok.com/@a/video/123',
    'https://user:pass@www.tiktok.com/@a/video/123',
    'https://www.tiktok.com:444/@a/video/123',
    'https://www.tiktok.com/@a/video/123/extra',
    'https://www.tiktok.com/@a/live',
    'https://www.tiktok.com/@a',
    'https://www.tiktok.com/@a/video/notanumber',
    'https://www.tiktok.com/x/../@a/video/123',
    'https://www.tiktok.com/@a%2fb/video/123',
    'https://vm.tiktok.com/ABC/extra',
    'https://vm.tiktok.com/',
  ])('rejects %s', (value) => expect(parseTikTokPosts(value)).toEqual([]));
  it('shares result limits and message ordering across platforms', () => {
    expect(parseTikTokPosts('a'.repeat(20001) + url)).toEqual([]);
    expect(
      parseTikTokPosts(Array.from({ length: 8 }, (_, i) => `${url}${i}`).join(' ')),
    ).toHaveLength(4);
    const instagram = 'https://www.instagram.com/reel/123456789/';
    expect(parseRepostLinks(`${url} ${instagram}`).map(({ platform }) => platform)).toEqual([
      'tiktok',
      'instagram',
    ]);
    expect(parseRepostLinks(`${instagram} ${url}`).map(({ platform }) => platform)).toEqual([
      'instagram',
      'tiktok',
    ]);
    expect(parseRepostLinks(`${url} ${url}`)).toHaveLength(1);
    expect(
      parseRepostLinks(Array.from({ length: 8 }, (_, i) => `${url}${i}`).join(' ')),
    ).toHaveLength(4);
  });
});
