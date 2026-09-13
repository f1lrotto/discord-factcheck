# Jolanda

Jolanda is a privacy-conscious, multilingual Discord assistant for one server. Mention her to ask a
question, mention her while replying to quote a message, or reply to one of her answers to continue
the same conversation. She answers in the language the user writes in.

## Behavior and settings

- `@Jolanda What is happening today?` starts a conversation.
- `@Jolanda +context Fact-check the discussion above` opts into the server-approved context window
  for that interaction only; `+context=10` requests a smaller explicit number.
- Mentioning Jolanda in a reply includes that explicitly replied-to message.
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
  reports missing usage/source metadata instead of guessing. The footer also shows the total cost
  of that response at microdollar precision; when usage is missing, it labels the conservative
  reservation charged by the accounting system. Model-authored URLs that
  do not match a structured citation stay non-clickable, but their readable Markdown labels remain.
  Local greetings are not labeled as model answers.
- Model responses use a compact Discord Markdown subset: normal-sized emphasis, lists, quotes, and
  code are allowed, while headings and other expansive document-style formatting are prohibited.
  A renderer-side clamp converts any model-generated Markdown heading into ordinary bold text.

There are intentionally no per-message model or reasoning overrides. Every interaction inherits
the server-scoped settings.

`/jolanda privacy` is available to every member. The following commands require **Manage Server**:

- `/jolanda settings` shows model, reasoning, context, and committed spend.
- `/jolanda model` selects an atomic model/reasoning profile. Discord only offers reasoning efforts
  supported by that model and labels profiles without a Zero Data Retention route as `[no ZDR]`.
- `/jolanda context-limit` controls how many preceding messages members may explicitly request,
  from `0` through `MAX_CONTEXT_MESSAGES` (default maximum `50`). It never changes the per-interaction
  default of zero, and explicit replies still work when the limit is zero.

Defaults are GLM 5.3 Flash, high reasoning, zero ambient context, and an opt-in context limit of
zero until a server administrator enables it.

## Architecture

- The Discord adapter owns bounded gateway admission, command authorization, reply detection,
  deadline-bound history/reference reads, and progressive rendering.
- The Jolanda core authorizes work before context reads, builds prompts, enforces ownership and
  concurrency, orchestrates inference, settles usage, and drains active turns on shutdown.
- Exact greetings and acknowledgements are answered locally. Every model turn receives one immutable,
  trusted clock snapshot in `JOLANDA_TIME_ZONE` (default `Europe/Bratislava`), OpenRouter's datetime
  tool, local calculator and IANA time-zone conversion tools, and bounded public web-search and
  web-fetch tools. The model decides which tools a question needs. Local function calls run through a
  bounded two-round loop and return structured results to the model; there is no research classifier
  or separate research generation.
- MongoDB exposes transactional settings, conversation, locking, rate-limit, budget-reservation,
  settlement, and expired-lease recovery operations through a small store interface.

Replies, explicitly requested context, history, and prior turns are labeled as untrusted data in the
prompt. Because every model turn has direct web tools, that context can influence a model-generated
public search query; members must not send secrets. Calculator and time-zone tools are deterministic
and receive no network access. Progress and reasoning summaries are ephemeral
rendering state: they are not written to transcripts or structured logs. Source-basis labels are
derived from structured usage/citation metadata; the canonical turn event records only the finite
basis category and source count, while stored conversation text keeps the answer without the UI
footer.

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

The defaults enforce three accepted prompts per member in a rolling minute, `$2` total server spend
per UTC day, `$10` per UTC month, two concurrent turns process-wide, one active turn per conversation,
at most five provider tool calls per request, two local function-call rounds, four local calls per
round, three search results, two fetched pages, at most 20 active Discord adapter handlers, and
bounded prompt/output/SSE sizes. Each OpenRouter request has ten minutes to produce its first
non-empty stream chunk; after streaming starts, inference has no application-level deadline and is
cancelled only by shutdown or an upstream caller.

Before inference, Jolanda computes a conservative reservation from the chosen model, reasoning,
prompt ceiling, completion ceiling across tool rounds, provider price ceilings, and search/fetch
allowances. MongoDB
reserves that amount transactionally. Exact request usage replaces it when OpenRouter reports
usage; otherwise the full reservation is charged. Configuration fails when a budget cannot cover one
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
the release command additionally covers every reasoning effort, web search on each model,
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

## Automatic Reels (Instagram and TikTok)

Automatic reposting is disabled by default. Set `INSTAGRAM_REELS_ENABLED=true` in the deployment,
then use `/jolanda reels enabled:true` in one test channel. Manage Server is required. Supported
channels are ordinary server text and announcement channels; the bot needs View Channel, Send
Messages, Read Message History, and Attach Files. `/jolanda settings` shows deployment availability
and the separately persisted channel setting. Disable a channel with `/jolanda reels enabled:false`;
the deployment switch disables both platforms in all channels without deleting their settings.
TikTok uses the same switch, channel setting, limits, and binaries; the existing `INSTAGRAM_*`
environment names are retained for compatibility.

A new human message containing a direct public Instagram `/reel/` or `/reels/` link, a TikTok
`/@creator/video/123` or `/@creator/photo/123` link, or a TikTok `vm.tiktok.com`, `vt.tiktok.com`, or `tiktok.com/t/` share
link triggers one media job. Videos produce one MP4 reply with the canonical source link. Code, spoilers,
and angle-bracket links do not trigger it. Only the first supported link is processed, even in
messages mixing both platforms. TikTok share redirects are validated before extraction; successful
reposts link to the canonical post. The original message is preserved. Threads, edits,
backfill, Instagram `/p/`, `/share/`, stories, TikTok profiles, live streams,
and account-only media are unsupported. Busy and rate-limited
local admissions are skipped silently; nothing is queued. AI questions still run independently,
and replies to media messages only start AI work with an explicit content mention. A repost does
not mean the model watched or fact-checked the video.

The default limits are one active media job, two concurrent admission operations, two attempts per
member and ten per guild per minute, 20 MiB per upload, and three minutes of media. Each job tries
up to three distinct compatible source versions, preferring a version that already fits. Source
downloads stream to disk with a separate 100 MiB cap per attempt; smaller alternatives are tried
when a source exceeds the upload limit. At most two source files are retained at once.

TikTok photo posts attach original JPEG, PNG, or WebP images in their original order, without
re-encoding or soundtrack audio. Up to 35 photos share one aggregate upload-size cap (20 MiB by
default). Albums exceeding that cap or photo count are rejected in full. All photos download before
publishing, then send in batches of up to ten per reply, with numbered ranges and distinct nonces.
The bot checks the source and channel setting again before every batch. If a later batch fails or
the source disappears, earlier batches remain; the album is not automatically replayed. Photo
metadata comes from a bounded public TikTok page request; it uses no account or extraction service.

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

Public video identifiers are sent to Instagram/Meta or TikTok according to the source link. Videos and photos exist temporarily in an owned private
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
