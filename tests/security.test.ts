import { describe, expect, it } from 'vitest';
import { maximumResponseCharacters } from '../src/limits.js';
import { ModelFailure } from '../src/model-failure.js';
import {
  createIdentifierProtector,
  publicSourceUrls,
  safeError,
  sanitizeAssistantOutput,
  sanitizeStreamingAssistantOutput,
} from '../src/security.js';

describe('security policy', () => {
  it('pseudonymizes identifiers deterministically without retaining the source', () => {
    const protect = createIdentifierProtector('a'.repeat(32));

    expect(protect('123456789012345678')).toBe(protect('123456789012345678'));
    expect(protect('123456789012345678')).not.toContain('123456789012345678');
    expect(protect('different')).not.toBe(protect('123456789012345678'));
  });

  it('caps output and removes private or credential-bearing URLs', () => {
    const unsafe = sanitizeAssistantOutput(
      'Visit http://user:pass@localhost/private and https://example.com/public?token=secret#private',
      ['https://example.com/public'],
    );
    const sanitized = sanitizeAssistantOutput('x'.repeat(maximumResponseCharacters + 100));

    expect(sanitized.length).toBeLessThanOrEqual(maximumResponseCharacters + 25);
    expect(sanitized).toContain('[…response truncated]');
    expect(unsafe).not.toContain('user:pass');
    expect(unsafe).not.toContain('token=secret');
    expect(unsafe).not.toContain('#private');
    expect(unsafe).toContain('[link removed]');
    expect(unsafe).toContain('https://example.com/public');
  });

  it('serializes only bounded error metadata', () => {
    const error = Object.assign(new Error('provider failed'), {
      requestBody: { content: 'private prompt' },
      code: 'UPSTREAM',
    });

    expect(safeError(error)).toEqual({
      type: 'Error',
      message: 'Unexpected error',
      code: 'UPSTREAM',
    });
  });

  it('redacts database credentials and authorization tokens from error messages', () => {
    const error = new Error(
      'mongodb+srv://user:password@cluster.example/db sk-or-secret_value Bearer private-token https://name:password@example.com/path',
    );
    const serialized = JSON.stringify(safeError(error));

    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('sk-or-secret_value');
    expect(serialized).not.toContain('private-token');
    expect(serialized).toContain('Unexpected error');
  });

  it.each([
    'data:text/html,private',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:127.0.0.1]/private',
    'www.attacker.example/private',
    'discord.gg/phish',
    'evil.de/path',
    'münich.de/útok',
    'attacker@example.com',
    '<tel:(+421)123456789>',
    '<javascript:(alert)>',
    '<file:(/etc/passwd)>',
    '<javascript:>',
    '<mailto:user@example.com>',
    '<mailto:>',
    '<a:>',
    '<x:payload>',
    '<x:(payload)>',
    '<t:>',
    'x:*payload',
    'file:~/etc/passwd',
    'javascript:*alert(1)',
    'https://attacker.example/PRIVATE_CONTEXT',
  ])('removes invented, non-HTTP, bare, or non-public links: %s', (unsafe) => {
    const sanitized = sanitizeAssistantOutput(unsafe);

    expect(sanitized).not.toContain(unsafe);
    expect(sanitized).toContain('[link removed]');
  });

  it.each([
    ['[click](javascript:alert(1))', 'click'],
    ['[open](x:payload)', 'open'],
    ['[official calendar](https://invented.example/events)', 'official calendar'],
  ])(
    'preserves an unmatched Markdown link label but removes its destination: %s',
    (unsafe, label) => {
      const sanitized = sanitizeAssistantOutput(unsafe);

      expect(sanitized).toBe(label);
      expect(sanitized).not.toMatch(/javascript:|x:payload|invented\.example/u);
      expect(sanitized).not.toContain('](');
    },
  );

  it('allows only exact public research sources and buffers incomplete streaming links', () => {
    const source = 'https://news.example.com/article';
    const renderedSource = `[source](${source})`;
    const sources = publicSourceUrls([`${source}?tracking=value`]);

    expect(sources).toEqual([source]);
    expect(sanitizeAssistantOutput(`Read ${source}?private=value`, sources)).toBe(
      `Read ${renderedSource}`,
    );
    expect(sanitizeAssistantOutput(`${source}/PRIVATE_CONTEXT`, sources)).toContain(
      '[link removed]',
    );
    expect(sanitizeStreamingAssistantOutput(`Read ${source.slice(0, -3)}`, sources)).toBe('Read');
    expect(sanitizeStreamingAssistantOutput(`Read ${source} now`, sources)).toBe(
      `Read ${renderedSource} now`,
    );
    const code = sanitizeAssistantOutput(
      'Use Node.js with config.ts and app.py. Example: `fetch("https://private.invalid")`.',
    );
    expect(code).toContain('Node.js');
    expect(code).toContain('config.ts');
    expect(code).toContain('app.py');
    expect(code).not.toContain('``app.py``');
    expect(code).toContain('`fetch("https://private.invalid")`');
  });

  it('preserves exact allowlisted balanced-parenthesis URLs only', () => {
    const source = 'https://example.com/wiki/Foo_(bar)';
    const renderedSource = `[source](${source})`;

    expect(sanitizeAssistantOutput(renderedSource, [source])).toBe(renderedSource);
    expect(sanitizeAssistantOutput(source, [source])).toBe(renderedSource);
    expect(sanitizeAssistantOutput(`See ${source}.`, [source])).toBe(`See ${renderedSource}.`);
    expect(sanitizeAssistantOutput(`${source}/private`, [source])).toContain('[link removed]');
    expect(sanitizeAssistantOutput('https://evil.example/Foo_(bar)', [source])).toBe(
      '[link removed]',
    );
  });

  it('preserves a bounded structured citation label on an exact allowlisted URL', () => {
    const source = 'https://events.example.com/calendar';
    const citation = `[Source 1: Official events calendar](${source})`;

    expect(sanitizeAssistantOutput(citation, [source])).toBe(citation);
    expect(sanitizeStreamingAssistantOutput(`${citation} next`, [source])).toBe(`${citation} next`);
  });

  it.each([
    '[angle]( <https://example.org/source> "Title" )',
    "[single](https://example.org/source 'Title')",
    '[parenthesized](https://example.org/source (Title))',
  ])('normalizes a CommonMark source with an optional title: %s', (content) => {
    const source = 'https://example.org/source';
    const label = content.slice(1, content.indexOf(']'));

    expect(sanitizeAssistantOutput(content, [source])).toBe(`[${label}](${source})`);
  });

  it.each(['\\PRIVATE_CONTEXT', '\\?secret=1', '^PRIVATE', '|PRIVATE', '/PRIVATE'])(
    'does not allow a complete URL candidate from a trusted prefix: %s',
    (continuation) => {
      const source = 'https://example.com/source';
      const sanitized = sanitizeAssistantOutput(`${source}${continuation}`, [source]);

      expect(sanitized).toContain('[link removed]');
      expect(sanitized).not.toContain('PRIVATE');
      expect(sanitized).not.toContain('secret');
    },
  );

  it('handles a maximum-size unmatched Markdown prefix without changing link policy', () => {
    const sanitized = sanitizeAssistantOutput('['.repeat(maximumResponseCharacters));

    expect(sanitized).toHaveLength(maximumResponseCharacters);
  });

  it('handles maximum-size escape runs while scanning Markdown', () => {
    const sanitized = sanitizeAssistantOutput('\\'.repeat(maximumResponseCharacters));

    expect(sanitized).toHaveLength(maximumResponseCharacters);
  });

  it.each([
    ['[', ']'],
    ['{', '}'],
    ['"', '"'],
    ['“', '”'],
    ['**', '**'],
    ['||', '||'],
    ['', ':'],
    ['', '—'],
  ])('preserves an exact source inside presentation %s…%s', (opening, closing) => {
    const source = 'https://example.org/wiki/Foo_(bar)';
    const content = `${opening}${source}${closing}`;
    const expected = `${opening}[source](${source})${closing}`;

    expect(sanitizeAssistantOutput(content, [source])).toBe(expected);
  });

  it.each([
    '[[click](https://evil.com/phish)](https://openai.com/research)',
    '[<https://evil.com/phish>](https://openai.com/research)',
    '[![pixel](https://evil.com/pixel.png)](https://openai.com/research)',
  ])('removes link-bearing labels from an allowlisted outer link: %s', (content) => {
    const sanitized = sanitizeAssistantOutput(content, ['https://openai.com/research']);

    expect(sanitized).toBe('[source](https://openai.com/research)');
    expect(
      sanitizeStreamingAssistantOutput(`${content} done`, ['https://openai.com/research']),
    ).not.toContain('evil.com');
  });

  it.each([
    '[see https://example.org/source]',
    '**Source https://example.org/source**',
    '_https://example.org/source_',
    '__https://example.org/source__',
    '___https://example.org/source___',
  ])('preserves an exact source in a balanced wider presentation: %s', (content) => {
    const source = 'https://example.org/source';

    expect(sanitizeAssistantOutput(content, [source])).toBe(
      content.replace(source, `[source](${source})`),
    );
  });

  it.each([
    '**https://example.org/source*PRIVATE**',
    '***https://example.org/source*PRIVATE***',
    '___https://example.org/source_PRIVATE___',
  ])('does not trust an incomplete formatting delimiter: %s', (content) => {
    const sanitized = sanitizeAssistantOutput(content, ['https://example.org/source']);

    expect(sanitized).toContain('[link removed]');
    expect(sanitized).not.toContain('PRIVATE');
  });

  it.each([2, 4])('sanitizes an active Markdown link after %i backslashes', (count) => {
    const source = 'https://example.org/source';
    const content = `${'\\'.repeat(count)}[${source}](//evil。com)`;

    const sanitized = sanitizeAssistantOutput(content, [source]);
    expect(sanitized).toContain('source');
    expect(sanitized).not.toContain('evil');
    expect(sanitized).not.toContain('](');
  });

  it('uses CommonMark escape parity and classifies unescaped destinations', () => {
    const source = 'https://example.org/source';
    const activeUnsafe = String.raw`[x](http\://evil。test\\)`;
    const activeAllowed = String.raw`\\[x](https\://example.org/source)`;
    const inertOpening = String.raw`\[x](http\://evil。test\\)`;

    expect(sanitizeAssistantOutput(activeUnsafe)).toBe('x');
    expect(sanitizeStreamingAssistantOutput(`${activeUnsafe} done`)).toBe('x done');
    expect(sanitizeAssistantOutput(activeAllowed, [source])).toBe(
      String.raw`\\[x](https://example.org/source)`,
    );
    expect(sanitizeAssistantOutput(inertOpening)).toBe(inertOpening);
  });

  it('bounds every rendered plain source to an exact allowlisted Markdown destination', () => {
    const source = 'https://example.org/source';
    const candidates: Array<readonly [string, boolean]> = [
      [`x_${source}_PRIVATE`, true],
      [String.raw`\_${source}_PRIVATE`, true],
      [`_closed_ ${source}_PRIVATE`, true],
      [`prefix_${source}_PRIVATE`, true],
      [`**done** ${source}_PRIVATE`, false],
    ];

    for (const [candidate, preservesSource] of candidates) {
      for (const output of [
        sanitizeAssistantOutput(candidate, [source]),
        sanitizeStreamingAssistantOutput(`${candidate} done`, [source]),
      ]) {
        const destinations = [...output.matchAll(/\]\((https?:\/\/[^\s)]+)\)/gu)].map(
          (match) => match[1],
        );
        expect(destinations).toEqual(preservesSource ? [source] : []);
        expect(output).not.toContain(`${source}_PRIVATE`);
      }
    }
  });

  it('preserves URL-internal underscores inside an exact bounded source', () => {
    const source = 'https://example.org/reference_with_underscores';

    expect(sanitizeAssistantOutput(source, [source])).toBe(`[source](${source})`);
    expect(sanitizeStreamingAssistantOutput(`${source} done`, [source])).toBe(
      `[source](${source}) done`,
    );
  });

  it('never lets prose authorize its own source and rejects private citation candidates', () => {
    expect(
      publicSourceUrls([
        'https://example.com/source?tracking=1',
        'http://127.0.0.1/private',
        'http://router.home.arpa/admin',
        'http://service.onion/admin',
        'http://service.alt/admin',
        'http://service.example/admin',
        'javascript:alert(1)',
      ]),
    ).toEqual(['https://example.com/source']);
    expect(sanitizeAssistantOutput('Invented https://example.com/source')).toContain(
      '[link removed]',
    );
  });

  it('sanitizes links behind escaped code delimiters and ignores representable old markers', () => {
    const escapedInline = '\\`[click](https://evil.com/phish)\\`';
    const escapedFence = '\\```\n[click](https://evil.com/fenced)\n\\```';
    const oldMarker = '\uE000JOLANDA_CODE_0\uE001';
    const sanitized = sanitizeAssistantOutput(
      `\`safe\` ${oldMarker} ${escapedInline}\n${escapedFence}`,
    );

    expect(sanitized).not.toContain('evil.com');
    expect(sanitized.match(/safe/g)).toHaveLength(1);
    expect(sanitized.match(/click/g)).toHaveLength(2);
  });

  it.each([
    '`[click](https://evil.example)`` done',
    '``[click](https://evil.example)``` done',
    '`[click](https://evil.example) done',
  ])('does not protect links behind unmatched or unequal backtick runs: %s', (unsafe) => {
    const final = sanitizeAssistantOutput(unsafe);
    const streaming = sanitizeStreamingAssistantOutput(unsafe);

    expect(final).not.toContain('evil.example');
    expect(final).toContain('click');
    expect(final).not.toContain('](');
    expect(streaming).toBe(final);
  });

  it('preserves multilingual prose labels while denying actual URI schemes', () => {
    const prose = [
      'Note: Be careful',
      'Sources:',
      '- item',
      'Answer: four',
      'Poznámka: Buď opatrný',
      '**Note:** text',
      '**Sources:**',
      '**Answer:** four',
      '**Poznámka:** Buď opatrný',
    ].join('\n');
    const unsafe = sanitizeAssistantOutput('Open x:payload and javascript:alert(1)');

    expect(sanitizeAssistantOutput(prose)).toBe(prose);
    expect(unsafe).not.toMatch(/x:payload|javascript:/);
    expect(unsafe.match(/\[link removed\]/g)).toHaveLength(2);
  });

  it('preserves Discord timestamps and non-link angle notation', () => {
    const notation = '<t:1724558400:R> <T: string> <Result: Success> <Note: be careful>';

    expect(sanitizeAssistantOutput(notation)).toBe(notation);
    expect(sanitizeStreamingAssistantOutput(`${notation} done`)).toBe(`${notation} done`);
  });

  it.each([
    '<Note: https://evil.example/phish> done',
    '<Result: x:payload> done',
    '<T: attacker@example.com> done',
    '<Note: router.home.arpa/admin> done',
    '<Note: intranet.local/admin> done',
    '<Note: service.onion/admin> done',
    '<Note: foo.invalid/path> done',
    '<Note: www.evil.example/path> done',
    '<T: service.alt/path> done',
  ])('sanitizes nested links inside otherwise generic angle notation: %s', (unsafe) => {
    const final = sanitizeAssistantOutput(unsafe);
    const streaming = sanitizeStreamingAssistantOutput(unsafe);

    expect(final).toBe('[link removed] done');
    expect(streaming).toBe(final);
  });

  it('restores nested safe fragments without exposing internal markers', () => {
    const source = 'https://docs.example.com/reference';
    const content = '<Note: [`config.ts`](' + source + ')>';
    const sanitized = sanitizeAssistantOutput(content, [source]);

    expect(sanitized).toContain('[`config.ts`](' + source + ')');
    expect(sanitized).not.toMatch(/[\uE000\uE001]/u);
  });

  it('strips Unicode format controls before rendering model output', () => {
    const sanitized = sanitizeAssistantOutput('\u202Ehttps://private.example/x\u2066 safe\u2069');

    expect(sanitized).toBe('[link removed] safe');
    expect(sanitized).not.toMatch(/\p{Cf}/u);
  });

  it('keeps allowlisted internal diagnostics while hiding arbitrary third-party messages', () => {
    expect(
      safeError(
        new ModelFailure({
          category: 'provider_unavailable',
          stage: 'answer',
          elapsedMs: 10,
          providerQuietMs: 5,
        }),
      ),
    ).toMatchObject({
      type: 'ModelFailure',
      message: 'OpenRouter answer failed (provider_unavailable)',
    });
    expect(safeError(new Error('private prompt echoed by provider'))).toMatchObject({
      message: 'Unexpected error',
    });
    const named = new Error('private');
    named.name = 'SecretProviderInternalFailure';
    expect(safeError(named)).toMatchObject({ type: 'Error', message: 'Unexpected error' });
    expect(safeError('not an Error')).toEqual({ type: 'UnknownError' });
    expect(
      safeError(Object.assign(new Error('OpenRouter answer failed (timeout)'), { code: 503 })),
    ).toEqual({
      type: 'Error',
      message: 'OpenRouter answer failed (timeout)',
      code: 503,
    });
  });
});
