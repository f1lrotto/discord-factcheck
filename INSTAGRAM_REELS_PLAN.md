# Instagram Reel downloads for Jolanda

Status: implemented locally on 13 September 2026; Railway-network and Discord desktop/mobile
playback acceptance remain pending. The deployment switch remains disabled by default.

Implementation note: media delivery uses discord.js MessagePayload with a dedicated REST client
(15-second timeout, no retries, immediate rate-limit rejection) so media operations cannot wait
behind assistant sends. This preserves ordinary attachment replies, references and nonce semantics.

Prepared on 13 September 2026 against the current working tree, including its existing uncommitted
changes.

## 1. Outcome and recommendation

When a member posts a public Instagram Reel in an enabled Discord channel, Jolanda should download
the video anonymously and reply to that message with an MP4 attachment and the original Reel link.
Members can then play the video inside Discord.

Build this as ordinary bot functionality, independent of the language model. Use a pinned yt-dlp
release to extract media information, a bounded Node.js downloader to retrieve the selected MP4,
and discord.js to upload it. No Instagram account, browser session, paid extraction API, or
OpenRouter call is required by this design.

The local investigation successfully downloaded Reel `DcjOE3QxRqW` as an MP4 of 6,427,035 bytes
without supplying credentials or cookies. The locally installed yt-dlp version reports
`2026.08.19`. This demonstrates anonymous retrieval for that example from the local network; it
does not establish hosting-network reliability, audiovisual correctness, or Discord playback.
Those require explicit validation during implementation.

## 2. First-release behavior

- Enable automatic reposting separately for each channel through an administrator command.
- Process new human messages containing direct `/reel/<shortcode>/` or `/reels/<shortcode>/` links.
- Download at most the first eligible Reel in each message. Repeated copies of the same URL within
  a message count once.
- Reply once with the video and `Instagram Reel · <canonical source URL>`; do not ping the author.
- Preserve the original message and its attribution. Do not delete, rewrite, or suppress its embeds.
- Keep downloads anonymous. If Instagram requires authentication, stop rather than introducing an
  account or credential fallback. Anonymous cookies generated internally by Instagram requests are
  different from a logged-in session and need not be persisted.
- Skip oversized, unsupported, deleted, inaccessible, or authentication-blocked media with a short
  failure reply when appropriate.
- Do not post progress messages for this first version. A bounded job ends in a video or one concise
  outcome, avoiding multiple notifications for one shared link.
- Respect code blocks, inline code, spoilers, and angle-bracket links used to suppress previews:
  links appearing in those forms do not trigger automatic reposting.
- An explicit AI question containing a Reel still follows the normal assistant path as well. A media
  job must not prevent the question from being answered, and an MP4 upload must not be represented
  as the model having watched or fact-checked the video.

Direct messages, bot/webhook messages, edited-message triggers, historical backfill, Instagram
stories, profile downloads, `/share/` redirects, `/p/` posts/carousels, and other platforms are outside
the first release. Compression, separate audio/video merging, and external embed services are also
deferred. These limits keep the first deployment easy to measure and operate.

## 3. Current code and integration constraints

- `src/discord-bot.ts` already subscribes to guild messages with the Message Content intent. Its
  current gateway admission gate also handles commands and AI messages.
- `src/discord-messages.ts` ignores messages that do not mention Jolanda or reference a conversation.
  It also uses bot-author/replied-user checks when identifying continuations. Media messages require
  more precise conversation identification.
- `src/discord-response.ts` is the streamed AI answer renderer. It applies mention protection and
  `SuppressEmbeds`; it is not the correct owner for downloading or uploading media.
- `src/discord-commands.ts` implements `/jolanda` settings and checks Manage Server at execution time.
- MongoDB already provides HMAC identifiers, TTL indexes, and operation deadlines. AI settings live
  in `src/models.ts` and `src/mongo-settings.ts`; media settings should have their own small store.
- `src/index.ts` composes the services and shuts down AI work before draining Discord handlers.
  Media jobs need cancellation before that drain as well.
- The runtime Docker image contains Node.js and application dependencies, but no yt-dlp/Python or
  media inspection tools.
- `SECURITY.md` specifies one Railway replica. Retain that topology; handle rolling deployment
  overlap with durable delivery claims rather than adding an active-active worker system.

## 4. Channel settings and permissions

Add `/jolanda reels enabled:<boolean>`, operating on the channel where the command is invoked.
Require Manage Server using the existing execution-time permission check. Support ordinary guild
text channels and announcement channels initially; reject other channel types with a clear command
response. Thread support can follow once its settings inheritance and permissions are specified.

Defaults:

- No stored channel setting means disabled.
- A deployment-wide `INSTAGRAM_REELS_ENABLED=false` switch disables the feature everywhere.
- Channel settings persist independently of the deployment switch.
- `/jolanda settings` shows both deployment availability and the current channel setting.
- `/jolanda privacy` explains automatic link processing, temporary downloads, and Discord storage.

At enable time and before processing, check View Channel, Send Messages, Read Message History, and
Attach Files. Recheck before upload because permissions may change while a download runs. Do not
request Manage Messages. The implementation uses attachments and does not require custom rich
embeds; verify the exact playback/permission combination in the live test channel.

Read the setting only after finding a syntactically eligible link. Ordinary channel traffic should
not cause a database lookup. Read it again before publishing so disabling a channel takes effect
for pending jobs. A small local pre-admission gate must bound concurrent settings lookups.

## 5. Proposed module boundaries

Use functional factories with injected dependencies, concise functions, and inferred return types
except where an exported contract benefits from an explicit type.

- `src/instagram-links.ts`: pure message parsing and canonicalization. Returns a bounded list of
  validated Reel identifiers and canonical URLs. No network access.
- `src/instagram-downloader.ts`: owns metadata extraction, format selection, local media inspection,
  temporary-file lifetime, and child-process termination. Exposes an operation such as
  `withDownloadedReel({ reel, signal, maximumBytes }, consume)` so cleanup encloses the upload.
- `src/media-http.ts`: implements the bounded HTTPS transfer and redirect/DNS checks for extracted
  media URLs. This is separate because downloader subprocesses do not inherit application URL rules.
- `src/discord-reels.ts`: owns admission, channel authorization, durable claims, user-visible outcomes,
  MP4 delivery, and shutdown. It depends on a downloader and a small `ReelStore` interface.
- `src/mongo-reels.ts`: implements channel settings and atomic delivery claims using the shared Mongo
  context. It does not use AI budgets, request accounting, or conversation locks.
- `src/reel-types.ts`: small shared result, failure, and persistence contracts if these are needed
  by multiple modules. Avoid creating a general media-provider framework for one provider.

Successful download metadata should contain only the owned local path, byte count, verified media
properties, and canonical source URL needed for delivery. Expected failures should be a finite
union, for example `unavailable`, `authentication_required`, `rate_limited`, `too_large`,
`unsupported_media`, `timeout`, `cancelled`, and `extractor_failed`. Unknown upstream text must not
become a public error message.

## 6. End-to-end processing

1. The existing MessageCreate listener continues dispatching assistant work. Independently offer
   eligible messages to the media handler; give it its own admission and lifecycle tracking.
2. Discard unsupported message/channel types and messages without a supported URL synchronously.
3. Check the global switch, bounded pre-admission gate, current channel setting, and permissions.
4. Apply media-specific rate limits and try to acquire the single download slot. Do not enqueue an
   unbounded backlog or hold an AI admission slot while downloading.
5. Atomically claim delivery for this guild/channel/source-message/Reel tuple. A duplicate claim
   causes no additional reply or extraction.
6. Extract metadata with yt-dlp, select one downloadable progressive MP4, and stream it into an owned
   temporary file with hard limits.
7. Inspect the completed file and verify its size and supported media properties.
8. Re-read channel settings and fetch the original message with a deadline. Confirm it still exists
   and still contains the same eligible Reel; abandon delivery if it was deleted or edited away.
9. Record the publishing state, then reply to the original message with the local file, canonical
   source link, safe mentions, and a deterministic nonce.
10. Record the outcome. Delete temporary files in `finally`, and release the slot only after all
    subprocesses, file streams, and Discord operations have settled.

Media failures must be contained within this path. Do not send the AI adapter's generic
“Jolanda is temporarily unavailable” response for a failed automatic download.

## 7. URL parsing and network boundaries

Use the installed link parser where appropriate, with explicit handling of Discord Markdown. Parse
URLs with `URL`, then accept only HTTPS, exact approved Instagram hostnames (`instagram.com`,
`www.instagram.com`, and `m.instagram.com`), standard ports, no credentials, and an exact supported
path shape. Reject lookalike domains, extra path segments, encoded separators, and malformed IDs.
Shortcodes should contain only bounded ASCII letters, digits, `_`, and `-`; do not assume all future
shortcodes have exactly the sample's length.

Reconstruct `https://www.instagram.com/reel/<shortcode>/` from the parsed identifier. Drop sharing
parameters and fragments, including the sample's `stkn` parameter. Never pass original message text
or an arbitrary extracted command to a subprocess.

For media retrieval, accept only HTTPS URLs on known Instagram/Meta CDN suffixes, using label-aware
checks rather than substring matching. Start with the CDN families observed in extraction and the
test corpus, such as `cdninstagram.com` and `fbcdn.net`; reject unexpected hosts pending review.
Reject credentials, nonstandard ports, private/loopback/link-local/reserved IPs, and IPv4-mapped
variants. Revalidate every redirect, with a maximum of three.

Perform DNS validation in the actual connection lookup and use that validated address for the
connection while preserving TLS hostname verification. A preflight DNS check followed by an
unrestricted fetch is insufficient. Do not forward authentication/cookie headers. If media retrieval
needs request headers, allow only a small explicit set such as a known User-Agent and canonical
Instagram Referer. Signed CDN queries stay in memory and never enter logs or MongoDB.

These controls govern Node's file transfer. yt-dlp itself still contacts Instagram to extract
metadata; an application URL parser is not a sandbox for its internal requests. Restrict it to the
Instagram extractor, disable configuration/plugins, provide a minimal child environment, and keep
the dependency patched. Stronger network/process isolation is a separate improvement if needed.

## 8. Anonymous extraction and MP4 selection

Run the pinned yt-dlp executable through `spawn` with an argument array and `shell: false`. Use a
metadata-only invocation with `--ignore-config`, `--no-plugin-dirs`, `--no-cache-dir`,
`--no-playlist`, and `--dump-single-json`. Set socket and retry limits explicitly and validate the
Instagram-only extractor selector against the pinned release. No browser-cookie, cookie-file,
netrc, password, custom-config, or user-provided argument support should be exposed.

Provide a minimal child environment that excludes Discord, OpenRouter, MongoDB, and data-protection
secrets; do not inherit proxy/config overrides unintentionally. Use an owned working directory.
Bound metadata stdout to 1 MiB and diagnostic stderr to 16 KiB. Terminate on overflow and classify
the result. Parse only the fields needed for selection; discard the complete response afterwards.

Prefer a single HTTPS MP4 containing video and its source audio, with compatible H.264/AAC codecs
when available. Pick the best candidate under the byte budget when its size is known; size estimates
are hints, not enforcement. Do not select manifest protocols, playlists, separate video/audio
tracks, or formats requiring ffmpeg to download or merge. Handle genuinely silent source videos
without inventing an audio requirement. If metadata cannot establish a compatible candidate, fail
as unsupported or validate a bounded candidate through media inspection.

Node should own the actual download so bytes can be counted while streaming. Abort on excessive
Content-Length or when streamed bytes exceed the cap, even if the header is missing or false.
Reject HTML/JSON responses and empty files. Do not buffer an unlimited response in memory or trust
an `.mp4` extension alone.

After downloading, run a bounded `ffprobe` against the owned local file to verify an MP4 container,
video stream, supported codecs, and available duration. Restrict probe protocols to local file
access and bound probe output, work, and execution time. Preserve source audio when available.
Inspection does not prove every frame decodes; representative playback remains a release check.

## 9. Resource limits and cleanup

Initial policy values are implementation defaults to validate during the hosting trial:

- One active media job process-wide, including extraction, download, inspection, and upload.
- At most two concurrent media pre-admission operations; no waiting job queue.
- At most one eligible Reel processed per source message.
- Two attempts per member per minute and ten attempts per guild per minute. Count admitted failures
  too. These are separate from the AI prompt limits.
- Extraction deadline: 20 seconds. Download deadline: 30 seconds. Probe deadline: 5 seconds.
  Overall pre-upload deadline: 60 seconds; each stage receives only the remaining overall time.
- Initial application file cap: 9 MiB, deliberately conservative. Raise only after testing the bot's
  actual attachment allowance in the target guild. Known Discord limits may lower this cap.
- Initial media-duration ceiling: three minutes where duration can be established. Unknown duration
  must not bypass byte/time limits; resolve through inspection or reject if still indeterminate.
- Discord upload uses a finite, verified transport timeout. Begin with the existing 15-second REST
  timeout and measure it with near-cap files before changing it.

Discord currently documents a default 20 MiB file limit, but that is not proof of this bot's effective
allowance. Automatic MessageCreate events also do not provide the interaction-specific
`attachment_size_limit`. Handle Discord's actual too-large response even after local checks.
[Discord upload reference](https://docs.discord.com/developers/reference#uploading-files).

Create one private temporary directory per job and a generated filename, never an upstream title.
Use streaming backpressure, count actual written bytes, and close file handles before deleting.
Account for discord.js potentially buffering the bounded attachment during upload. With one job,
both the on-disk file and any upload buffer remain bounded.

On abort, send SIGTERM, escalate to SIGKILL after a short grace period, and await process exit.
Retain ownership of any noncancelable Discord promise until it settles; a Promise.race timeout does
not cancel an upload. On shutdown stop admission, abort extraction/transfers, settle or bound active
uploads, clean files, then drain Discord and close MongoDB. Do this alongside AI shutdown rather
than waiting for a long AI turn before signaling media jobs.

On startup, remove stale directories only within the application's dedicated media scratch root,
with an age threshold greater than a job's maximum lifetime. Never recursively sweep general `/tmp`.
Clean up initialized media resources on Discord login failure as well as normal shutdown.

## 10. Delivery claims and persistence

Add a separate channel-settings collection keyed by a domain-separated HMAC of guild and channel.
Store only `enabled` and update metadata alongside pseudonymous identifiers. This avoids coupling
media toggles to model/reasoning validation or `replaceOne` updates in existing AI settings.

Add a media-delivery collection keyed by a domain-separated HMAC of guild, channel, source message,
and shortcode. Suggested fields are `status`, `leaseOwnerKey`, `leaseExpiresAt`, `createdAt`,
`updatedAt`, `expiresAt`, a finite outcome category, and an optional HMAC of the delivered message ID.
Store no caption, original message body, raw Discord ID, signed media URL, or video bytes.

Use atomic claims and owner-checked state changes. Proposed states are `processing`, `publishing`,
`sent`, `failed`, and `uncertain`. Give processing a lease longer than the maximum job plus shutdown
grace, for example three minutes, and receipts a 24-hour TTL. Check expiry in application queries;
Mongo TTL deletion is asynchronous. No background history scan or automatic job recovery is needed
for the first version. Expired pre-publish claims may be replaced only when the same event is offered
again; publishing/uncertain claims suppress replay until receipt expiry.

Use a stable, namespaced nonce no longer than Discord's permitted length and `enforceNonce: true`
when publishing. Discord only deduplicates nonces for a short recent window, so this complements
durable claims rather than providing permanent exactly-once delivery.
[Discord Create Message](https://docs.discord.com/developers/resources/message#create-message).

If an upload times out after it may have reached Discord, mark it uncertain and do not automatically
re-upload or send a second failure message. Likewise, a successful upload followed by a failed
receipt update must not trigger another upload. Prefer a missed automatic preview over duplicates
in ambiguous cases. State explicitly that delivery is best effort, not exactly once across crashes.

Deduplicate the source event, not every appearance of a Reel forever. A later deliberate post of the
same Reel may produce a new reply. Process-local rate limits are acceptable under the documented
single-replica topology; rolling overlap can briefly increase aggregate attempts, while shared claims
still protect the same source event. A distributed quota is needed before supporting multiple active
replicas.

## 11. Discord replies and conversation routing

Upload the owned local file through `message.reply({ files: [...] })` with a generated filename such
as `instagram-reel.mp4`, `allowedMentions: safeMentions`, and the canonical source link enclosed in
angle brackets. Use ordinary attachment messages, not Components V2 or custom `EmbedBuilder` video
fields. Set reference behavior to fail if the original message no longer exists.

Do not run media messages through `createResponseSink` or relax AI output sanitization. Do not
blindly copy `safeMessageFlags` into the media path: verify the attachment player's behavior with
the chosen flags on desktop and mobile. The angle-bracket source link avoids an extra URL preview.

Fix continuation detection before enabling the feature:

- A reply continues an AI conversation only when its referenced message is linked to a stored
  conversation in the same guild and channel. Retain creator ownership checks in the core.
- Being authored by Jolanda, or having `mentions.repliedUser` set to Jolanda, is insufficient.
- Distinguish an explicit mention token in the message content from Discord's automatic reply ping.
- An unmentioned reply to a media post should not start AI work or report an expired conversation.
- An explicit `@Jolanda` question replying to a media post may start a new AI conversation with the
  textual source reference. It does not create video understanding or automatically download again.
- Existing replies to every chunk of an AI answer must continue working without another mention.

Keep settings and media failure messages out of the AI conversation link store as well.

## 12. Failure UX, privacy, and observability

Use fixed, short copy rather than raw subprocess errors:

- Unavailable/authentication required: “I couldn’t access this Reel without an Instagram login.”
  Use this wording only when the category is established; unknown failures get generic copy.
- Too large: “This Reel is too large to upload here. You can still open the original link.”
- Unsupported media: “I couldn’t retrieve a compatible video for this Reel.”
- Timeout/unknown extraction failure: “I couldn’t download this Reel right now.”

Disabled channels, duplicates, source deletion, shutdown cancellation, and already-ambiguous uploads
stay silent. Rate-limited or busy messages may receive one channel-throttled notice, at most once per
minute; do not imply that a skipped job was queued. Missing Send Messages permissions can only be
logged. Expected media failures should not be logged as assistant outages.

Emit one structured `instagram_reel` outcome event per admitted job, containing pseudonymous scope
keys, finite outcome/stage, downloader version, byte count, timing, and safe process/HTTP status when
available. Do not log raw stderr, metadata JSON, message content, captions, credentials, paths
containing identifiers, or signed CDN URLs. Capture enough finite diagnostics to distinguish an
Instagram block from a Discord permission or upload failure.

Document that media retrieval sends the public Reel identifier to Instagram/Meta, temporarily stores
the video on the host, and uploads a copy to Discord. The copy follows Discord message retention,
not the bot's Mongo transcript TTL. Deleting the original Instagram post or Discord link does not
automatically delete an already-uploaded copy in version one. Administrators can remove the bot's
message through normal Discord moderation.

## 13. Dependencies and deployment

Use yt-dlp directly, without an extra npm downloader wrapper. Install Python packages through the
Python package manager in an isolated environment, using a committed version pin and reproducible
dependency lock where applicable. The locally tested version is a candidate, not a promise that
future Instagram changes will remain compatible. Install Python, CA certificates, and ffprobe via
the container's package manager; ffprobe is commonly supplied by the ffmpeg OS package.

Keep the runtime non-root. Make the scratch directory writable by the runtime user and keep
credentials out of subprocess environments. Do not mount browser profiles or configure cookies.
Do not auto-update yt-dlp on every request or container startup; update it through a tested rebuild.

Add strict configuration validation for the deployment switch, executable paths, byte cap, and job
deadline. Parse boolean strings explicitly so `"false"` cannot become truthy through coercion.
Keep most rate/stage defaults in a dedicated limits module until operations demonstrate a need to
configure them. When globally disabled, avoid requiring downloader binaries at startup. When enabled,
validate required binary availability and version before accepting media jobs; report deployment
misconfiguration clearly.

No persistent media volume or public HTTP endpoint is required. Stay on one Railway replica. Compare
image size, idle memory, peak job memory, download latency, and upload bandwidth against the existing
deployment. Media has no LLM charge, but hosting resources and network traffic still have a cost.

## 14. Implementation sequence and file impact

### Phase A — deployment feasibility

Reproduce anonymous retrieval in the proposed container from Railway's network with a small,
representative set of public Reels, including `DcjOE3QxRqW`. Inspect formats and file sizes, and verify
sound and playback in a designated Discord test channel. Posting to that channel belongs to an
explicitly authorized implementation test, not this planning task. If hosting requests are blocked,
pause rollout rather than silently introducing cookies or paid providers.

### Phase B — extraction and bounded download

Add `instagram-links.ts`, `instagram-downloader.ts`, `media-http.ts`, and shared contracts/limits only
where useful. Implement parsing, process deadlines, metadata selection, transfer limits, local
inspection, cleanup, and finite error mapping before connecting them to live MessageCreate events.

### Phase C — settings and delivery state

Add `mongo-reels.ts`; extend `mongo-schema.ts` and initialization indexes. Compose the media store
through `mongo-store.ts`, exposing it separately from the core `JolandaStore` contract where possible.
Inject it into the bot/commands instead of making every AI-store test double implement media APIs.
Add the command and settings/privacy text in `discord-commands.ts`.

### Phase D — gateway and upload integration

Add `discord-reels.ts`; wire independent admission in `discord-bot.ts`. Correct conversation
recognition in `discord-messages.ts`, including automatic reply mentions. Implement source rechecks,
claims, nonce handling, upload failure handling, and cancellation. Wire startup/shutdown in
`index.ts`, extending lifecycle tests and changing `lifecycle.ts` only if its interface needs it.

### Phase E — packaging and rollout

Update `Dockerfile`, dependency pin/lock files, `config.ts`, `.env.example`, `README.md`, and
`SECURITY.md`. Add smoke-test tooling and package scripts using the project's pnpm workflow.
Enable only the chosen test channel first, then the intended channel after the release criteria pass.
Existing model files, prompts, accounting, and answer renderer should need no feature changes.

## 15. Automated verification

Use meaningful behavior tests, fake subprocesses/local HTTP fixtures, and Mongo integration tests.
Normal `pnpm check` must not contact Instagram, Discord, or paid providers.

1. Parsing: real sample with `stkn`, punctuation, Markdown links, repeated links, multiple Reels,
   protected code/spoiler/angle forms, lookalike domains, credentialed URLs, encoded separators,
   unsupported paths, and boundary-length inputs.
2. Downloader: progressive MP4 selection, missing/estimated sizes, silent clips, incompatible
   codecs, invalid/oversized JSON, authentication and rate-limit classification, timeout, abort,
   child spawn failure, stderr flood, and forced termination.
3. Transfer: false/missing Content-Length, cap exceeded mid-stream, redirect loops, disallowed hosts,
   private IPv4/IPv6 and mapped addresses, DNS rebinding prevention, stalled streams, HTML masquerading
   as MP4, disk errors, and cleanup following every failure. Network dependencies should be injected
   so tests need not weaken production address restrictions.
4. Media inspection: valid video with audio, legitimate silent video, invalid/truncated container,
   excessive duration, unsupported codec, probe timeout, and network protocol restrictions.
5. Mongo: default disabled, channel/guild isolation, concurrent claim winner, owner-checked updates,
   expired claims before TTL cleanup, terminal/uncertain replay suppression, and interrupted writes.
6. Discord: permissions, enable/disable during a job, source deletion/edit, one attachment and source
   link, no mentions, duplicate events, oversized upload response, uncertain send, and preserved AI
   responses for messages that also ask a question.
7. Conversation regression: replies to every AI chunk still continue; replies to media/status messages
   do not; explicit content mentions still start questions; automatic reply pings are not explicit
   mentions; conversation ownership and guild/channel boundaries remain enforced.
8. Admission/lifecycle: media saturation does not consume AI slots; rate limits and notice throttles
   apply; shutdown cancels active work and waits for cleanup; no pending child processes, temp files,
   upload promises, or database operations outlive their owners.
9. Logging/configuration: event fields contain no raw URLs/IDs/secrets, strict booleans and numeric
   bounds, missing executables when enabled, and successful startup without them when disabled.

After each implementation increment, run `pnpm format` and `pnpm check`. Before the final rollout,
also run `pnpm format:check`, `pnpm build`, and `pnpm audit --prod`, and build/test the actual Docker
image. Preserve existing coverage thresholds. Existing paid OpenRouter release tests remain subject
to the project's capped-key release procedure; they are not a substitute for media smoke tests.

## 16. Live acceptance and rollout criteria

Use an explicitly invoked smoke test, never part of ordinary CI. Test at least five representative
public Reels across different authors, including portrait video, sound, a silent example if available,
and a larger clip. Include inaccessible and oversized fixtures to verify the failure behavior.

Release when:

- The provided sample and the representative public sample retrieve anonymously from Railway, with
  successes and failures recorded rather than claiming a universal success rate.
- Uploaded videos play with correct orientation and expected sound on Discord desktop and mobile.
- Posting requires no mention, no account, and no extra action from members in the enabled channel.
- Every completed job removes local media; upload ambiguity does not cause duplicate responses.
- Jobs respect memory, byte, time, concurrency, and shutdown limits in the runtime container.
- AI questions and conversation continuations work while a media job is active.
- Channel disable and the deployment switch stop new processing, and disabled settings survive
  restart without unexpected enablement.
- Automated checks and container checks pass; operational failure categories are visible in logs.

Start with one enabled channel and observe outcomes, peak memory, and response time for a few days.
Disable the channel or deployment switch if Instagram blocks requests or downloads interfere with
normal bot operation. Rollback requires no deletion of AI data or already-posted Discord messages.

## 17. Later improvements, driven by observed failures

Consider bounded compression only if oversized files are common; it needs its own CPU/time/temp-space
budget and audio/video tests. Consider `/share/` resolution, `/p/` video posts, thread support, a manual
retry command, and short-lived caching individually. A managed retrieval provider or separate worker
is a later architectural choice if hosting-network reliability or isolation warrants it. None should
silently change the login-free requirement.

Useful references: [yt-dlp documentation](https://github.com/yt-dlp/yt-dlp),
[Instagram extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/instagram.py), and
[discord.js message options](https://discord.js.org/docs/packages/discord.js/main/MessageCreateOptions:Interface).
