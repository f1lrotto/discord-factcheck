import { parseInstagramReels } from './instagram-links.js';
import { parseTikTokPosts } from './tiktok-links.js';
import type { Reel } from './reel-types.js';
import { visibleHttpsLinks } from './reel-links.js';

export const parseRepostLinks = (content: string) => {
  const links = new Map<string, Reel>();
  for (const url of visibleHttpsLinks(content)) {
    const link = parseInstagramReels(url.href)[0] ?? parseTikTokPosts(url.href)[0];
    if (link) links.set(link.shortcode, link);
    if (links.size === 4) break;
  }
  return [...links.values()];
};
