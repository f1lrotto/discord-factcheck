import { maximumDiscordChunks } from './limits.js';

export const stripJolandaMention = (content: string, botId: string) =>
  content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();

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
