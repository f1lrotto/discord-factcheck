import { describe, expect, it } from 'vitest';
import {
  defaultGuildSettings,
  findModelProfile,
  getModel,
  modelProfiles,
  modelSupportsReasoning,
  modelSupportsZdr,
} from '../src/models.js';

describe('model catalog', () => {
  it('uses a ZDR-compatible model and zero ambient context by default', () => {
    expect(defaultGuildSettings).toEqual({
      model: 'glm-5.3-flash',
      reasoning: 'high',
      contextLimitMessages: 0,
    });
    expect(modelSupportsZdr(defaultGuildSettings.model)).toBe(true);
  });

  it('derives all valid profiles and warns when a model has no ZDR route', () => {
    expect(modelProfiles()).toHaveLength(12);
    expect(
      modelProfiles()
        .filter(({ model }) => model === 'luna')
        .every(({ label }) => label.includes('[no ZDR]')),
    ).toBe(true);
    expect(
      modelProfiles()
        .filter(({ model }) => model === 'deepseek-v4-flash')
        .every(({ label }) => !label.includes('[no ZDR]')),
    ).toBe(true);
    expect(
      modelProfiles()
        .filter(({ model }) => model === 'glm-5.3-flash')
        .every(({ label }) => !label.includes('[no ZDR]')),
    ).toBe(true);
    expect(findModelProfile('deepseek-v4-flash:medium')).toBeUndefined();
    expect(findModelProfile('luna:medium')).toMatchObject({
      model: 'luna',
      reasoning: 'medium',
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
    expect(getModel('glm-5.3-flash')).toMatchObject({
      openRouterId: 'z-ai/glm-5.3-flash',
      defaultReasoning: 'max',
      reasoningEfforts: ['low', 'high', 'max'],
      supportsZdr: true,
    });
  });
});
