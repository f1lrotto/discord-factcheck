import { describe, expect, it } from 'vitest';
import {
  costEnvelopeDetails,
  costEnvelopeMicrodollars,
  createConcurrencyGate,
  createSlidingWindowGate,
  maximumCostEnvelopeMicrodollars,
  maximumResearchEvidenceCharacters,
  researchQuestionCharacters,
  webSearchMaxResults,
  webSearchResultCharacters,
} from '../src/limits.js';
import { modelCatalog } from '../src/models.js';

describe('cost and concurrency limits', () => {
  it('reserves a conservative bounded envelope for every exposed configuration', () => {
    const medium = costEnvelopeMicrodollars({
      model: 'luna',
      reasoning: 'medium',
      maximumPromptCharacters: 32_000,
    });
    const maximum = maximumCostEnvelopeMicrodollars(32_000);

    expect(medium).toBeGreaterThan(100_000);
    expect(maximum).toBeGreaterThanOrEqual(medium);
    expect(maximum).toBeLessThan(2_000_000);

    const configurations = Object.values(modelCatalog).flatMap((model) =>
      model.reasoningEfforts.map((reasoning) => ({ model, reasoning })),
    );
    const totals = configurations.map(({ model, reasoning }) => {
      const details = costEnvelopeDetails({
        model: model.id,
        reasoning,
        maximumPromptCharacters: 32_000,
      });

      expect(details.maximumInputCharacters).toBeGreaterThanOrEqual(
        32_000 +
          researchQuestionCharacters +
          maximumResearchEvidenceCharacters +
          webSearchMaxResults * webSearchResultCharacters,
      );
      expect(details.maximumInputTokens).toBe(details.maximumInputCharacters * 4);
      expect(details.maximumOutputTokens).toBeGreaterThan(2_000);
      expect(details.totalMicrodollars).toBe(
        details.promptMicrodollars +
          details.completionMicrodollars +
          details.webSearchMicrodollars +
          details.safetyMarginMicrodollars,
      );
      expect(details.webSearchMicrodollars).toBeGreaterThanOrEqual(5_000);
      return details.totalMicrodollars;
    });
    expect(maximum).toBe(Math.max(...totals));
  });

  it('never admits more concurrent work than configured', () => {
    const gate = createConcurrencyGate(1);
    const release = gate.tryAcquire();

    expect(release).toBeTypeOf('function');
    expect(gate.tryAcquire()).toBeNull();
    release?.();
    release?.();
    expect(gate.active()).toBe(0);
    expect(gate.tryAcquire()).toBeTypeOf('function');
  });

  it('prunes expired callers before applying sliding-window key capacity', () => {
    const gate = createSlidingWindowGate(1, 1_000, 2);

    expect(gate.tryAcquire('first', 0)).toBe(true);
    expect(gate.tryAcquire('second', 0)).toBe(true);
    expect(gate.tryAcquire('blocked', 500)).toBe(false);
    expect(gate.tryAcquire('replacement', 1_001)).toBe(true);
  });
});
