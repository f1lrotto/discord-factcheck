import { maximumDiscordChunks } from './limits.js';
import type { AmbientContextRequest } from './types.js';

export const stripJolandaMention = (content: string, botId: string) =>
  content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();

export type ParsedJolandaPrompt =
  { ok: true; question: string; ambientContext?: AmbientContextRequest } | { ok: false };

export const parseJolandaPrompt = (content: string): ParsedJolandaPrompt => {
  const question = content.trim();
  if (!/^\+context(?==|\s|$)/iu.test(question)) return { ok: true, question };

  const directive = /^\+context(?:=(\d+))?(?:\s+|$)/iu.exec(question);
  if (!directive) return { ok: false };
  const requested = directive[1];
  const limit = requested === undefined ? 'maximum' : Number(requested);
  if (limit !== 'maximum' && (!Number.isSafeInteger(limit) || limit < 0)) return { ok: false };

  return {
    ok: true,
    question: question.slice(directive[0].length).trim(),
    ambientContext: { limit },
  };
};

export const minimizeDiscordContent = (content: string) =>
  content
    .replace(
      /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(?:@me|\d{17,20})\/\d{17,20}\/\d{17,20}(?:[/?#][^\s<]*)?/giu,
      '[Discord message]',
    )
    .replace(/<@&\d{17,20}>/g, '@role')
    .replace(/<@!?\d{17,20}>/g, '@participant')
    .replace(/<#\d{17,20}>/g, '#channel')
    .replace(/<a?:([A-Za-z0-9_]{1,32}):\d{17,20}>/g, ':$1:')
    .replace(/<\/([^:>\n]{1,100}):\d{17,20}>/g, '/$1')
    .replace(/(?<!\d)\d{17,20}(?!\d)/g, '[Discord identifier]');

const fencedCodeLine = /^[\t ]*(?:>[\t ]*)*(`{3,}|~{3,})/u;
const markdownHeadingLine = /^([\t ]*(?:>[\t ]*)*)#{1,6}[\t ]+(.+)$/u;

export const clampDiscordMarkdown = (content: string) => {
  let activeFence: '`' | '~' | undefined;

  return content
    .split('\n')
    .map((line) => {
      const fence = fencedCodeLine.exec(line)?.[1]?.[0] as '`' | '~' | undefined;
      if (fence) {
        if (!activeFence) activeFence = fence;
        else if (activeFence === fence) activeFence = undefined;
        return line;
      }
      if (activeFence) return line;

      const heading = markdownHeadingLine.exec(line);
      if (!heading) return line;
      const prefix = heading[1] ?? '';
      const label = (heading[2] ?? '').replace(/[\t ]+#+[\t ]*$/u, '').trim();
      if (!label) return prefix.trimEnd();
      return `${prefix}${label.startsWith('**') && label.endsWith('**') ? label : `**${label}**`}`;
    })
    .join('\n');
};

type AtomicSpan = { start: number; end: number };

// Constructs that lose their meaning the moment a chunk boundary lands inside them.
const atomicSpanPatterns = [
  /`{1,3}[^`\n]*`{1,3}/gu,
  /\[[^[\]\n]{0,500}\]\([^()\s]{0,2100}\)/gu,
  /(\*\*\*|\*\*|~~|\|\||__)(?:(?!\1)[^\n])+\1/gu,
] as const;

const atomicSpans = (content: string) =>
  atomicSpanPatterns.flatMap((pattern) =>
    [...content.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  );

const spanContaining = (spans: readonly AtomicSpan[], index: number) =>
  spans.find((span) => index > span.start && index < span.end);

// Ordered by how natural the resulting break reads; the first tier with a usable
// candidate wins, so a paragraph break always beats a mid-sentence space.
const breakPatterns = [/\n[\t ]*\n/gu, /\n/gu, /[.!?…][)"'”’»]?[\t ]/gu, /[\t ]/gu] as const;

const chooseSplit = (content: string, spans: readonly AtomicSpan[], budget: number) => {
  const window = content.slice(0, budget);
  const minimum = Math.floor(budget * 0.6);
  for (const pattern of breakPatterns) {
    let best = -1;
    for (const match of window.matchAll(pattern)) {
      const index = match.index + match[0].length;
      if (index >= minimum && !spanContaining(spans, index)) best = index;
    }
    if (best > 0) return best;
  }
  const blocking = spanContaining(spans, budget);
  return blocking && blocking.start > 0 ? blocking.start : budget;
};

const fenceMarkerIn = (line: string) => fencedCodeLine.exec(line)?.[1];

const openFenceAfter = (content: string, opening?: string) =>
  content.split('\n').reduce<string | undefined>((open, line) => {
    const fence = fenceMarkerIn(line);
    if (!fence) return open;
    if (!open) return fence;
    return open[0] === fence[0] ? undefined : open;
  }, opening);

// Room to close an open code fence at the end of a chunk.
const fenceAllowance = 8;

export type DiscordChunk = { text: string; sourceEnd: number };

/**
 * Splits sanitized output into Discord-sized chunks without cutting through a markdown
 * link, inline code span, emphasis run, or code fence. `sourceEnd` is the offset in the
 * trimmed input consumed by each chunk, so callers can keep published chunks stable while
 * a response is still streaming.
 */
export const splitDiscordChunks = (
  content: string,
  maximumLength = 1_900,
  maximumChunks = maximumDiscordChunks,
): DiscordChunk[] => {
  const chunks: DiscordChunk[] = [];
  const trimmed = content.trim();
  let consumed = 0;
  let carriedFence: string | undefined;

  while (chunks.length < maximumChunks - 1) {
    const prefix = carriedFence ? `${carriedFence}\n` : '';
    const remainder = trimmed.slice(consumed);
    if (prefix.length + remainder.length <= maximumLength) break;
    const budget = maximumLength - prefix.length - fenceAllowance;
    if (budget <= 0) break;
    const splitAt = chooseSplit(remainder, atomicSpans(remainder), budget);
    if (splitAt <= 0) break;
    const head = remainder.slice(0, splitAt).trimEnd();
    const tail = remainder.slice(splitAt);
    const openFence = openFenceAfter(head, carriedFence);
    consumed += splitAt + (tail.length - tail.trimStart().length);
    chunks.push({
      text: `${prefix}${head}${openFence ? `\n${openFence}` : ''}`,
      sourceEnd: consumed,
    });
    carriedFence = openFence;
  }

  const remainder = trimmed.slice(consumed);
  if (remainder) {
    const prefix = carriedFence ? `${carriedFence}\n` : '';
    const tail = `${prefix}${remainder}`;
    const marker = '\n[…response truncated]';
    chunks.push({
      text:
        tail.length <= maximumLength
          ? tail
          : `${tail.slice(0, maximumLength - marker.length).trimEnd()}${marker}`,
      sourceEnd: trimmed.length,
    });
  }
  return chunks;
};

export const splitDiscordMessage = (
  content: string,
  maximumLength = 1_900,
  maximumChunks = maximumDiscordChunks,
) => splitDiscordChunks(content, maximumLength, maximumChunks).map((chunk) => chunk.text);
