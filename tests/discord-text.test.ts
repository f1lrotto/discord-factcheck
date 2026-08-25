import { describe, expect, it } from 'vitest';
import {
  clampDiscordMarkdown,
  minimizeDiscordContent,
  parseJolandaPrompt,
  splitDiscordMessage,
  stripJolandaMention,
} from '../src/discord-text.js';

describe('clampDiscordMarkdown', () => {
  it('converts headings to normal-sized bold labels, including quoted headings', () => {
    expect(
      clampDiscordMarkdown(
        '# Main title\n### Details ###\n  # Indented title\n> ## Quoted title\nKeep # inline',
      ),
    ).toBe('**Main title**\n**Details**\n  **Indented title**\n> **Quoted title**\nKeep # inline');
  });

  it('preserves Markdown-looking content inside fenced code blocks', () => {
    const content = ['```md', '# Code heading', '```', '# Answer heading'].join('\n');

    expect(clampDiscordMarkdown(content)).toBe(
      ['```md', '# Code heading', '```', '**Answer heading**'].join('\n'),
    );
  });

  it('is stable when a heading is already bold', () => {
    const content = '# **Compact title**';

    expect(clampDiscordMarkdown(clampDiscordMarkdown(content))).toBe('**Compact title**');
  });
});

describe('stripJolandaMention', () => {
  it('removes both Discord mention formats', () => {
    expect(stripJolandaMention('<@123> hello <@!123>', '123')).toBe('hello');
  });
});

describe('parseJolandaPrompt', () => {
  it('keeps ordinary questions at zero ambient context', () => {
    expect(parseJolandaPrompt('Fact-check this')).toEqual({
      ok: true,
      question: 'Fact-check this',
    });
  });

  it('extracts maximum and numeric per-turn context modifiers', () => {
    expect(parseJolandaPrompt('+context Fact-check this')).toEqual({
      ok: true,
      question: 'Fact-check this',
      ambientContext: { limit: 'maximum' },
    });
    expect(parseJolandaPrompt('+context=12 Fact-check this')).toEqual({
      ok: true,
      question: 'Fact-check this',
      ambientContext: { limit: 12 },
    });
  });

  it('rejects malformed or unsafe context values without matching similar words', () => {
    expect(parseJolandaPrompt('+context=many Fact-check this')).toEqual({ ok: false });
    expect(parseJolandaPrompt(`+context=${'9'.repeat(100)} Fact-check this`)).toEqual({
      ok: false,
    });
    expect(parseJolandaPrompt('+contextual question')).toEqual({
      ok: true,
      question: '+contextual question',
    });
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
