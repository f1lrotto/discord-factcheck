import { createHmac, randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { LinkifyIt } from 'linkify-it';
import {
  maximumResponseCharacters,
  maximumSourceUrlCharacters,
  researchQuestionCharacters,
  webSearchMaxResults,
} from './limits.js';

const sensitivePatterns = [
  /\b(?:password|passwd|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|secret|heslo|tajny|kluc|token)\b/i,
  /(?:tajn[ýá]|kľúč)/iu,
  /\b[A-Za-z0-9_-]{32,}\b/,
  /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
  /\b(?:\d[ -]?){12,20}\b/,
  /```/,
] as const;

const privateHost = (hostname: string) => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (ipaddr.isValid(normalized)) return ipaddr.process(normalized).range() !== 'unicast';
  return (
    !normalized.includes('.') ||
    [
      'alt',
      'example',
      'home.arpa',
      'internal',
      'invalid',
      'lan',
      'local',
      'localhost',
      'onion',
      'test',
    ].some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))
  );
};

const discordMessageUrlPattern =
  /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(?:@me|\d{17,20})\/\d{17,20}\/\d{17,20}/iu;
const explicitUrlPattern = /https?:\/\/[^\s<>()]+/gi;
const targetTokenPattern = /\S+/gu;
const internalHostHints = new Set([
  'build_server',
  'database',
  'grafana',
  'intranet',
  'internal',
  'jenkins',
  'kibana',
  'localhost',
  'prometheus',
  'router',
  'vault',
]);
const ordinaryTargetIntentPattern =
  /(?<![\p{L}\p{N}_])(?:brows(?:e|ed|ing)|check(?:ed|ing)?|fetch(?:ed|ing)?|find|found|inspect(?:ed|ing)?|open(?:ed|ing)?|quer(?:y|ied|ying)|read|research(?:ed|ing)?|search(?:ed|ing)?|visit(?:ed|ing)?|look(?:ed|ing)?\s+up|lookup|nájdi|načítaj|načítan[ýáé]|nacitaj|nacitan[yae]|navštív|otvor|otvoren[ýáé]|prečítaj|prehľadaj|skontroluj|vyhľadaj)(?![\p{L}\p{N}_])/iu;
const strongNetworkIntentPattern =
  /(?<![\p{L}\p{N}_])(?:access(?:ed|ing)?|connect(?:ed|ing)?|curl|navigat(?:e|ed|ing)|pripoj|pripojen[ýáé]|prist[uú]p|prist[uú]pen[ýáé])(?![\p{L}\p{N}_])/iu;
const httpMethodIntentPattern = /\b(?:CONNECT|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT|TRACE)\b/u;
const comparisonIntentPattern =
  /(?<![\p{L}\p{N}_])(?:compare|comparison|differences?|between|versus|vs|porovnaj|porovnanie|rozdiely?)(?![\p{L}\p{N}_])/iu;
const semanticFollowerPattern =
  /^\s*(?:[,:(\u005B\u007B<«‹“‘—–-]\s*)*(?:a\s+|an\s+|the\s+)?(?:v\d+\s+)?(?:adoption|analysis|architecture|authentication|behavior|comparison|conversion|differences|economics|evolution|flows|formats|hierarchy|history|lifecycle|network\s+protocol|notation|patterns|protocol|relationship|relationships|security|switching|tradeoffs|trends|usage)\b/iu;
const topicalFollowerPattern =
  /^\s*(?:[,:(\u005B\u007B<«‹“‘—–-]\s*)*(?:a\s+|an\s+|the\s+)?(?:v\d+\s+)?[\p{L}][\p{L}\p{N}-]*/iu;
const fillerFollowerPattern =
  /^\s*(?:[,:(\u005B\u007B<«‹“‘—–-]\s*)*(?:now|page|please|today|documentation|details|teraz|prosím|dnes)\b/iu;
const safeCompoundExplanationPattern =
  /(?<![\p{L}\p{N}_])(?:compare|convert|differences?|discuss|explain|translate|how\b[^.!?;]{0,80}\b(?:search|work)|porovnaj|prelož|vysvetli)(?![\p{L}\p{N}_])/iu;
const directCompoundTargetPattern =
  /(?<![\p{L}\p{N}_])(?:access|browse|connect|curl|fetch|inspect|launch|load|navigate|open|read|request|use|visit|načítaj|nacitaj|navštív|otvor|pripoj|pristúp|pristup|použi)(?![\p{L}\p{N}_])/iu;
const targetAssertionPattern =
  /(?<![\p{L}\p{N}_])(?:(?:what|where|why)\s+(?:is|are)|(?:can|could)\b[^.!?;]{0,80}\b(?:be\s+)?reached|(?:is|are)\s+(?:down|up|broken|available|healthy)|status\s+of|(?:page|endpoint|path|server|target)\s+(?:is|for)|\bfailed\b|timed\s+out|(?:aký|kde|prečo)\s+(?:je|sú)|stav\s+)(?![\p{L}\p{N}_])/iu;
const generalTargetIntentPattern =
  /(?<![\p{L}\p{N}_])(?:debug|diagnose|lookup|monitor|probe|query|target|troubleshoot|use|použi|pouzit|použiť|diagnostikuj|otestuj)(?![\p{L}\p{N}_])/iu;
const topicalActionPattern =
  /(?<![\p{L}\p{N}_])(?:compare|discuss|explain|find|research|search|porovnaj|vysvetli|vyhľadaj)(?![\p{L}\p{N}_])/iu;
const protocolExplanationPattern =
  /(?<![\p{L}\p{N}_])(?:(?:what|which)\s+(?:is|are)|how\s+(?:does|do)|tell\s+me\s+about|compare|explain|find|information\s+about|protocol|research|summarize|version|čo\s+je|ako\s+funguje|porovnaj|vysvetli|informácie\s+o|protokol|verzia|zhrň)(?![\p{L}\p{N}_])/iu;
const directProtocolTargetPattern =
  /(?<![\p{L}\p{N}_])(?:access|browse|check|connect|curl|fetch|inspect|launch|load|monitor|navigate|open|probe|query|request|search|target|troubleshoot|use|visit|CONNECT|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT|TRACE|načítaj|nacitaj|navštív|otvor|pripoj|pristúp|pristup|použi)(?![\p{L}\p{N}_])/iu;
const adjacentReferencePattern =
  /^\s*(?:(?:(?:and\s+)?then|and|next|následne|potom)\s+)?(?:(?:please|prosím)\s+)?(?:(?:could|can|would)\s+you\s+)?(?:(?:please|prosím)\s+)?(?:look\s+(?:it|that|this)\s+up|(?:access|browse|check|connect|fetch|find|inspect|lookup|navigate|open|query|read|research|search|use|visit)\s+(?:(?:for|to)\s+)?(?:it|that|this)|(?:nájdi|načítaj|nacitaj|otvor|prečítaj|prehľadaj|pripoj|pristúp|pristup|skontroluj|vyhľadaj)\s+(?:ho|ju|ich|to|toto|tam))\b/iu;
const commonSentenceAbbreviationPattern = /(?:\b(?:dr|etc|mr|mrs|ms|prof|vs)|\b(?:e\.g|i\.e))\.$/iu;
const precedingImperativePattern =
  /^\s*(?:(?:please|prosím)\s*,?\s*)?(?:(?:could|can|would)\s+you\s+)?(?:access|browse|check|connect|curl|debug|diagnose|fetch|find|inspect|look\s+up|lookup|monitor|navigate|open|probe|query|read|research|search|target|troubleshoot|use|visit|CONNECT|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT|TRACE|nájdi|načítaj|nacitaj|navštív|otvor|prečítaj|prehľadaj|pripoj|pristúp|pristup|použi|skontroluj|vyhľadaj)(?:\s+(?:for|to))?\s*$/iu;
const hostRoleHints = new Set([
  'corp',
  'build',
  'canary',
  'demo',
  'dev',
  'development',
  'integration',
  'local',
  'prod',
  'preprod',
  'preview',
  'production',
  'qa',
  'stage',
  'staging',
  'sandbox',
  'test',
  'uat',
]);
const privatePathHints = new Set([
  '.env',
  'admin',
  'api',
  'config',
  'credentials',
  'dashboard',
  'health',
  'metadata',
  'password',
  'passwords',
  'payroll',
  'private',
  'secret',
  'secrets',
  'status',
  'token',
  'tokens',
  'metrics',
  'actuator',
]);
const safeSlashCompoundKeys = new Set([
  'advantages/disadvantages',
  'benefits/drawbacks',
  'buyer/seller',
  'cd/ci',
  'client/server',
  'cons/pros',
  'english/slovak',
  'eu/us',
  'h/km',
  'input/output',
  'linux/windows',
  'off/on',
  'read/write',
  'rewards/risks',
  'strengths/weaknesses',
  'nevýhody/výhody',
  'vstup/výstup',
]);
const presentationPairs = [
  ['***', '***'],
  ['___', '___'],
  ['**', '**'],
  ['__', '__'],
  ['~~', '~~'],
  ['||', '||'],
  ['*', '*'],
  ['_', '_'],
  ['`', '`'],
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['«', '»'],
  ['‹', '›'],
  ['“', '”'],
  ['‘', '’'],
] as const;

interface MarkdownLink {
  start: number;
  end: number;
  label: string;
  destination: string;
}

const characterIsEscaped = (content: string, index: number) => {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1)
    backslashes += 1;
  return backslashes % 2 === 1;
};

const squareBracketPairs = (value: string) => {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  let backslashRun = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const escaped = backslashRun % 2 === 1;
    if (!escaped && character === '[') stack.push(index);
    if (!escaped && character === ']') {
      const opening = stack.pop();
      if (opening !== undefined) pairs.set(opening, index);
    }
    if (character === '\\') {
      backslashRun += 1;
      continue;
    }
    backslashRun = 0;
  }
  return pairs;
};

const markdownDestination = (value: string, start: number) => {
  let cursor = start;
  while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
  if (value[cursor] === '<') {
    const end = value.indexOf('>', cursor + 1);
    if (end < 0 || /[\n<>]/u.test(value.slice(cursor + 1, end))) return null;
    return { destination: value.slice(cursor + 1, end), cursor: end + 1 };
  }
  const destinationStart = cursor;
  let depth = 0;
  const maximumEnd = Math.min(value.length, destinationStart + maximumSourceUrlCharacters + 1);
  while (cursor < maximumEnd) {
    const character = value[cursor];
    if (characterIsEscaped(value, cursor)) {
      cursor += 1;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    if ((character === ' ' || character === '\t' || character === '\n') && depth === 0) break;
    cursor += 1;
  }
  if (depth !== 0 || cursor === destinationStart) return null;
  return { destination: value.slice(destinationStart, cursor), cursor };
};

const markdownLinkEnd = (value: string, start: number) => {
  let cursor = start;
  while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
  if (value[cursor] === ')') return cursor + 1;
  const quote = value[cursor];
  if (!['"', "'", '('].includes(quote ?? '')) return -1;
  const closing = quote === '(' ? ')' : quote;
  cursor += 1;
  while (
    cursor < value.length &&
    (value[cursor] !== closing || characterIsEscaped(value, cursor))
  ) {
    if (value[cursor] === '\n') return -1;
    cursor += value[cursor] === '\\' ? 2 : 1;
  }
  if (value[cursor] !== closing) return -1;
  cursor += 1;
  while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
  return value[cursor] === ')' ? cursor + 1 : -1;
};

const scanMarkdownLinks = (value: string) => {
  const links: MarkdownLink[] = [];
  const bracketPairs = squareBracketPairs(value);
  for (let start = 0; start < value.length && links.length < 100; start += 1) {
    if (value[start] !== '[' || characterIsEscaped(value, start)) continue;
    const labelEnd = bracketPairs.get(start);
    if (labelEnd === undefined || value[labelEnd + 1] !== '(' || labelEnd - start > 500) continue;
    const parsed = markdownDestination(value, labelEnd + 2);
    if (!parsed || parsed.destination.length > maximumSourceUrlCharacters) continue;
    const end = markdownLinkEnd(value, parsed.cursor);
    if (end < 0) continue;
    links.push({
      start,
      end,
      label: value.slice(start + 1, labelEnd),
      destination: parsed.destination.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/gu, '$1'),
    });
    start = end - 1;
  }
  return links;
};

const unwrapPresentation = (value: string) => {
  let unwrapped = value;
  let changed = true;
  while (changed && unwrapped) {
    changed = false;
    const withoutOrdinaryPunctuation = unwrapped.replace(/^[,;!?"'“”‘’]+|[,;!?"'“”‘’]+$/gu, '');
    if (withoutOrdinaryPunctuation !== unwrapped) {
      unwrapped = withoutOrdinaryPunctuation;
      changed = true;
      continue;
    }
    const withoutSentenceEnding = unwrapped.replace(/(?:\.{1,3}|…)+$/u, '');
    if (
      withoutSentenceEnding !== unwrapped &&
      presentationPairs.some(([, closing]) => withoutSentenceEnding.endsWith(closing))
    ) {
      unwrapped = withoutSentenceEnding;
      changed = true;
      continue;
    }
    const withoutWrapperPunctuation = unwrapped.replace(/[:\-‐-―−]+$/u, '');
    if (
      withoutWrapperPunctuation !== unwrapped &&
      presentationPairs.some(([, closing]) => withoutWrapperPunctuation.endsWith(closing))
    ) {
      unwrapped = withoutWrapperPunctuation;
      changed = true;
      continue;
    }
    if (unwrapped.startsWith('>')) {
      unwrapped = unwrapped.replace(/^>+/u, '');
      changed = true;
      continue;
    }
    if (
      ['-', '+'].includes(unwrapped[0] ?? '') &&
      presentationPairs.some(([opening]) => unwrapped.slice(1).startsWith(opening))
    ) {
      unwrapped = unwrapped.slice(1);
      changed = true;
      continue;
    }
    for (const [opening, closing] of presentationPairs) {
      const firstClosing = unwrapped.indexOf(closing, opening.length);
      const structuralIpv6 =
        opening === '[' &&
        firstClosing > opening.length &&
        firstClosing < unwrapped.length - closing.length &&
        ipaddr.isValid(unwrapped.slice(opening.length, firstClosing));
      if (
        !structuralIpv6 &&
        unwrapped.length > opening.length + closing.length &&
        unwrapped.startsWith(opening) &&
        unwrapped.endsWith(closing)
      ) {
        unwrapped = unwrapped.slice(opening.length, -closing.length);
        changed = true;
        break;
      }
    }
  }
  return unwrapped;
};

const normalizeWrappedComponents = (value: string) => {
  let normalized = value;
  normalized = normalized.replace(/\*{1,3}|_{2,3}|~~|\|\||`/gu, '').trim();
  for (const [opening, closing] of presentationPairs) {
    if (!normalized.startsWith(opening)) continue;
    const closingIndex = normalized.indexOf(closing, opening.length);
    if (closingIndex < opening.length) continue;
    const wrapped = normalized.slice(opening.length, closingIndex);
    if (opening === '[' && wrapped.includes(':') && ipaddr.isValid(wrapped)) continue;
    const afterClosing = normalized.slice(closingIndex + closing.length);
    if (!/^[/:?#]/u.test(afterClosing)) continue;
    normalized = `${normalized.slice(opening.length, closingIndex)}${afterClosing}`;
    break;
  }
  return normalized;
};

const canonicalizePresentedIpv6 = (value: string) => {
  const portPattern = /:(?:[^\p{L}\p{N}/?#:]*)?(\d{1,5})(?:[^\p{L}\p{N}/?#:]*)(?=\/|[?#]|$)/gu;
  const portMatches = [...value.matchAll(portPattern)];
  for (const port of portMatches.reverse()) {
    const host = value.slice(0, port.index).replace(/[*_|~`(){}\u005B\u005D<>«»‹›“”‘’]/gu, '');
    if (!host.includes(':') || !ipaddr.isValid(host)) continue;
    const portEnd = port.index + port[0].length;
    return `[${host}]:${port[1]}${value.slice(portEnd)}`;
  }
  const boundary = value.search(/[/?#]/u);
  if (boundary < 0) return value;
  const host = value.slice(0, boundary).replace(/[*_|~`(){}\u005B\u005D<>«»‹›“”‘’]/gu, '');
  if (!host.includes(':') || !ipaddr.isValid(host)) return value;
  return `[${host}]${value.slice(boundary)}`;
};

const presentationVariants = (value: string) => {
  const markerless = unwrapPresentation(canonicalizePresentedIpv6(value)).replace(
    /\*{1,3}|_{1,3}|~~|\|\||`/gu,
    '',
  );
  const flattened = markerless
    .replace(/[(){}<>«»‹›“”‘’]/gu, '')
    .replace(/\[([^\]]*)\]/gu, (wrapped, inner: string) =>
      inner.includes(':') && ipaddr.isValid(inner) ? wrapped : inner,
    );
  const canonical = [markerless, flattened].map(normalizeWrappedComponents).map((candidate) => {
    let trimmed = unwrapPresentation(candidate);
    while (/[.,;!?…\-‐-―−)\]}>»›”’]$/u.test(trimmed)) trimmed = trimmed.slice(0, -1);
    const colonCount = trimmed.match(/:/gu)?.length ?? 0;
    if (trimmed.endsWith(':') && (trimmed.includes('/') || colonCount > 1))
      trimmed = trimmed.slice(0, -1);
    return unwrapPresentation(trimmed);
  });
  return [...new Set(canonical)].filter(Boolean);
};

const normalizeTargetCandidate = (value: string) => {
  let unwrapped = unwrapPresentation(value);
  if (unwrapped.endsWith('.') && ipv6Privacy(unwrapped.slice(0, -1)) !== null)
    unwrapped = unwrapped.slice(0, -1);
  const contentSuffixIndex = unwrapped.search(/[?#]./u);
  const terminalFragment =
    unwrapped.endsWith('#') && !/^[cf]#$/iu.test(unwrapped) ? unwrapped.length - 1 : -1;
  const suffixIndex = contentSuffixIndex >= 0 ? contentSuffixIndex : terminalFragment;
  if (suffixIndex < 0) return { candidate: unwrapped, target: unwrapped, hasSuffix: false };
  const target = unwrapPresentation(unwrapped.slice(0, suffixIndex));
  return {
    candidate: `${target}${unwrapped.slice(suffixIndex)}`,
    target,
    hasSuffix: true,
  };
};

const sentenceClauses = (value: string) => {
  const clauses: Array<{ start: number; end: number }> = [];
  let start = 0;
  const push = (end: number, next: number) => {
    if (end > start) clauses.push({ start, end });
    start = next;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const remainder = value.slice(index);
    if (character === ',' && /^,\s*(?:then|but|however|potom|následne)\b/iu.test(remainder)) {
      push(index, index + 1);
      continue;
    }
    const nextCharacter = value[index + 1];
    if (character === '?' && nextCharacter !== undefined && !/\s/u.test(nextCharacter)) continue;
    if (['!', '?', ';', '…'].includes(character)) {
      push(index, index + 1);
      continue;
    }
    if (character !== '.' || (nextCharacter !== undefined && !/\s/u.test(nextCharacter))) continue;
    if (value[index - 1] === '.' || value[index + 1] === '.') continue;
    if (commonSentenceAbbreviationPattern.test(value.slice(Math.max(start, index - 8), index + 1)))
      continue;
    push(index, index + 1);
  }
  if (start < value.length) clauses.push({ start, end: value.length });
  return clauses;
};

const candidateIntent = (
  value: string,
  clause: { start: number; end: number },
  previousClause: { start: number; end: number } | undefined,
  nextClause: { start: number; end: number } | undefined,
  candidateIndex: number,
  candidateLength: number,
) => {
  const context = value.slice(clause.start, clause.end);
  const before = value.slice(clause.start, candidateIndex);
  const predicateBefore = before.split(/\b(?:and\s+then|but|then)\b/iu).at(-1) ?? before;
  const after = value.slice(candidateIndex + candidateLength, clause.end);
  const nextContext = nextClause ? value.slice(nextClause.start, nextClause.end) : '';
  const referred =
    adjacentReferencePattern.test(after) || adjacentReferencePattern.test(nextContext);
  const previousContext = previousClause
    ? value.slice(previousClause.start, previousClause.end)
    : '';
  const precedingImperative = precedingImperativePattern.test(previousContext);
  return {
    context,
    before,
    predicateBefore,
    after,
    referred,
    ordinary:
      ordinaryTargetIntentPattern.test(context) ||
      generalTargetIntentPattern.test(context) ||
      targetAssertionPattern.test(context) ||
      referred ||
      precedingImperative,
    strong:
      strongNetworkIntentPattern.test(context) ||
      httpMethodIntentPattern.test(context) ||
      (precedingImperative &&
        (strongNetworkIntentPattern.test(previousContext) ||
          httpMethodIntentPattern.test(previousContext))),
    topical:
      topicalActionPattern.test(before) ||
      (precedingImperative && topicalActionPattern.test(previousContext)),
  };
};

const isSafeSlashCompound = (candidate: string) => {
  const compound = /^([\p{L}]+)\/([\p{L}]+)$/u.exec(candidate);
  if (!compound) return false;
  const key = [compound[1], compound[2]]
    .map((part) => part?.toLocaleLowerCase('en-US') ?? '')
    .sort((left, right) => left.localeCompare(right, 'en-US'))
    .join('/');
  return safeSlashCompoundKeys.has(key);
};

const isSafeColonProse = (candidate: string) => {
  const numeric = /^(\d{1,2}):(\d{1,2})$/u.exec(candidate);
  if (numeric && Number(numeric[1]) <= 59 && Number(numeric[2]) <= 59) return true;
  return (
    /^(?:HTTP|HTTPS|IPv4|IPv6|TLS):\d+(?:\.\d+)?$/iu.test(candidate) ||
    /^(?:chapter|kapitola|protocol|version|verzia):\d+(?:\.\d+)?$/iu.test(candidate)
  );
};

const isKnownProtocolVersion = (candidate: string) =>
  /^(?:HTTP:(?:0\.9|1(?:\.0|\.1)?|2|3)|IPv[46]:\d+(?:\.\d+)?|TLS:(?:1(?:\.[0-3])?|2|3))$/iu.test(
    candidate,
  );

const isKnownProtocolSlashVersion = (candidate: string) =>
  /^(?:HTTP\/(?:0\.9|1(?:\.0|\.1)?|2|3)|IPv[46]\/\d+(?:\.\d+)?|TLS\/(?:1(?:\.[0-3])?|2|3))$/iu.test(
    candidate,
  );

const isLexicalSlashCompound = (
  candidate: string,
  intent: {
    before: string;
    predicateBefore: string;
    context: string;
    after: string;
    referred: boolean;
    ordinary: boolean;
    strong: boolean;
    topical: boolean;
  },
) => {
  if (!/^[\p{L}]+\/[\p{L}]+$/u.test(candidate)) return false;
  if (intent.strong || intent.referred) return false;
  if (directCompoundTargetPattern.test(intent.predicateBefore)) return false;
  if (comparisonIntentPattern.test(intent.context)) return true;
  if (safeCompoundExplanationPattern.test(intent.predicateBefore)) return true;
  const hasMeaningfulFollower =
    !fillerFollowerPattern.test(intent.after) &&
    (semanticFollowerPattern.test(intent.after) || topicalFollowerPattern.test(intent.after));
  if (isSafeSlashCompound(candidate) && hasMeaningfulFollower) return true;
  return (
    intent.topical &&
    hasMeaningfulFollower &&
    (!intent.ordinary || topicalActionPattern.test(intent.before))
  );
};

const parsedTokenIsPrivate = (candidate: string) => {
  try {
    const url = new URL(`http://${candidate.replace(/^\/\//u, '').replaceAll('\\', '/')}`);
    return (
      Boolean(url.username || url.password || url.search || url.hash) || privateHost(url.hostname)
    );
  } catch {
    return true;
  }
};

const markdownDestinationIsPrivate = (destination: string) => {
  const normalized = destination.replaceAll('\\', '/');
  if (/^\/\//u.test(normalized)) return parsedTokenIsPrivate(normalized.replace(/^\/+/u, '//'));
  if (/^(?:#|\.\.?\/)/u.test(normalized) || /^\/(?!\/)/u.test(normalized)) {
    const payload = normalized.replace(/^#/u, '').replace(/^(?:(?:\.\.?\/)|\/)+/u, '');
    return (
      relativePayloadHasPrivateEvidence(payload) ||
      decisivePrivateTarget(payload) ||
      decisivePathTarget(payload) ||
      /^[^/:?#]+:\d{1,5}(?:\/|$)/u.test(payload)
    );
  }
  if (/^https?:/iu.test(normalized)) {
    try {
      const url = new URL(normalized);
      return Boolean(
        url.username || url.password || url.search || url.hash || privateHost(url.hostname),
      );
    } catch {
      return true;
    }
  }
  if (/^[a-z][a-z0-9+.-]{0,31}:/iu.test(normalized)) return true;
  if (/^[^/:?#]+:\d{1,5}(?:\/|$)/u.test(normalized)) return true;
  return decisivePrivateTarget(normalized) || decisivePathTarget(normalized);
};

const ipv6Privacy = (candidate: string) => {
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?(?:\/.*)?$/u.exec(candidate)?.[1];
  const host = (bracketed ?? candidate.split('/')[0] ?? '').replace(/%[\p{L}\p{N}_.-]+$/u, '');
  if ((host.match(/:/g)?.length ?? 0) < 2 || !ipaddr.isValid(host)) return null;
  return ipaddr.process(host).range() !== 'unicast';
};

const containsPrivateAddressComponent = (candidate: string) => {
  for (const match of candidate.matchAll(/(?<![\da-f:])(?:\d{1,3}\.){3}\d{1,3}(?![\da-f:])/giu)) {
    if (ipaddr.isValid(match[0]) && ipaddr.process(match[0]).range() !== 'unicast') return true;
  }
  for (const match of candidate.matchAll(
    /(?<![\p{L}\p{N}_.-])[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?:\.)?(?![\p{L}\p{N}_.-])/gu,
  )) {
    if (privateHost(match[0])) return true;
  }
  return false;
};

const decisivePrivateTarget = (candidate: string) => {
  if (containsPrivateAddressComponent(candidate)) return true;
  const ipv6Private = ipv6Privacy(candidate);
  if (ipv6Private !== null) return ipv6Private;
  const normalized = candidate.replace(/^\/\//u, '').replaceAll('\\', '/');
  const host = /^(?:\[([^\]]+)\]|([^/:?#]+))(?::\d{1,5})?(?:[/?#]|$)/u.exec(normalized);
  const hostname = (host?.[1] ?? host?.[2] ?? '').replace(/\.$/u, '').toLocaleLowerCase('en-US');
  if (!hostname) return false;
  const numericHost = /^(?:0x[\da-f]+|0[0-7]+|\d+)$/iu.test(hostname);
  const internalHost = internalHostHints.has(hostname) || hostname.includes('_');
  const specialOrAddress = hostname.includes('.') && privateHost(hostname);
  return (numericHost || internalHost || specialOrAddress) && parsedTokenIsPrivate(candidate);
};

const decisivePathTarget = (candidate: string, intent?: { context: string; after: string }) => {
  const normalized = candidate.replace(/^\/\//u, '').replaceAll('\\', '/');
  const path = /^([^/:?#]+)\/(.+)$/u.exec(normalized);
  if (!path) return false;
  const host = path[1]?.replace(/\.$/u, '').toLocaleLowerCase('en-US') ?? '';
  const pathSegments = (path[2] ?? '')
    .split('/')
    .map((segment) => segment.toLocaleLowerCase('en-US'));
  const privateSegments = pathSegments.filter((segment) => privatePathHints.has(segment));
  const comparisonSafe =
    Boolean(intent) &&
    comparisonIntentPattern.test(intent?.context ?? '') &&
    privateSegments.every((segment) => ['api', 'config'].includes(segment));
  return (
    hostRoleHints.has(host) ||
    internalHostHints.has(host) ||
    host.includes('_') ||
    (privateSegments.length > 0 && !comparisonSafe)
  );
};

const relativePayloadHasPrivateEvidence = (payload: string) => {
  let decoded = payload;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    // A malformed escape remains subject to the literal checks below.
  }
  return [payload, decoded].some((candidatePayload) =>
    candidatePayload
      .split(/[/?#&=]/u)
      .filter(Boolean)
      .some((component) => {
        const lower = component.toLocaleLowerCase('en-US');
        if (privatePathHints.has(lower) || hostRoleHints.has(lower) || internalHostHints.has(lower))
          return true;
        return presentationVariants(component).some(
          (candidate) =>
            decisivePrivateTarget(candidate) ||
            ipv6Privacy(candidate) === true ||
            /^[^/:?#]+:\d{1,5}$/u.test(candidate),
        );
      }),
  );
};

const hasPrivateReference = (value: string, depth = 0): boolean => {
  const markdownLinks = scanMarkdownLinks(value);
  for (const link of markdownLinks) {
    const nestedLabelLinks = scanMarkdownLinks(link.label);
    if (depth >= 4 && nestedLabelLinks.length > 0) return true;
    const protocolLabel = presentationVariants(link.label).some(
      (candidate) => isKnownProtocolVersion(candidate) || isKnownProtocolSlashVersion(candidate),
    );
    const clauses = sentenceClauses(value);
    const clauseIndex = clauses.findIndex(
      (clause) => link.start >= clause.start && link.start < clause.end,
    );
    const clause = clauses[clauseIndex];
    const intent = clause
      ? candidateIntent(
          value,
          clause,
          clauses[clauseIndex - 1],
          clauses[clauseIndex + 1],
          link.start,
          link.end - link.start,
        )
      : null;
    const explanatoryProtocolLabel =
      protocolLabel &&
      Boolean(intent) &&
      protocolExplanationPattern.test(intent?.predicateBefore ?? '') &&
      !directProtocolTargetPattern.test(intent?.predicateBefore ?? '') &&
      !intent?.referred;
    if (!explanatoryProtocolLabel && hasPrivateReference(link.label, depth + 1)) return true;
    if (
      presentationVariants(link.destination).some((candidate) =>
        markdownDestinationIsPrivate(candidate),
      )
    )
      return true;
  }
  const publicUrlRanges: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(explicitUrlPattern)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password || url.search || url.hash || privateHost(url.hostname))
        return true;
      publicUrlRanges.push({ start: match.index, end: match.index + match[0].length });
    } catch {
      return true;
    }
  }
  if (discordMessageUrlPattern.test(value)) return true;
  const clauses = sentenceClauses(value);
  for (const [clauseIndex, clause] of clauses.entries()) {
    const clauseValue = value.slice(clause.start, clause.end);
    for (const localMatch of clauseValue.matchAll(targetTokenPattern)) {
      const match = { index: clause.start + localMatch.index, value: localMatch[0] };
      if (
        publicUrlRanges.some(
          (range) => match.index < range.end && match.index + match.value.length > range.start,
        ) ||
        markdownLinks.some(
          (link) => match.index < link.end && match.index + match.value.length > link.start,
        )
      )
        continue;
      const intent = candidateIntent(
        value,
        clause,
        clauses[clauseIndex - 1],
        clauses[clauseIndex + 1],
        match.index,
        match.value.length,
      );
      for (const variant of presentationVariants(match.value)) {
        const { candidate, target, hasSuffix } = normalizeTargetCandidate(variant);
        if (!candidate) continue;
        const safeColonProse = isSafeColonProse(target);
        const lexicalSlashCompound = isLexicalSlashCompound(target, intent);
        const numericColonProse = /^\d{1,2}:\d{1,2}$/u.test(target);
        const explainedProtocol =
          protocolExplanationPattern.test(intent.predicateBefore) &&
          !directProtocolTargetPattern.test(intent.predicateBefore) &&
          !intent.referred;

        if (numericColonProse && safeColonProse && !intent.strong && !hasSuffix) continue;
        if (isKnownProtocolSlashVersion(target)) {
          if (explainedProtocol) continue;
          return true;
        }
        if (decisivePrivateTarget(candidate)) return true;
        if (hasSuffix && parsedTokenIsPrivate(candidate)) return true;
        if (decisivePathTarget(candidate, intent)) return true;

        const ipv6Private = ipv6Privacy(target);
        if (ipv6Private !== null) {
          const sensitivePath = target
            .split('/')
            .slice(1)
            .some((segment) => privatePathHints.has(segment.split(/[?#]/u, 1)[0] ?? ''));
          if (ipv6Private || sensitivePath) return true;
          continue;
        }

        const schemeTarget = /^[a-z][a-z0-9+.-]{0,31}:/iu.test(candidate);
        const colonProseExemption =
          safeColonProse &&
          !intent.strong &&
          !hasSuffix &&
          (/^(?:chapter|kapitola|protocol|version|verzia)/iu.test(target) ||
            (!intent.ordinary &&
              !directProtocolTargetPattern.test(intent.predicateBefore) &&
              !/^https?:/iu.test(target)) ||
            (isKnownProtocolVersion(target) && explainedProtocol));
        if (schemeTarget && !colonProseExemption) {
          if (safeColonProse) return true;
          try {
            const url = new URL(candidate.replaceAll('\\', '/'));
            if (
              !['http:', 'https:'].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash ||
              privateHost(url.hostname)
            )
              return true;
            continue;
          } catch {
            return true;
          }
        }
        if (colonProseExemption) continue;

        const hostPort = /^([^/:]+):\d{1,5}(?:\/.*)?$/u.exec(target);
        if (hostPort) {
          if (parsedTokenIsPrivate(candidate)) return true;
          continue;
        }

        const normalizedCandidate = target.replace(/^\/\//u, '').replaceAll('\\', '/');
        try {
          const url = new URL(`http://${normalizedCandidate}`);
          const host = url.hostname.replace(/\.$/u, '').toLocaleLowerCase('en-US');
          const numericHost = /^(?:0x[\da-f]+|0[0-7]+|\d+)$/iu.test(host);
          const networkLike =
            candidate.startsWith('//') ||
            candidate.includes('\\') ||
            host.includes('.') ||
            numericHost ||
            internalHostHints.has(host);
          if (networkLike) {
            if (parsedTokenIsPrivate(candidate)) return true;
            continue;
          }
        } catch {
          if (candidate.startsWith('//') || candidate.includes('\\')) return true;
        }

        const path = /^([^/:]+)\/(.+)$/u.exec(normalizedCandidate);
        if (path) {
          if (!lexicalSlashCompound && parsedTokenIsPrivate(candidate)) return true;
          continue;
        }

        const bareHost = target.replace(/\.$/, '').toLocaleLowerCase('en-US');
        if (internalHostHints.has(bareHost) && parsedTokenIsPrivate(candidate)) return true;
      }
    }
  }
  return false;
};

export const publicResearchQuestion = (question: string) => {
  if (question.length > researchQuestionCharacters * 4) return null;
  const normalized = question
    .normalize('NFKC')
    .replace(/[。．｡]/gu, '.')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || sensitivePatterns.some((pattern) => pattern.test(normalized))) return null;
  if (hasPrivateReference(normalized)) return null;
  return normalized.slice(0, researchQuestionCharacters);
};

export const createIdentifierProtector = (secret: string) => (identifier: string) =>
  createHmac('sha256', secret).update(identifier).digest('base64url').slice(0, 24);

const sanitizeUrl = (candidate: string) => {
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return '[unsafe link removed]';
    if (url.username || url.password || privateHost(url.hostname)) return '[unsafe link removed]';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid link removed]';
  }
};

const canonicalPublicUrl = (candidate: string) => {
  if (candidate.length > maximumSourceUrlCharacters) return null;
  const sanitized = sanitizeUrl(candidate);
  return (sanitized.startsWith('http://') || sanitized.startsWith('https://')) &&
    sanitized.length <= maximumSourceUrlCharacters
    ? sanitized
    : null;
};

const linkifier = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: true });
const angleSchemePattern = /<([a-z][a-z0-9+.-]{0,31}):([^<>\n]*)>/giu;
const discordTimestampPattern = /<t:\d{1,12}(?::[tTdDfFR])?>/g;
const genericAngleNotationPattern = /<[\p{L}][\p{L}\p{N}_.-]{0,50}:\s+([^<>\n]+)>/gu;
const nestedSchemePattern = /(?<![\p{L}\p{N}_])[a-z][a-z0-9+.-]{0,31}:/iu;
const formattedProseLabelPattern =
  /(?:\*{1,3}[\p{L}][\p{L}\p{N} .-]{0,50}:\*{1,3}|_{1,3}[\p{L}][\p{L}\p{N} .-]{0,50}:_{1,3}|~{2}[\p{L}][\p{L}\p{N} .-]{0,50}:~{2})(?=\s|$)/gu;
const unknownSchemePattern = /(?<![\p{L}\p{N}_])[a-z][a-z0-9+.-]{0,31}:[^\s<>()\]]+/giu;
const bareDomainPattern =
  /(?<![\p{L}\p{N}_@.-])(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}\.)+\p{L}[\p{L}\p{N}-]{1,62})(?:\/[^\s<>()\]]*)?/giu;
const codeFilenamePattern =
  /^[\p{L}\d_.-]+\.(?:c|cpp|css|go|h|html|java|js|json|jsx|md|py|rs|sh|sql|ts|tsx|yml)$/iu;
const containsLinkCandidate = (payload: string) =>
  nestedSchemePattern.test(payload) ||
  Boolean(linkifier.match(payload)?.length) ||
  [...payload.matchAll(bareDomainPattern)].some((match) => !codeFilenamePattern.test(match[0]));

export const publicSourceUrls = (candidates: readonly string[]) =>
  candidates
    .map(canonicalPublicUrl)
    .filter((url): url is string => Boolean(url))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .slice(0, webSearchMaxResults);

const fragmentMarker = (nonce: string, kind: 'CODE' | 'LINK', index: number) =>
  `\uE000${nonce}_${kind}_${index}\uE001`;

const protectCodeFragments = (content: string, nonce: string) => {
  const fragments: string[] = [];
  let protectedContent = '';
  let copiedUntil = 0;
  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] !== '`' || characterIsEscaped(content, cursor)) {
      cursor += 1;
      continue;
    }
    let runLength = 1;
    while (content[cursor + runLength] === '`') runLength += 1;
    let closing = -1;
    let searchFrom = cursor + runLength;
    while (searchFrom < content.length) {
      const candidate = content.indexOf('`', searchFrom);
      if (candidate < 0) break;
      let candidateLength = 1;
      while (content[candidate + candidateLength] === '`') candidateLength += 1;
      if (candidateLength === runLength && !characterIsEscaped(content, candidate)) {
        closing = candidate;
        break;
      }
      searchFrom = candidate + candidateLength;
    }
    if (closing < 0) {
      cursor += runLength;
      continue;
    }
    const end = closing + runLength;
    protectedContent += `${content.slice(copiedUntil, cursor)}${fragmentMarker(
      nonce,
      'CODE',
      fragments.length,
    )}`;
    fragments.push(content.slice(cursor, end));
    copiedUntil = end;
    cursor = end;
  }
  return { content: protectedContent + content.slice(copiedUntil), fragments };
};

const protectMarkdownLinks = (content: string, nonce: string, allowed: ReadonlySet<string>) => {
  const fragments: string[] = [];
  let protectedContent = '';
  let copiedUntil = 0;
  for (const link of scanMarkdownLinks(content)) {
    protectedContent += content.slice(copiedUntil, link.start);
    protectedContent += fragmentMarker(nonce, 'LINK', fragments.length);
    const canonical = canonicalPublicUrl(link.destination);
    const safeLabel =
      scanMarkdownLinks(link.label).length > 0 ||
      /!\[/u.test(link.label) ||
      containsLinkCandidate(link.label)
        ? 'source'
        : link.label;
    fragments.push(
      canonical && allowed.has(canonical) ? `[${safeLabel}](${canonical})` : '[link removed]',
    );
    copiedUntil = link.end;
  }
  protectedContent += content.slice(copiedUntil);
  return { content: protectedContent, fragments };
};

const scanPlainHttpUrls = (content: string) => {
  const urls: Array<{ start: number; end: number; candidate: string }> = [];
  const scheme = /https?:\/\//giu;
  let match = scheme.exec(content);
  while (match && urls.length < 100) {
    const start = match.index;
    const before = content[start - 1] ?? '';
    if (before && /[\p{L}\p{N}@]/u.test(before)) {
      match = scheme.exec(content);
      continue;
    }
    let cursor = start + match[0].length;
    let parenthesisDepth = 0;
    const lineStart = Math.max(content.lastIndexOf('\n', start - 1) + 1, 0);
    const prefix = content.slice(lineStart, start);
    while (cursor < content.length) {
      const character = content[cursor] ?? '';
      if (/\s|[<>\uE000\uE001]/u.test(character)) break;
      const next = content[cursor + 1] ?? '';
      let closingRun = 0;
      let openingRun = 0;
      if (['*', '_', '~', '|'].includes(character)) {
        while (content[cursor + closingRun] === character) closingRun += 1;
        const openingEnd = prefix.lastIndexOf(character);
        if (openingEnd >= 0) {
          let openingStart = openingEnd;
          while (prefix[openingStart - 1] === character) openingStart -= 1;
          openingRun = openingEnd - openingStart + 1;
        }
      }
      const pairedPresentation =
        (character === ']' && prefix.lastIndexOf('[') > prefix.lastIndexOf(']')) ||
        (character === '}' && prefix.lastIndexOf('{') > prefix.lastIndexOf('}')) ||
        (character === '"' && (prefix.match(/"/gu)?.length ?? 0) % 2 === 1) ||
        (character === "'" && (prefix.match(/'/gu)?.length ?? 0) % 2 === 1) ||
        (character === '”' && prefix.lastIndexOf('“') > prefix.lastIndexOf('”')) ||
        (character === '’' && prefix.lastIndexOf('‘') > prefix.lastIndexOf('’')) ||
        (character === '»' && prefix.lastIndexOf('«') > prefix.lastIndexOf('»')) ||
        (character === '›' && prefix.lastIndexOf('‹') > prefix.lastIndexOf('›')) ||
        (openingRun > 0 && openingRun === closingRun);
      const terminalPresentation = /[:—–]/u.test(character) && (!next || /\s/u.test(next));
      if (pairedPresentation || terminalPresentation) break;
      if (character === '(') parenthesisDepth += 1;
      if (character === ')') {
        if (parenthesisDepth === 0) break;
        parenthesisDepth -= 1;
      }
      cursor += 1;
    }
    urls.push({ start, end: cursor, candidate: content.slice(start, cursor) });
    scheme.lastIndex = cursor;
    match = scheme.exec(content);
  }
  return urls;
};

const protectPlainHttpUrls = (
  content: string,
  allowed: ReadonlySet<string>,
  protect: (url: string) => string,
) => {
  let protectedContent = '';
  let copiedUntil = 0;
  for (const url of scanPlainHttpUrls(content)) {
    protectedContent += content.slice(copiedUntil, url.start);
    let candidate = url.candidate;
    let trailing = '';
    let canonical = canonicalPublicUrl(candidate);
    if (!canonical || !allowed.has(canonical)) {
      while (/[.,;!]$/u.test(candidate)) {
        trailing = `${candidate.at(-1)}${trailing}`;
        candidate = candidate.slice(0, -1);
      }
      canonical = canonicalPublicUrl(candidate);
    }
    protectedContent +=
      canonical && allowed.has(canonical)
        ? `${protect(canonical)}${trailing}`
        : `[link removed]${trailing}`;
    copiedUntil = url.end;
  }
  return protectedContent + content.slice(copiedUntil);
};

const restoreFragments = (
  content: string,
  nonce: string,
  codeFragments: readonly string[],
  linkFragments: readonly string[],
) => {
  const markerPattern = new RegExp(`\uE000${nonce}_(CODE|LINK)_(\\d+)\uE001`, 'g');
  let restored = content;
  for (let depth = 0; depth < 4; depth += 1) {
    const next = restored.replace(markerPattern, (_marker, kind: string, index: string) => {
      const fragments = kind === 'CODE' ? codeFragments : linkFragments;
      return fragments[Number(index)] ?? '';
    });
    if (next === restored) break;
    restored = next;
  }
  return restored;
};

export const sanitizeAssistantOutput = (
  content: string,
  allowedSourceUrls: readonly string[] = [],
) => {
  const withoutControls = [...content.replace(/\p{Cf}/gu, '')]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
  const allowed = new Set(
    allowedSourceUrls.map(canonicalPublicUrl).filter((url): url is string => Boolean(url)),
  );
  const nonce = randomUUID();
  const code = protectCodeFragments(withoutControls, nonce);
  const links = protectMarkdownLinks(code.content, nonce, allowed);
  const linkFragments = [...links.fragments];
  const linkMarker = (fragment: string) => {
    const marker = fragmentMarker(nonce, 'LINK', linkFragments.length);
    linkFragments.push(fragment);
    return marker;
  };
  const sourceMarker = (url: string) => linkMarker(`[source](${url})`);
  let sanitized = links.content.replace(discordTimestampPattern, linkMarker);
  sanitized = sanitized.replace(genericAngleNotationPattern, (fragment, payload: string) => {
    return containsLinkCandidate(payload) ? fragment : linkMarker(fragment);
  });
  sanitized = sanitized.replace(angleSchemePattern, (_match, scheme: string, payload: string) => {
    const canonical = canonicalPublicUrl(`${scheme}:${payload}`);
    return canonical && allowed.has(canonical) ? sourceMarker(canonical) : '[link removed]';
  });
  sanitized = sanitized.replace(formattedProseLabelPattern, linkMarker);
  sanitized = protectPlainHttpUrls(sanitized, allowed, sourceMarker);
  sanitized = sanitized.replace(unknownSchemePattern, (candidate) => {
    const trailing = /[.,;!?]+$/.exec(candidate)?.[0] ?? '';
    const canonical = canonicalPublicUrl(candidate.slice(0, candidate.length - trailing.length));
    return canonical && allowed.has(canonical)
      ? `${sourceMarker(canonical)}${trailing}`
      : `[link removed]${trailing}`;
  });
  const matches = linkifier.match(sanitized) ?? [];
  for (const match of [...matches].reverse()) {
    const canonical = ['http:', 'https:'].includes(match.schema)
      ? canonicalPublicUrl(match.url)
      : null;
    const replacement =
      match.schema === '' && codeFilenamePattern.test(match.raw)
        ? linkMarker(`\`${match.raw}\``)
        : canonical && allowed.has(canonical)
          ? sourceMarker(canonical)
          : '[link removed]';
    sanitized = `${sanitized.slice(0, match.index)}${replacement}${sanitized.slice(match.lastIndex)}`;
  }
  sanitized = sanitized.replace(bareDomainPattern, (candidate) =>
    codeFilenamePattern.test(candidate) ? `\`${candidate}\`` : '[link removed]',
  );
  sanitized = restoreFragments(sanitized, nonce, code.fragments, linkFragments).trim();
  if (sanitized.length <= maximumResponseCharacters) return sanitized;
  return `${sanitized.slice(0, maximumResponseCharacters).trimEnd()}\n\n[…response truncated]`;
};

export const sanitizeStreamingAssistantOutput = (
  content: string,
  allowedSourceUrls: readonly string[] = [],
) => {
  const trailingToken = /(?:^|\s)([^\s]*)$/.exec(content)?.[1] ?? '';
  const mayBeIncompleteLink = /[a-z][a-z0-9+.-]{0,31}:|@|[\p{L}\d][./][\p{L}\d]/iu.test(
    trailingToken,
  );
  const stableContent = mayBeIncompleteLink
    ? content.slice(0, content.length - trailingToken.length)
    : content;
  return sanitizeAssistantOutput(stableContent, allowedSourceUrls);
};

const redactSensitiveText = (value: string) =>
  value
    .replace(/mongodb(?:\+srv)?:\/\/[^\s@]+@/gi, 'mongodb://[REDACTED]@')
    .replace(/\bsk-or-[A-Za-z0-9_-]+\b/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s@]+@/gi, '$1[REDACTED]@');

const safeMessagePatterns = [
  /^Configured spend limits must convert to finite safe microdollar integers$/,
  /^Configured spend limits must each cover the maximum per-turn cost envelope/,
  /^Conversation (?:reached its maximum turn count|scope or owner changed)$/,
  /^Discord (?:channel is not sendable|operation exceeded the configured timeout|returned an unknown (?:model|reasoning) option)$/,
  /^Final prompt has no current user message$/,
  /^Guild settings (?:disappeared during update|update did not complete)$/,
  /^Invalid environment configuration:/,
  /^Jolanda (?:is shutting down|shutdown left unsettled requests)$/,
  /^OpenRouter (?:request failed with status \d{3}|returned no response stream|SSE (?:buffer|frame|read) exceeded the configured limit|stream failed(?: \([A-Za-z0-9_.-]+\))?)$/,
  /^Production (?:MONGODB_URI must enforce TLS|deployment requires NODE_ENV=production)$/,
  /^UnsupportedReasoningError$/,
] as const;
const safeStringErrorCodes = new Set(['ABORT_ERR', 'ECONNREFUSED', 'ETIMEDOUT', 'UPSTREAM']);
const safeErrorNames = new Set([
  'AbortError',
  'DiscordAPIError',
  'Error',
  'MongoNetworkError',
  'MongoServerSelectionError',
  'MongoServerError',
  'MongoTimeoutError',
  'TimeoutError',
  'UnsupportedReasoningError',
  'ZodError',
]);

export const safeError = (error: unknown) => {
  if (!(error instanceof Error)) return { type: 'UnknownError' };
  const redactedMessage = redactSensitiveText(error.message).slice(0, 300);
  const message = safeMessagePatterns.some((pattern) => pattern.test(redactedMessage))
    ? redactedMessage
    : 'Unexpected error';
  const rawCode = 'code' in error ? error.code : undefined;
  const code =
    (typeof rawCode === 'number' && Number.isFinite(rawCode)) ||
    (typeof rawCode === 'string' && safeStringErrorCodes.has(rawCode))
      ? rawCode
      : undefined;
  return {
    type: safeErrorNames.has(error.name) ? error.name : 'Error',
    message,
    ...(code !== undefined ? { code } : {}),
  };
};
