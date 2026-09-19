import type { NewsFeed, NewsSourceResult } from '../news/types.js';
import { plural, type Locale } from './plural.js';
import type { Messages } from './sk.js';

const locale: Locale = 'en';

const feedLabel = {
  continuous: 'Continuous · Denník N',
  daily: 'Daily · Aktuality.sk',
} satisfies Record<NewsFeed, string>;

const feedName = { continuous: 'continuous', daily: 'daily' } satisfies Record<NewsFeed, string>;

const outcomeLabel = {
  stories: 'Stories collected',
  edition: 'Editorial edition collected',
  unchanged: 'Source unchanged',
  empty: 'No items or edition found',
  stale: 'No fresh edition found',
  malformed: 'Source parser failed',
  'access-denied': 'Publisher denied access',
  'rate-limited': 'Publisher rate limit',
  unavailable: 'Publisher unavailable',
  timeout: 'Source request timed out',
  cancelled: 'Collection cancelled',
} satisfies Record<NonNullable<NewsSourceResult['outcome']>, string>;

const notCollectedYet = 'Not collected yet';
const usageHeading = (windowDays: number) => `📊 Jolanda usage — last ${windowDays} days`;
const onOff = (value: boolean) => (value ? 'enabled' : 'disabled');
const messages = (count: number) =>
  plural(locale, count, { one: '{count} message', other: '{count} messages' });
const days = (count: number) =>
  plural(locale, count, { one: '{count} day', other: '{count} days' });

export const en = {
  releases: {
    disabled: 'Release notes are off. Use `/jolanda releases set channel:#updates` to enable them.',
    invalidChannel:
      'Choose a text or announcement channel in this server where Jolanda can view the channel and send messages.',
    configured: (channelId: string, failed: boolean) =>
      `Release notes will go to <#${channelId}>. This setting is saved for this server. ${failed ? 'The current announcement could not be confirmed; check Jolanda’s channel permissions.' : 'Each release is announced only once per server.'}`,
    status: (channelId: string) =>
      `Release notes are enabled in <#${channelId}>. Each new release is announced once, in the server’s language.`,
  },
  locale,
  languageName: 'English',

  common: {
    enabled: 'enabled',
    disabled: 'disabled',
    available: 'available',
    unavailable: 'unavailable',
    none: 'none',
    never: 'never',
    yes: 'yes',
    no: 'no',
    saveFailed: 'I could not save that setting. Please try again.',
    temporarilyUnavailable: 'Jolanda is temporarily unavailable. Please try again.',
  },

  commands: {
    needsManageServer: 'You need the Manage Server permission to change Jolanda.',
    unknownGroup: 'Unknown Jolanda command group.',
    unknownCommand: 'Unknown Jolanda command.',
    contextSyntax: 'Use `+context` or `+context=N` at the beginning of your question.',

    privacy: (facts) =>
      [
        '**Jolanda privacy**',
        'News copies public publisher content into channels configured by server administrators. News uses no AI or model calls. News routing identifiers are encrypted separately; disabling a feed removes its routing, while copies already posted remain in Discord until removed with Discord moderation.',
        'Automatic reposting sends public post IDs to Instagram/Meta or TikTok anonymously. Media is downloaded temporarily and copied to Discord without AI analysis. Copies follow Discord retention; source deletion does not remove them. Admins can moderate copies.',
        'Your question, explicit replies, and conversation turns are processed by OpenRouter and a selected model provider.',
        'Use /jolanda ask to choose a model for one answer from a dropdown. The server default stays unchanged. Zero Data Retention follows the chosen model; profiles marked [no ZDR] may retain prompts.',
        facts.supportsZdr
          ? `Zero Data Retention is **enforced** for ${facts.modelLabel}.`
          : `Zero Data Retention is **not available** for ${facts.modelLabel}; its provider may retain prompts under its policy.`,
        'Ambient channel context defaults to **disabled for every interaction**.',
        facts.contextLimit
          ? `Start a prompt with **+context** or **+context=N** to request up to **${messages(facts.contextLimit)}** preceding human messages from the same channel.`
          : 'Per-interaction ambient context is currently **disabled by server policy**.',
        `Conversation text, including any explicitly requested context, is stored in plaintext so replies can continue; Discord identifiers are pseudonymized. Both expire after **${days(facts.transcriptTtlDays)}**, though Atlas TTL deletion may occur shortly after expiry.`,
        'Every model turn has direct read-only web tools. Your question, replies, conversation history, and requested context can influence a public search query when the model decides research is useful.',
        'Open-Meteo receives configured city names for geocoding and coordinates for forecasts, with no Discord identifiers. Briefings use no model calls.',
        'Reminders store plaintext text until 7 days after the due date; routing is encrypted and removed after delivery or cancellation. Text is visible in the original channel. Briefing agendas use only reminders from that same channel.',
        'Reply conversations are owner-bound. Do not send passwords, tokens, payment details, or other secrets.',
      ].join('\n'),

    settings: (facts) =>
      [
        `Reels deployment (Instagram and TikTok): **${facts.reelsDeploymentAvailable ? 'available' : 'disabled'}**`,
        `Reels in this channel (Instagram and TikTok): **${onOff(facts.reelsChannelEnabled)}**`,
        `Model: **${facts.modelLabel}**`,
        `Reasoning: **${facts.reasoning}**`,
        `Zero Data Retention: **${facts.supportsZdr ? 'enforced' : 'unavailable'}**`,
        `Language: **${facts.languageName}**`,
        'Ambient context default: **0 messages**',
        `Per-interaction context limit: **${messages(facts.contextLimit)}**`,
        `Daily committed spend: **${facts.dailyCommitted}**`,
        `Monthly committed spend: **${facts.monthlyCommitted}**`,
      ].join('\n'),

    modelSet: (input) =>
      input.supportsZdr
        ? `Model set to **${input.label}** with **${input.reasoning}** reasoning. Zero Data Retention will be enforced.`
        : `Model set to **${input.label}** with **${input.reasoning}** reasoning. ⚠️ Zero Data Retention is not available for this model.`,

    contextLimitSet: (count) =>
      count === 0
        ? 'Per-interaction ambient context is disabled. Explicitly replied-to messages are still included.'
        : `Members may now request up to **${messages(count)}** preceding human messages with +context.`,

    languageSet: (languageName) =>
      `Jolanda will now reply in **${languageName}**. Model answers still follow the language you write in.`,
  },

  reels: {
    channelUnsupported:
      'Reels settings are available in server text and announcement channels only.',
    missingPermissions:
      'I need View Channel, Send Messages, Read Message History, and Attach Files to repost Reels.',
    toggled: (input) =>
      `Automatic Reels (Instagram and TikTok) are **${onOff(input.enabled)}** in this channel.${
        input.enabled && input.deploymentOff
          ? ' Downloads remain unavailable while the deployment switch is off.'
          : ''
      }`,
    platformLabel: {
      tiktok: 'TikTok',
      instagramPost: 'Instagram post',
      instagramReel: 'Instagram Reel',
    },
    sizeUnknown: 'size unknown',
    atLeast: (value) => `at least ${value}`,
    bytes: (value) => `${value} bytes`,
    failure: (input) =>
      ({
        unavailable: `I couldn’t access this ${input.platform} without a login.`,
        authentication_required: `I couldn’t access this ${input.platform} without a login.`,
        too_large: `${input.platform} is too large.`,
        unsupported_media: `I couldn’t retrieve a compatible video for this ${input.platform}.`,
        timeout: `I couldn’t download this ${input.platform} right now.`,
        extractor_failed: `I couldn’t download this ${input.platform} right now.`,
        rate_limited: `I couldn’t download this ${input.platform} right now.`,
        photos_unavailable: `I couldn’t retrieve the original photos for this ${input.platform}.`,
        too_many_photos: `This ${input.platform} has more than ${input.maximumPhotos} photos, which is my limit per post.`,
        cancelled: '',
      })[input.failure],
    tooLarge: (input) =>
      `${input.platform} is too large${input.discordRejected ? ' for Discord' : ''}: ${input.measurement} (${
        { download: 'download limit', app: 'app limit', plain: 'limit' }[input.limitLabel]
      }: ${input.limit}).`,
    photosRange: (input) => `Photos ${input.from}–${input.to} of ${input.total}`,
  },

  news: {
    moreStories: 'More stories are available in the source article.',
    story: 'Story',

    unavailableDeployment: 'News: **unavailable in this deployment**',
    unavailable: 'News is unavailable in this deployment.',
    unknownCommand: 'Unknown news command.',
    feedLabel,
    feedName,
    outcome: outcomeLabel,
    notCollectedYet,

    summary: (input) =>
      `News deployment: **${input.available ? 'available' : 'disabled'}** · ${input.feeds
        .map(({ feed, state }) => `${feedName[feed]}: ${state}`)
        .join(' · ')}. Use /jolanda continuous status or /jolanda daily status for details.`,
    summaryState: { enabled: 'enabled', paused: 'paused', off: 'off' },

    statusLines: (facts) => {
      const pausedLabel = {
        'destination-unavailable': 'destination unavailable',
        'decryption-failed': 'decryption failed',
        'deployment-disabled': 'deployment disabled',
        'feed-disabled': 'feed disabled',
      };
      return [
        `**${feedLabel[facts.feed]} news**`,
        `Deployment switch: **${onOff(facts.deploymentEnabled)}**`,
        `Configuration: **${
          facts.configuration === 'missing'
            ? 'not configured'
            : facts.configuration === 'enabled'
              ? 'enabled'
              : 'disabled'
        }**`,
        `Destination: ${
          facts.destination.kind === 'channel'
            ? `<#${facts.destination.channelId}>`
            : facts.destination.kind === 'unavailable'
              ? 'unavailable; configure the feed again'
              : 'none'
        }`,
        `Notifications: ${
          facts.feed === 'continuous'
            ? 'silent; no mentions'
            : facts.notifyRoleId
              ? `normal channel behavior; explicit role <@&${facts.notifyRoleId}>`
              : 'normal channel behavior; no role ping'
        }`,
        `Delivery paused: **${facts.paused ? pausedLabel[facts.paused] : 'no'}**`,
        `Next collection: ${facts.nextCollectionAt ?? 'not scheduled for this subscription'}`,
        `Last source outcome: **${facts.lastOutcome ? outcomeLabel[facts.lastOutcome] : notCollectedYet}**`,
        `Last successful collection: ${facts.lastSuccessAt ?? 'never'}`,
        ...(facts.backoffUntil ? [`Source backoff until: ${facts.backoffUntil}`] : []),
        ...(facts.storedEdition
          ? [
              `Stored edition: ${facts.storedEdition.current ? 'current day' : 'older day'} · ${facts.storedEdition.collectedAt} (collected, not a delivery receipt)`,
            ]
          : facts.feed === 'daily'
            ? ['Stored edition: none; no fresh edition is stored']
            : []),
        `Pending deliveries: **${facts.pending}** · Uncertain deliveries: **${facts.uncertain}**`,
        ...(facts.uncertain ? ['Uncertain deliveries are held to avoid duplicate messages.'] : []),
      ];
    },

    feedDisabled: (feed) =>
      `${feedLabel[feed]} feed disabled. Stored routing has been removed; already sent messages remain in Discord.`,
    feedConfigured: (input) =>
      `${feedLabel[input.feed]} feed enabled in <#${input.channelId}>.${
        input.feed === 'continuous'
          ? ' Posts are silent and do not mention anyone.'
          : input.notifyRoleId
            ? ` Daily editions may notify <@&${input.notifyRoleId}> once; member notification settings still apply.`
            : ' Daily editions use normal channel notifications without a role ping.'
      }${input.deploymentEnabled ? '' : ' Collection and delivery remain disabled while the deployment switch is off.'}`,
    invalidDestination:
      'Choose a text or announcement channel in this server and an optional role other than @everyone.',
    validationFailed:
      'I could not validate that destination. I need View Channel, Send Messages and Embed Links there. An optional notification role must still exist and be mentionable, or I need Mention Everyone in that channel.',
  },

  weather: {
    clear: 'Clear',
    partlyCloudy: 'Partly cloudy',
    overcast: 'Overcast',
    fog: 'Fog',
    drizzle: 'Drizzle',
    freezingRain: 'Freezing rain',
    rain: 'Rain',
    snow: 'Snow',
    thunderstorm: 'Thunderstorm',
    unknown: 'Unknown weather',
  },
  manualRun: {
    queued:
      'Manual run queued. The message will arrive in the configured channel; the regular schedule is unchanged.',
    unconfigured: 'First configure and enable a destination channel with the feed command.',
    busy: 'A run is already active or a cooldown applies. Try again later (at least 10 minutes after the previous manual run).',
    unavailable:
      'The source is temporarily unavailable or has no daily edition from the last 48 hours. Try again later.',
  },
  briefing: {
    noNameday: 'No name day in the official calendar today.',
    agendaUnavailable: 'Reminders are currently unavailable.',
    moreAgenda: (count) => `More reminders today: ${count}`,

    unavailable: 'The morning briefing is unavailable in this deployment.',
    unknownCommand: 'Unknown morning briefing command.',
    summary: (input) =>
      `Morning briefing: **${!input.available ? 'unavailable in this deployment' : input.configured ? `enabled at ${String(input.hour).padStart(2, '0')}:00` : 'not configured'}**`,
    channelUnsupported:
      'The morning briefing is available in server text and announcement channels only.',
    configured: (input) =>
      `Morning briefing enabled in <#${input.channelId}> at **${String(input.hour).padStart(2, '0')}:00**.`,
    disabledFeed:
      'Morning briefing disabled. Stored routing has been removed; already sent briefings remain in Discord.',
    hourSet: (hour) =>
      `The morning briefing will arrive at **${String(hour).padStart(2, '0')}:00** (Europe/Bratislava).`,
    cityAdded: (input) =>
      `Added **${input.name}**. You now have ${input.count} of ${input.maximum} configured.`,
    cityRemoved: (name) => `Removed **${name}**.`,
    cityUnknown: (name) =>
      `I could not find **${name}**. Try a different spelling or a larger nearby city.`,
    cityDuplicate: (name) => `**${name}** is already in your briefing.`,
    cityLimit: (maximum) => `A briefing can hold at most ${maximum} cities. Remove one first.`,
    noCities: 'No cities configured yet. Add one with /jolanda briefing city action:add.',

    statusLines: (facts) => [
      '**Morning briefing**',
      `Configuration: **${facts.configured ? 'enabled' : 'not configured'}**`,
      `Destination: ${
        facts.destination.kind === 'channel'
          ? `<#${facts.destination.channelId}>`
          : facts.destination.kind === 'unavailable'
            ? 'unavailable; configure the briefing again'
            : 'none'
      }`,
      `Delivery time: **${String(facts.hour).padStart(2, '0')}:00** (Europe/Bratislava)`,
      `Cities (${facts.cities.length}/${facts.maximumCities}): ${facts.cities.length ? facts.cities.join(' · ') : 'none'}`,
      `Next delivery: ${facts.nextDeliveryAt ?? 'not scheduled'}`,
      `Last delivery: ${facts.lastDeliveredAt ?? 'never'}`,
    ],

    greeting: (date) => `Good morning — ${date}`,
    weatherUnavailable: (city) => `${city} — weather currently unavailable`,
    daylight: (input) =>
      `${input.duration} of daylight, ${input.delta} ${input.shorter ? 'shorter' : 'longer'} than yesterday`,
    namedays: (names) =>
      `Name day: ${names[0]}${names.length > 1 ? ` (${names.slice(1).join(', ')})` : ''}`,
    holiday: (input) =>
      `${input.name} — ${input.stateHoliday ? 'state holiday' : 'holiday'}${input.dayOff ? ' and a day of rest' : ' (not a day of rest)'}`,
    agenda: (rows) => `Today: ${rows.map((row) => `${row.dueAt} ${row.text}`).join(' · ')}`,
    feels: (value) => `feels ${value}`,
    rain: (input) =>
      input.millimetres > 0
        ? `${input.millimetres} mm (${input.probability} %)`
        : `no rain (${input.probability} %)`,
    wind: (input) => `wind ${Math.round(input.speed)} km/h, gusts ${Math.round(input.gusts)}`,
    uv: (value) => `UV ${value.toFixed(1)}`,
  },

  reminders: {
    deliveryUncertain: '⚠️ Delivery uncertain:',

    textTooLong: 'Reminder text must be at most 280 characters.',
    created: (input) => `✅ I'll remind you at ${input.dueAt}. ID: \`${input.id}\``,
    cancelled: (id) => `✅ Reminder \`${id}\` cancelled.`,
    notFound: (id) => `I could not find reminder \`${id}\`.`,
    listEmpty: 'You have no pending reminders.',
    list: (rows) =>
      [
        `**Your reminders (${rows.length})**`,
        ...rows.map((row) => `\`${row.id}\` · ${row.dueAt} — ${row.text}`),
      ].join('\n'),
    limitReached: (maximum) =>
      `You can have at most ${maximum} pending reminders. Cancel one first or wait for it to fire.`,
    invalidTime:
      'I could not read that time. Use for example `in:2h`, `in:90m`, `in:3d`, or `at:2026-09-16 09:00`.',
    tooSoon: 'A reminder must be at least a minute in the future.',
    tooFar: 'I can set a reminder at most a year ahead.',
    emptyText: 'Tell me what to remind you about.',
    saveFailed: '⚠️ I could not save that reminder, so it is not set. Please try again.',
    deliver: (input) => `🔔 <@${input.userId}> — ${input.text}\nSet ${input.createdAt}`,
  },

  usage: {
    heading: usageHeading,
    noData: 'I have no recorded turns for this window.',
    others: 'others',
    lines: (facts) =>
      [
        usageHeading(facts.windowDays),
        '',
        `Spend  ${facts.sparkline}  ${facts.totalCost} total`,
        `Today ${facts.dailyCost} · Month ${facts.monthlyCost} of ${facts.monthlyLimit}`,
        '',
        `**Per member (last ${facts.memberWindowDays} days)**`,
        ...(facts.members.length
          ? facts.members.map((member) =>
              `${member.name} — ${plural(locale, member.requests, {
                one: '{count} turn',
                other: '{count} turns',
              })} · ${member.cost} ${member.failures ? `· ${member.failures} failed` : ''}`.trim(),
            )
          : ['No data in this window.']),
        '',
        `Per-member data covers ${facts.memberWindowDays} days (transcript retention); the trend covers ${facts.windowDays} days. Daily totals are retained for 120 days.`,
        ...(facts.othersIncluded
          ? ['Members that could not be resolved are grouped as “others”.']
          : []),
      ].join('\n'),
  },

  rejections: (promptsPerMinute, imageCount, replyLimit) => ({
    empty_question: 'Please include a question when you tag me or reply to me.',
    invalid_model:
      'That model profile is unavailable. Please choose a model from the /jolanda ask dropdown again.',
    image_limit: `Please send at most ${imageCount} images across your message and the message you reply to.`,
    image_too_large: 'Please use images up to 8 MiB each, or upload a smaller version.',
    image_unavailable:
      'I could not read an attached image. Please upload it again as JPEG, PNG, WebP, or GIF (up to 40 megapixels).',
    expired_conversation: 'That conversation has expired. Tag me in a new message to start again.',
    conversation_busy: 'I am already answering in that conversation. Please wait for it to finish.',
    conversation_limit: `This conversation reached its limit of ${replyLimit} Jolanda replies. Tag me to start a new one.`,
    conversation_owner:
      'Only the person who started that conversation can continue it. Tag me in a new message to start your own.',
    context_limit:
      'That context request exceeds this server’s per-interaction limit. Use a smaller +context value or ask an administrator to change /jolanda context-limit.',
    server_busy: 'Jolanda is at her concurrency limit. Please try again after an answer finishes.',
    shutting_down: 'Jolanda is restarting. Please try again in a moment.',
    duplicate: '',
    rate_limited: `You can send at most ${promptsPerMinute} prompts in a rolling minute. Please wait a moment.`,
    monthly_budget: 'Jolanda has reached the server’s monthly spending limit.',
  }),

  progress: {
    thinking: 'Jolanda is thinking…',
    answering: '🧠 Working through the question…',
    finalizing: '📦 Finalizing the response…',
    waitingAnswering: '🧠 Waiting for OpenRouter…',
    waitingFinalizing: '📦 Finalizing the response…',
    currentApproach: '🧠 **Current approach**',
    noActivityFor: (elapsed) => ` · no activity for ${elapsed}`,
    waitingForOpenRouter: ' · waiting for OpenRouter',
    retry: (input) =>
      `⚠️ OpenRouter is shitting itself again.\nReason: ${input.reason}\n${input.waitSeconds ? `Retrying in ${input.waitSeconds}s` : 'Retrying'} · attempt ${input.attempt}/${input.maximum} · ${input.elapsed}`,
  },

  answer: {
    question: 'Question',
    model: 'Model',
    noModel: 'Local reply, no AI model',
    truncationNotice: '⚠️ *The model hit its output limit, so this answer is cut short.*',
    footerTruncation: '\n\n[…answer shortened to include response details]',
    imageModel: (label) => `\n\n👁️ **Image model:** ${label}`,
    basisModelOnly: '🧠 **Source basis:** No public web research was used.',
    basisWebWithoutSources:
      '🌐 **Source basis:** Public web research was used, but OpenRouter returned no usable source links.',
    basisUnreported:
      '⚠️ **Source basis:** OpenRouter did not report whether public web research was used.',
    basisWebSources: '🌐 **Source basis:** Public web research was used.',
    omittedSources: (count) =>
      `- ${plural(locale, count, {
        one: '{count} additional source link omitted',
        other: '{count} additional source links omitted',
      })}`,
    sourceLabel: (sourceNumber, title) =>
      title ? `Source ${sourceNumber}: ${title}` : `Source ${sourceNumber}`,
    cost: (value) => `💵 **Response cost:** ${value}`,
    costUnknown: '💵 **Response cost:** Unknown (not counted toward the server budget)',
  },

  failures: {
    generic: '⚠️ I could not finish that response. Please try again.',
    notice: (input) => {
      if (input.malformedReason === 'empty_answer')
        return `⚠️ The model returned no answer text. Try a different model with \`/model\`, or ask again. Reference: \`${input.reference}\`.`;
      if (input.malformedReason === 'reasoning_budget_exhausted')
        return `⚠️ The model used its entire token budget on reasoning and never produced an answer. Try a lower reasoning effort with \`/model\`, or ask again. Reference: \`${input.reference}\`.`;
      const reason = {
        timeout: 'Answer generation timed out.',
        rate_limited: 'OpenRouter rate-limited the answer generation.',
        authentication: 'OpenRouter rejected the bot credentials.',
        payment_required: 'OpenRouter rejected the request for billing reasons.',
        request_rejected: 'OpenRouter rejected the answer generation request.',
        provider_unavailable: 'No model provider was available for answer generation.',
        provider_failure: 'The model provider failed during answer generation.',
        malformed_response: 'OpenRouter returned an invalid response during answer generation.',
        network_failure: 'The connection to OpenRouter failed during answer generation.',
        cancelled: 'The request was cancelled.',
        unknown: 'I could not finish that response.',
      }[input.category];
      return `⚠️ ${reason} Please try again. Reference: \`${input.reference}\`.`;
    },
    retryReason: (input) => {
      if (input.status === 502) return '502 Bad Gateway — upstream provider failed';
      if (input.malformedReason === 'empty_answer')
        return 'The provider finished without returning any answer text';
      if (input.malformedReason === 'reasoning_budget_exhausted')
        return 'The model exhausted its reasoning budget without answering';
      const reason = {
        timeout: 'OpenRouter timed out',
        rate_limited: 'OpenRouter rate limit',
        provider_failure: 'Upstream provider failed',
        provider_unavailable: 'No eligible provider was available',
        malformed_response: 'The provider returned an invalid or empty answer',
        network_failure: 'Connection to OpenRouter failed',
        authentication: 'OpenRouter rejected the bot credentials',
        payment_required: 'OpenRouter rejected the request for billing reasons',
        request_rejected: 'OpenRouter rejected the request',
        cancelled: 'The request was cancelled',
        unknown: 'Unknown OpenRouter failure',
      }[input.category];
      return input.status === undefined ? reason : `${input.status}: ${reason}`;
    },
  },
} satisfies Messages;
