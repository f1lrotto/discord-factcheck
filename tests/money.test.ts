import { describe, expect, it } from 'vitest';
import { formatUsd } from '../src/money.js';

describe('formatUsd', () => {
  it.each([
    [0, '$0.0000'],
    [1, '$0.000001'],
    [1_000, '$0.0010'],
    [1_234_567, '$1.234567'],
    [1_000_000, '$1.0000'],
  ])('renders %i microdollars without hiding sub-cent precision', (microdollars, expected) => {
    expect(formatUsd(microdollars)).toBe(expected);
  });
});
