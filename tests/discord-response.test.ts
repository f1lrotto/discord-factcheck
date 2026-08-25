import { type Message } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createResponseSink } from '../src/discord-response.js';

describe('Discord response renderer', () => {
  it('serializes renders and stops a cancelled render after its in-flight REST call settles', async () => {
    let releaseEdit: (() => void) | undefined;
    const edit = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Promise<void>((resolve) => {
            releaseEdit = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const responseMessage = { id: 'response', edit, delete: vi.fn() };
    const source = {
      id: 'source',
      reply: vi.fn(async () => responseMessage),
      channel: { isSendable: () => true, send: vi.fn() },
    } as unknown as Message<true>;
    const sink = createResponseSink({
      source,
      logger: pino({ enabled: false }),
      protectIdentifier: (value) => value,
    });
    await sink.prepare();
    const controller = new AbortController();
    const rendering = sink.finish('first answer', [], controller.signal);
    await vi.waitFor(() => expect(edit).toHaveBeenCalledOnce());
    controller.abort(new Error('cancel render'));
    const failure = sink.fail('partial');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(edit).toHaveBeenCalledOnce();
    releaseEdit?.();
    await expect(rendering).rejects.toThrow('cancel render');
    await failure;
    expect(edit).toHaveBeenCalledTimes(2);
    expect(String(edit.mock.calls[1]?.[0].content)).toContain('could not finish');
  });
});
