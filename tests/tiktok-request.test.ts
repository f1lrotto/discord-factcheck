import { describe, expect, it } from 'vitest';
import { tikTokGuestCookies } from '../src/tiktok-request.js';
describe('ephemeral TikTok guest cookies', () => {
  it('decodes quoted chain tokens and preserves only scoped anonymous cookies', () => {
    expect(
      tikTokGuestCookies(
        'ttwid=visitor%7Cid; Domain=.tiktok.com; Path=/; Secure; tt_chain_token="abc/def=="; Domain=.tiktok.com; Path=/; Secure; Expires=9999999999; sid_tt=login; Domain=.tiktok.com; Path=/; Secure',
      ),
    ).toBe('ttwid=visitor%7Cid; tt_chain_token=abc/def==');
  });
  it.each([
    undefined,
    '',
    'x'.repeat(16385),
    'ttwid=x; Domain=evil.test; Path=/',
    'ttwid=x; Domain=.tiktok.com; Path=/private',
    'ttwid=x',
    'ttwid=x\r\nInjected: header; Domain=.tiktok.com; Path=/',
  ])('rejects missing, unscoped or unsafe values', (raw) => {
    expect(tikTokGuestCookies(raw)).toBe('');
  });
});
