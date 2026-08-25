import { describe, expect, it } from 'vitest';
import {
  minimizeDiscordContent,
  splitDiscordMessage,
  stripJolandaMention,
} from '../src/discord-text.js';

describe('stripJolandaMention', () => {
  it('removes both Discord mention formats', () => {
    expect(stripJolandaMention('<@123> hello <@!123>', '123')).toBe('hello');
  });
});

describe('minimizeDiscordContent', () => {
  it('replaces stable identifiers in Discord syntax without losing useful labels', () => {
    const minimized = minimizeDiscordContent(
      [
        '<@123456789012345678>',
        '<@!223456789012345678>',
        '<@&323456789012345678>',
        '<#423456789012345678>',
        '<:party:523456789012345678>',
        '</jolanda privacy:623456789012345678>',
        '723456789012345678',
        'https://discord.com/channels/823456789012345678/923456789012345678/1034567890123456789',
      ].join(' '),
    );

    expect(minimized).toBe(
      '@participant @participant @role #channel :party: /jolanda privacy [Discord identifier] [Discord message]',
    );
    expect(minimized).not.toMatch(/\d{17,20}/);
  });
});

describe('splitDiscordMessage', () => {
  it('keeps every chunk under the configured limit without losing words', () => {
    const content = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(' ');
    const chunks = splitDiscordMessage(content, 100, 100);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join(' ')).toBe(content);
  });

  it('caps the number of Discord messages and marks truncation', () => {
    const chunks = splitDiscordMessage('word '.repeat(1_000), 100, 3);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.at(-1)).toContain('[…response truncated]');
  });
});
