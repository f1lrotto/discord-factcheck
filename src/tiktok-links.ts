import type { Reel } from './reel-types.js';
import { visibleHttpsLinks } from './reel-links.js';

export const parseTikTokPosts = (content: string): Reel[] => {
  const videos = new Map<string, Reel>();
  for (const url of visibleHttpsLinks(content)) {
    const mainHost = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname);
    const direct =
      mainHost && /^\/@([A-Za-z0-9_.-]{1,64})\/(video|photo)\/([0-9]{1,25})\/?$/.exec(url.pathname);
    const share = mainHost
      ? /^\/t\/([A-Za-z0-9_]{1,64})\/?$/.exec(url.pathname)?.[1]
      : ['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname)
        ? /^\/([A-Za-z0-9_]{1,64})\/?$/.exec(url.pathname)?.[1]
        : undefined;
    if (!direct && !share) continue;
    const canonical = direct
      ? `https://www.tiktok.com/@${direct[1]}/${direct[2]}/${direct[3]}`
      : `https://${mainHost ? 'www.tiktok.com/t' : url.hostname}/${share}/`;
    // Namespace TikTok claims so existing Instagram delivery keys remain stable.
    const shortcode = direct ? `tiktok:${direct[2]}:${direct[3]}` : `tiktok:share:${canonical}`;
    videos.set(shortcode, { platform: 'tiktok', shortcode, url: canonical });
    if (videos.size === 4) break;
  }
  return [...videos.values()];
};
