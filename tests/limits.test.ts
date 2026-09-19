import { describe, expect, it } from 'vitest';
import {
  costEnvelopeDetails,
  costEnvelopeMicrodollars,
  createConcurrencyGate,
  createSlidingWindowGate,
  maximumCostEnvelopeMicrodollars,
  maximumAnswerRequests,
  openRouterStreamStartTimeoutMs,
  requestLeaseMs,
  webFetchMaxContentTokens,
  webFetchMaxUses,
  webSearchMaxResults,
  webSearchResultCharacters,
} from '../src/limits.js';
import { modelCatalog } from '../src/models.js';
import { imageLimits } from '../src/image-limits.js';

describe('cost and concurrency limits', () => {
  it('allows ten minutes for OpenRouter to start streaming', () => {
    expect(openRouterStreamStartTimeoutMs).toBe(10 * 60_000);
    expect(requestLeaseMs).toBeGreaterThan(openRouterStreamStartTimeoutMs);
  });

  it('reserves a conservative bounded envelope for every exposed configuration', () => {
    const medium = costEnvelopeMicrodollars({
      model: 'luna',
      reasoning: 'medium',
      maximumPromptCharacters: 32_000,
    });
    const maximum = maximumCostEnvelopeMicrodollars(32_000);

    expect(medium).toBeGreaterThan(100_000);
    expect(maximum).toBeGreaterThanOrEqual(medium);
    expect(maximum).toBeLessThan(10_000_000);

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
        32_000 + webSearchMaxResults * webSearchResultCharacters,
      );
      expect(details.maximumInputTokens).toBe(
        details.maximumInputCharacters * 4 + webFetchMaxUses * webFetchMaxContentTokens,
      );
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
    expect(maximum).toBeGreaterThanOrEqual(Math.max(...totals));
    expect(maximum).toBe(
      costEnvelopeMicrodollars({
        model: 'grok-4.3',
        reasoning: 'high',
        maximumPromptCharacters: 32_000,
        imageCount: imageLimits.count,
      }),
    );
  });

  it('reserves image tokens on every possible model round without consuming the text budget', () => {
    const configuration = {
      model: 'glm-5.3-flash',
      reasoning: 'high',
      maximumPromptCharacters: 32_000,
    } as const;
    const text = costEnvelopeDetails(configuration);
    const vision = costEnvelopeDetails({ ...configuration, imageCount: 2 });
    expect(vision.maximumInputCharacters).toBe(text.maximumInputCharacters);
    expect(vision.maximumInputTokens - text.maximumInputTokens).toBe(
      2 * imageLimits.tokensPerImage * maximumAnswerRequests,
    );
    expect(vision.totalMicrodollars).toBeGreaterThan(text.totalMicrodollars);
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
