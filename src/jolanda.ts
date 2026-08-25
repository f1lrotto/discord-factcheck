import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  conversationReplyLimit,
  costEnvelopeMicrodollars,
  createConcurrencyGate,
  discordOperationTimeoutMs,
  streamUpdateIntervalMs,
  turnExecutionTimeoutMs,
} from './limits.js';
import { buildPromptMessages, composeUserContent } from './prompt.js';
import {
  publicResearchQuestion,
  safeError,
  sanitizeAssistantOutput,
  sanitizeStreamingAssistantOutput,
} from './security.js';
import type {
  Conversation,
  JolandaStore,
  ModelRunner,
  ResponseSink,
  TurnOutcome,
  TurnRequest,
  Usage,
} from './types.js';

const emptyUsage = (costMicrodollars: number): Usage => ({
  costMicrodollars,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
});

type ExistingConversationResult =
  | { ok: true; conversation: Conversation | null; lockToken: string | null }
  | { ok: false; outcome: TurnOutcome };

const waitForDiscordOperation = <Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  signal: AbortSignal,
  track?: (operation: Promise<unknown>) => void,
) =>
  new Promise<Value>((resolve, reject) => {
    let finished = false;
    const operationController = new AbortController();
    const operationSignal = AbortSignal.any([signal, operationController.signal]);
    const task = Promise.resolve().then(() => operation(operationSignal));
    track?.(task);
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const rejectOnce = (error: unknown) => {
      if (finish()) reject(error);
    };
    const onAbort = () => {
      operationController.abort(signal.reason);
      rejectOnce(signal.reason);
    };
    const timeout = setTimeout(() => {
      const error = new Error('Discord operation exceeded the configured timeout');
      operationController.abort(error);
      rejectOnce(error);
    }, discordOperationTimeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    task.then((value) => {
      if (finish()) resolve(value);
    }, rejectOnce);
    if (signal.aborted) onAbort();
  });

export const createJolanda = (dependencies: {
  store: JolandaStore;
  modelRunner: ModelRunner;
  logger: Logger;
  maximumContextMessages: number;
  maximumPromptCharacters: number;
  maximumConcurrentTurns: number;
  transcriptTtlMs: number;
  protectIdentifier: (identifier: string) => string;
  now?: () => Date;
  createId?: () => string;
  createLockToken?: () => string;
}) => {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const createLockToken = dependencies.createLockToken ?? randomUUID;
  const gate = createConcurrencyGate(dependencies.maximumConcurrentTurns);
  const controllers = new Set<AbortController>();
  const activeTurns = new Set<Promise<TurnOutcome>>();
  const pendingDiscordOperations = new Set<Promise<unknown>>();
  const pendingSettlements = new Map<string, () => Promise<void>>();
  let accepting = true;

  const trackDiscordOperation = (operation: Promise<unknown>) => {
    pendingDiscordOperations.add(operation);
    void operation.finally(() => pendingDiscordOperations.delete(operation)).catch(() => undefined);
  };

  const resolveConversation = async (request: TurnRequest): Promise<ExistingConversationResult> => {
    if (request.referencedMessage?.isJolanda !== true)
      return { ok: true, conversation: null, lockToken: null };

    const conversation = await dependencies.store.findConversationByMessage({
      messageId: request.referencedMessage.id,
      guildId: request.guildId,
      channelId: request.channelId,
    });
    if (!conversation)
      return { ok: false, outcome: { status: 'rejected', reason: 'expired_conversation' } };
    if (conversation.ownerKey !== dependencies.protectIdentifier(request.userId))
      return { ok: false, outcome: { status: 'rejected', reason: 'conversation_owner' } };
    if (conversation.replyCount >= conversationReplyLimit)
      return { ok: false, outcome: { status: 'rejected', reason: 'conversation_limit' } };

    const lockToken = createLockToken();
    const lockHeld = await dependencies.store.tryLockConversation(
      conversation.id,
      lockToken,
      now(),
    );
    if (!lockHeld)
      return { ok: false, outcome: { status: 'rejected', reason: 'conversation_busy' } };
    return { ok: true, conversation, lockToken };
  };

  const executeTurn = async (
    request: TurnRequest,
    sink: ResponseSink,
    signal: AbortSignal,
  ): Promise<TurnOutcome> => {
    const startedAt = Date.now();
    const question = request.question.trim();
    if (!question) return { status: 'rejected', reason: 'empty_question' };
    signal.throwIfAborted();

    const resolved = await resolveConversation(request);
    if (!resolved.ok) return resolved.outcome;
    const { conversation, lockToken } = resolved;
    const releaseGate = gate.tryAcquire();
    if (!releaseGate) {
      if (lockToken && conversation)
        await dependencies.store.releaseConversation(conversation.id, lockToken);
      return { status: 'rejected', reason: 'server_busy' };
    }

    const conversationId = conversation?.id ?? createId();
    let authorized = false;
    let settled = false;
    let modelStarted = false;
    let reservationMicrodollars = 0;
    let partialContent = '';
    let allowedSourceUrls: readonly string[] = [];
    let lastStreamUpdateAt: number | null = null;

    try {
      signal.throwIfAborted();
      const settings = await dependencies.store.getSettings(request.guildId);
      reservationMicrodollars = costEnvelopeMicrodollars({
        model: settings.model,
        reasoning: settings.reasoning,
        maximumPromptCharacters: dependencies.maximumPromptCharacters,
      });
      const authorization = await dependencies.store.authorizeTurn({
        requestId: request.id,
        guildId: request.guildId,
        channelId: request.channelId,
        userId: request.userId,
        reservationMicrodollars,
        now: now(),
      });
      if (!authorization.ok) return { status: 'rejected', reason: authorization.reason };
      authorized = true;

      const contextLimit = Math.min(settings.contextMessages, dependencies.maximumContextMessages);
      const ambientMessages =
        contextLimit === 0
          ? []
          : await waitForDiscordOperation(() => request.loadAmbientContext(contextLimit), signal);
      const excludedIds = new Set([request.id, request.referencedMessage?.id].filter(Boolean));
      const uniqueAmbientMessages = ambientMessages.filter(
        (message, index, messages) =>
          !excludedIds.has(message.id) &&
          messages.findIndex((candidate) => candidate.id === message.id) === index,
      );
      const currentUserContent = composeUserContent({
        question,
        ambientMessages: uniqueAmbientMessages,
        ...(request.referencedMessage && !request.referencedMessage.isJolanda
          ? { referencedMessage: request.referencedMessage }
          : {}),
        maximumCharacters: Math.floor(dependencies.maximumPromptCharacters * 0.6),
      });

      await waitForDiscordOperation(
        (operationSignal) => sink.prepare(operationSignal),
        signal,
        trackDiscordOperation,
      );
      modelStarted = true;
      const publicQuestion = publicResearchQuestion(question);
      const result = await dependencies.modelRunner.run(
        {
          messages: buildPromptMessages({
            conversation,
            currentUserContent,
            maximumCharacters: dependencies.maximumPromptCharacters,
          }),
          model: settings.model,
          reasoning: settings.reasoning,
          signal,
          ...(publicQuestion ? { publicQuestion } : {}),
        },
        async (delta, sourceUrls = []) => {
          partialContent += delta;
          allowedSourceUrls = sourceUrls;
          const updateAt = Date.now();
          if (lastStreamUpdateAt !== null && updateAt - lastStreamUpdateAt < streamUpdateIntervalMs)
            return;
          lastStreamUpdateAt = updateAt;
          await waitForDiscordOperation(
            (operationSignal) =>
              sink.update(
                sanitizeStreamingAssistantOutput(partialContent, allowedSourceUrls),
                allowedSourceUrls,
                operationSignal,
              ),
            signal,
            trackDiscordOperation,
          );
        },
      );

      allowedSourceUrls = result.allowedSourceUrls ?? allowedSourceUrls;
      const assistantContent = sanitizeAssistantOutput(result.content, allowedSourceUrls);
      partialContent = assistantContent;
      const usage = result.usage ?? emptyUsage(reservationMicrodollars);
      await dependencies.store.settleRequest({
        requestId: request.id,
        usage,
        status: result.usage ? 'completed' : 'usage_missing',
      });
      settled = true;
      if (!assistantContent) throw new Error('OpenRouter returned an empty response');

      const assistantMessageIds = await waitForDiscordOperation(
        (operationSignal) => sink.finish(assistantContent, allowedSourceUrls, operationSignal),
        signal,
        trackDiscordOperation,
      );
      try {
        const completedAt = now();
        await dependencies.store.appendTurn({
          conversationId,
          guildId: request.guildId,
          channelId: request.channelId,
          ownerId: request.userId,
          requestId: request.id,
          assistantMessageIds,
          turn: {
            userContent: currentUserContent,
            assistantContent,
            createdAt: completedAt,
          },
          expiresAt: new Date(completedAt.getTime() + dependencies.transcriptTtlMs),
        });
      } catch (error) {
        dependencies.logger.error({
          event: 'conversation_persistence_failed',
          error: safeError(error),
          requestKey: dependencies.protectIdentifier(request.id),
          conversationId,
        });
      }

      dependencies.logger.info({
        event: 'jolanda_turn',
        outcome: 'completed',
        requestKey: dependencies.protectIdentifier(request.id),
        conversationId,
        guildKey: dependencies.protectIdentifier(request.guildId),
        channelKey: dependencies.protectIdentifier(request.channelId),
        userKey: dependencies.protectIdentifier(request.userId),
        model: settings.model,
        reasoning: settings.reasoning,
        contextMessages: uniqueAmbientMessages.length,
        costMicrodollars: usage.costMicrodollars,
        reservedMicrodollars: reservationMicrodollars,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        webSearchRequests: usage.webSearchRequests,
        durationMs: Date.now() - startedAt,
      });
      return { status: 'completed', conversationId };
    } catch (error) {
      dependencies.logger.error({
        event: 'jolanda_turn',
        outcome: signal.aborted ? 'aborted' : 'failed',
        error: safeError(error),
        requestKey: dependencies.protectIdentifier(request.id),
        conversationId,
        guildKey: dependencies.protectIdentifier(request.guildId),
        channelKey: dependencies.protectIdentifier(request.channelId),
        userKey: dependencies.protectIdentifier(request.userId),
        durationMs: Date.now() - startedAt,
      });

      if (authorized && !settled) {
        const settleConservatively = modelStarted
          ? () =>
              dependencies.store.settleRequest({
                requestId: request.id,
                usage: emptyUsage(reservationMicrodollars),
                status: 'usage_missing',
              })
          : () => dependencies.store.failRequest(request.id, 'before_inference');
        try {
          await settleConservatively();
          pendingSettlements.delete(request.id);
        } catch (settlementError) {
          pendingSettlements.set(request.id, settleConservatively);
          dependencies.logger.error({
            event: 'turn_settlement_failed',
            error: safeError(settlementError),
            requestKey: dependencies.protectIdentifier(request.id),
          });
        }
      }

      if (!signal.aborted)
        await waitForDiscordOperation(
          (operationSignal) => sink.fail(partialContent, allowedSourceUrls, operationSignal),
          signal,
          trackDiscordOperation,
        ).catch((sinkError) =>
          dependencies.logger.error({
            event: 'discord_failure_notice_failed',
            error: safeError(sinkError),
            requestKey: dependencies.protectIdentifier(request.id),
          }),
        );
      return { status: 'failed' };
    } finally {
      releaseGate();
      if (lockToken && conversation) {
        try {
          await dependencies.store.releaseConversation(conversation.id, lockToken);
        } catch (error) {
          dependencies.logger.error({
            event: 'conversation_lock_release_failed',
            error: safeError(error),
            requestKey: dependencies.protectIdentifier(request.id),
            conversationId: conversation.id,
          });
        }
      }
    }
  };

  const handleTurn = (request: TurnRequest, sink: ResponseSink) => {
    if (!accepting)
      return Promise.resolve<TurnOutcome>({ status: 'rejected', reason: 'shutting_down' });
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(turnExecutionTimeoutMs),
    ]);
    const turn = executeTurn(request, sink, signal);
    activeTurns.add(turn);
    const removeTurn = () => {
      controllers.delete(controller);
      activeTurns.delete(turn);
    };
    void turn.then(removeTurn, removeTurn);
    return turn;
  };

  const shutdown = async () => {
    accepting = false;
    for (const controller of controllers) controller.abort(new Error('Jolanda is shutting down'));
    await Promise.allSettled([...activeTurns]);
    while (pendingDiscordOperations.size) await Promise.allSettled([...pendingDiscordOperations]);
    for (let attempt = 0; attempt < 3 && pendingSettlements.size; attempt += 1) {
      for (const [requestId, settle] of pendingSettlements) {
        try {
          await settle();
          pendingSettlements.delete(requestId);
        } catch (error) {
          dependencies.logger.error({
            event: 'shutdown_settlement_retry_failed',
            error: safeError(error),
            requestKey: dependencies.protectIdentifier(requestId),
            attempt: attempt + 1,
          });
        }
      }
    }
    if (pendingSettlements.size) throw new Error('Jolanda shutdown left unsettled requests');
  };

  return { handleTurn, shutdown };
};

export type Jolanda = ReturnType<typeof createJolanda>;
