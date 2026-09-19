import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { downloadInstagramPhotos, extractInstagramPhotos } from '../src/instagram-photos.js';
import { parseInstagramReels } from '../src/instagram-links.js';
import { reelLimits } from '../src/reel-limits.js';

const reel = parseInstagramReels('https://www.instagram.com/p/DdTfQ2SjrBf/')[0]!;
const url = 'https://scontent.cdninstagram.com/photo.jpg?signature=private';
const photo = { is_video: false, display_url: url };
const post = { ...photo, shortcode: reel.shortcode };
const page = (media: unknown = post, blocked = false) =>
  `<script>${JSON.stringify({
    contextJSON: JSON.stringify({
      context: { copyright_blocked: blocked },
      gql_data: { shortcode_media: media },
    }),
  })}</script>`;
const album = (count: number) => ({
  ...post,
  edge_sidecar_to_children: {
    edges: Array.from({ length: count }, (_, i) => ({
      node: { ...photo, display_url: `${url}&slide=${i}` },
    })),
  },
});

describe('Instagram photo extraction', () => {
  it('extracts every carousel photo in order and supports single-image posts', () => {
    expect(extractInstagramPhotos(page(album(7)), reel)).toEqual(
      Array.from({ length: 7 }, (_, i) => [`${url}&slide=${i}`]),
    );
    expect(extractInstagramPhotos(page(), reel)).toEqual([[url]]);
  });
  it.each([
    '<html>Login</html>',
    '"contextJSON":"broken"',
    page({ ...post, shortcode: 'other' }),
    page(post, true),
    page({ ...post, is_video: true }),
    page({ ...post, edge_sidecar_to_children: { edges: [] } }),
    page({
      ...post,
      edge_sidecar_to_children: {
        edges: [{ node: photo }, { node: { ...photo, is_video: true } }],
      },
    }),
    page({ ...post, display_url: 'https://evil.test/photo.jpg' }),
    page({ ...post, display_url: url.replace('.jpg', '.heic') }),
    'x'.repeat(reelLimits.pageBytes + 1),
  ])('fails closed for unavailable, malformed or incompatible metadata (%#)', (raw) => {
    expect(() => extractInstagramPhotos(raw, reel)).toThrow('photos_unavailable');
  });
  it('rejects an oversized carousel instead of dropping images', () => {
    expect(() => extractInstagramPhotos(page(album(36)), reel)).toThrow('too_many_photos');
  });
  it('downloads validated originals using Instagram hosts, names and one aggregate limit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'instagram-photos-test-'));
    const jpeg = Buffer.from('ffd8ffe000104a464946000101', 'hex');
    const transfer = vi.fn(async ({ path }: { path: string }) => {
      await writeFile(path, jpeg);
      return jpeg.length;
    });
    const input = {
      reel,
      cwd,
      maximumBytes: 1000,
      signal: AbortSignal.timeout(2000),
      extractionSignal: AbortSignal.timeout(2000),
    };
    const dependencies = { fetchPage: vi.fn(async () => page(album(7))), transfer };
    try {
      const result = await downloadInstagramPhotos(input, dependencies);
      expect(result).toMatchObject({ kind: 'photos', bytes: 7 * jpeg.length, url: reel.url });
      expect(result.files.map(({ name }) => name)).toEqual(
        Array.from({ length: 7 }, (_, i) => `instagram-photo-0${i + 1}.jpg`),
      );
      expect(transfer).toHaveBeenNthCalledWith(
        7,
        expect.objectContaining({
          platform: 'instagram',
          kind: 'image',
          maximumBytes: 1000 - 6 * jpeg.length,
        }),
      );
      await expect(
        downloadInstagramPhotos({ ...input, maximumBytes: 1 }, dependencies),
      ).rejects.toMatchObject({ category: 'too_large' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
