import type { Reel } from './reel-types.js';

import { visibleHttpsLinks } from './reel-links.js';

export const parseInstagramReels = (content: string): Reel[] => {
  const reels = new Map<string, Reel>();
  for (const url of visibleHttpsLinks(content)) {
    if (!['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname)) continue;
    const shortcode = /^\/reels?\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname)?.[1];
    if (!shortcode) continue;
    reels.set(shortcode, {
      platform: 'instagram',
      shortcode,
      url: `https://www.instagram.com/reel/${shortcode}/`,
    });
    if (reels.size === 4) break;
  }
  return [...reels.values()];
};
