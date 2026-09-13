// Only anonymous cookies created during this extraction may accompany TikTok media.
// yt-dlp serializes each cookie followed by its Domain/Path/Secure attributes.
export const tikTokGuestCookies = (serialized: string | undefined) => {
  if (!serialized || serialized.length > 16_384) return '';
  const cookies = serialized.split(/;\s*(?=[^;=]+=[^;]*(?:;\s*Domain=))/i);
  return cookies
    .flatMap((cookie) => {
      const [pair, ...attributes] = cookie.split(/;\s*/);
      const match =
        /^(ttwid|tt_chain_token|tt_csrf_token)=(?:"([A-Za-z0-9%_|.+=/-]{1,4096})"|([A-Za-z0-9%_|.+=/-]{1,4096}))$/.exec(
          pair ?? '',
        );
      if (!match) return [];
      const normalized = `${match[1]}=${match[2] ?? match[3]}`;
      const domain = attributes
        .find((value) => /^Domain=/i.test(value))
        ?.slice(7)
        .toLowerCase();
      const path = attributes.find((value) => /^Path=/i.test(value))?.slice(5);
      return ['.tiktok.com', 'tiktok.com'].includes(domain ?? '') && path === '/'
        ? [normalized]
        : [];
    })
    .join('; ');
};

export type TikTokMediaRequest = { userAgent: string; referer: string; cookie: string };
