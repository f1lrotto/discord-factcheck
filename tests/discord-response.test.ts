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

  it('keeps a published chunk boundary fixed while the response keeps streaming', async () => {
    const edits: string[] = [];
    const sent: string[] = [];
    const responseMessage = {
      id: 'response',
      edit: vi.fn(async (payload: { content: string }) => {
        edits.push(payload.content);
      }),
      delete: vi.fn(),
    };
    const source = {
      id: 'source',
      reply: vi.fn(async () => responseMessage),
      channel: {
        isSendable: () => true,
        send: vi.fn(async (payload: { content: string }) => {
          const index = sent.push(payload.content) - 1;
          return {
            id: `sent-${index}`,
            edit: vi.fn(async (next: { content: string }) => {
              sent[index] = next.content;
            }),
            delete: vi.fn(),
          };
        }),
      },
    } as unknown as Message<true>;
    const sink = createResponseSink({
      source,
      logger: pino({ enabled: false }),
      protectIdentifier: (value) => value,
    });

    const body = 'Veta o tuneli. '.repeat(150).trim();
    await sink.finish(body);
    const firstChunk = edits.at(-1);
    await sink.finish(`${body} A ešte jedna veta navyše na koniec.`);

    expect(firstChunk).toBeTruthy();
    expect(edits.at(-1)).toBe(firstChunk);
    expect(sent.at(-1)).toContain('A ešte jedna veta navyše na koniec.');
  });

  it('names an exhausted reasoning budget in the failure notice', async () => {
    const edit = vi.fn(async () => undefined);
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

    await sink.fail('', [], {
      category: 'malformed_response',
      malformedReason: 'reasoning_budget_exhausted',
      reference: 'REF123',
    });

    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('entire token budget on reasoning') as unknown as string,
      }),
    );
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('REF123') as unknown as string,
      }),
    );
  });

  it('renders a safe provider reason and correlation reference without raw metadata', async () => {
    const edit = vi.fn(async () => undefined);
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

    await sink.fail('', [], {
      category: 'timeout',
      stage: 'answer',
      reference: 'ABC123<script>',
    });

    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '⚠️ Answer generation timed out. Please try again. Reference: `ABC123script`.',
      }),
    );
  });
});
