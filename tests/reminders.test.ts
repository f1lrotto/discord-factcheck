import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  parseReminder,
  checkReminderInstant,
  normalizeReminderText,
  reminderLimits,
  type ReminderStore,
} from '../src/reminders.js';
import { createReminderRuntime } from '../src/reminder-runtime.js';
import { createAssistantToolbox } from '../src/assistant-tools.js';
import { createClockSnapshot } from '../src/clock.js';
import { localWallClockInstant } from '../src/scheduling/slots.js';

const now = new Date('2026-09-15T15:30:00Z');
const timeZone = 'Europe/Bratislava';
const parse = (overrides: Partial<Parameters<typeof parseReminder>[0]> = {}) =>
  parseReminder({ now, timeZone, text: 'Laundry', in: '2h', ...overrides });

describe('reminder inputs', () => {
  it.each([
    ['2h', 7_200_000],
    ['90m', 5_400_000],
    ['3d', 259_200_000],
    ['1min', 60_000],
    ['2hod', 7_200_000],
  ])('resolves %s', (delay, ms) =>
    expect(parse({ in: delay })).toEqual({ ok: true, dueAt: new Date(+now + ms), text: 'Laundry' }),
  );
  it.each([
    ['2026-03-28T22:30:00Z', '09:00', '2026-03-29T07:00:00Z'],
    ['2026-10-24T22:30:00Z', '00:15', '2026-10-25T23:15:00Z'],
  ])('uses tomorrow’s calendar date across DST from %s', (instant, at, expected) => {
    expect(parse({ now: new Date(instant), in: null, at })).toMatchObject({
      ok: true,
      dueAt: new Date(expected),
    });
  });
  it('normalizes text without allowing control characters', () =>
    expect(normalizeReminderText('  hi\u200b\n\tthere  ')).toBe('hi there'));
  it.each(['', '0h', '-2h', 'infinity', '123456h'])('rejects bad delay %s', (delay) =>
    expect(parse({ in: delay }).ok).toBe(false),
  );
  it('requires exactly one time and validates bounds', () => {
    expect(parse({ at: '2026-09-16 09:00' })).toEqual({ ok: false, reason: 'invalid_time' });
    expect(parse({ in: null, at: '2026-09-16 09:00' })).toMatchObject({
      dueAt: new Date('2026-09-16T07:00:00Z'),
    });
    expect(parse({ in: null, at: '18:00' })).toMatchObject({
      dueAt: new Date('2026-09-15T16:00:00Z'),
    });
    expect(parse({ in: null, at: '09:00' })).toMatchObject({
      dueAt: new Date('2026-09-16T07:00:00Z'),
    });
    expect(parse({ in: '366d' })).toEqual({ ok: false, reason: 'too_far' });
    expect(parse({ text: ' ' })).toEqual({ ok: false, reason: 'empty_text' });
    expect(parse({ text: 'a'.repeat(281) })).toEqual({ ok: false, reason: 'text_too_long' });
    expect(checkReminderInstant({ dueAt: now, now, text: 'x' })).toEqual({
      ok: false,
      reason: 'too_soon',
    });
    expect(checkReminderInstant({ dueAt: new Date('bad'), now, text: 'x' })).toEqual({
      ok: false,
      reason: 'invalid_time',
    });
    expect(checkReminderInstant({ dueAt: now, now, text: ' ' }).ok).toBe(false);
    expect(checkReminderInstant({ dueAt: now, now, text: 'x'.repeat(281) }).ok).toBe(false);
    expect(parse({ in: '365d' }).ok).toBe(true);
  });
  it.each([
    '2026-02-30 09:00',
    '2026-03-29 02:30',
    '2026-10-25 02:30',
    '2026-09-16 24:00',
    '2026-09-16 09:60',
    'nonsense',
  ])('rejects impossible or ambiguous time %s', (at) =>
    expect(parse({ in: null, at }).ok).toBe(false),
  );
  it('rejects invalid timezone and date shape', () => {
    expect(localWallClockInstant({ date: 'bad', hour: 9, minute: 0, timeZone })).toBeNull();
    expect(
      localWallClockInstant({ date: '2026-09-15', hour: 9, minute: 0, timeZone: 'bad' }),
    ).toBeNull();
    expect(parse({ in: null, at: '99:00' }).ok).toBe(false);
  });
  it('keeps reminder tools synchronous, deterministic and draft-only', () => {
    const toolbox = createAssistantToolbox({
      clock: createClockSnapshot(now, timeZone),
      allowFunctions: true,
      allowReminders: true,
    });
    const call = {
      id: 'r',
      name: 'create_reminder',
      arguments: JSON.stringify({ instant: '2026-09-16T07:00:00Z', text: ' Invoice ' }),
    };
    const result = toolbox.execute(call);
    expect(toolbox.execute(call)).toBe(result);
    expect(JSON.parse(result)).toEqual({
      ok: true,
      draft: { instant: '2026-09-16T07:00:00.000Z', text: 'Invoice' },
      saved: false,
    });
    expect(JSON.parse(toolbox.execute({ ...call, arguments: '{}' })).ok).toBe(false);
    expect(
      JSON.parse(
        toolbox.execute({
          ...call,
          arguments: JSON.stringify({ instant: now.toISOString(), text: 'x' }),
        }),
      ).error,
    ).toBe('too_soon');
  });
});

describe('reminder runtime', () => {
  const setup = () => {
    const claim = {
      key: 'k',
      owner: 'o',
      nonce: 'n',
      reminder: { id: 'a123', text: 'Hi', dueAt: now, createdAt: now },
    };
    const store = {
      claimDue: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
      beginSend: vi.fn().mockResolvedValue({ guildId: 'g', channelId: 'c', userId: 'u' }),
      finishSend: vi.fn(),
    } as unknown as ReminderStore;
    const publisher = {
      ready: vi.fn(() => true),
      publish: vi.fn().mockResolvedValue({ outcome: 'sent', messageId: 'm' }),
    };
    const runtime = createReminderRuntime({
      store,
      publisher,
      logger: pino({ enabled: false }),
      now: () => now,
    });
    return { claim, store, publisher, runtime };
  };
  it('claims, fences, publishes, finishes and drains', async () => {
    const s = setup();
    await s.runtime.start();
    await s.runtime.shutdown();
    await s.runtime.tick();
    expect(s.store.finishSend).toHaveBeenCalledWith(s.claim, { outcome: 'sent', messageId: 'm' });
    expect(s.publisher.publish).toHaveBeenCalledOnce();
    expect(reminderLimits.maximumPending).toBe(20);
  });
  it('parks thrown sends as uncertain', async () => {
    const s = setup();
    s.publisher.publish.mockRejectedValue(new Error('ambiguous'));
    await s.runtime.tick();
    expect(s.store.finishSend).toHaveBeenCalledWith(s.claim, { outcome: 'uncertain' });
  });
  it('does not send when not ready or when the claim loses its fence', async () => {
    const s = setup();
    s.publisher.ready.mockReturnValue(false);
    await s.runtime.tick();
    expect(s.store.claimDue).not.toHaveBeenCalled();
    s.publisher.ready.mockReturnValue(true);
    vi.mocked(s.store.beginSend).mockResolvedValue(null);
    await s.runtime.tick();
    expect(s.publisher.publish).not.toHaveBeenCalled();
  });
});
