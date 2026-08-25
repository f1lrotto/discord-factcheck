export const normalizeLiveResponse = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('sk');

export const matchesNormalizedExactResponse = (actual: string, expected: string) =>
  normalizeLiveResponse(actual) === normalizeLiveResponse(expected);
