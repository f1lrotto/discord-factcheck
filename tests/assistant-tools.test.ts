import { describe, expect, it } from 'vitest';
import { createAssistantToolbox } from '../src/assistant-tools.js';
import { createClockSnapshot } from '../src/clock.js';

const clock = createClockSnapshot(new Date('2026-08-25T12:00:00.000Z'), 'Europe/Bratislava');

describe('assistant toolbox', () => {
  it('always offers the complete read-only assistant toolbox', () => {
    const toolbox = createAssistantToolbox({
      clock,
      allowFunctions: true,
    });

    expect(toolbox.offered).toEqual([
      'openrouter:datetime',
      'calculate',
      'get_datetime_in_timezone',
      'openrouter:web_search',
      'openrouter:web_fetch',
    ]);
    expect(toolbox.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'openrouter:web_search' }),
        expect.objectContaining({
          type: 'openrouter:web_fetch',
          parameters: expect.objectContaining({ max_uses: 2, max_content_tokens: 8_000 }),
        }),
      ]),
    );
  });

  it('executes calculator and time-zone calls against the immutable turn clock', () => {
    const toolbox = createAssistantToolbox({
      clock,
      allowFunctions: true,
    });

    expect(
      JSON.parse(
        toolbox.execute({
          id: 'call-calculate',
          name: 'calculate',
          arguments: JSON.stringify({ expression: '(12 + 8) / 4' }),
        }),
      ),
    ).toEqual({ ok: true, expression: '(12 + 8) / 4', result: 5 });
    expect(
      JSON.parse(
        toolbox.execute({
          id: 'call-time',
          name: 'get_datetime_in_timezone',
          arguments: JSON.stringify({ time_zone: 'America/New_York' }),
        }),
      ),
    ).toMatchObject({
      ok: true,
      instant: '2026-08-25T12:00:00.000Z',
      localDateTime: '2026-08-25T08:00:00',
      utcOffset: '-04:00',
    });
  });

  it('converts supplied absolute instants and returns bounded errors without throwing', () => {
    const toolbox = createAssistantToolbox({
      clock,
      allowFunctions: true,
    });
    const execute = (name: string, arguments_: string) =>
      JSON.parse(toolbox.execute({ id: 'call', name, arguments: arguments_ })) as {
        ok: boolean;
        error?: string;
        localDateTime?: string;
      };

    expect(
      execute(
        'get_datetime_in_timezone',
        JSON.stringify({ time_zone: 'Asia/Tokyo', instant: '2026-01-01T00:00:00Z' }),
      ),
    ).toMatchObject({ ok: true, localDateTime: '2026-01-01T09:00:00' });
    expect(execute('calculate', '{')).toEqual({ ok: false, error: 'invalid_tool_arguments' });
    expect(execute('calculate', JSON.stringify({ expression: '2 / 0' }))).toEqual({
      ok: false,
      error: 'tool_execution_failed',
    });
    expect(execute('get_datetime_in_timezone', JSON.stringify({ time_zone: 'invalid' }))).toEqual({
      ok: false,
      error: 'invalid_timezone_arguments',
    });
    expect(execute('unknown', '{}')).toEqual({ ok: false, error: 'unknown_tool' });
    expect(execute('calculate', 'x'.repeat(4_001))).toEqual({
      ok: false,
      error: 'invalid_tool_arguments',
    });
  });
});
