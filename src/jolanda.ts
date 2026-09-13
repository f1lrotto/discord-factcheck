import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { createClockSnapshot } from './clock.js';
import { sourceCitationMarkdown, uniqueSourceCitations, type SourceCitation } from './citations.js';
import { clampDiscordMarkdown } from './discord-text.js';
import {
  conversationReplyLimit,
  costEnvelopeMicrodollars,
  createConcurrencyGate,
  discordOperationTimeoutMs,
  maximumResponseCharacters,
  maximumReasoningSummaryCharacters,
  progressHeartbeatIntervalMs,
  providerQuietThresholdMs,
  streamUpdateIntervalMs,
} from './limits.js';
import { modelFailureDiagnostic } from './model-failure.js';
import { formatUsd } from './money.js';
import { buildPromptMessages, composeUserContent } from './prompt.js';
import {
  safeError,
  sanitizeAssistantOutput,
  sanitizeStreamingAssistantOutput,
} from './security.js';
import { getModel, type GuildSettings } from './models.js';
import type {
  Conversation,
  JolandaStore,
  ModelRunner,
  ModelProgress,
  ModelRunResult,
  ResponseSink,
  TurnOutcome,
  TurnRequest,
  Usage,
} from './types.js';

const truncationNotice = '⚠️ *The model hit its output limit, so this answer is cut short.*';

const progressStageMessages = {
  answering: '🧠 Working through the question…',
  finalizing: '📦 Finalizing the response…',
} as const;

const waitingStageMessages = {
  answering: '🧠 Waiting for OpenRouter…',
  finalizing: '📦 Finalizing the response…',
} as const;

type ProgressStage = keyof typeof progressStageMessages;
type SourceBasis = 'local' | 'model_only' | 'web_sources' | 'web_without_sources' | 'unreported';
type TurnPlan =
  | { route: 'local'; reason: 'greeting' | 'thanks'; content: string }
  | { route: 'assistant'; reason: 'model_decides' };

const normalizedSocialPrompt = (question: string) =>
  question
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[!?.…]+$/gu, '')
    .trim();

const englishGreetings = new Set([
  'hi',
  'hello',
  'hey',
  'good morning',
  'good afternoon',
  'good evening',
]);
const slovakGreetings = new Set(['ahoj', 'čau', 'čauko', 'zdravím', 'dobrý deň', 'dobré ráno']);
const englishThanks = new Set(['thanks', 'thank you', 'thx']);
const slovakThanks = new Set(['ďakujem', 'díky', 'dík', 'vďaka']);

const planTurn = (question: string): TurnPlan => {
  const normalized = normalizedSocialPrompt(question);
  if (englishGreetings.has(normalized))
    return { route: 'local', reason: 'greeting', content: 'Hi! How can I help?' };
  if (slovakGreetings.has(normalized))
    return { route: 'local', reason: 'greeting', content: 'Ahoj! Ako môžem pomôcť?' };
  if (englishThanks.has(normalized))
    return { route: 'local', reason: 'thanks', content: "You're welcome!" };
  if (slovakThanks.has(normalized))
    return { route: 'local', reason: 'thanks', content: 'Rado sa stalo!' };
  return { route: 'assistant', reason: 'model_decides' };
};

const progressDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return [Math.floor(seconds / 60), seconds % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
};

const failureReference = (protectedRequestId: string) =>
  protectedRequestId
    .replace(/[^A-Za-z0-9_-]/gu, '')
    .slice(0, 10)
    .toLocaleUpperCase('en-US') || 'UNKNOWN';

const emptyUsage = (costMicrodollars: number): Usage => ({
  costMicrodollars,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
});

const sourceBasis = (
  route: TurnPlan['route'],
  result: ModelRunResult,
  sourceUrls: readonly string[],
): SourceBasis => {
  if (route === 'local') return 'local';
  if (sourceUrls.length) return 'web_sources';
  if (!result.usage) return 'unreported';
  return result.usage.webSearchRequests > 0 ? 'web_without_sources' : 'model_only';
};

const responseFooter = (
  basis: SourceBasis,
  sourceCitations: readonly SourceCitation[],
  usage: Usage,
  usageReported: boolean,
) => {
  if (basis === 'local') return '';
  const sourceLines = (() => {
    if (basis === 'model_only') return ['🧠 **Source basis:** No public web research was used.'];
    if (basis === 'web_without_sources')
      return [
        '🌐 **Source basis:** Public web research was used, but OpenRouter returned no usable source links.',
      ];
    if (basis === 'unreported')
      return [
        '⚠️ **Source basis:** OpenRouter did not report whether public web research was used.',
      ];

    const maximumSourceListCharacters = 3_000;
    const links = sourceCitations.reduce<string[]>((lines, citation, index) => {
      const line = `- ${sourceCitationMarkdown(citation, index + 1)}`;
      return [...lines, line].join('\n').length <= maximumSourceListCharacters
        ? [...lines, line]
        : lines;
    }, []);
    const omitted = sourceCitations.length - links.length;
    return [
      '🌐 **Source basis:** Public web research was used.',
      ...links,
      ...(omitted
        ? [`- ${omitted} additional source link${omitted === 1 ? '' : 's'} omitted`]
        : []),
    ];
  })();
  const unreported = usageReported
    ? ''
    : ' (conservative charge because provider usage was not reported)';
  return [
    ...sourceLines,
    `💵 **Response cost:** ${formatUsd(usage.costMicrodollars)}${unreported}`,
  ].join('\n');
};

const answerWithFooter = (
  content: string,
  basis: SourceBasis,
  sourceCitations: readonly SourceCitation[],
  usage: Usage,
  usageReported: boolean,
) => {
  const footer = responseFooter(basis, sourceCitations, usage, usageReported);
  if (!footer) return content;
  const suffix = `\n\n---\n${footer}`;
  if (content.length + suffix.length <= maximumResponseCharacters) return `${content}${suffix}`;
  const truncation = '\n\n[…answer shortened to include response details]';
  const retained = Math.max(0, maximumResponseCharacters - suffix.length - truncation.length);
  return `${content.slice(0, retained).trimEnd()}${truncation}${suffix}`;
};

type ExistingConversationResult =
  | { ok: true; conversation: Conversation | null; lockToken: string | null }
  | { ok: false; outcome: TurnOutcome };

const resolveContextLimit = (request: TurnRequest, guildLimit: number, deploymentLimit: number) => {
  const allowed = Math.max(0, Math.min(guildLimit, deploymentLimit));
  const requested = request.ambientContext?.limit;
  if (requested === undefined) return { ok: true as const, limit: 0 };
  if (requested === 'maximum') return { ok: true as const, limit: allowed };
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > allowed)
    return { ok: false as const };
  return { ok: true as const, limit: requested };
};

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
  timeZone: string;
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
    let reasoningSummary = '';
    let lastStreamUpdateAt: number | null = null;
    let modelContext:
      (Pick<GuildSettings, 'model' | 'reasoning'> & { zdrEnforced: boolean }) | undefined;
    let requestedContextMessages = 0;
    let contextMessages = 0;
    let turnPlan: TurnPlan | undefined;
    let stopActiveProgress: () => void = () => undefined;
    let markActiveProgressFinalizing: () => void = () => undefined;

    try {
      signal.throwIfAborted();
      const clock = createClockSnapshot(now(), dependencies.timeZone);
      const settings = await dependencies.store.getSettings(request.guildId);
      modelContext = {
        model: settings.model,
        reasoning: settings.reasoning,
        zdrEnforced: getModel(settings.model).supportsZdr,
      };
      const context = resolveContextLimit(
        request,
        settings.contextLimitMessages,
        dependencies.maximumContextMessages,
      );
      if (!context.ok) return { status: 'rejected', reason: 'context_limit' };
      requestedContextMessages = context.limit;
      const selectedPlan = planTurn(question);
      turnPlan = selectedPlan;
      reservationMicrodollars =
        selectedPlan.route === 'local'
          ? 0
          : costEnvelopeMicrodollars({
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

      const ambientMessages =
        selectedPlan.route === 'local' || requestedContextMessages === 0
          ? []
          : await waitForDiscordOperation(
              () => request.loadAmbientContext(requestedContextMessages),
              signal,
            );
      const excludedIds = new Set([request.id, request.referencedMessage?.id].filter(Boolean));
      const uniqueAmbientMessages = ambientMessages.filter(
        (message, index, messages) =>
          !excludedIds.has(message.id) &&
          messages.findIndex((candidate) => candidate.id === message.id) === index,
      );
      contextMessages = uniqueAmbientMessages.length;
      const referencedMessage =
        selectedPlan.route !== 'local' &&
        request.referencedMessage &&
        !request.referencedMessage.isJolanda
          ? request.referencedMessage
          : undefined;
      const currentUserContent = composeUserContent({
        question,
        ambientMessages: uniqueAmbientMessages,
        ...(referencedMessage ? { referencedMessage } : {}),
        maximumCharacters: Math.floor(dependencies.maximumPromptCharacters * 0.6),
      });

      await waitForDiscordOperation(
        (operationSignal) => sink.prepare(operationSignal),
        signal,
        trackDiscordOperation,
      );
      modelStarted = true;
      const runModel = async (): Promise<ModelRunResult> => {
        if (selectedPlan.route === 'local')
          return { content: selectedPlan.content, usage: emptyUsage(0) };

        const progressStartedAt = Date.now();
        let progressStage: ProgressStage = 'answering';
        let lastProviderActivityAt: number | null = null;
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
        let heartbeatUpdatePending = false;

        const stopProgressHeartbeat = () => {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        };
        stopActiveProgress = stopProgressHeartbeat;
        markActiveProgressFinalizing = () => {
          progressStage = 'finalizing';
          lastProviderActivityAt = Date.now();
          reasoningSummary = '';
        };
        const renderProgress = async () => {
          if (signal.aborted) return;
          const updateAt = Date.now();
          const quietForMs = updateAt - (lastProviderActivityAt ?? progressStartedAt);
          const providerIsQuiet =
            progressStage !== 'finalizing' && quietForMs >= providerQuietThresholdMs;
          const elapsed = progressDuration(updateAt - progressStartedAt);
          const sanitizedSummary = sanitizeAssistantOutput(reasoningSummary);
          const sanitizedPartial = sanitizeStreamingAssistantOutput(
            partialContent,
            allowedSourceUrls,
          );
          const quietSuffix = providerIsQuiet
            ? ` · no activity for ${progressDuration(quietForMs)}`
            : '';
          const stageMessage = providerIsQuiet
            ? waitingStageMessages[progressStage]
            : progressStageMessages[progressStage];
          const content = sanitizedPartial
            ? `${sanitizedPartial}\n\n${stageMessage} · ${elapsed}${quietSuffix}`
            : sanitizedSummary
              ? `🧠 **Current approach**\n${sanitizedSummary}\n\n⏱ ${elapsed}${
                  providerIsQuiet ? ' · waiting for OpenRouter' : ''
                }${quietSuffix}`
              : `${stageMessage} · ${elapsed}${quietSuffix}`;
          await waitForDiscordOperation(
            (operationSignal) =>
              sink.update(content, sanitizedPartial ? allowedSourceUrls : [], operationSignal),
            signal,
            trackDiscordOperation,
          );
        };
        const heartbeat = () => {
          if (heartbeatUpdatePending || signal.aborted) return;
          heartbeatUpdatePending = true;
          const operation = renderProgress()
            .catch((error: unknown) => {
              if (signal.aborted) return;
              dependencies.logger.info({
                event: 'discord_progress_heartbeat_failed',
                error: safeError(error),
                requestKey: dependencies.protectIdentifier(request.id),
              });
            })
            .finally(() => {
              heartbeatUpdatePending = false;
            });
          trackDiscordOperation(operation);
        };
        heartbeatTimer = setInterval(heartbeat, progressHeartbeatIntervalMs);

        return dependencies.modelRunner.run(
          {
            messages: buildPromptMessages({
              conversation,
              currentUserContent,
              maximumCharacters: dependencies.maximumPromptCharacters,
              clock,
            }),
            model: settings.model,
            reasoning: settings.reasoning,
            clock,
            signal,
          },
          async (delta, sourceUrls = []) => {
            partialContent += delta;
            allowedSourceUrls = sourceUrls;
            lastProviderActivityAt = Date.now();
            const updateAt = Date.now();
            if (
              lastStreamUpdateAt !== null &&
              updateAt - lastStreamUpdateAt < streamUpdateIntervalMs
            )
              return;
            lastStreamUpdateAt = updateAt;
            await renderProgress();
          },
          async (progress: ModelProgress) => {
            if (progress.type === 'activity') {
              lastProviderActivityAt = Date.now();
              return;
            }
            if (partialContent) return;
            if (progress.type === 'stage') {
              progressStage = progress.stage;
              reasoningSummary = '';
            } else {
              lastProviderActivityAt = Date.now();
              reasoningSummary = `${reasoningSummary}${progress.delta}`.slice(
                -maximumReasoningSummaryCharacters,
              );
            }
            await renderProgress();
          },
        );
      };
      const result = await runModel();
      markActiveProgressFinalizing();

      allowedSourceUrls = result.allowedSourceUrls ?? allowedSourceUrls;
      const sourceCitations = uniqueSourceCitations(
        result.sourceCitations ?? [],
        allowedSourceUrls,
      );
      const sanitizedAnswer = sanitizeAssistantOutput(
        clampDiscordMarkdown(result.content),
        allowedSourceUrls,
      );
      // A `finish_reason: "length"` answer used to be presented as if it were complete, footer
      // and cost line included. Say so instead of implying the thought was finished.
      const assistantContent =
        result.truncated && sanitizedAnswer
          ? `${sanitizedAnswer}\n\n${truncationNotice}`
          : sanitizedAnswer;
      partialContent = assistantContent;
      const basis = sourceBasis(selectedPlan.route, result, allowedSourceUrls);
      const usage = result.usage ?? emptyUsage(reservationMicrodollars);
      const displayedContent = answerWithFooter(
        assistantContent,
        basis,
        sourceCitations,
        usage,
        Boolean(result.usage),
      );
      await dependencies.store.settleRequest({
        requestId: request.id,
        usage,
        status: result.usage ? 'completed' : 'usage_missing',
      });
      settled = true;
      if (!assistantContent) throw new Error('OpenRouter returned an empty response');

      stopActiveProgress();
      const assistantMessageIds = await waitForDiscordOperation(
        (operationSignal) => sink.finish(displayedContent, allowedSourceUrls, operationSignal),
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
        zdrEnforced: getModel(settings.model).supportsZdr,
        inferenceRoute: selectedPlan.route,
        inferenceReason: selectedPlan.reason,
        requestedContextMessages,
        contextMessages,
        costMicrodollars: usage.costMicrodollars,
        reservedMicrodollars: reservationMicrodollars,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        webSearchRequests: usage.webSearchRequests,
        ...(result.toolActivity ? { toolActivity: result.toolActivity } : {}),
        sourceBasis: basis,
        sourceCount: allowedSourceUrls.length,
        sourceCitationAnnotations: result.sourceCitations?.length ?? 0,
        responseCharacters: assistantContent.length,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.generationId ? { answerGenerationId: result.generationId } : {}),
        ...(result.diagnostics ? { modelDiagnostics: result.diagnostics } : {}),
        durationMs: Date.now() - startedAt,
      });
      return { status: 'completed', conversationId };
    } catch (error) {
      stopActiveProgress();
      const providerFailure = modelFailureDiagnostic(error);
      const reference = failureReference(dependencies.protectIdentifier(request.id));
      dependencies.logger.error({
        event: 'jolanda_turn',
        outcome: signal.aborted ? 'aborted' : 'failed',
        error: safeError(error),
        requestKey: dependencies.protectIdentifier(request.id),
        conversationId,
        guildKey: dependencies.protectIdentifier(request.guildId),
        channelKey: dependencies.protectIdentifier(request.channelId),
        userKey: dependencies.protectIdentifier(request.userId),
        ...modelContext,
        ...(turnPlan ? { inferenceRoute: turnPlan.route, inferenceReason: turnPlan.reason } : {}),
        requestedContextMessages,
        contextMessages,
        reservedMicrodollars: reservationMicrodollars,
        failureReference: reference,
        ...(providerFailure ? { providerFailure } : {}),
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
          (operationSignal) =>
            sink.fail(
              partialContent,
              allowedSourceUrls,
              {
                category: providerFailure?.category ?? 'unknown',
                ...(providerFailure ? { stage: providerFailure.stage } : {}),
                ...(providerFailure?.malformedReason
                  ? { malformedReason: providerFailure.malformedReason }
                  : {}),
                reference,
              },
              operationSignal,
            ),
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
      stopActiveProgress();
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
    const signal = controller.signal;
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
