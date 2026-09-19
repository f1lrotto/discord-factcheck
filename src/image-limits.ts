export const imageLimits = {
  count: 4,
  sourceBytes: 8 * 1024 * 1024,
  decodedPixels: 40_000_000,
  dimension: 1600,
  outputBytes: 2 * 1024 * 1024,
  timeoutMs: 15_000,
  // Generous allowance for a resized image, charged again on every tool round.
  tokensPerImage: 16_384,
} as const;
