import { MessageFlags, type APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderNews } from '../../src/news/render.js';
import type { NewsEdition, NewsStory } from '../../src/news/types.js';

const story: NewsStory = {
  kind: 'story',
  source: 'dennikn',
  id: '1',
  revision: '1',
  important: true,
  title: 'Dôležitá správa',
  url: 'https://dennikn.sk/minuta/1234/',
  publishedAt: new Date('2026-09-14T13:00:00Z'),
};
const edition: NewsEdition = {
  kind: 'edition',
  source: 'aktuality',
  id: '2',
  revision: '1',
  title: 'Denný výber správ',
  url: 'https://www.aktuality.sk/clanok/abc/denny-vyber/',
  publishedAt: new Date('2026-09-14T17:00:00Z'),
  sections: [
    {
      title: 'Prvá správa',
      url: 'https://www.aktuality.sk/clanok/abc/prva-sprava/',
      description: 'Krátky opis.',
    },
  ],
};
const embedSize = (embed: APIEmbed) =>
  (embed.title?.length ?? 0) +
  (embed.description?.length ?? 0) +
  (embed.footer?.text.length ?? 0) +
  (embed.author?.name.length ?? 0) +
  (embed.fields?.reduce((sum, field) => sum + field.name.length + field.value.length, 0) ?? 0);

describe('news renderer', () => {
  it('preserves a source title, link and time without optional metadata', () => {
    expect(renderNews(story)).toEqual({
      embeds: [
        {
          title: story.title,
          url: story.url,
          timestamp: '2026-09-14T13:00:00.000Z',
          footer: { text: 'Denník N' },
        },
      ],
      flags: MessageFlags.SuppressNotifications,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    });
  });
  it('preserves the exact economy hostname present in six captured Denník minute links', () => {
    const url = 'https://e.dennikn.sk/minuta/5558475/';
    expect(renderNews({ ...story, id: '5558475', url }).embeds![0]!.url).toBe(url);
    expect(() =>
      renderNews({ ...story, url: 'https://e.dennikn.sk.evil.test/minuta/5558475/' }),
    ).toThrow();
    expect(() =>
      renderNews({ ...story, url: 'https://other.dennikn.sk/minuta/5558475/' }),
    ).toThrow();
  });
  it('preserves useful descriptions, tags and provider image metadata', () => {
    const payload = renderNews({
      ...story,
      description: 'Zdrojový opis.',
      tags: ['Slovensko', 'Politika'],
      image: { url: 'https://img.projektn.sk/image.jpg' },
    });
    expect(payload.embeds?.[0]).toMatchObject({
      description: 'Zdrojový opis.',
      footer: { text: 'Denník N · Slovensko · Politika' },
      image: { url: 'https://img.projektn.sk/image.jpg' },
    });
    expect(
      renderNews({ ...edition, image: { url: 'https://img.aktuality.sk/foto.jpg' } }).embeds?.[0]
        ?.image,
    ).toEqual({ url: 'https://img.aktuality.sk/foto.jpg' });
  });
  it('escapes source Markdown, removes HTML and neutralizes all source mentions', () => {
    const hostile =
      '<b>Title</b> @everyone @here <@123> <@&456> [click](https://evil.test) **bold** `code` ||spoiler|| # heading';
    const embed = renderNews({ ...story, title: hostile, description: hostile, tags: [hostile] })
      .embeds![0]!;
    for (const value of [embed.title!, embed.description!, embed.footer!.text]) {
      expect(value).not.toMatch(/@(everyone|here)|<[^>]*>|(?<!\\)\[click\]/);
      expect(value).toContain('@\u200beveryone');
      expect(value).toContain('\\[click\\]\\(https://evil.test\\)');
      expect(value).toContain('\\*\\*bold\\*\\*');
    }
  });
  it('builds one daily message with source introduction and links, allowing only an explicit role', () => {
    const payload = renderNews({ ...edition, description: 'Dnešný prehľad.' }, '345');
    expect(payload).toMatchObject({
      content: '<@&345>',
      allowed_mentions: { parse: [], users: [], roles: ['345'], replied_user: false },
    });
    expect(payload.flags).toBeUndefined();
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds![0]!.description).toBe(
      'Dnešný prehľad.\n\n[Prvá správa](https://www.aktuality.sk/clanok/abc/prva-sprava/)\nKrátky opis.',
    );
    expect(renderNews(edition).content).toBeUndefined();
    expect(renderNews(edition).allowed_mentions?.roles).toEqual([]);
    expect(renderNews(story, '345').content).toBeUndefined();
    expect(renderNews(story, '345').allowed_mentions?.roles).toEqual([]);
  });
  it('bounds long daily editions without splitting messages, Unicode or Markdown links', () => {
    const payload = renderNews({
      ...edition,
      title: '😀*'.repeat(300),
      description: 'Opis '.repeat(500),
      tags: ['x'.repeat(500)],
      sections: Array.from({ length: 100 }, (_, index) => ({
        title: '[😀]'.repeat(70),
        url: `https://www.aktuality.sk/clanok/${index}/a(b)[c]`,
        description: 'Text '.repeat(100),
      })),
    });
    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds![0]!;
    expect(embedSize(embed)).toBeLessThanOrEqual(6000);
    expect(embed.title!.length).toBeLessThanOrEqual(256);
    expect(embed.title).not.toMatch(/\p{Surrogate}/u);
    expect(embed.title).not.toMatch(/(?<!\\)\\…$/);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.description).toContain('Ďalšie správy nájdete v zdrojovom článku.');
    const links = [...embed.description!.matchAll(/\]\((https:[^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, url] of links) {
      expect(new URL(url!).hostname).toBe('www.aktuality.sk');
      expect(url).toContain('a%28b%29%5Bc%5D');
    }
  });
  it('bounds continuous descriptions with intact escape pairs and falls back for empty titles', () => {
    const embed = renderNews({ ...story, title: '<b></b>', description: '*😀'.repeat(3000) })
      .embeds![0]!;
    expect(embed.title).toBe('Denník N');
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.description).not.toMatch(/\p{Surrogate}/u);
    expect(embedSize(embed)).toBeLessThanOrEqual(6000);
    expect(embed.description).toMatch(/…$/);
  });
  it.each([
    'http://dennikn.sk/minuta/1',
    'https://dennikn.sk.evil.test/1',
    'https://evil.test/1',
    'https://user@dennikn.sk/1',
    'https://dennikn.sk:8080/1',
    'javascript:alert(1)',
    'not a URL',
    `https://dennikn.sk/${'x'.repeat(2100)}`,
  ])('rejects an unsafe source URL: %s', (url) => {
    expect(() => renderNews({ ...story, url })).toThrow('Invalid normalized news metadata');
  });
  it('omits unsafe optional image/section URLs and renders editions missing optional text', () => {
    const payload = renderNews({
      ...edition,
      image: { url: 'https://img.aktuality.sk.evil.test/a' },
      sections: [
        { title: '', url: 'https://evil.test/a' },
        { title: '<@&345> @everyone [x]', url: 'javascript:alert(1)' },
      ],
    });
    expect(payload.embeds![0]!.image).toBeUndefined();
    expect(payload.embeds![0]!.description).toBe('Správa\n\n@\u200beveryone \\[x\\]');
    expect(renderNews({ ...edition, sections: [] }).embeds![0]!.description).toBeUndefined();
  });
  it('rejects URLs whose encoded Markdown delimiters exceed the URL limit', () => {
    expect(() => renderNews({ ...story, url: `https://dennikn.sk/${'('.repeat(1000)}` })).toThrow();
  });
  it('rejects invalid timestamps and role strings', () => {
    expect(() => renderNews({ ...story, publishedAt: new Date('bad') })).toThrow();
    expect(() => renderNews(edition, '123> @everyone')).toThrow();
  });
});
