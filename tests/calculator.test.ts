import { describe, expect, it } from 'vitest';
import { calculate } from '../src/calculator.js';

describe('calculator', () => {
  it.each([
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['2^3^2', 512],
    ['-2^2', -4],
    ['2^-3', 0.125],
    ['1e3 / 4', 250],
    ['0.1 + 0.2', 0.3],
    ['sqrt(81) + abs(-4)', 13],
    ['max(2, 9, 4) - min(2, 9, 4)', 7],
    ['round(pi)', 3],
    ['pow(2, 5) + log(100) + ln(e)', 35],
  ])('evaluates %s', (expression, expected) => {
    expect(calculate(expression)).toEqual({ expression, result: expected });
  });

  it.each([
    '',
    '2 + process.exit()',
    '2 + (3',
    'sqrt()',
    'unknown(2)',
    '2 / 0',
    '1e999',
    '1,2',
    'x'.repeat(300),
  ])('rejects unsafe or invalid input: %s', (expression) => {
    expect(() => calculate(expression)).toThrow();
  });
});
