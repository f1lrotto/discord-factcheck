import { createHmac, randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { LinkifyIt } from 'linkify-it';
import {
  maximumCitationAnnotations,
  maximumResponseCharacters,
  maximumSourceUrlCharacters,
} from './limits.js';

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
// Restricted to real URI schemes. The previous `word:nonspace` shape matched ordinary prose
// ("Karpaty:10 980", "ratio:3") and replaced it with "[link removed]".
const knownUriSchemes = [
  'about',
  'blob',
  'chrome-extension',
  'chrome',
  'data',
  'file',
  'ftps',
  'ftp',
  'gopher',
  'intent',
  'jar',
  'javascript',
  'ldap',
  'magnet',
  'mailto',
  'market',
  'moz-extension',
  'nfs',
  'sftp',
  'smb',
  'sms',
  'ssh',
  'steam',
  'telnet',
  'tel',
  'vbscript',
  'view-source',
  'wss',
  'ws',
] as const;
const unknownSchemePattern = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:[a-z][a-z0-9+.-]{0,31}://|(?:${knownUriSchemes.join('|')}):)[^\\s<>()\\]]*`,
  'giu',
);
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
    .slice(0, maximumCitationAnnotations);

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
      canonical && allowed.has(canonical)
        ? `[${safeLabel}](${canonical})`
        : safeLabel.trim() || 'link unavailable',
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
    // Fuzzy matches ("www.example.com/page") report an empty schema; canonicalize them as
    // https so a cited source written without its scheme still resolves to the allowlist.
    const canonical = ['', '//'].includes(match.schema)
      ? (canonicalPublicUrl(`https://${match.raw.replace(/^\/\//u, '')}`) ??
        canonicalPublicUrl(match.url))
      : ['http:', 'https:'].includes(match.schema)
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
  sanitized = sanitized.replace(bareDomainPattern, (candidate) => {
    if (codeFilenamePattern.test(candidate)) return `\`${candidate}\``;
    // A cited source written without its scheme is still a cited source; only genuinely
    // unverified domains are removed.
    const canonical = canonicalPublicUrl(`https://${candidate}`);
    return canonical && allowed.has(canonical) ? sourceMarker(canonical) : '[link removed]';
  });
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
  /^OpenRouter (?:(?:research|answer) failed \([a-z_]+\)|returned (?:an empty response|no response stream)|SSE (?:buffer|frame|read) exceeded the configured limit)$/,
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
  'ModelFailure',
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
