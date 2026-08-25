import { describe, expect, it } from 'vitest';
import {
  addSourceCitation,
  attachSourceCitations,
  createSourceCitation,
  sourceCitationMarkdown,
  uniqueSourceCitations,
  type SourceCitation,
} from '../src/citations.js';
import {
  maximumCitationAnnotations,
  maximumCitationTitleCharacters,
  maximumResponseCharacters,
} from '../src/limits.js';

describe('structured source citations', () => {
  it('normalizes a public annotation into bounded provider-agnostic metadata', () => {
    expect(
      createSourceCitation({
        url: 'https://events.example.com/calendar?tracking=private#month',
        title: `  Events\u0000   calendar ${'x'.repeat(maximumCitationTitleCharacters)}  `,
        startIndex: 4,
        endIndex: 11,
      }),
    ).toEqual({
      url: 'https://events.example.com/calendar',
      title: `Events calendar ${'x'.repeat(maximumCitationTitleCharacters - 16)}`,
      startIndex: 4,
      endIndex: 11,
    });
  });

  it('rejects private URLs and discards incomplete, reversed, or oversized ranges', () => {
    expect(createSourceCitation({ url: 'http://127.0.0.1/private' })).toBeNull();
    expect(
      createSourceCitation({
        url: 'https://events.example.com/calendar',
        startIndex: 12,
        endIndex: 4,
      }),
    ).toEqual({ url: 'https://events.example.com/calendar' });
    expect(
      createSourceCitation({
        url: 'https://events.example.com/calendar',
        startIndex: 0,
        endIndex: maximumResponseCharacters + 1,
      }),
    ).toEqual({ url: 'https://events.example.com/calendar' });
  });

  it('deduplicates annotations, caps their count, and retains metadata for unique footer sources', () => {
    const first = { url: 'https://events.example.com/a', startIndex: 0, endIndex: 1 };
    expect(addSourceCitation([first], first)).toEqual([first]);

    const full = Array.from({ length: maximumCitationAnnotations }, (_, index) => ({
      url: `https://events.example.com/${index}`,
    }));
    expect(addSourceCitation(full, { url: 'https://events.example.com/overflow' })).toBe(full);
    expect(
      uniqueSourceCitations(
        [first, { ...first, title: 'Richer title', startIndex: 10, endIndex: 11 }],
        ['https://events.example.com/b?tracking=1'],
      ),
    ).toEqual([
      { ...first, title: 'Richer title', startIndex: 10, endIndex: 11 },
      { url: 'https://events.example.com/b' },
    ]);
  });

  it('renders bounded titles and trusted markers at inclusive annotation ranges', () => {
    const citation: SourceCitation = {
      url: 'https://events.example.com/calendar',
      title: 'Events [calendar](unsafe) `listing`',
      startIndex: 0,
      endIndex: 5,
    };

    expect(sourceCitationMarkdown(citation, 1)).toBe(
      '[Source 1: Events calendarunsafe listing](https://events.example.com/calendar)',
    );
    expect(attachSourceCitations('Events are listed.', [citation])).toBe(
      'Events [Source 1: Events calendarunsafe listing](https://events.example.com/calendar) are listed.',
    );
  });

  it('renders multiple markers from the end without shifting earlier ranges', () => {
    const citations: SourceCitation[] = [
      {
        url: 'https://events.example.com/alpha',
        startIndex: 0,
        endIndex: 4,
      },
      {
        url: 'https://events.example.com/beta',
        startIndex: 7,
        endIndex: 10,
      },
    ];

    expect(attachSourceCitations('Alpha. Beta.', citations)).toBe(
      'Alpha [Source 1](https://events.example.com/alpha). Beta [Source 2](https://events.example.com/beta).',
    );
  });

  it('ignores invalid positions and does not duplicate a URL already inside its cited range', () => {
    const existing = 'See https://events.example.com/calendar';
    expect(
      attachSourceCitations(existing, [
        {
          url: 'https://events.example.com/calendar',
          startIndex: 0,
          endIndex: existing.length,
        },
        {
          url: 'https://events.example.com/out-of-range',
          startIndex: existing.length,
          endIndex: existing.length,
        },
      ]),
    ).toBe(existing);
    expect(
      attachSourceCitations('Private target', [
        { url: 'http://127.0.0.1/admin', startIndex: 0, endIndex: 6 },
      ]),
    ).toBe('Private target');
    expect(
      uniqueSourceCitations(
        [{ url: 'http://127.0.0.1/admin' }],
        ['https://events.example.com/calendar'],
      ),
    ).toEqual([{ url: 'https://events.example.com/calendar' }]);
  });
});
