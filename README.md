# Jolanda

Jolanda is a privacy-conscious, multilingual Discord assistant for one server. Mention her to ask a
question, mention her while replying to quote a message, or reply to one of her answers to continue
the same conversation. She answers in the language the user writes in.

## Behavior and settings

- `@Jolanda What is happening today?` starts a conversation.
- `/jolanda ask` lets any member enter a question and optionally choose a model/reasoning profile
  from a searchable picker for **that answer only**. Leave the model empty to use the server default.
  Replies to the answer use the current server default again. Existing spending and rate limits
  apply; profiles without Zero Data Retention are labeled `[no ZDR]`. The answer is public in the
  channel with the question quoted above it and the actual model/reasoning profile shown alongside.
  Local greetings are labeled as replies without an AI model. This command does not read surrounding channel messages.
- `@Jolanda +context Fact-check the discussion above` opts into the server-approved context window
  for that interaction only; `+context=10` requests a smaller explicit number.
- Mentioning Jolanda in a reply includes that explicitly replied-to message.
- Attach photos to a tagged message (for example, `@Jolanda čo je na tomto obrázku?`), or tag her
  while replying to a photo. Up to four images across those two messages are supported: JPEG, PNG,
  WebP, or GIF, each up to 8 MiB and 40 megapixels. GIFs use the first frame. An image-only mention
  asks for a description. Ambient channel history remains text-only; image links/embeds and videos
  are not treated as photo attachments.
- GLM 5.3 Flash, Luna, Grok 4.3, Qwen3.8 Flash, and Mistral Small 4 handle images directly.
  When a text-only model is selected, image-bearing turns use GLM 5.3 Flash and show an **Image model** note; the server setting remains unchanged.
- Follow-ups retain the conversation text, including earlier descriptions, but not image data.
  To inspect a photo again, reattach it or tag Jolanda while replying to its original message.
- Replying to any chunk of Jolanda's answer continues the conversation without another mention.
- A conversation is private to its creator, channel, and guild and ends after 10 Jolanda replies.
- Ambient context defaults to `0` on every interaction. When explicitly requested, it includes only
  preceding human messages in the same channel, up to the server policy and prompt-size ceilings.
- Server settings are read fresh for every interaction, including an ongoing reply chain.
- While a turn is running, one throttled Discord message shows the answering or finalizing stage and
  any provider-generated reasoning summary. Its elapsed-time heartbeat keeps
  updating every two seconds after answer text starts and until final rendering, distinguishing an
  open request from recent provider stream activity. Raw reasoning is never displayed. The status
  is replaced by the streamed answer, which is bounded to six messages; generated mentions and link
  previews are disabled.
- Every model-generated final answer has a trusted source-basis footer. It says when no public web
  research ran, renders bounded OpenRouter source links once in the footer when available, or
  reports missing usage/source metadata instead of guessing. The footer shows the reported cost
  of successful generations at microdollar precision; missing usage is labeled unknown and does
  not consume the server budget. Failed attempts are excluded from budget accounting. Model-authored URLs that
  do not match a structured citation stay non-clickable, but their readable Markdown labels remain.
  Local greetings are not labeled as model answers.
- Model responses use a compact Discord Markdown subset: normal-sized emphasis, lists, quotes, and
  code are allowed, while headings and other expansive document-style formatting are prohibited.
  A renderer-side clamp converts any model-generated Markdown heading into ordinary bold text.

Mentions and replies inherit the server's model/reasoning profile, subject to the image fallback
above. The optional model in `/jolanda ask` never changes saved settings or carries over to a reply.

`/jolanda ask` and `/jolanda privacy` are available to every member. The following commands require **Manage Server**:

- `/jolanda settings` shows model, reasoning, context, and committed spend.
- `/jolanda model` selects an atomic model/reasoning profile. Discord only offers reasoning efforts
  supported by that model and labels profiles without a Zero Data Retention route as `[no ZDR]`.
  Both model pickers show a short Slovak or English description. Initially they show one default
  profile per model; type a model name or reasoning effort (for example `grok high`) to see alternatives.
- `/jolanda context-limit` controls how many preceding messages members may explicitly request,
  from `0` through `MAX_CONTEXT_MESSAGES` (default maximum `50`). It never changes the per-interaction
  default of zero, and explicit replies still work when the limit is zero.

Defaults are GLM 5.3 Flash, high reasoning, zero ambient context, and an opt-in context limit of
zero until a server administrator enables it.

Available additions: Hermes 4 405B (fewer refusals),
Venice Uncensored, Grok 4.3, Qwen3.8 Flash, and Mistral Small 4. Hermes and Venice
are **chat only** on their current OpenRouter routes: no web research, calculator, or conversational
reminder creation. `/jolanda remind` remains available independently. Hermes offers thinking off
(`none`) or on (`high`); Venice offers `none` only. Image turns use the GLM fallback.
Qwen and Luna are labeled `[no ZDR]`. All models retain Jolanda's system instructions.

Example: `/jolanda ask question:Vysvetli mi tento vtip model:` then type `hermes` and select its
profile. Any member can use this one-answer selection; Manage Server is required to persist a
server default with `/jolanda model profile:`.

## Architecture

- The Discord adapter owns bounded gateway admission, command authorization, reply detection,
  deadline-bound history/reference reads, and progressive rendering.
- The Jolanda core authorizes work before context reads, builds prompts, enforces ownership and
  concurrency, orchestrates inference, settles usage, and drains active turns on shutdown.
- Exact greetings and acknowledgements are answered locally. Every model turn receives one immutable,
  trusted clock snapshot in `JOLANDA_TIME_ZONE` (default `Europe/Bratislava`). Tool-capable models
  also receive OpenRouter's datetime tool, local calculator and IANA time-zone conversion tools,
  and bounded public web-search and web-fetch tools. The model decides which tools a question needs. Local function calls run through a
  bounded two-round loop and return structured results to the model; there is no research classifier
  or separate research generation.
- MongoDB exposes transactional settings, conversation, locking, rate-limit, budget-reservation,
  settlement, and expired-lease recovery operations through a small store interface.

Replies, explicitly requested context, history, and prior turns are labeled as untrusted data in the
prompt. On tool-capable models, that context can influence a model-generated
public search query; members must not send secrets. Calculator and time-zone tools are deterministic
and receive no network access. Progress and reasoning summaries are ephemeral
rendering state: they are not written to transcripts or structured logs. Source-basis labels are
derived from structured usage/citation metadata; the canonical turn event records only the finite
basis category and source count, while stored conversation text keeps the answer without the UI
footer.

Transient OpenRouter failures get up to five attempts per generation, with 1, 2, 4, and 8 second
delays. The placeholder shows the retry reason and attempt count. Retries stop after answer text
has been streamed or the turn is cancelled; credential, billing, and rejected-request errors are
not retried. Invalid or empty answers retain a single retry because they can consume a full token
budget. Provider error bodies stay private: the displayed reason uses fixed labels and numeric
status codes. A 502 is reported as an upstream failure, rather than missing provider availability.
If Z.AI finishes without answer text, that generation's retry excludes the `z-ai` provider while
keeping the same model and privacy requirements. Empty-answer failures are named explicitly;
an empty response alone is not treated as proof of content filtering.

## Local setup

Requirements: Node.js 22+, pnpm 11+, a Discord application, an OpenRouter API key, and MongoDB Atlas.

```sh
pnpm install
cp .env.example .env
# For a local non-Atlas MongoDB only, set NODE_ENV=development.
pnpm dev
```

Generate `DATA_PROTECTION_SECRET` with `openssl rand -base64 32`. Configure the Discord application:

Set `JOLANDA_TIME_ZONE` to the deployment's default IANA time zone if it should differ from
`Europe/Bratislava`, for example `America/New_York`. It is shared by every server using the bot.

1. Create a bot named **Jolanda** in the Discord Developer Portal.
2. Enable **Message Content Intent**.
3. Invite it with the `bot` and `applications.commands` scopes.
4. Grant **View Channels**, **Send Messages**, and **Read Message History** only where it may operate.
5. Invite the same application to every server where Jolanda should operate. Slash commands are
   registered globally at startup and settings, budgets, and conversations remain isolated per server.

## Limits and accounting

The defaults enforce three accepted prompts per member in a rolling minute, `$10` total server spend
per UTC month, two concurrent turns process-wide, one active turn per conversation,
at most five provider tool calls per request, two local function-call rounds, four local calls per
round, three search results, two fetched pages, at most 20 active Discord adapter handlers, and
bounded prompt/output/SSE sizes. Each OpenRouter request has ten minutes to produce its first
non-empty stream chunk; after streaming starts, inference has no application-level deadline and is
cancelled only by shutdown or an upstream caller.

There is no server daily spending limit. Daily usage remains tracked; obsolete
`DAILY_SPEND_LIMIT_USD` environment values are ignored. Monthly limits and the OpenRouter key cap remain.

Before inference, Jolanda computes a conservative reservation from the chosen model, reasoning,
prompt ceiling, completion ceiling across tool rounds, provider price ceilings, and search/fetch
allowances. MongoDB
reserves that amount transactionally. Reported successful usage replaces it. Failed attempts,
cancelled or expired requests, and missing or invalid usage release the reservation without a
budget charge. Retries retain the reported usage of successful generations only. These server
counters intentionally exclude failures even if OpenRouter charges for them. Configuration fails when a budget cannot cover one
maximum-cost turn. Money is stored as integer microdollars.

OpenRouter currently rejects `provider.max_price` when a server tool is present. Assistant generations
therefore rely on the pinned model price, conservative reservation, bounded tools, and production-key
cap instead of a request-side price ceiling.

Set a separate `$10` monthly cap on the production OpenRouter key as defense in depth. Pricing and
provider behavior can change, so review the ceilings in `src/models.ts` before upgrading models.

## Privacy and security

- Context is opt-in and disabled by default. Transcript retention defaults to seven days.
- Context explicitly requested for a turn becomes part of the stored conversation transcript until
  that transcript expires.
- Photo attachments are fetched only from Discord attachment hosts, with redirects disabled and
  download, byte, and decoded-pixel limits. After admission and spend reservation, they are resized
  to at most 1600 pixels per side and re-encoded as JPEG without metadata. Only inline image data
  reaches OpenRouter; attachment URLs and filenames are not sent. Images are processed in memory
  and are not written to transcripts, logs, or disk. Transcripts retain source markers and the
  assistant's textual answer, which may describe private image content. Image-token allowances
  cover each possible model/tool round, and actual provider usage settles the request.
- Guild, channel, member, Discord-message, request, and interaction IDs are HMAC-pseudonymized before
  MongoDB persistence or application logging. Structured Discord mentions, message links, custom
  emoji IDs, and standalone snowflakes inside transcript text are replaced with generic labels.
- OpenRouter routing denies provider data collection and requires parameter support. It enforces
  Zero Data Retention automatically for models with a compatible route; models labeled `[no ZDR]`
  remain selectable and may be retained by their provider under that provider's policy.
- The system prompt tells the model never to search for credentials, personal data, or private
  targets; this is model behavior rather than a deterministic request gate. Web tools are read-only
  and bounded. Output is bounded; only exact public URLs carried by OpenRouter's
  structured citation annotations can remain clickable, with query strings and fragments removed.
  Citation titles, ranges, and URLs are bounded, provider excerpts are discarded, and source
  annotations are rendered only in the trusted footer rather than rewriting answer text.
- Failed responses show a safe reason and correlation reference. The matching Railway
  `jolanda_turn` event records bounded OpenRouter status, code, stage, generation/provider routing,
  and timing fields when available; raw provider messages and response bodies are discarded.
- Model output cannot ping members or roles and cannot generate Discord embeds.

Atlas TTL cleanup is asynchronous; application queries reject expired transcripts immediately.
Atlas backups and Railway logs have their own retention. See [SECURITY.md](SECURITY.md) for the
threat model, production checklist, incident response, and residual risks.

## Verification

```sh
pnpm format
pnpm check
pnpm build
pnpm audit --prod
```

`pnpm check` runs TypeScript, ESLint, MongoDB replica-set integration tests, adapter/core tests, and
enforced V8 coverage thresholds. The required predeployment provider gate is opt-in and paid:

```sh
OPENROUTER_LIVE_TEST_KEY=... pnpm test:release-live
```

Use only a deliberately capped key. `pnpm test:live` remains a smaller compatibility smoke test;
the release command additionally covers every reasoning effort, web search on each tool-capable model,
English/Slovak prompt injection, and direct misuse refusals. Both paid commands fail before Vitest
when the live-test key is absent; `pnpm check` never enables paid calls merely because a key exists
in the environment.

## Railway deployment

Deploy the included Dockerfile as one Railway worker replica and add every variable from
`.env.example`. Jolanda uses the outbound Discord Gateway and needs no public domain. Shutdown stops
new work, aborts and drains active inference, settles reservations, and only then closes MongoDB.
Keep `NODE_ENV=production`; startup rejects Railway deployment metadata in any other mode.

Use a dedicated least-privilege Atlas user and a TLS-enabled URI. Railway static outbound IPs may
require a paid networking feature; otherwise Atlas must allow changing egress addresses. If a broad
Atlas access-list rule is unavoidable, compensate with a long unique password, strict database
permissions, TLS, and provider/database usage alerts.

## Automatic media reposts (Instagram and TikTok)

Automatic reposting is disabled by default. Set `INSTAGRAM_REELS_ENABLED=true` in the deployment,
then use `/jolanda reels enabled:true` in one test channel. Manage Server is required. Supported
channels are ordinary server text and announcement channels; the bot needs View Channel, Send
Messages, Read Message History, and Attach Files. `/jolanda settings` shows deployment availability
and the separately persisted channel setting. Disable a channel with `/jolanda reels enabled:false`;
the deployment switch disables both platforms in all channels without deleting their settings.
TikTok uses the same switch, channel setting, limits, and binaries; the existing `INSTAGRAM_*`
environment names are retained for compatibility.

A new human message containing a direct public Instagram `/reel/`, `/reels/`, or `/p/` link, a TikTok
`/@creator/video/123` or `/@creator/photo/123` link, or a TikTok `vm.tiktok.com`, `vt.tiktok.com`, or `tiktok.com/t/` share
link triggers one media job. Videos produce one MP4 reply with the canonical source link. Code, spoilers,
and angle-bracket links do not trigger it. Only the first supported link is processed, even in
messages mixing both platforms. TikTok share redirects are validated before extraction; successful
reposts link to the canonical post. The original message is preserved. Threads, edits,
backfill, Instagram `/share/`, stories, TikTok profiles, live streams,
and account-only media are unsupported. Busy and rate-limited
local admissions are skipped silently; nothing is queued. AI questions still run independently,
and replies to media messages only start AI work with an explicit content mention. A repost does
not mean the model watched or fact-checked the video.

The default limits are one active media job, two concurrent admission operations, two attempts per
member and ten per guild per minute, 20 MiB per upload, and three minutes of media. Each job tries
up to three distinct compatible source versions, preferring a version that already fits. Source
downloads stream to disk with a separate 100 MiB cap per attempt; smaller alternatives are tried
when a source exceeds the upload limit. At most two source files are retained at once.

Instagram image posts/carousels and TikTok photo posts attach original JPEG, PNG, or WebP images in their original order, without
re-encoding or soundtrack audio. Up to 35 photos share one aggregate upload-size cap (20 MiB by
default). Albums exceeding that cap or photo count are rejected in full. All photos download before
publishing, then send in batches of up to ten per reply, with numbered ranges and distinct nonces.
The bot checks the source and channel setting again before every batch. If a later batch fails or
the source disappears, earlier batches remain; the album is not automatically replayed. Photo
metadata comes from bounded public page requests (Instagram embeds or TikTok pages); it uses no account or extraction service. Instagram slide-selection and tracking parameters are discarded: the whole carousel is reposted. Single-image Instagram posts are supported too. Instagram `/p/` posts containing videos or mixed photo/video carousels are rejected in full; existing `/reel/` video support is unchanged. Private, login-gated, or embed-disabled posts may be unavailable.

If no downloaded video version fits, FFmpeg compresses the smallest retained source to H.264/AAC MP4.
Two-pass encoding targets 95% of the configured upload cap, with one lower-bitrate retry if needed.
Compression preserves the full clip and audio, caps high frame rates at 30 fps, and scales to fit
720×1280 (portrait) or 1280×720 (landscape), or 480×854/854×480 at lower bitrates, without upscaling.
The final file size, codecs, audio presence, and duration are checked before upload. Videos are
not split or deliberately truncated. Clips that already fit are uploaded without re-encoding.

Extraction, all source downloads together, each probe, and all compression passes together have
20/60/5/120-second deadlines within a 240-second pre-upload budget. Configuration can lower
`INSTAGRAM_REELS_MAX_BYTES` and `INSTAGRAM_REELS_JOB_TIMEOUT_MS`. Media uses a separate discord.js
REST client with a 15-second transport timeout, no retries, and immediate rejection of rate-limit
waits, so it cannot queue behind assistant messages. Bounded attachments may also occupy memory
during upload. Durable HMAC claims and deterministic nonces suppress duplicate events, including
rolling deployment overlap. Delivery is best effort; ambiguous uploads are not retried.

The Docker image installs hash-locked yt-dlp 2026.08.19 in `/opt/yt-dlp` and ffprobe/ffmpeg through Debian's
ffmpeg package. No account, browser profile, paid extraction API, or LLM request is used.
TikTok video downloads retain only allowlisted anonymous guest cookies from the current extraction
in memory and scope them to `tiktok.com` hosts. No login cookies are loaded or retained.
TikTok media may come from `tiktok.com` or any of its subdomains, alongside the documented CDN
allowlist; every redirect and DNS result still passes the network checks.
For local operation, install the locked Python requirements into a virtual environment and ffmpeg
with your OS package manager, then set absolute `INSTAGRAM_YT_DLP_PATH` and
`INSTAGRAM_FFPROBE_PATH` / `INSTAGRAM_FFMPEG_PATH`. Startup checks for libx264 and AAC encoders.
When disabled, these executables are not required at startup. Existing deployments should remove
or update a `60000` timeout override to allow the full compression budget. Upgrade yt-dlp
through a tested lock-file update and image rebuild, alongside `ytDlpVersion` in `src/reel-limits.ts`.

`pnpm check` includes offline compression tests using generated portrait and landscape clips when
ffmpeg and ffprobe are available on PATH (or via their environment overrides); those tests are
skipped when the tools are absent. They check output size, duration, audio, resolution, frame rate,
and cleanup without contacting Instagram, TikTok, or Discord.

Public post identifiers are sent to Instagram/Meta or TikTok according to the source link. Videos and photos exist temporarily in an owned private
scratch directory and are removed after upload or failure; startup removes only stale job
directories within that dedicated root. Uploaded copies follow Discord message retention, not
Mongo transcript TTL. Deleting a source post or original Discord link does not delete an
already uploaded copy. Administrators can remove copies using ordinary Discord moderation.

### Explicit media smoke tests and rollout

Normal `pnpm check` uses local fixtures and never contacts Instagram, TikTok, or Discord. To explicitly test
anonymous retrieval (no Discord messages are posted):

```sh
pnpm test:reels-smoke https://www.instagram.com/reel/DcjOE3QxRqW/
docker build -t jolanda-reels-test .
docker run --rm --memory=256m --cpus=1 jolanda-reels-test \
  node scripts/reels-smoke.mjs https://www.instagram.com/reel/DcjOE3QxRqW/
```

The smoke test accepts multiple Instagram or TikTok URLs (including short TikTok share links), emits numbered outcomes with size, media kind, photo count or video duration/audio presence,
latency and Node RSS, and removes all downloaded files. Never log extracted CDN URLs or metadata.
Run it from Railway with at least five representative public videos from each platform before rollout. In an authorized
Discord test channel, check sound, orientation, and playback on desktop and mobile; near-cap files;
inaccessible/oversized outcomes; source deletion and channel disable during a job; shutdown cleanup;
and simultaneous AI questions. Retain one Railway replica. Observe failures, peak container memory,
latency and bandwidth for a few days before enabling additional channels. Stop rollout if the hosting
network is blocked; do not introduce account credentials or browser-cookie fallbacks.

Local implementation validation retrieved the provided sample in the runtime container on
13 September 2026 (6,427,035 bytes, 73.164 seconds, audio present). This validates local anonymous
extraction and inspection only. Railway-network reliability and desktop/mobile Discord playback
remain release acceptance checks.

## Scheduled news

News uses the existing Jolanda bot and MongoDB, independently of AI and media. A member with
**Manage Server** can choose one destination per guild for each feed using native channel selectors:

```text
/jolanda continuous feed channel:#news
/jolanda daily feed channel:#daily-news [notify-role:@news-readers]
/jolanda continuous status
/jolanda daily status
/jolanda continuous disable
/jolanda daily disable
```

Denník N's important Minúta selection is collected once every 20 minutes, shared across guilds.
After each collection, all newly eligible stories are sent promptly, one embed message per story,
without a 20-minute gap between messages. Continuous embeds suppress push notifications and never
mention anyone; delivery respects Discord rate limits. Activation establishes a baseline, and
unsent stories expire after the two-hour recovery window.
There is no daily quota. Aktuality's own daily edition is collected at **20:00 Europe/Bratislava**
(CET/CEST), with retries at **21:00, 21:20 and 21:40** if no fresh edition was collected. A missing edition is
skipped; no replacement digest is generated. Daily delivery is one message and stops at 22:00.
Its optional role mention requires explicit configuration and destination permission validation.

Text and announcement channels are supported. Status is independent of AI budget availability;
`/jolanda settings` also includes a short feed summary. Routing identifiers are encrypted, while
durable delivery state prevents replay after restarts or channel changes. An ambiguous Discord
acceptance is held as uncertain instead of automatically retried.

See [news operations](NEWS_OPERATIONS.md) for the kill switch, preview commands, recovery,
retention, and controlled rollout; [acceptance evidence](NEWS_ACCEPTANCE.md) records what was
locally tested, checked against publishers, live verified, or deployed.

## Language, usage, reminders, and morning briefings

New and existing guilds default to Slovak for application messages. Administrators can use
`/jolanda language locale:en` or `locale:sk`. Model answers and local greetings still follow the
member's input language; the guild language never enters the model prompt. Source-basis footers,
errors, command replies and scheduled-message furniture use the guild language. Publisher article
text is preserved. Discord does not offer a Slovak client locale, so slash descriptions use Slovak
as their base and native English localizations.

`/jolanda usage` requires **Manage Server**. It shows a 14-day UTC spend trend, today's spend and the monthly
committed budget, and member totals for `TRANSCRIPT_TTL_DAYS` (7 days by default). Daily spend
buckets last 120 days; request records last only the configured transcript retention. These windows
are independent. Only cached Discord members are resolved; unresolved/overflow rows become
“others”. No privileged member intent or model breakdown is used. Usage-missing turns are counted
with failures and have no reported spend.

### Reminders

- `/jolanda remind in:2h text:take the laundry out`
- `/jolanda remind at:2026-09-16 09:00 text:send the invoice`
- `/jolanda reminders list`
- `/jolanda reminders cancel id:abcd`

Ordinary members can manage their own reminders. Times use `JOLANDA_TIME_ZONE`; ambiguous or
nonexistent DST wall times are rejected. Limits: 20 active reminders per member per guild,
1 minute to 365 days ahead, and 280 text characters. Delivery is to the original server text or
announcement channel and may mention only the owner. Slash commands incur no model cost.

Conversational creation uses one ordinary authorized model turn, with one reminder per turn.
`create_reminder` remains a synchronous, network-free draft validator. The application saves the
draft before displaying the final answer and appends a receipt with the real ID. Model answer text
is held until this commit boundary when reminders are available; progress messages still appear.
A failed commit follows the failure-notice path and displays no uncommitted confirmation.

Claims and send boundaries are atomic and lease-fenced across replicas. A worker that crashes
**before** the send boundary can be retried. A crash **after** a Discord POST may have started is
ambiguous: the reminder is marked `uncertain` and is not automatically resent. `/reminders list`
shows that status. Discord cannot guarantee exactly-once delivery across an ambiguous network
failure; check the channel before deliberately recreating an uncertain reminder. Confirmed
rejections retry after a cooldown. Destination identifiers are encrypted, text is plaintext, and
records expire seven days after the due date (Mongo TTL deletion is asynchronous).

### Manual runs

Administrators with Manage Server can use `/jolanda briefing run` for a fresh briefing or
`/jolanda daily run` to fetch and send the latest daily edition from the last 48 hours.
Both send a new message to the configured channel and leave the automatic schedule unchanged.
Manual daily news does not ping the notification role. Configure and enable the feed first.
A successful command confirms durable queuing, not delivery; the worker picks it up on its next
30-second tick. Manual runs have a ten-minute cooldown and delivery window, reuse the existing
leases and uncertain-on-ambiguous-send handling, and honor source backoff. No database deletion
is needed, and disabling or rerouting a feed fences queued news from the old configuration.

### Morning briefing

Configure a channel with `/jolanda briefing feed` to enable delivery; no environment switch is needed.
`BRIEFING_MAX_CITIES` defaults to 5 and accepts 1–5. Administrator commands:

- `/jolanda briefing feed channel:#morning`
- `/jolanda briefing city action:add name:Bratislava`
- `/jolanda briefing city action:remove name:Bratislava`
- `/jolanda briefing time hour:6`
- `/jolanda briefing status`
- `/jolanda briefing disable`

Discord allows only one subcommand-group level, hence `city action:add` rather than a nested
`city add`. The geocoder's first match is shown with its country code in the confirmation.
Delivery uses Europe/Bratislava, at 06:00 by default, with a 07:00 retry and an 08:00 deadline.
The hour override accepts 5–21, with fallback/deadline one/two hours later. One durable daily
record prevents repeat sends after successful or ambiguous delivery, including after rerouting.
Disabling removes encrypted routing and cancels unsent work; already-started sends may complete.

Each city gets an Open-Meteo `best_match` forecast: temperatures, apparent maximum, rain,
wind/gusts, UV, sunrise/sunset, daylight and the change from yesterday.
Temperatures every two hours from 06:00 through 24:00
use each city's local time; 24:00 is the following midnight. Missing hourly readings show `—`,
and an unavailable hourly section does not suppress the daily forecast. Weather failure for one
city leaves the other sections available. Temporary weather failures get one short retry within
the briefing deadline; outcome and attempt count are logged without city coordinates or Discord
identifiers. Calendar data is offline. Agenda entries are read-only
and include only reminders created in the briefing's own channel. Failed agenda reads are labelled.
Briefings use no model calls and no mentions. Calendar availability does not bypass Discord,
MongoDB, permission or network failures; delivery itself can still fail.

The name-day table follows the Ministry of Culture's
[official 2025 calendar](https://www.culture.gov.sk/storage/2020/03/Oficialne-kalendarium_2025.pdf).
Holiday rules were checked against
[Act 241/1993](https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1993/241/) on 2026-09-15.
State holidays and other holidays are distinct from days off: **8 May and 15 September are
working days in 2026 only**; 1 September, 28 October and 17 November also have explicit exceptions.
Review the table when the law changes. Bratislava events remain deferred.

Open-Meteo receives city names at configuration time via `geocoding-api.open-meteo.com` and city
coordinates for forecasts via `api.open-meteo.com`, with no Discord identifiers. Forecast data is
attributed to Open-Meteo (CC BY 4.0). Check its service terms if this personal bot becomes commercial.
Run `pnpm test:briefing-smoke Bratislava` for a live forecast rendered as JSON without sending to
Discord. Run `pnpm format && pnpm check && pnpm build` for local validation.
