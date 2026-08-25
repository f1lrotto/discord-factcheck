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

export const splitDiscordMessage = (
  content: string,
  maximumLength = 1_900,
  maximumChunks = maximumDiscordChunks,
) => {
  const chunks: string[] = [];
  let remainder = content.trim();

  while (remainder.length > maximumLength && chunks.length < maximumChunks - 1) {
    const candidate = remainder.slice(0, maximumLength);
    const newline = candidate.lastIndexOf('\n');
    const space = candidate.lastIndexOf(' ');
    const naturalBreak = Math.max(newline, space);
    const splitAt = naturalBreak >= Math.floor(maximumLength * 0.6) ? naturalBreak : maximumLength;
    chunks.push(remainder.slice(0, splitAt).trimEnd());
    remainder = remainder.slice(splitAt).trimStart();
  }

  if (remainder) {
    const marker = '\n[…response truncated]';
    chunks.push(
      remainder.length <= maximumLength
        ? remainder
        : `${remainder.slice(0, maximumLength - marker.length).trimEnd()}${marker}`,
    );
  }
  return chunks;
};
