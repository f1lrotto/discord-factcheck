// Strip protected Discord Markdown, including unclosed fences and spoilers.
export function* visibleHttpsLinks(content: string) {
  if (content.length > 20_000) return;
  const visible = content.replace(
    /```[\s\S]*?(?:```|$)|`+[^`\n]*(?:`+|$)|\|\|[\s\S]*?(?:\|\||$)|<[^>\n]*>/g,
    ' ',
  );
  for (const match of visible.matchAll(/https?:\/\/[^\s<>[\]()`|]+/gi)) {
    const raw = match[0].replace(/[.,!?;:]+$/, '');
    try {
      const url = new URL(raw);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        /\\|%|\/\.{1,2}(?:\/|$)/.test(raw.split(/[?#]/)[0] ?? '')
      )
        continue;
      yield url;
    } catch {
      // Invalid links are ordinary message text.
    }
  }
}
