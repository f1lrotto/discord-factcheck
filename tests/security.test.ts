import { describe, expect, it } from 'vitest';
import { maximumResponseCharacters } from '../src/limits.js';
import {
  createIdentifierProtector,
  publicResearchQuestion,
  publicSourceUrls,
  safeError,
  sanitizeAssistantOutput,
  sanitizeStreamingAssistantOutput,
} from '../src/security.js';

describe('security policy', () => {
  it('allows a minimized multilingual public research question', () => {
    expect(publicResearchQuestion('  Aké je dnes počasie v Bratislave?  ')).toBe(
      'Aké je dnes počasie v Bratislave?',
    );
  });

  it.each([
    'My API key is abcdefghijklmnopqrstuvwxyz123456',
    'Search for user@example.com',
    'Open http://localhost:3000/private',
    'Search localhost:3000/admin',
    'Search 127.0.0.1:8080/admin',
    'Search 127.0.0.1',
    'Search 10.0.0.1',
    'Search 169.254.169.254',
    'Search 203.0.113.1',
    'Search 169.254.169.254/latest/meta-data',
    'Search intranet.local/admin',
    'Search intranet.local',
    'Search foo.internal',
    'Search router.lan',
    'Search [::ffff:127.0.0.1]/admin',
    'Search 2130706433/admin',
    'Search 2130706433',
    'Search 0x7f000001',
    'Search ::1/admin',
    'Search fe80::1/admin',
    'Search ::1?x=1',
    'Search [::1]?x=1',
    'Search fe80::1#admin',
    'Search 2001:4860:4860::8888?x=1',
    'Search [2001:4860:4860::8888]?x=1',
    'Search 2606:4700:4700::1111#admin',
    'Search jenkins:8080/admin',
    'Target 127:8080',
    'Target 0177:80',
    'Target 2130706433:443',
    'Target 0x7f000001:8080',
    'curl 10:10',
    'curl 10:22',
    'GET 01:22',
    'Connect to 10:30',
    'Access 10:30?admin=true',
    'Search intranet/admin',
    'Search intranet/admin now',
    'Search localhost/admin please',
    'Compare intranet/admin behavior',
    'Compare qa/foo?x=1',
    'Compare printer/admin#x',
    'Search 127/admin',
    'Search 0177/admin',
    'Search build_server:8080/admin',
    'Search intranet.:8080/admin',
    'Search read/admin',
    'Search input/secrets',
    'Search write/config',
    'Search //localhost/admin',
    'Search localhost\\admin',
    'Search 127.0.0.1?x=1',
    'Search qa/foo',
    'Search: qa/foo',
    'Please search for: qa/foo',
    'Please search the web for qa/foo',
    'Search online for qa/foo',
    'Search... qa/foo',
    'Search for information about intranet2/admin',
    'Please open the page company-intranet/private',
    'Find details on internal-dashboard/secrets',
    'Vyhľadaj informácie o firemny-intranet/admin',
    'Vyhľadaj na webe qa/foo',
    'Vyhľadaj: qa/foo',
    'Open qa/foo',
    'Open (qa/foo)',
    'Open <qa/foo>',
    'Read qa/foo',
    'Fetch qa/foo',
    'Connect to qa:8080/admin',
    'Access qa:8080/admin',
    'Navigate to qa/foo',
    'curl qa/foo',
    'GET qa/foo',
    'Can qa/foo be searched online?',
    'Please have qa/foo opened',
    'Is qa/foo available? Search it',
    'qa/foo vyhľadaj na webe',
    'Search printer?x=1',
    'Search **169.254.169.254**',
    'Search __127.0.0.1__',
    'Search ~~::1~~',
    'Search {intranet.local}',
    'Search [service.onion]',
    'Search «router.home.arpa»',
    'Search **127.0.0.1**.',
    'Search [169.254.169.254].',
    'Search (**::1**).',
    'Search ||127.0.0.1||',
    'Search ||intranet.local||',
    'Search >**127.0.0.1**',
    'Search -**127.0.0.1**',
    'Search **127.0.0.1**…',
    'Search **127.0.0.1**—',
    'Search [::1]–',
    'Search **127.0.0.1**:',
    'Search «::1»:',
    'Search ||localhost||:',
    'Search ::1.',
    'Search ::1#',
    'Search [::1]#',
    'curl **127.0.0.1**/admin',
    'curl **127.0.0.1**-admin',
    'curl «(127.0.0.1)»/admin',
    'curl ((127.0.0.1))/admin',
    'Search (**127.0.0.1**:8080)',
    'Search [host](127.0.0.1)',
    'Search [host](127.0.0.1 "title")',
    'Search [[host]](127.0.0.1)',
    'Search [127.0.0.1](details)',
    'Search [127].0.0.1',
    'Search «127».0.0.1',
    'Search 127.0.0.1:[80]',
    'Search ::1:',
    'Search ::1—',
    'Search ::1…',
    'Search ::ffff:127.0.0.1…',
    'Search [::1]:22:',
    'Search 127。0。0。1/admin',
    'Search http://router.home.arpa/admin',
    'Search home.arpa/admin',
    'Search service.onion/admin',
    'Search service.onion./admin',
    'Search service.alt/admin',
    'Search service.example/admin',
    'Search ftp://localhost/private',
    'Search http:/localhost/private',
    'Search http:localhost/private',
    'Search https:127.0.0.1/admin',
    'Search http:[::1]/x',
    'Search http:router.home.arpa/admin',
    'Search ftp:localhost/private',
    'Search file:localhost/private',
    'Open http:10',
    'Open HTTP:10',
    'Open HTTP:3',
    'Search HTTP:3',
    'Fetch HTTP:3',
    'Open HTTP:1.1',
    'Search HTTP:10',
    'Open HTTPS:127',
    'curl https:127',
    'curl http:10?x',
    'curl client/server',
    'GET input/output',
    'Pripoj sa k qa/foo',
    'Pristúp na qa/foo',
    'Pristup na qa/foo',
    'qa/foo má byť načítaný',
    'qa/foo ma byt nacitany',
    'Read https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678',
    'Inspect https://example.com/?token=private',
    '```env\nTOKEN=secret\n```',
    'Môj tajný kľúč je abcdefghijklmnopqrstuvwxyz123456',
    'My s\u200be\u200bc\u200br\u200be\u200bt is abcdefghijklmnopqrstuvwxyz123456',
    'Search qa/admin page',
    'Search qa/admin please',
    'Search qa/admin now',
    'Search qa/admin, please',
    'Open input/secrets page',
    'Fetch read/config now',
    'qa/foo. Look it up',
    'qa/foo; look it up',
    'qa/foo. Could you look it up?',
    'Is QA/foo available? Vyhľadaj ho',
    'What is [host](127.0.0.1)?',
    '[host](localhost:8080/admin)',
    '[host](file:localhost)',
    'What is printer?x=1',
    'Explain qa/foo#admin',
    'curl 10:22.',
    'curl 127.0.0.1:22…',
    'curl 10:22...',
    'curl 10:22:',
    'curl 10:22-',
    'curl 10:22)',
    'qa/admin is down',
    'The qa/admin page is down',
    'Status of qa/admin',
    'Why is qa/admin broken?',
    'What is qa/foo?',
    'Search qa/admin architecture',
    'Open dev/admin authentication',
    'Research prod/api lifecycle',
    'Search input/secrets analysis',
    'Open read/config usage',
    'Compare staging/secrets behavior',
    '1qa:8080',
    'žaba:8080',
    'Search — qa/foo',
    'Open – qa/foo',
    'Navigate — qa/foo',
    'Otvor — qa/foo',
    'curl — qa/foo',
    'Search! qa/foo',
    'qa/foo. Please look it up',
    'qa/foo. Search for it',
    'Search [internal](//localhost/admin)',
    'Open [meta](//169.254.169.254/latest/meta-data)',
    'Read [local](///localhost/admin)',
    'Search [router](/\\router/admin)',
    'Search [127.0.0.1](#details)',
    'What is [localhost](#section)?',
    'Research [127.0.0.1](#intro)',
    'Search [private](<//router.home.arpa/admin>)',
    'Search [private](https://user:pass@example.com/path)',
    'Open login/config',
    'Fetch login/config',
    'Search config/login',
    'Open [::1]:**80**',
    'Open [::1]:__80__',
    'Open [::1]:[80]',
    'Open **[::1]**:80',
    'Open [::1]:**80**/admin',
    'Connect! alpha/beta',
    'GET. preprod/api',
    'Research; alpha/beta',
    'Pripoj? alpha/beta',
    'alpha/beta. Could you please look it up?',
    'alpha/beta. Research it',
    'Research preprod/api architecture',
    'Search sandbox/dashboard lifecycle',
    'Compare demo/payroll behavior',
    'Research preview/passwords security',
    'Debug service/api',
    'Troubleshoot service/dashboard',
    'Use service/api',
    'Probe service/health',
    'Diagnose service/status',
    'Can service/api be reached?',
    'Is service/api healthy?',
    'service/api failed',
    'The service/api endpoint timed out',
    'Search [safe](/169.254.169.254/latest)',
    'Search [safe](./localhost/admin)',
    'Search [safe](../127.0.0.1/admin)',
    'Search [safe](#localhost:8080)',
    'Search [[[[[localhost](#a)](#b)](#c)](#d)](#e)',
    'Open «::1»:80/admin',
    'Search (::1):80/admin',
    'curl {::1}:80/admin',
    'Open [**::1**]:[80]',
    'Open [__::__]:[443]',
    'Search [x]([**::1**]:[80])',
    'Could you search? alpha/beta',
    'Connect to! alpha/beta',
    'Search for! alpha/beta',
    'Prosím, vyhľadaj! alpha/beta',
    'Lookup! alpha/beta',
    'Query. alpha/beta',
    'Použi? alpha/beta',
    'alpha/beta. Connect to it',
    'alpha/beta. Access it',
    'alpha/beta. Navigate to it',
    'alpha/beta',
    'The target is alpha/beta',
    'The path is alpha/beta',
    'Monitor printer/docs',
    'Target is printer/docs',
    'printer/docs',
    'Visit HTTP:3 protocol',
    'Search foo/bar now',
    'Research foo/bar please',
    'Vyhľadaj foo/bar teraz',
    'Research integration/tokens architecture',
    'Search canary/metrics lifecycle',
    'Compare build/actuator behavior',
    'Search [safe](/docs/localhost/admin)',
    'Search [safe](./docs/intranet/start)',
    'Search [safe](../docs/[::1]:80/admin)',
    'Search [safe](#docs/router/config)',
    'Search [safe](/docs/page?host=localhost)',
    'Search [safe](./docs/start?target=2130706433:80)',
    'Search [safe](/docs/%5B::1%5D/admin)',
    'Search [safe](/docs/start#target=build_server:8080)',
    'Open «::1»:«80»/admin',
    'Open «(::1)»',
    'Open [«::1»]:[80]',
    'Search [2606:4700:4700::1111]/admin',
    'Load HTTP:3',
    'Launch HTTP/3',
    'Request TLS:1.3',
    'What is HTTP:3? Open it',
    'Explain HTTP/3. Connect to it',
    '[HTTP:3](#x). Explain cats',
    'Explain cats, then [HTTP:3](#x)',
    'Open input/output',
    'Open input/output architecture',
    'Fetch input/output',
    'Visit read/write',
    'Search pros/cons',
    'Search for pros/cons',
    'Research alpha/beta architecture. Open it',
  ])('disables public research for sensitive input: %s', (question) => {
    expect(publicResearchQuestion(question)).toBeNull();
  });

  it.each([
    'Compare input/output formats',
    'Compare pros/cons',
    'Compare risks/rewards',
    'Compare admin/api authentication',
    'Compare login/config flows',
    'Explain CI/CD',
    'Translate English/Slovak',
    'Compare client/server architecture',
    'Compare Windows/Linux security',
    'Latest EU/US trade news',
    'Convert km/h to mph',
    'Explain on/off switching',
    'Porovnaj vstup/výstup',
    'What happened today at 12:30?',
    'Latest score Madrid 3:2',
    'Explain the 16:9 aspect ratio',
    'Explain HTTP:3',
    'Summarize chapter:5',
    'Research pros/cons of solar',
    'How do I search for files in Windows/Linux?',
    'Find the latest score Madrid 3:2',
    'Search today at 12:30',
    'Find information about HTTP:3',
    'Open chapter:5',
    'Find the differences between Windows/Linux',
    'Check the km/h conversion',
    'Search for EU/US trade news',
    'Do not search, compare pros/cons',
    'Research HTTP:3',
    'Vyhľadaj výhody/nevýhody TypeScriptu',
    'Research TCP/IP history',
    'Research URL encoding TCP/IP history',
    'Research TCP/IP v6 adoption',
    'Research TCP/IP (network protocol)',
    'Research TCP/IP evolution',
    'Research TCP/IP — protocol history',
    'Search supply/demand economics',
    'Search supply/demand trends',
    'Find parent/child relationships',
    'Find parent/child patterns',
    'Find parent/child hierarchy',
    'Research producer/consumer patterns',
    'Search energy/mass relationship',
    'Research risk/reward tradeoffs',
    'Research cost/benefit analysis',
    'Search request/response lifecycle',
    'Compare admin/api authentication. Then search for current OAuth news',
    'Compare admin/api. then search OAuth news',
    'Discuss alpha/beta. then search current news',
    'Discuss client/server. Curl https://example.org',
    'Research HTTP:3.',
    'Summarize chapter:5.',
    'Summarize [OpenAI](https://openai.com/research)',
    'Research [docs](https://example.org/path)',
    'Summarize [section](#introduction)',
    'Read [guide](./documentation)',
    'Discuss [parent](../alpha)',
    'Summarize [chapter](introduction)',
    'Read [guide](documentation/start)',
    'What is HTTP:3?',
    'How does HTTP:3 work?',
    'Compare HTTP:3 and HTTP:2',
    'Summarize HTTP:3',
    'Tell me about HTTP:3',
    'Čo je HTTP:3?',
    'Explain http:3',
    'Explain tls:1.3',
    'Research HTTP/3',
    'Find HTTP/3 adoption',
    'Research TLS/1.3 adoption',
    'Research TCP/IP: history',
    'Research “TCP/IP”: history',
    'Research **TCP/IP**: history',
    'Research TCP/IP... history',
    'What is [HTTP:3](#docs)?',
    'Research [HTTP/3](#docs)',
    'Explain HTTP:3 and open the current RFC',
    'Open docs then explain HTTP/3',
    'Explain HTTP:3 and open RFC',
    'Summarize TLS:1.3 but fetch current browser support',
    'Search wave/particle duality',
    'Research space/time concepts',
    'Find cause/effect examples',
    'Search syntax/semantics distinctions',
    'Search supply/demand elasticity',
    'Vyhľadaj príčina/následok príklady',
    'Research ponuka/dopyt elasticity',
    'Summarize https://openai.com/research/index',
  ])('does not mistake public research prose for an intranet target: %s', (question) => {
    expect(publicResearchQuestion(question)).toBe(question);
  });

  it.each(
    ['intranet', 'localhost', 'router'].flatMap((host) =>
      ['admin', 'config'].flatMap((path) =>
        ['now', 'page', 'please', 'documentation'].map(
          (follower) => `Search ${host}/${path} ${follower}`,
        ),
      ),
    ),
  )('prioritizes mutated private-host evidence over lexical followers: %s', (question) => {
    expect(publicResearchQuestion(question)).toBeNull();
  });

  it.each(
    ['[::1]', '**[::1]**', '__[::1]__'].flatMap((host) =>
      [':80', ':**80**', ':__80__', ':[80]'].flatMap((port) =>
        ['', '/admin'].map((suffix) => `Open ${host}${port}${suffix}`),
      ),
    ),
  )('preserves IPv6 structure across host and port presentation: %s', (question) => {
    expect(publicResearchQuestion(question)).toBeNull();
  });

  it.each(
    ['«', '(', '{', '<', '“', '**', '||', '`'].flatMap((opening) => {
      const closing = new Map([
        ['«', '»'],
        ['(', ')'],
        ['{', '}'],
        ['<', '>'],
        ['“', '”'],
        ['**', '**'],
        ['||', '||'],
        ['`', '`'],
      ]).get(opening);
      return [`Open ${opening}::1${closing}:80/admin`];
    }),
  )('canonicalizes a presented IPv6 host before its port: %s', (question) => {
    expect(publicResearchQuestion(question)).toBeNull();
  });

  it.each(Array.from({ length: 7 }, (_, depth) => depth + 1))(
    'fails closed for a private Markdown label at nesting depth %i',
    (depth) => {
      let label = '127.0.0.1';
      for (let index = 0; index < depth; index += 1) label = `[${label}](#section)`;

      expect(publicResearchQuestion(`Research ${label}`)).toBeNull();
    },
  );

  it('rejects overlong research input before structural parsing', () => {
    expect(publicResearchQuestion('('.repeat(2_001))).toBeNull();
  });

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
    '[click](javascript:alert(1))',
    'data:text/html,private',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:127.0.0.1]/private',
    'www.attacker.example/private',
    'discord.gg/phish',
    'evil.de/path',
    'münich.de/útok',
    'attacker@example.com',
    '[open](x:payload)',
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

    expect(sanitizeAssistantOutput(content, [source])).toContain('[link removed]');
  });

  it('uses CommonMark escape parity and classifies unescaped destinations', () => {
    const source = 'https://example.org/source';
    const activeUnsafe = String.raw`[x](http\://evil。test\\)`;
    const activeAllowed = String.raw`\\[x](https\://example.org/source)`;
    const inertOpening = String.raw`\[x](http\://evil。test\\)`;

    expect(sanitizeAssistantOutput(activeUnsafe)).toBe('[link removed]');
    expect(sanitizeStreamingAssistantOutput(`${activeUnsafe} done`)).toBe('[link removed] done');
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
    expect(sanitized.match(/\[link removed\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    '`[click](https://evil.example)`` done',
    '``[click](https://evil.example)``` done',
    '`[click](https://evil.example) done',
  ])('does not protect links behind unmatched or unequal backtick runs: %s', (unsafe) => {
    const final = sanitizeAssistantOutput(unsafe);
    const streaming = sanitizeStreamingAssistantOutput(unsafe);

    expect(final).not.toContain('evil.example');
    expect(final).toContain('[link removed]');
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
    expect(safeError(new Error('OpenRouter request failed with status 503'))).toMatchObject({
      message: 'OpenRouter request failed with status 503',
    });
    expect(safeError(new Error('private prompt echoed by provider'))).toMatchObject({
      message: 'Unexpected error',
    });
    const named = new Error('private');
    named.name = 'SecretProviderInternalFailure';
    expect(safeError(named)).toMatchObject({ type: 'Error', message: 'Unexpected error' });
  });
});
