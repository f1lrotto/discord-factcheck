import { describe, expect, it } from 'vitest';
import { defaultGuildSettings, getModel, modelSupportsReasoning } from '../src/models.js';

describe('model catalog', () => {
  it('uses Luna medium and zero ambient context by default', () => {
    expect(defaultGuildSettings).toEqual({
      model: 'luna',
      reasoning: 'medium',
      contextMessages: 0,
    });
  });

  it('validates reasoning per model', () => {
    expect(modelSupportsReasoning('luna', 'medium')).toBe(true);
    expect(modelSupportsReasoning('deepseek-v4-flash', 'medium')).toBe(false);
    expect(modelSupportsReasoning('deepseek-v4-flash', 'low')).toBe(true);
    expect(modelSupportsReasoning('deepseek-v4-flash', 'high')).toBe(true);
    expect(modelSupportsReasoning('deepseek-v4-flash', 'max')).toBe(true);
    expect(modelSupportsReasoning('deepseek-v4-flash', 'xhigh')).toBe(false);
    expect(getModel('deepseek-v4-flash').reasoningEfforts).toEqual(['low', 'high', 'max']);
    expect(getModel('deepseek-v4-flash').openRouterId).toBe('deepseek/deepseek-v4-flash-0731');
  });
});
