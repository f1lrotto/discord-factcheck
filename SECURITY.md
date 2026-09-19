# Security policy

Jolanda handles Discord messages and a paid OpenRouter credential. Treat its deployment as a
small production service even when it is used by only one server.

## Security boundaries

- The servers where the Discord application is installed and its per-channel permissions define where
  Jolanda operates.
- Only members with **Manage Server** can change the model/reasoning profile or ambient-context
  limit. Other members may opt into context only within that server-controlled limit.
- Conversations are bound to the member who started them, their channel, and their guild.
- Every model turn receives the same read-only calculator, clock, time-zone, public web-search, and
  public web-fetch tools. The model decides whether to use them; there is no request classifier or
  isolated research stage. Replies, conversation history, and explicitly requested context can
  therefore influence a model-generated public search query.
- Spend is authorized transactionally against a worst-case model/search envelope before inference.
  Server budgets count only valid reported usage from successful generations. Failed attempts,
  cancellations, expired leases, and unreported usage release reservations without a charge.
- AI/media identifiers and news lookup/receipt keys are HMAC-pseudonymized before persistence or
  structured logging. News also keeps authenticated-encrypted routing identifiers for scheduled delivery.
- Conversation text remains plaintext in MongoDB until its configured expiry so reply chains work.
- Photo attachments from the current or explicitly replied-to message are downloaded only after
  admission and spend reservation. Downloads accept HTTPS Discord attachment hosts only, reject
  redirects, and have byte/time limits. Decoding has a 40-megapixel limit; images are resized and
  re-encoded without metadata in memory. Image bytes and signed attachment URLs are not stored or
  logged, and only inline image data is sent to OpenRouter. Textual descriptions and source markers
  remain in the conversation transcript. Image text is untrusted context and can influence public
  research just like message text. DeepSeek image turns use the ZDR-compatible GLM vision route;
  Luna retains its existing provider retention policy.
- Model output cannot create mentions or embeds, is length-bounded, and has private, credentialed,
  query-bearing, and fragment-bearing links removed. Only exact URLs supplied by bounded public
  research are allowlisted as citations.
- Final source-basis labels come from structured OpenRouter search usage and citation annotations,
  never from model-authored claims. No-search, searched-with-sources, searched-without-links, and
  unreported states remain distinct. Bounded citation ranges may add trusted inline source markers;
  malformed ranges are ignored, annotation excerpts are discarded, and unmatched model-authored
  link destinations remain non-clickable while their plain labels may remain visible.
- Progress rendering accepts only provider-labelled reasoning summaries. Raw and encrypted reasoning
  blocks are ignored, and neither progress stages nor summaries are persisted or logged. The
  heartbeat remains active through answer streaming and final persistence, then stops before the
  final Discord synchronization.
- OpenRouter error bodies are byte-bounded and schema-decoded into a finite safe taxonomy. Public
  failures contain only a reason and pseudonymous reference; matching Railway events may contain
  bounded status, code, generation, provider, routing, and timing fields but never upstream messages.
- Discord gateway work is admitted through a fixed process-wide gate before reference or database
  lookups; Discord REST and adapter operations have finite deadlines.

Prompting and model refusals govern when read-only tools are used; they are not authorization
controls. Deterministic limits still bound spending, tool calls, time, output, citations, Discord
permissions, and network targets. Jolanda's model-facing tools cannot write data, send
messages outside the current Discord response, execute code, or access private services.

## Required production controls

1. Generate `DATA_PROTECTION_SECRET` independently from every API credential and keep it stable.
   Rotating it makes existing AI/media pseudonymous records unreachable until their TTL expires.
   News detects a changed secret and fails explicitly instead of silently orphaning its address book;
   follow the maintenance procedure in [news operations](NEWS_OPERATIONS.md#secret-maintenance).
2. Use a dedicated, least-privilege Atlas database user and a TLS-enabled Atlas URI. Restrict the
   network access list where Railway networking permits it.
3. Review each model's retention warning before selecting it. Jolanda requests Zero Data Retention
   whenever the model catalogue marks a compatible route, but models labeled `[no ZDR]` may be
   retained by their provider. OpenRouter account or guardrail ZDR settings are stricter and can
   still make those models unavailable.
4. Create a dedicated OpenRouter key and set its provider-side monthly cap to `$10`. The application
   separately enforces the `$2` UTC daily and `$10` UTC monthly server budgets.
5. Keep Railway variables encrypted and do not put `.env`, database dumps, logs, or Discord exports
   in source control.
6. Run one Railway replica. Lease-based recovery protects rolling overlap, but active-active gateway
   operation is not a supported deployment topology.
7. Review Atlas backup retention and Railway log retention against your privacy policy. Atlas TTL
   deletion is asynchronous and does not immediately remove backup copies.

Members can run `/jolanda privacy` to see the per-interaction context default and limit alongside the
transcript-retention settings. Ambient context is read only when the member begins a prompt with
`+context` or `+context=N`; this opt-in does not persist to later interactions.
Because direct web tools are available on model turns, members must assume that any supplied context
may influence a public search query and must not include passwords, tokens, payment data, or other
secrets.

## Incident response

If a Discord, OpenRouter, MongoDB, or data-protection secret may have leaked, revoke the affected
credential first, stop the Railway service, inspect pseudonymous structured events and provider
usage, then deploy replacement secrets. If the HMAC secret leaked, expire stored transcripts and
message links as part of the response.

Do not include secrets, message contents, database dumps, or raw Discord identifiers in a security
report. Report the affected version, observed behavior, timestamps, and sanitized reproduction
steps to the repository owner through a private channel.

## Verification

Before deployment, run:

```sh
pnpm format:check
pnpm check
pnpm build
pnpm audit --prod
```

Paid provider compatibility tests are opt-in and require a deliberately capped test key:

```sh
OPENROUTER_LIVE_TEST_KEY=... pnpm test:release-live
```

The release command enables model/language, every reasoning effort, web-search, prompt-injection,
and direct-misuse checks, and exits nonzero before Vitest if the key is missing. Ordinary checks do
not enable live calls even when the key is exported. Never use an uncapped production credential
for this paid gate.

## Automatic media boundary

Reel reposting covers Instagram and TikTok with shared channel settings, admission, rate limits and HMAC delivery
claims. It is disabled deployment-wide by default, and only Manage Server can change channel settings.
It never enters the model runner, AI budget accounting, or conversation-link store. One active job
and two admission operations bound host work; local rate limits assume the single-replica topology.
Owner-checked claims last 24 hours and processing leases last six minutes. Expired processing can
be reclaimed only on a repeated source event; publishing and uncertain receipts suppress replay until
receipt expiry. Nonces complement claims but do not establish exactly-once delivery across crashes.

Only canonical HTTPS Instagram Reel or TikTok video URLs reach a shell-free yt-dlp invocation,
restricted to the matching platform extractor. TikTok short shares resolve through at most three
HTTPS redirects, each limited to supported TikTok links with public DNS pinning; profiles and
other destinations are rejected before extraction.
Configuration, plugins, caches and inherited secrets/proxies are excluded. Extraction output and
runtime are bounded. yt-dlp's internal platform requests are not sandboxed by the Node URL validator;
keep the pinned extractor patched. Node transfers use separate platform allowlists: `cdninstagram.com`
and `fbcdn.net` for Instagram; `tiktok.com`, `tiktokcdn.com`, `tiktokcdn-us.com`, `tiktokcdn-eu.com`, `tiktokv.com`,
`tiktokv.us`, `byteoversea.com`, and `ibytedtos.com` for TikTok. Hosts match on label boundaries,
require HTTPS, validate every redirect against the same platform, and connect only to validated
public DNS addresses.
For TikTok videos, the bounded extractor User-Agent and canonical source Referer accompany media
requests. Only anonymous `ttwid`, `tt_chain_token`, and `tt_csrf_token` cookies scoped to
`.tiktok.com` and `/` are retained in memory for the job. Quoted values are decoded within a strict
character allowlist. These cookies are stripped on redirects outside `tiktok.com`; authentication
cookies and arbitrary upstream headers are never forwarded. Instagram transfers remain cookie-free.
Streamed bytes enforce the cap even without a
truthful Content-Length; local ffprobe verifies compatible MP4/H.264/AAC streams and bounded duration.
Each job tries at most three distinct sources, capped at 100 MiB each, with a shared 60-second
download deadline. At most two source files coexist. Oversized media is compressed locally with
single-threaded decoding, filtering, and encoding, two passes and at most one bitrate retry, under
a shared 120-second compression deadline. FFmpeg accepts only local MOV/MP4 inputs, receives no
inherited credentials, and cannot fetch remote media. Output writing stops above twice the upload
cap; oversized, empty, incompatible, audio-losing, or duration-changing results are rejected.
The 240-second overall pre-upload budget fits within the processing lease. Final attachments
remain capped at the configured upload limit (20 MiB by default).
Instagram image posts use the canonical `/p/<shortcode>/embed/captioned/` page with public DNS
pinning, a 2 MiB response cap, and the extraction deadline. No redirects or account cookies are
allowed. The embedded JSON must match the requested shortcode and contain only still images;
mixed video carousels are rejected in full. Tracking and selected-slide parameters are discarded.
Instagram and TikTok share photo transfer, byte limits, signature checks, and cleanup.
TikTok photo pages use a separate public-DNS-pinned HTTPS fetch with a 2 MiB cap and the extraction
deadline. Redirects must remain on a supported TikTok post with the same ID. Photo metadata selects
only allowlisted JPEG/PNG/WebP CDN URLs; downloaded file signatures are checked without decoding.
Up to 35 original photos share the configured upload cap and a 60-second download deadline. All
photos are downloaded before publication and cleaned with their owned job directory. Albums send
in batches of ten, sharing one claim with distinct batch nonces and source checks before each send;
failed or partial publication is not automatically retried.
The container runs as a non-root user. Deployment memory limits should account for child processes
and bounded Discord attachment buffering.

Media sends use a dedicated discord.js REST transport with a 15-second timeout, no automatic retries,
and immediate rate-limit rejection. Noncancelable work is retained until settled, including uploads,
before temporary-file cleanup and slot release. Shutdown signals AI and media together, then drains
Discord before closing MongoDB. Successful sends followed by receipt errors and ambiguous sends do
not trigger another upload or failure notice. Expected failures use fixed templates with numeric sizes and finite event fields;
logs and Mongo contain no raw Discord IDs, signed CDN URLs, subprocess diagnostics or media bytes.

The public post identifier leaves the host for Instagram/Meta or TikTok; temporary videos and photos are copied to
Discord. Discord retention governs that copy, including after source deletion. Moderators must remove
copies through Discord. No login fallback, browser cookies, video splitting, merging or historical scan
is supported. Keep deployment availability off until Railway-network retrieval and desktop/mobile
playback acceptance checks in README pass. The explicit smoke test sends no Discord messages.

## Scheduled news boundary

News has no model calls, generated summaries, media jobs, or access to AI conversations and budgets.
Only Manage Server can configure, disable, or inspect feeds. Configuration and delivery both check
the selected guild destination's effective View Channel, Send Messages, and Embed Links permissions.
The optional daily role must belong to that guild and be mentionable or permitted by the bot's
effective Mention Everyone permission. The everyone role is never accepted. Continuous messages
suppress notifications and all mentions; daily messages permit only the explicitly selected role.

Guild/channel/optional role references use AES-256-GCM with a fresh nonce, a versioned format, and
subscription/revision-bound authenticated context. HKDF derives separate encryption and HMAC keys
from the existing deployment secret. Disabling or removing a guild erases retrievable routing data;
non-reversible delivery tombstones remain. Encrypted storage still requires protecting the secret
and database backups. It does not shorten Discord's retention of already posted messages.

Short Mongo transactions serialize news configuration, collection state, planning, and send admission.
The durable `sending` transition is the uncertainty boundary: a crash after it may miss a message,
but cannot blindly replay it. Nonces provide additional short-window suppression, not distributed
exactly-once delivery. Permission loss pauses delivery without posting public failure notices.

Continuous observations expire seven days after their last observation. Complete daily edition/cache
bodies have separate TTL storage expiring seven days after publication; reads reject expired bodies
even before Mongo cleanup. Current-day bodies may survive disabling the last subscriber for same-day
reconfiguration and fallback suppression. Older unnecessary bodies are removed on last-subscriber
removal. Terminal outbox records drop payloads and retain deduplication metadata/hashed receipts for
30 days beyond the delivery deadline. Bounded source schedule/cache-reference metadata remains;
raw publisher HTML is never stored in Mongo or logs. Backups follow their own configured retention.

Anonymous publisher requests enforce exact HTTPS host/path rules, validated redirects, public DNS
pinning, a 3 MB body cap, and a 25-second per-request deadline. Daily attempts request the listing
and at most one candidate. Optional images use publisher metadata without additional article or
image retrieval by Jolanda. Malformed pages do not replace good cache validators. Access denial
causes at least a six-hour cooldown; ordinary failure backoff starts at 20 minutes and doubles up
to six hours, respecting longer Retry-After values. No login, cookie, proxy, or generated-digest
fallback bypasses a publisher restriction.

News Discord requests use bounded native HTTPS fetches, no automatic retries, explicit cancellation,
and timestamp cooldowns. They share the bot token's quota with AI/media. Payloads contain bounded,
escaped source text and allowlisted source/image URLs. Logs use finite outcomes and hashed scopes,
without raw routing IDs, tokens, source bodies, or upstream error bodies.

## Scheduled personal features

Reminder destination encryption uses a separate `jolanda/reminders/v1` key namespace; briefing
routing uses `jolanda/briefing/v1`. Both derive from `DATA_PROTECTION_SECRET` and authenticate the
record key. Identifiers used for guild, owner, channel, leases and reminder lookup are HMAC keys;
public reminder handles are random. Reminder text and configured city names/coordinates are
plaintext. Reminder records expire seven days after their due date; delivery receipts for briefings
last seven days. TTL expiry is enforced in eligibility queries; MongoDB physical deletion can lag.
Terminal reminders erase encrypted routing; briefing disable erases routing and fences unsent work.

Reminders are owner-scoped for listing/cancellation and guild-scoped for the 20-active limit,
enforced by a partial unique index even across concurrent replicas. Due selection, claiming and
begin-send are atomic. Expired claimed work is recoverable; expired sending work becomes uncertain
and is never automatically retried. Nonces offer Discord's additional short-term deduplication;
they are not an exactly-once guarantee. The only allowed user mention is the reminder owner.
Briefing messages suppress all mentions and only include agenda text from their destination channel.

The model reminder function has no database, network, Discord IDs or mutable external state.
It returns a validated absolute-time draft; the authorized application turn persists it before
showing a final confirmation. One reminder per turn avoids partial multi-draft commits. Retrieved
pages and quoted context are not authorization to create reminders. Ordinary conversational creation
uses normal model limits/accounting; structured reminder commands and briefings do not use a model.

Two HTTPS hosts are added: `geocoding-api.open-meteo.com/v1/search` receives city names when an
administrator configures a city; `api.open-meteo.com/v1/forecast` receives only city coordinates,
time zone and forecast parameters. Neither receives Discord identifiers or reminder text.
The shared transport checks DNS answers at socket lookup, rejects non-public addresses and
redirects, validates JSON content type, and bounds headers, bytes and deadlines. Calendar data is
bundled offline, with source provenance in `src/briefing/namedays.ts` and `calendar.ts`.

Usage breakdowns require Manage Server and match only existing Discord member-cache IDs against
stored pseudonyms. No member-list fetch or privileged intent is introduced. Request aggregation
filters both the reporting window and logical expiry; long-lived daily budget totals are labelled
separately from short-lived member request records. Guild language affects application copy only,
not model prompts, clock snapshots or persistence keys.
