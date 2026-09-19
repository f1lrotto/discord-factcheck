import { describe, expect, it } from 'vitest';
import {
  defaultGuildSettings,
  findModelProfile,
  getModel,
  modelProfiles,
  modelChoices,
  modelCatalog,
  modelSupportsReasoning,
  modelSupportsZdr,
  resolveImageModel,
} from '../src/models.js';

describe('model catalog', () => {
  it('shows every default with a short description and makes every effort searchable', () => {
    for (const locale of ['en', 'sk'] as const) {
      const defaults = modelChoices('', locale);
      expect(defaults).toHaveLength(8);
      for (const model of Object.values(modelCatalog)) {
        expect(defaults).toContainEqual({
          value: `${model.id}:${model.defaultReasoning}`,
          name: expect.stringContaining(model.description[locale]),
        });
        for (const effort of model.reasoningEfforts) {
          const choices = modelChoices(`${model.id} ${effort}`, locale);
          expect(choices.some(({ value }) => value === `${model.id}:${effort}`)).toBe(true);
          expect(choices.every(({ name }) => name.length <= 100)).toBe(true);
        }
      }
      expect(modelChoices('a', locale).length).toBeLessThanOrEqual(25);
      expect(modelChoices('unknown-model', locale)).toEqual([]);
    }
    expect(modelChoices('  GROK HIGH  ', 'en').map(({ value }) => value)).toEqual([
      'grok-4.3:high',
    ]);
    expect(modelChoices('chat only', 'en')).toHaveLength(3);
  });

  it('uses the image fallback for the chat-only models without changing saved settings', () => {
    for (const model of ['hermes-4-405b', 'venice-uncensored'] as const) {
      const settings = {
        ...defaultGuildSettings,
        model,
        reasoning: 'none' as const,
        guildId: 'guild',
        updatedAt: new Date(),
      };
      expect(resolveImageModel(settings, false)).toBe(settings);
      expect(resolveImageModel(settings, true)).toMatchObject({
        model: 'glm-5.3-flash',
        reasoning: 'max',
      });
      expect(settings.model).toBe(model);
    }
  });
  it('keeps vision models and text turns on their selected profile', () => {
    const base = { ...defaultGuildSettings, guildId: 'guild', updatedAt: new Date() };
    expect(resolveImageModel(base, true)).toBe(base);
    const luna = { ...base, model: 'luna', reasoning: 'medium' } as const;
    expect(resolveImageModel(luna, true)).toBe(luna);
    const deepseek = { ...base, model: 'deepseek-v4-flash' } as const;
    expect(resolveImageModel(deepseek, false)).toBe(deepseek);
    expect(resolveImageModel(deepseek, true)).toMatchObject({
      model: 'glm-5.3-flash',
      reasoning: 'high',
    });
    expect(resolveImageModel({ ...deepseek, reasoning: 'medium' }, true)).toMatchObject({
      model: 'glm-5.3-flash',
      reasoning: 'max',
    });
  });
  it('uses a ZDR-compatible model and zero ambient context by default', () => {
    expect(defaultGuildSettings).toEqual({
      model: 'glm-5.3-flash',
      reasoning: 'high',
      contextLimitMessages: 0,
      locale: 'sk',
    });
    expect(modelSupportsZdr(defaultGuildSettings.model)).toBe(true);
  });

  it('derives all valid profiles and warns when a model has no ZDR route', () => {
    expect(modelProfiles()).toHaveLength(27);
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
