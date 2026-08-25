import {
  maximumCitationAnnotations,
  maximumCitationTitleCharacters,
  maximumResponseCharacters,
} from './limits.js';
import { publicSourceUrls } from './security.js';

export type SourceCitation = {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
};

const boundedIndex = (value: unknown) =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximumResponseCharacters
    ? value
    : undefined;

const boundedTitle = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const title = value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximumCitationTitleCharacters);
  return title || undefined;
};

export const createSourceCitation = (input: {
  url: unknown;
  title?: unknown;
  startIndex?: unknown;
  endIndex?: unknown;
}): SourceCitation | null => {
  if (typeof input.url !== 'string') return null;
  const url = publicSourceUrls([input.url])[0];
  if (!url) return null;
  const title = boundedTitle(input.title);
  const startIndex = boundedIndex(input.startIndex);
  const endIndex = boundedIndex(input.endIndex);
  const hasValidRange =
    startIndex !== undefined && endIndex !== undefined && startIndex <= endIndex;
  return {
    url,
    ...(title ? { title } : {}),
    ...(hasValidRange ? { startIndex, endIndex } : {}),
  };
};

const sameCitation = (left: SourceCitation, right: SourceCitation) =>
  left.url === right.url &&
  left.startIndex === right.startIndex &&
  left.endIndex === right.endIndex;

export const addSourceCitation = (
  citations: readonly SourceCitation[],
  citation: SourceCitation,
) =>
  citations.length >= maximumCitationAnnotations ||
  citations.some((candidate) => sameCitation(candidate, citation))
    ? citations
    : [...citations, citation];

export const uniqueSourceCitations = (
  citations: readonly SourceCitation[],
  sourceUrls: readonly string[] = [],
) => {
  const normalized = citations.flatMap((citation) => {
    const candidate = createSourceCitation(citation);
    return candidate ? [candidate] : [];
  });
  const byUrl = new Map(normalized.map((citation) => [citation.url, citation]));
  for (const url of publicSourceUrls(sourceUrls)) if (!byUrl.has(url)) byUrl.set(url, { url });
  return [...byUrl.values()];
};

const citationLabel = (citation: SourceCitation, sourceNumber: number) => {
  const title = citation.title
    ?.replace(/[\\[\]()`*_~<>|@]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return title ? `Source ${sourceNumber}: ${title}` : `Source ${sourceNumber}`;
};

export const sourceCitationMarkdown = (citation: SourceCitation, sourceNumber: number) =>
  `[${citationLabel(citation, sourceNumber)}](${citation.url})`;

export const attachSourceCitations = (content: string, citations: readonly SourceCitation[]) => {
  const normalized = citations.flatMap((citation) => {
    const candidate = createSourceCitation(citation);
    return candidate ? [candidate] : [];
  });
  const sources = uniqueSourceCitations(normalized);
  const sourceNumbers = new Map(sources.map((citation, index) => [citation.url, index + 1]));
  const insertions = new Map<number, SourceCitation[]>();

  for (const citation of normalized) {
    if (citation.startIndex === undefined || citation.endIndex === undefined) continue;
    if (citation.startIndex >= content.length || citation.endIndex > content.length) continue;
    const insertionIndex = Math.min(content.length, citation.endIndex + 1);
    const citedRange = content.slice(citation.startIndex, insertionIndex);
    if (citedRange.includes(citation.url)) continue;
    const existing = insertions.get(insertionIndex) ?? [];
    if (!existing.some((candidate) => candidate.url === citation.url))
      insertions.set(insertionIndex, [...existing, citation]);
  }

  return [...insertions.entries()]
    .sort(([left], [right]) => right - left)
    .reduce((rendered, [index, positioned]) => {
      const markers = positioned
        .map((citation) => {
          const number = sourceNumbers.get(citation.url);
          return number ? sourceCitationMarkdown(citation, number) : '';
        })
        .filter(Boolean)
        .join(' ');
      return markers ? `${rendered.slice(0, index)} ${markers}${rendered.slice(index)}` : rendered;
    }, content);
};
