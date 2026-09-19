import { messages, type Locale } from '../i18n/index.js';
import { MessageFlags, type APIEmbed, type RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import type { NewsContent, NewsSourceId } from './types.js';

const sources = {
  dennikn: {
    name: 'Denník N',
    hosts: ['dennikn.sk', 'www.dennikn.sk', 'e.dennikn.sk'],
    images: ['img.projektn.sk'],
  },
  aktuality: {
    name: 'Aktuality.sk',
    hosts: ['aktuality.sk', 'www.aktuality.sk'],
    images: ['img.aktuality.sk'],
  },
};

// These are displayed links, never fetch targets. Encode Markdown delimiters as whole URL bytes.
const publicUrl = (raw: string, source: NewsSourceId, image = false) => {
  try {
    const url = new URL(raw);
    const hosts = image ? sources[source].images : sources[source].hosts;
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.includes(url.hostname) ||
      url.href.length > 2048
    )
      return undefined;
    const encoded = url.href.replace(
      /[()[\]`<>]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return encoded.length <= 2048 ? encoded : undefined;
  } catch {
    return undefined;
  }
};

// Escape before budgeting, keeping each escaped character and Unicode code point intact.
export const text = (raw: string, limit: number) => {
  const normalized = raw
    .replace(/<[^>]*>/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const atoms = [...normalized].map((character) => {
    if (character === '@') return '@\u200b';
    if (character === '<') return '‹';
    if (character === '>') return '›';
    return /[\\*_~`|#[\]()!+-]/.test(character) ? `\\${character}` : character;
  });
  if (atoms.join('').length <= limit) return atoms.join('');
  let clipped = '';
  for (const atom of atoms) {
    if (clipped.length + atom.length > limit - 1) break;
    clipped += atom;
  }
  return `${clipped}…`;
};

const dailyDescription = (content: Extract<NewsContent, { kind: 'edition' }>, locale: Locale) => {
  const introduction = text(content.description ?? '', 650);
  const omitted = messages(locale).news.moreStories;
  let description = introduction;
  for (const section of content.sections) {
    const title = text(section.title, 180) || messages(locale).news.story;
    const url = section.url && publicUrl(section.url, content.source);
    const headline = url ? `[${title}](${url})` : title;
    const excerpt = text(section.description ?? '', 240);
    const block = `${headline}${excerpt ? `\n${excerpt}` : ''}`;
    const next = `${description}${description ? '\n\n' : ''}${block}`;
    if (next.length > 4096 - omitted.length - 2) {
      return `${description}${description ? '\n\n' : ''}${omitted}`;
    }
    description = next;
  }
  return description;
};

export const renderNews = (content: NewsContent, notifyRoleId?: string, locale: Locale = 'sk') => {
  const url = publicUrl(content.url, content.source);
  if (!url || !Number.isFinite(content.publishedAt.getTime()))
    throw new Error('Invalid normalized news metadata');
  if (notifyRoleId && !/^[1-9]\d{0,19}$/.test(notifyRoleId))
    throw new Error('Invalid news notification role');
  const description =
    content.kind === 'edition'
      ? dailyDescription(content, locale)
      : text(content.description ?? '', 4096);
  const tags = text(content.tags?.join(' · ') ?? '', 200);
  const image = content.image && publicUrl(content.image.url, content.source, true);
  const embed: APIEmbed = {
    title: text(content.title, 256) || sources[content.source].name,
    url,
    timestamp: content.publishedAt.toISOString(),
    footer: { text: `${sources[content.source].name}${tags ? ` · ${tags}` : ''}` },
    ...(description ? { description } : {}),
    ...(image ? { image: { url: image } } : {}),
  };
  // One embed caps aggregate text below 4,600 characters; a daily edition is always one message.
  const role = content.kind === 'edition' ? notifyRoleId : undefined;
  const payload: RESTPostAPIChannelMessageJSONBody = {
    embeds: [embed],
    allowed_mentions: { parse: [], users: [], roles: role ? [role] : [], replied_user: false },
    ...(role ? { content: `<@&${role}>` } : {}),
    ...(content.kind === 'story' ? { flags: MessageFlags.SuppressNotifications } : {}),
  };
  return payload;
};
