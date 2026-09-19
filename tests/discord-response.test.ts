import { type Message } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createResponseSink } from '../src/discord-response.js';

describe('Discord response renderer', () => {
  it.each([
    `Why **bold**?\n${'word '.repeat(790)}`,
    `X${'\n'.repeat(3998)}X`,
    '`https://example.com/path?token=secret`',
  ])(
    'keeps a long quoted question visible without consuming the answer budget',
    async (question) => {
      const chunks = new Map<string, string>();
      const message = (content: string) => {
        const id = `message-${chunks.size}`;
        chunks.set(id, content);
        return {
          id,
          edit: async (payload: { content: string }) => {
            chunks.set(id, payload.content);
          },
          delete: async () => {
            chunks.delete(id);
          },
        };
      };
      const source = {
        id: 'ask',
        reply: async (payload: { content: string }) => message(payload.content),
        channel: {
          isSendable: () => true,
          send: async (payload: { content: string }) => message(payload.content),
        },
      } as unknown as Message<true>;
      const sink = createResponseSink({
        source,
        logger: pino({ enabled: false }),
        protectIdentifier: (value) => value,
        locale: 'en',
        question,
      });
      const profile = question.startsWith('Why')
        ? null
        : { model: 'luna' as const, reasoning: 'medium' as const };
      await sink.prepare(undefined, profile);
      await sink.update('Working on it…');
      await sink.finish('The complete answer. '.repeat(450));
      const rendered = [...chunks.values()].join('\n');
      expect(rendered.match(/\*\*Question:\*\*/gu)).toHaveLength(1);
      expect(rendered).toContain(
        `**Model:** ${profile ? 'GPT-5.6 Luna · medium' : 'Local reply, no AI model'}`,
      );
      if (question.startsWith('Why')) {
        expect(rendered).toContain('> Why \\*\\*bold\\*\\*?');
        expect(rendered.match(/word/gu)).toHaveLength(790);
      } else if (question.startsWith('X')) expect(rendered.match(/> X/gu)).toHaveLength(2);
      else expect(rendered).not.toContain('https://example.com/path?token=secret');
      expect(rendered.match(/The complete answer\./gu)).toHaveLength(450);
      expect([...chunks.values()].every((chunk) => chunk.length <= 1900)).toBe(true);
      await sink.fail('Partial answer.');
      expect([...chunks.values()].join('\n')).toContain('**Question:**');
      expect([...chunks.values()].join('\n')).toContain('could not finish');
      expect([...chunks.values()].join('\n')).toContain('**Model:**');
    },
  );

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
      locale: 'en',
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
      locale: 'en',
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
      locale: 'en',
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

  it('names an empty answer without claiming that the provider filtered it', async () => {
    const edit = vi.fn(async () => undefined);
    const source = {
      id: 'source',
      reply: vi.fn(async () => ({ id: 'response', edit, delete: vi.fn() })),
      channel: { isSendable: () => true, send: vi.fn() },
    } as unknown as Message<true>;
    const sink = createResponseSink({
      source,
      logger: pino({ enabled: false }),
      protectIdentifier: (value) => value,
      locale: 'en',
    });
    await sink.fail('', [], {
      category: 'malformed_response',
      malformedReason: 'empty_answer',
      reference: 'EMPTY<script>',
    });
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          '⚠️ The model returned no answer text. Try a different model with `/model`, or ask again. Reference: `EMPTYscript`.',
      }),
    );
  });

  it('describes an upstream failure without claiming that no provider was available', async () => {
    const edit = vi.fn(async () => undefined);
    const source = {
      id: 'source',
      reply: vi.fn(async () => ({ id: 'response', edit, delete: vi.fn() })),
      channel: { isSendable: () => true, send: vi.fn() },
    } as unknown as Message<true>;
    const sink = createResponseSink({
      source,
      logger: pino({ enabled: false }),
      protectIdentifier: (value) => value,
      locale: 'en',
    });

    await sink.fail('', [], { category: 'provider_failure', reference: 'REF502' });

    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          '⚠️ The model provider failed during answer generation. Please try again. Reference: `REF502`.',
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
      locale: 'en',
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
