import { describe, expect, it } from 'vitest';
import {
  clampDiscordMarkdown,
  minimizeDiscordContent,
  parseJolandaPrompt,
  splitDiscordChunks,
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

  it('never cuts through a Markdown link', () => {
    const footer = [
      '---',
      '🌐 **Source basis:** Public web research was used.',
      '- [Source 1: Tunel Karpaty](https://sk.wikipedia.org/wiki/Tunel_Karpaty)',
      '- [Source 2: Vláda zaradila tunel Karpaty](https://www.teraz.sk/karpaty)',
      '💵 **Response cost:** $0.012448',
    ].join('\n');
    const chunks = splitDiscordMessage(`${'Veta o tuneli. '.repeat(120)}\n\n${footer}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.match(/\[/gu)?.length ?? 0).toBe(chunk.match(/\]\(/gu)?.length ?? 0);
      expect(chunk).not.toMatch(/\]\([^)]*$/u);
      expect(chunk).not.toMatch(/^[^[]*\]\(/u);
    }
    expect(chunks.at(-1)).toContain(
      '[Source 1: Tunel Karpaty](https://sk.wikipedia.org/wiki/Tunel_Karpaty)',
    );
  });

  it('never cuts through an emphasis run or inline code span', () => {
    const content = Array.from(
      { length: 40 },
      (_, index) => `Line ${index} with **bold ${index} text** and \`code-${index}\` inline.`,
    ).join('\n');

    for (const chunk of splitDiscordMessage(content, 120, 100)) {
      expect((chunk.match(/\*\*/gu)?.length ?? 0) % 2).toBe(0);
      expect((chunk.match(/`/gu)?.length ?? 0) % 2).toBe(0);
    }
  });

  it('closes and reopens a code fence across a boundary', () => {
    const chunks = splitDiscordMessage(
      `intro\n\`\`\`ts\n${'const value = 1;\n'.repeat(40)}\`\`\`\ndone`,
      300,
      20,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect((chunk.match(/```/gu)?.length ?? 0) % 2).toBe(0);
    expect(chunks[1]).toMatch(/^```\n/u);
  });

  it('reports the source offset each chunk consumed', () => {
    const content = 'word '.repeat(400).trim();
    const chunks = splitDiscordChunks(content, 200, 20);

    expect(chunks.at(-1)?.sourceEnd).toBe(content.length);
    for (const [index, chunk] of chunks.entries()) {
      const previous = chunks[index - 1]?.sourceEnd ?? 0;
      expect(chunk.sourceEnd).toBeGreaterThan(previous);
      expect(content.slice(previous, chunk.sourceEnd).trim()).toBe(chunk.text.trim());
    }
  });
});
