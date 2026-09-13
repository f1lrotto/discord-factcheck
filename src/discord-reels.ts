import type { ReelDiscordTransport } from './discord-reel-transport.js';
import { createHash } from 'node:crypto';
import { ChannelType, MessageType, PermissionFlagsBits, type Message } from 'discord.js';
import type { Logger } from 'pino';
import { createConcurrencyGate, createSlidingWindowGate } from './limits.js';
import { safeMentions } from './discord-response.js';
import { parseRepostLinks } from './repost-links.js';
import { reelLimits, ytDlpVersion } from './reel-limits.js';
import {
  ReelError,
  reelFailure,
  type ReelDownloader,
  type ReelStore,
  type ReelFailure,
  type ReelClaim,
  type ReelOutcome,
  type ReelStage,
} from './reel-types.js';

export const reelChannelSupported = (type: ChannelType) =>
  [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(type);
export const reelPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
];
const canPublish = (message: Message<true>) => {
  const member = message.guild.members.me;
  return Boolean(member && message.channel.permissionsFor(member)?.has(reelPermissions));
};
const failureCopy: Record<ReelFailure, string> = {
  unavailable: 'I couldn’t access this Reel without an Instagram login.',
  authentication_required: 'I couldn’t access this Reel without an Instagram login.',
  too_large: 'Reel is too large.',
  unsupported_media: 'I couldn’t retrieve a compatible video for this Reel.',
  timeout: 'I couldn’t download this Reel right now.',
  extractor_failed: 'I couldn’t download this Reel right now.',
  rate_limited: 'I couldn’t download this Reel right now.',
  photos_unavailable: 'I couldn’t retrieve the original photos for this TikTok.',
  too_many_photos: `This TikTok has more than ${reelLimits.maximumPhotos} photos, which is my limit per post.`,
  cancelled: '',
};
const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${bytes.toLocaleString('en-US')} bytes`
    : `${+(bytes / 1024 / 1024).toFixed(2)} MiB`;
const tooLargeCopy = (maximumBytes: number, size?: ReelError['size'], discordRejected = false) => {
  const measurement = size
    ? `${size.atLeast ? 'at least ' : ''}${formatBytes(size.bytes)}`
    : 'size unknown';
  const limit = size?.downloadLimit ?? maximumBytes;
  const label = size?.downloadLimit ? 'download limit' : discordRejected ? 'app limit' : 'limit';
  return `Reel is too large${discordRejected ? ' for Discord' : ''}: ${measurement} (${label}: ${formatBytes(limit)}).`;
};
const discordCode = (error: unknown) => {
  if (typeof error !== 'object' || !error) return undefined;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'number' ? code : undefined;
};
export const createDiscordReels = (input: {
  enabled: boolean;
  store: ReelStore;
  downloader: ReelDownloader;
  logger: Logger;
  protectIdentifier: (identifier: string) => string;
  maximumBytes?: number;
  jobMs?: number;
  transport?: ReelDiscordTransport;
}) => {
  const maximumBytes = input.maximumBytes ?? reelLimits.maximumBytes;
  const transport: ReelDiscordTransport = input.transport ?? {
    fetchContent: async (message) =>
      (await message.channel.messages.fetch({ message: message.id, force: true })).content,
    reply: (message, options) => message.reply(options),
  };
  const admission = createConcurrencyGate(2);
  const slot = createConcurrencyGate(1);
  const members = createSlidingWindowGate(2);
  const guilds = createSlidingWindowGate(10);
  const abort = new AbortController();
  const tasks = new Set<Promise<void>>();
  let accepting = true;
  const process = async (
    message: Message<true>,
    reel: NonNullable<ReturnType<typeof parseRepostLinks>[0]>,
  ) => {
    const label = reel.platform === 'tiktok' ? 'TikTok' : 'Instagram Reel';
    const copy = (text: string) =>
      reel.platform === 'tiktok'
        ? text.replaceAll('Reel', 'TikTok').replaceAll('an Instagram', 'a TikTok')
        : text;
    const scope = { guildId: message.guildId, channelId: message.channelId };
    if (!(await input.store.getEnabled(scope)) || abort.signal.aborted) return;
    if (!canPublish(message)) {
      input.logger.info({
        event: 'reel_admission_failed',
        platform: reel.platform,
        outcome: 'permission_denied',
        channelKey: input.protectIdentifier(message.channelId),
      });
      return;
    }
    const release = slot.tryAcquire();
    if (!release) return; // No queue or notification storm when busy.
    const started = Date.now();
    const jobSignal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(input.jobMs ?? reelLimits.jobMs),
    ]);
    let claim: ReelClaim | null = null;
    let publishing = false;
    let outcome: ReelOutcome = 'cancelled';
    let stage: ReelStage = 'admission';
    let bytes: number | undefined;
    let status: number | undefined;
    let sentMessages = 0;
    const source = async (allowExpired = false) => {
      if (abort.signal.aborted) return null;
      const content = await transport.fetchContent(message).catch(() => null);
      if (
        abort.signal.aborted ||
        content === null ||
        !(await input.store.getEnabled(scope)) ||
        !canPublish(message) ||
        !parseRepostLinks(content).some((link) => link.shortcode === reel.shortcode)
      )
        return null;
      if (!allowExpired && jobSignal.aborted) throw new ReelError('timeout');
      return message;
    };
    const publish = async (
      options: { content: string; files?: { attachment: string; name: string }[] },
      success: ReelOutcome,
    ) => {
      const current = await source(!options.files);
      if (!current || !claim) {
        outcome = 'source_unavailable';
        return;
      }
      if (!(await input.store.transition(claim, 'processing', 'publishing'))) {
        outcome = 'claim_lost';
        return;
      }
      publishing = true;
      if (abort.signal.aborted || !canPublish(message)) {
        outcome = 'cancelled';
        await input.store.transition(claim, 'publishing', 'failed', outcome);
        return;
      }
      stage = 'upload';
      if (options.files && jobSignal.aborted) {
        options = { content: copy(failureCopy.timeout) };
        success = 'timeout';
      }
      const replyOptions = {
        ...options,
        allowedMentions: safeMentions,
        failIfNotExists: true,
        nonce: createHash('sha256')
          .update(`instagram-reel:${claim.key}`)
          .digest('hex')
          .slice(0, 25),
        enforceNonce: true,
      };
      let delivered: { id: string } | undefined;
      const batches = options.files
        ? Array.from(
            { length: Math.ceil(options.files.length / reelLimits.photosPerMessage) },
            (_, index) =>
              options.files!.slice(
                index * reelLimits.photosPerMessage,
                (index + 1) * reelLimits.photosPerMessage,
              ),
          )
        : [undefined];
      try {
        for (const [index, files] of batches.entries()) {
          if (index > 0 && !(await source())) {
            outcome = 'source_unavailable';
            await input.store.transition(claim, 'publishing', 'failed', outcome);
            return;
          }
          const batchOptions = {
            ...replyOptions,
            ...(files ? { files } : {}),
            ...(batches.length > 1
              ? {
                  content: `${options.content} · Photos ${index * reelLimits.photosPerMessage + 1}–${index * reelLimits.photosPerMessage + files!.length} of ${options.files!.length}`,
                  nonce: createHash('sha256')
                    .update(`${replyOptions.nonce}:part:${index}`)
                    .digest('hex')
                    .slice(0, 25),
                }
              : {}),
          };
          try {
            delivered = await transport.reply(current, batchOptions);
            sentMessages++;
          } catch (error) {
            // Only a definite first-send size rejection can become a text outcome.
            if (sentMessages || discordCode(error) !== 40005 || !options.files || !(await source()))
              throw error;
            delivered = await transport.reply(current, {
              ...batchOptions,
              files: [],
              content: copy(
                tooLargeCopy(maximumBytes, bytes === undefined ? undefined : { bytes }, true),
              ),
            });
            sentMessages++;
            success = 'too_large';
            break;
          }
        }
      } catch (error) {
        status = discordCode(error);
        outcome =
          status === 40005
            ? 'too_large'
            : status === 50013 || status === 50001
              ? 'permission_denied'
              : status === 10008
                ? 'source_unavailable'
                : 'uncertain';
        await input.store.transition(
          claim,
          'publishing',
          outcome === 'uncertain' ? 'uncertain' : 'failed',
          outcome,
        );
        return;
      }
      outcome = success;
      // Never treat a failed receipt update as a failed send; leave publishing intact.
      await input.store.transition(claim, 'publishing', 'sent', outcome, delivered?.id);
    };
    try {
      if (
        !members.tryAcquire(input.protectIdentifier(`${message.guildId}:${message.author.id}`)) ||
        !guilds.tryAcquire(input.protectIdentifier(message.guildId))
      )
        return;
      claim = await input.store.claim({
        ...scope,
        messageId: message.id,
        shortcode: reel.shortcode,
      });
      if (!claim) return;
      stage = 'download';
      await input.downloader.withDownloadedReel(
        {
          reel,
          signal: jobSignal,
          maximumBytes,
          onStage: (next) => {
            stage = next;
          },
        },
        async (media) => {
          bytes = media.bytes;
          stage = 'source_check';
          await publish(
            {
              content: `${label} · <${media.url}>`,
              files:
                media.kind === 'photos'
                  ? media.files.map(({ path, name }) => ({ attachment: path, name }))
                  : [
                      {
                        attachment: media.path,
                        name: reel.platform === 'tiktok' ? 'tiktok.mp4' : 'instagram-reel.mp4',
                      },
                    ],
            },
            'sent',
          );
        },
      );
    } catch (error) {
      if (!publishing && claim) {
        outcome = abort.signal.aborted
          ? 'cancelled'
          : jobSignal.aborted
            ? 'timeout'
            : reelFailure(error);
        if (outcome !== 'cancelled') {
          try {
            const content =
              outcome === 'too_large'
                ? tooLargeCopy(maximumBytes, error instanceof ReelError ? error.size : undefined)
                : failureCopy[outcome as ReelFailure];
            await publish({ content: copy(content) }, outcome);
          } catch {
            outcome = 'store_unavailable';
          }
        }
      } else if (publishing) outcome = 'uncertain';
    } finally {
      if (claim) {
        if (!publishing)
          await input.store
            .transition(claim, 'processing', 'failed', outcome)
            .catch(() => undefined);
        input.logger.info({
          event: 'reel',
          platform: reel.platform,
          guildKey: input.protectIdentifier(message.guildId),
          channelKey: input.protectIdentifier(message.channelId),
          messageKey: input.protectIdentifier(message.id),
          outcome,
          stage,
          downloaderVersion: ytDlpVersion,
          sentMessages,
          bytes,
          discordCode: status,
          elapsedMs: Date.now() - started,
        });
      }
      release();
    }
  };
  const offer = (message: Message) => {
    if (
      !accepting ||
      !input.enabled ||
      !message.inGuild() ||
      message.author.bot ||
      message.webhookId ||
      ![MessageType.Default, MessageType.Reply].includes(message.type) ||
      !reelChannelSupported(message.channel.type)
    )
      return;
    const reel = parseRepostLinks(message.content)[0];
    if (!reel) return;
    const release = admission.tryAcquire();
    if (!release) return;
    const task = process(message, reel)
      .catch(() => {
        input.logger.info({
          event: 'reel_admission_failed',
          platform: reel.platform,
          outcome: 'store_unavailable',
        });
      })
      .finally(() => {
        release();
        tasks.delete(task);
      });
    tasks.add(task);
  };
  const shutdown = async () => {
    accepting = false;
    abort.abort();
    await Promise.allSettled([...tasks]);
    transport.close?.();
  };
  return { offer, shutdown };
};
