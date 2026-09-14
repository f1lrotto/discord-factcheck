# Jolanda news: implementation plan

Status: implementation in progress; see [NEWS_TASKS.json](NEWS_TASKS.json) and
[NEWS_ACCEPTANCE.md](NEWS_ACCEPTANCE.md) for current acceptance evidence. Updated 14 September 2026.

This is the implementation contract for two scheduled news feeds in the existing Jolanda bot. It supersedes the earlier architecture exploration wherever that document describes channel configuration or scheduling as undecided. Development will use the orchestrator–worker protocol in [NEWS_AGENT_RUNBOOK.md](NEWS_AGENT_RUNBOOK.md); [NEWS_TASKS.json](NEWS_TASKS.json) records task dependencies and execution status. The agent workflow is used to build the feature. It is not part of the running Discord bot.

The planning baseline was commit `7f38348e632e5c219bfed95d7bbcc3b9fa0dc370`.
Initial, unverified scaffolding had been removed when this plan was written.
Implementation re-inspected that baseline; the integration points below describe
the starting architecture, while the ledger and acceptance packet record the resulting feature.

## 1. Product contract

### Agreed behavior

- Keep the existing repository, Node.js process, MongoDB, and Discord bot identity. Add news as a separate module alongside AI conversations and media reposting.
- Collect **Denník N's important Minúta po minúte selection every 20 minutes**. Publish individual, readable embeds throughout the day. Approximately 15 important stories per day is an orientation, not an enforced quota or a requirement to manufacture content.
- Collect **Aktuality's own daily editorial roundup at 20:00**, with **one fallback at 21:00 if no fresh edition was collected at 20:00**. Do not poll Aktuality every 20 minutes.
- Publish the roundup as **one Discord message**, with at most one notification opportunity. If neither collection finds a fresh edition, skip that day. Do not construct an alternative digest, use Denník N as a fallback, or resend yesterday's roundup.
- Configure each destination using a native Discord channel selector under the existing lowercase command name:
  - `/jolanda continuous feed channel:#news`
  - `/jolanda daily feed channel:#daily-news`
- Preserve title, source link, publication time, and useful available description, tags, and image metadata. Optional metadata may be absent without blocking publication.
- Prevent repeated stories, bursty catch-up after downtime, and duplicate daily messages after restart or deployment overlap.

### Explicit implementation defaults

These resolve unspecified details for a first implementation. They are local design choices, not new user requirements; the orchestrator may refine them with evidence while preserving the agreed behavior.

- **Time zone:** `Europe/Bratislava`, meaning 20:00/21:00 Slovak local time, CET in winter and CEST in summer. This is the interpretation announced in the conversation. Do not silently use fixed UTC+01:00 or the host's local zone. Keep news scheduling independent of any AI conversation time-zone override.
- **Command ownership:** one continuous subscription and one daily subscription per guild. Channel names are selected through Discord and saved by ID. Renaming a channel does not break delivery.
- **Supported destinations:** server text and announcement channels. No DMs, threads, forum channels, cross-server destinations, or automatic announcement crossposting in v1.
- **Administration:** require Manage Server to set, disable, or inspect feed settings. Add `/jolanda continuous disable`, `/jolanda daily disable`, and `/jolanda continuous status` / `/jolanda daily status`. Include a concise feed summary in `/jolanda settings`; dedicated news status must work without an unrelated AI budget read.
- **Notifications:** continuous posts use suppressed push notifications and no mentions. Daily posts use normal channel notification behavior, with an optional `notify-role` selector on the daily feed command for an explicit role ping. No automatic `@everyone` or `@here`. Validate the selected role and permissions; store its ID encrypted with the destination. Member notification settings still determine actual push delivery.
- **Continuous pacing:** start with at most one new continuous message per destination per 20 minutes; queued stories expire after a two-hour catch-up window. Do not add a hard 15-story cutoff. Evaluate a multi-day fixture replay for excessive delay or dropped important stories before accepting this default; adjust pacing through an explicit policy change if needed.
- **No old-news bootstrap for continuous feeds:** activation establishes a subscription-specific baseline against the source snapshot. Enabling a second guild must not replay old continuous content merely because collection already runs for the first guild. Daily subscriptions use current-day edition eligibility, not this baseline; their first valid evening edition must not be discarded.
- **Corrections:** repeated source IDs or minor revisions do not create new posts. Automatic editing of previously delivered embeds is deferred; this avoids introducing recoverable message-ID storage just for edits. Keep a content revision/hash so edits can be added later.
- **Scope exclusions:** no generated summaries, LLM ranking, new OpenRouter tools, additional publishers, webhook management, external queue service, separate worker deployment, or agent-framework dependency.

### Requirement IDs used in handoffs and review

- **R01:** correct source and 20-minute Denník N cadence; collection shared across subscriptions.
- **R02:** local 20:00 primary / 21:00 conditional fallback; missing day skipped.
- **R03:** one persistent destination per guild and feed, native channel commands, disable and status.
- **R04:** selected-channel permissions, guild isolation, encrypted retrievable identifiers.
- **R05:** source-attributed embeds with bounded optional metadata and deliberate mentions.
- **R06:** durable deduplication, bounded replay, low-noise pacing, no bootstrap flood.
- **R07:** source failures, parser changes, cache validators, and backoff handled distinctly.
- **R08:** recoverable scheduling/outbox state and conservative ambiguous-send handling.
- **R09:** lifecycle integration and failure isolation; existing AI and media behavior preserved.
- **R10:** meaningful automated verification, operational instructions, and honest rollout evidence.

## 2. Architecture and existing integration points

The module accepts source adapters, a news store, a Discord publisher, a clock, and a logger. Its external interface should stay small: lifecycle methods and the settings operations needed by commands. Keep selection and formatting as pure functions; place HTTP, MongoDB, and Discord effects behind explicit adapters.

Proposed files are ownership boundaries, not a mandate to create a file for every concept:

- `src/news/types.ts`, `policy.ts`: domain contracts, daily slots, freshness, pacing, and publication identity.
- `src/news/http.ts`, `sources/dennikn.ts`, `sources/aktuality.ts`: bounded retrieval and publisher-specific parsing.
- `src/news/cipher.ts`, `mongo.ts`: retrievable subscriptions, source state, content, and the durable delivery queue.
- `src/news/render.ts`, `discord.ts`: source-derived embed rendering and a narrow publisher.
- `src/news/commands.ts`: news command builders/handlers; preserve the existing command namespace.
- `src/news/index.ts`: scheduling, collection, planning, delivery, shutdown, and health reporting.
- `tests/news/`: fixtures and tests crossing those interfaces.

Concrete existing seams to verify:

- [src/index.ts](src/index.ts) constructs dependencies and drains AI/media before closing Discord and MongoDB. News must join this lifecycle.
- [src/discord-bot.ts](src/discord-bot.ts) owns Gateway events and command registration. Its current public interface has lifecycle methods only. Add/inject a narrow publisher/readiness capability; keep exactly one command-registration owner.
- [src/discord-commands.ts](src/discord-commands.ts) dispatches only by subcommand today. Both new groups contain `feed`; group-aware dispatch is required. Unknown operations must not fall through into `context-limit`.
- [src/discord-reel-transport.ts](src/discord-reel-transport.ts) demonstrates REST delivery using the same bot identity, but its reply interface requires an incoming message. Reuse the pattern, not that interface. Account for rate limits shared by clients using one token.
- [src/discord-response.ts](src/discord-response.ts) suppresses AI embeds. Keep those restrictions and use a dedicated news renderer.
- [src/mongo-store.ts](src/mongo-store.ts), [src/mongo-schema.ts](src/mongo-schema.ts), and [src/mongo-context.ts](src/mongo-context.ts) provide a shared Mongo client, finite operation deadlines, and feature-specific collections. Add `store.news` without mixing news into AI accounting.
- [src/mongo-reels.ts](src/mongo-reels.ts) stores HMAC keys, not recoverable destination IDs. It cannot serve as an enumerable news address book.
- [src/clock.ts](src/clock.ts) already supplies IANA local-time conversion. Avoid a new date library unless the implementation demonstrates a need.
- [src/media-http.ts](src/media-http.ts) has public-address validation and DNS pinning ideas. Its provider allowlists/errors are media-specific; do not inherit Instagram/TikTok policy accidentally.
- [src/discord-messages.ts](src/discord-messages.ts) ignores bot/webhook messages and detects AI conversations through stored links. News receipts remain separate. Replying with an explicit AI mention currently reads message content, not embed text; automatic news-to-AI context is outside this feature.

## 3. Scheduling and publication invariants

### Continuous collection

Persist a source-wide next-attempt time, last successful parse, cache validators, and expiring poll ownership. Run one active request per source regardless of the number of subscribed guilds. A timer merely asks whether work is due; it does not own the schedule.

After an ordinary attempt, the next attempt is at least 20 minutes later. A 304 is a successful unchanged result and does not republish cached items. A process restart does not reset the next-attempt time. Never overlap a slow request with a second request for the same source.

Use source IDs for exact identity, preserving publication time separately from first-seen time and first-seen-as-important time. A story may become important after publication; advancing only by publication timestamp loses that story. Maintain a bounded overlap of recent observations and a per-subscription activation baseline. Keep promotion eligibility bounded, initially to stories published within 24 hours; replay after downtime is still limited to two hours of newly observed eligible work.

For a continuous subscription with no usable source snapshot, the first successful snapshot establishes its baseline and does not publish historical contents. With a current snapshot, capture the activation watermark and admit subsequently eligible observations.

Do not equate an HTTP polling interval with a requirement to send a message each interval. Empty intervals produce no messages. Pacing and receipt state survive restart. Deduplication is scoped to each feed subscription; a story appearing in the continuous channel does not remove it from Aktuality's independent editorial roundup.

### Daily collection and fallback

Use a durable key containing the publisher, Slovak calendar date, and primary/fallback slot. A successful current-day edition is stored before publication planning. Preserve the collection result independently from the delivery result.

The first scheduler tick at or after 20:00 performs the primary attempt. Permit recovery within `[20:00, 21:00)` if the process was down at 20:00. At or after 21:00, use the fallback slot within `[21:00, 22:00)` only if no current-day edition has been successfully collected. If startup occurs during that second window without a primary attempt, make one fallback attempt, not two immediate attempts. After 22:00, skip catch-up for that day. These bounded recovery windows are implementation defaults; normal operation remains 20:00 and 21:00.

Required cases:

- Fresh edition collected at 20:00: plan one publication; do not scrape again at 21:00.
- Missing/stale edition at 20:00: record the attempt and try at 21:00.
- Source timeout or parser failure at 20:00: record the distinct failure and allow the 21:00 attempt unless publisher backoff forbids it.
- Fresh edition collected at 20:00 but Discord fails: retry/reconcile the same stored publication. Do not activate the collection fallback.
- Missing edition at 21:00: no message, no generated replacement, no further collection that day.
- Valid 304 at 21:00: it must not erase a fresh stored edition or incorrectly stand in for one. If the listing is unchanged and no fresh edition is stored, retain enough candidate metadata to revalidate the candidate article within the fallback request budget.
- Changed channel at 20:30 after successful delivery: no second daily message in the new channel. Daily identity is guild/feed/date, not channel/date.
- Role or channel changes while work is pending: invalidate the pending configuration revision and replan only eligible, unsent work. Sent or uncertain publications remain deduplicated.

Freshness uses the edition's publication date in `Europe/Bratislava`, not discovery time, modification time alone, server UTC date, or a fixed 24-hour timer. A weekly weekend roundup does not qualify as a daily edition merely because it is newest on the listing.

**Daily activation:** a first daily subscription enabled before 20:00 receives that evening's first eligible edition; do not treat the edition as a bootstrap baseline. A newly enabled subscription during `[20:00, 22:00)` may immediately plan one already-collected current-day edition. If none is stored, it joins the remaining source-wide primary/fallback opportunity without resetting previously completed attempt slots. If no daily subscriber existed earlier, activation at 20:30 permits the primary recovery attempt; activation at 21:30 permits one fallback attempt. Activation before 20:00 or at/after 22:00 does not send a cached edition immediately. Re-enabling the same guild/feed preserves that day's sent/uncertain tombstones; a previously disabled, never-sent eligible publication may be replanned under the new revision.

**Daily delivery deadline:** admit a daily Discord send only before 22:00 on that edition's Slovak publication date. Retry failures known to precede acceptance only within that window and while the configured destination remains valid. At 22:00, expire pending or safely retryable daily work; do not deliver it the next morning. An already-issued request may finish just after the deadline and cannot be recalled. Preserve its sent/uncertain outcome and never blindly retry it. If collection finishes at/after 22:00, retain the source outcome but do not admit a late daily send. Collection success still suppresses the 21:00 collection fallback even when delivery later expires.

### Delivery reliability

Persist a publication before making its Discord request. The outbox record freezes the selected content, destination configuration revision, deduplication key, due time, and replay deadline. Reading then sending without an atomic claim is insufficient.

Model at least pending, claimed/pre-send, sending, sent, uncertain, cancelled, and expired outcomes. Expired pre-send ownership may be reclaimed after validating the subscription again. A crashed or timed-out send must not be reclassified as safely pending merely because its lease expired.

Use a stable Discord nonce for immediate duplicate suppression. It is not a permanent exactly-once guarantee: MongoDB and Discord do not share a transaction. For v1, an ambiguous send is held as uncertain and surfaced in admin status; do not blindly resend it. Automatic bounded history reconciliation can be added only if it demonstrably identifies the publication. Prefer a missed notification to a duplicate when the result cannot be established. Discord documents the short nonce window and embed/notification limits in its [message contract](https://docs.discord.com/developers/resources/message).

Safe failures known to occur before a send can be retried with bounded backoff. Confirmed Discord rejection, such as a rate limit, must be distinguished from connection loss after sending. A deleted/inaccessible channel pauses delivery and appears in admin diagnostics; it must not generate recurring public failure notices.

## 4. Storage, retrieval, and output contracts

### Persistent data

Prefer explicit bounded collections; the exact grouping may change if a simpler representation preserves every invariant:

- **Subscriptions:** unique guild/feed HMAC key; encrypted guild/channel/optional role IDs; configuration revision; enabled state; activation baseline; next permitted delivery. Disabled subscriptions cannot admit new sends. Remove unnecessary retrievable destination data when disabling/removing a guild, while retaining non-reversible deduplication tombstones.
- **Sources:** one record per publisher/mode with cache validators, schedule/slot state, last successful parse, failures/backoff, lease owner and expiry, and a bounded candidate reference for daily fallback.
- **Items:** source/item identity, publication time, discovery/importance timestamps, revision hash, public excerpt/metadata, and edition membership. Store only what rendering and bounded recovery need.
- **Deliveries:** unique subscription/publication key, frozen payload or normalized publication, revision, due/deadline, claim/outcome, attempts, and hashed message receipt. A daily unique key must prevent two editions occupying the same subscription/date slot.

Use a dedicated, domain-separated encryption key derived from the existing deployment secret through an established Node crypto primitive. Use authenticated encryption with a fresh nonce and versioned format; bind the ciphertext to its subscription/context so record swapping fails. Keep HMAC lookup keys. Never assume HMACs are decryptable. Document key rotation/reconfiguration and avoid silently accepting undecryptable subscriptions as successfully loaded.

Initial retention proposal: public items seven days; delivery tombstones 30 days, longer than any replay window; bounded source metadata while active; no indefinite raw publisher HTML. Disabling/re-enabling must not replay delivered or uncertain publications from the same day. TTL expiry is cleanup, not an eligibility check. Existing transcript and spending retention remain unchanged.

Atomic store operations must prevent cursor advancement from losing unplanned content, double poll claims, duplicate outbox insertion, stale-owner commits, and configuration changes routing old work to a new destination. Use the existing Mongo transaction capability where required, or prove equivalent recovery through unique upserts and repeatable planning. Do not introduce Redis for this workload.

### Source adapters

Recent observations are evidence for fixtures, not supported public API guarantees:

- [Denník N important listing](https://dennikn.sk/minuta/dolezite) contains initial structured JSON under `window.__INITIAL_STATE__`, with posts in `postsApi.queries.*.data.pages[].posts`. Observed fields include IDs, `isImportant`, timestamps, excerpt, tags, and image sizes. Titles can be empty; use the opening bold sentence and then a bounded text fallback. Parse JSON as data without evaluating page scripts. General RSS lacks the observed importance flag and is not an equivalent fallback.
- [Aktuality roundup listing](https://www.aktuality.sk/spravy/denny-vyber-sprav/) links to daily editions. Observed edition pages expose publication metadata and section headings in `#articleContent`. Preserve one edition containing multiple sections. No correct dedicated roundup RSS was verified. Do not substitute the generic article RSS or a guessed feed URL.

One owner gathers fresh representative fixtures once; other workers reuse minimized fixtures. Do not commit full pages containing unrelated articles, tracking scripts, cookies, or large payloads. Include provenance, retrieval date, relevant structure, and deliberately modified edge cases.

HTTP must have HTTPS/provider/path allowlists, redirect validation, DNS checks against private addresses, finite deadlines and response-size limits, and cancellation. Request only the listing and at most one selected edition per daily attempt. Reuse available image metadata instead of fetching every linked story. Revalidate redirected targets and never forward arbitrary credentials/cookies.

Record unchanged, empty, stale, malformed, access-denied, rate-limited, unavailable, and cancelled outcomes distinctly. Do not convert a changed parser schema to an empty successful feed. Preserve good state when parsing fails. Honor Retry-After; exponential backoff starts from the ordinary cadence for continuous errors. Access denial uses a longer cooldown and visible status. For daily collection, backoff may suppress the 21:00 fallback; it must never cause repeated retries around a publisher restriction. Do not introduce rotating identities, proxies, or login-cookie workarounds.

### Discord payloads and settings

Build source-controlled text from validated normalized fields. Escape publisher text for Discord Markdown, neutralize mentions, and validate link/image origins. Never pass raw HTML or page-provided JSON directly as a Discord payload.

Continuous: one headline embed, source URL, publication timestamp, bounded description, compact tags, and optional image. Daily: one message containing the roundup's selected headlines/links and a short source-provided introduction. Prefer one structured embed; multiple embeds are allowed only when they remain one message and fit Discord's aggregate limit. Do not repeat the same embed URL across multiple embeds, because Discord deduplicates those. Truncation must preserve readable labels and valid links rather than silently splitting into a second message.

Use a channel option, not an arbitrary channel-name string. Re-fetch/resolve the selected guild channel and check the bot's effective permissions there, including View Channel, Send Messages, and Embed Links. `interaction.appPermissions` describes the invocation channel and is insufficient. Check optional role ping authorization separately. Preserve existing user-level Manage Server checks and ephemeral replies. See Discord's [application-command contract](https://docs.discord.com/developers/interactions/application-commands) for group/channel-option structure.

Admin status includes destination, mode, the next local collection time, last source success/outcome, pending count, uncertain count, and whether delivery is paused. It must distinguish no edition from an outage, no subscriptions from an empty feed, and a stored edition from a delivered message. Logs use finite outcomes and hashed scope IDs, without raw destinations, article bodies, tokens, or full HTTP errors.

## 5. Executable task cards

Every implementation card includes its own meaningful tests and documentation impact. The common completion gate is `pnpm format` followed by `pnpm check` in that task's isolated worktree, after all edits. Run `pnpm build` where runtime imports/entrypoints change. A reviewer may use focused tests to investigate, but a full green gate is required before acceptance. Do not reduce coverage thresholds or add skips to make a task pass.

### N00 — Baseline, fixtures strategy, and acceptance contract

**Dependencies:** none. **Owner:** orchestrator with a read-only explorer. **Requirements:** R01–R10.

Read the files listed above, local instructions, package scripts, and current git state. Record the actual base revision, existing user changes, baseline check results, and any pre-existing skips. Confirm the daily windows, low-noise defaults, role option, and source request budget in a short decision record. The requested behavior takes precedence over stale architecture text. Create local execution artifact directories and initialize the ledger without marking implementation complete.

**Deliverables:** current code map, test baseline, risk list, and frozen acceptance IDs. **Proof:** `pnpm check`, `git status --short`, and a mapping of R01–R10 to the cards below. **Orchestrator gate:** all requested behavior has an owner; no worker is relying on the removed draft or an assumed supported RSS endpoint.

### N01 — Domain contracts and deterministic publication policy

**Dependencies:** N00. **Owned paths:** `src/news/types.ts`, `src/news/policy.ts`, `tests/news/policy.test.ts`. **Requirements:** R01, R02, R05, R06, R08.

Define story-versus-edition results, subscription revisions, source outcomes, store/publisher interfaces, stable publication identity, and injectable time. Implement pure functions for local slots, fallback eligibility, freshness, activation baselines, pacing, replay deadlines, and publication selection. Keep exact module interfaces small enough for production adapters and test fakes.

**Acceptance:** winter/summer and both DST-transition days map to 20:00/21:00 local; 19:59 has no daily work; a saved edition suppresses fallback despite failed delivery; missing/stale editions permit exactly the fallback; after 22:00 no daily collection or send admission; safe daily retries expire at the cutoff; first and late daily activation use current-day eligibility rather than continuous baselines; daily identity survives channel changes; no artificial 15-story fill/cutoff; newly important older posts have explicit eligibility.

**Proof:** focused policy tests with injected timestamps and synthetic multi-day scenarios. These establish deterministic behavior, not real publisher-volume suitability; publisher-grounded volume validation follows fixture capture in N03/N10. Review before downstream workers rely on the contracts. Interface changes later return to the orchestrator and invalidate affected task packets.

### N02 — Bounded source HTTP and fixture tooling

**Dependencies:** N01. **Owned paths:** `src/news/http.ts`, `tests/news/http.test.ts`, fixture provenance/tooling; `package.json` and `pnpm-lock.yaml` only during this ownership window. **Requirements:** R01, R07, R09.

Implement anonymous bounded HTTP with conditional requests, validated redirects, public-address resolution, finite body/time limits, and cancellation. Select an HTML parser if needed and install it with `pnpm add`; do not edit dependency declarations directly. Capture/minimize representative publisher structures once, without writing to Discord. Keep pure parser entrypoints independent of the HTTP client.

**Acceptance:** 200/304, missing/invalid content type, redirect loops/foreign hosts, private DNS, oversized and partial bodies, timeouts, abort, 403, and 429/Retry-After have tested outcomes. A failed parse never commits validators as a successful update. No requests happen in ordinary test runs.

**Proof:** fixture-based transport tests plus at most one bounded read-only smoke attempt per source during fixture capture. Save exact request outcomes separately from parser correctness. Live availability cannot be a requirement for offline checks to pass.

### N03 — Denník N important-news adapter

**Dependencies:** N01, N02. **Owned paths:** `src/news/sources/dennikn.ts`, dedicated fixtures and tests. **Requirements:** R01, R05, R06, R07.

Parse the observed initial JSON, select important items, normalize stable IDs/timestamps and optional metadata, and handle title fallback. Preserve observations needed for importance promotion and revision handling. Reject structural drift explicitly. Do not fetch linked full articles to fill optional fields.

**Acceptance:** blank title/bold fallback; missing images/tags; malformed timestamps; false importance; duplicate IDs; updated excerpts; delayed importance promotion; reordered snapshots; unchanged responses. Extra unrelated page state must not break parsing, while a missing required post structure must produce a parser failure.

**Proof:** independent fixtures and a timestamped multi-day observation replay yielding expected important IDs with request count independent of subscription count. Report observed send delays and expired stories to evaluate the pacing/catch-up defaults; identify any synthetic inputs separately. Can run alongside N04 after the shared HTTP contract is accepted.

### N04 — Aktuality editorial-edition adapter

**Dependencies:** N01, N02. **Owned paths:** `src/news/sources/aktuality.ts`, dedicated fixtures and tests. **Requirements:** R02, R05, R07.

Discover the current daily edition from the category listing, fetch one candidate, parse publication metadata and editorial sections, and return a complete edition. Distinguish a stale daily article, a weekly roundup, no fresh edition, and broken markup. Preserve candidate/cache data needed for the 21:00 fallback.

**Acceptance:** current/stale/future publication date, primary missing then fallback available, unchanged listing with cached candidate, weekly newest entry, incomplete headings, alternate metadata placement, missing optional image, and malformed page. Freshness uses publication date in Slovakia. No generated fallback and no generic RSS substitution.

**Proof:** tests covering at least two real minimized edition structures and missing-day fixtures; request budget is listing plus at most one candidate per attempt. Section count is data, not a hardcoded seven.

### N05 — Encrypted, guild-scoped subscription persistence

**Dependencies:** N01. **Owned paths:** `src/news/cipher.ts`, subscription part of `src/news/mongo.ts`, `tests/news/subscriptions.integration.test.ts`; coordinated store/schema integration. **Requirements:** R03, R04, R06.

Add subscription persistence and indexes through the existing Mongo client. Encrypt retrievable destination and optional role identifiers, bind ciphertext to its context, keep HMAC lookup keys, and add configuration revisions and activation baselines. Define disable, re-enable, removed-guild, and secret-change behavior. Update relevant privacy documentation in this card or record exact changes for N11.

**Acceptance:** persistence across store instances/restart, independent guilds/feed types, channel rename, replacement, same-value idempotent configuration, disable/re-enable, authenticated-encryption tampering/record swap/wrong key, and absence of plaintext identifiers in Mongo/logs. A configuration change cannot reset daily deduplication or admit old queued work into a newly selected channel.

**Proof:** real Mongo integration tests, not only mocked `updateOne` expectations; inspect stored documents and indexes. This card owns shared store/schema files while integrating; no simultaneous edits there.

### N06 — Durable poll coordination and delivery outbox

**Dependencies:** N01, N05. **Owned paths:** coordination/outbox parts of `src/news/mongo.ts`, associated integration tests and indexes. **Requirements:** R01, R02, R06, R07, R08.

Persist source-wide next attempts, daily slots, successful editions, item observations, and publication reservations. Implement atomic ownership, repeatable planning, outbox claims, configuration checks, pacing reservation, terminal deduplication, and retention. Make the crash boundary before a Discord call explicit.

**Acceptance:** two instances cannot own the same poll or publication; stale owners cannot commit; process failure at every claim/plan transition is recoverable; late source completion is fenced; daily fallback is collection-driven; cursor/item commit cannot lose publication; expired pre-send work is reclaimable; sending/uncertain work is not blindly retried; tombstone TTL never resurrects expired news; daily pending work expires at 22:00 rather than retrying the next morning; first/late daily activation and re-enable preserve the correct day slot; disable/reconfigure fences unsent work.

**Proof:** adversarial Mongo integration tests with competing stores and controlled clocks, including unique-index races. A reviewer traces the state transitions and identifies the exact point where delivery becomes uncertain. This is a mandatory independent review checkpoint.

### N07 — Embed renderer and Discord publisher

**Dependencies:** N01. **Owned paths:** `src/news/render.ts`, `src/news/discord.ts`, associated tests. **Requirements:** R04, R05, R08, R09.

Create a pure renderer and narrow Discord sender using the existing bot identity. Choose the existing REST client's injection or a dedicated bounded REST client, documenting shared-token rate-limit handling. Add destination validation and stable nonces. Keep `SuppressEmbeds` in the AI renderer unchanged.

**Acceptance:** valid link/title/timestamp, missing optional fields, source-text mention/Markdown injection, long daily editions, valid truncation, one-message daily payload, aggregate embed limits, distinct embed URLs if multiple are used, silent continuous delivery, explicit role allowlist, permissions checked in the destination, finite timeout, known rejection versus uncertain acceptance. The sender receives stored content and never scrapes.

**Proof:** normalized-item fixtures produce inspected JSON payloads; fake Discord transport exercises success, 403, 429, timeout, and malformed receipt. No live Discord sends from ordinary tests.

### N08 — Channel commands, disable, and feed status

**Dependencies:** N05, N06, N07. **Owned paths:** `src/news/commands.ts`, `src/discord-commands.ts`, command tests; registration changes coordinated with `src/discord-bot.ts`. **Requirements:** R03, R04, R05, R09.

Add the two subcommand groups and native channel selectors, optional daily role, disable operations, and dedicated status output. News status must not depend on AI accounting availability. Dispatch by group and subcommand before legacy branches. Validate the selected guild channel and bot member permissions there, persist only after validation, and keep replies ephemeral. Preserve all existing commands and legacy guild-command migration behavior.

**Acceptance:** invocation in channel A configuring channel B; missing Manage Server; missing destination Embed Links/Send Messages; foreign guild/unsupported channel; role removed or not mentionable/authorized; duplicate channel names; persistence and status despite unrelated accounting failure; independent disable; unknown commands do not change context limits; ordinary users retain `/jolanda privacy` access.

**Proof:** serialized command-definition assertions and behavior tests using selected-channel mocks, plus unchanged existing command tests. No second top-level bot identity and no Gateway command owner in a worker.

### N09 — News runtime and lifecycle integration

**Dependencies:** N03, N04, N06, N07, N08. **Owned paths:** `src/news/index.ts`, `src/index.ts`, `src/discord-bot.ts`, configuration/environment documentation, runtime tests. **Requirements:** R01–R09.

Wire collection, durable planning, and delivery into the current process. Start only after database initialization, gate sends on Discord readiness, poll only subscribed sources, prevent overlapping ticks, and use bounded per-source work. Integrate shutdown so no timers or detached work survive Discord/Mongo closure. Add a deployment kill switch and a dry-run/preview route that cannot create live delivery receipts or consume daily publication slots.

**Acceptance:** idle installation performs no source requests; commands activate future collection; two channels do not double requests; startup at each daily boundary; restart preserves slots/pacing; one broken source leaves the other source and AI/media functional; shutdown during fetch, Mongo work, and send; repeated start/stop is safe; no new LLM calls; paused/deleted destinations do not generate failure spam.

**Proof:** fake-clock/runtime tests crossing real module interfaces; `pnpm build`; one full application-wiring test through channel configuration and planned delivery. On integration, re-review any earlier contract modified by this card.

### N10 — Independent feature acceptance and failure replay

**Dependencies:** N09. **Owned paths:** integration/scenario tests and review artifacts; production repairs assigned back to their implementer. **Requirements:** R01–R10.

A fresh evaluator works from this product contract, the final diff, and the running test setup. It must demonstrate the user journeys, not merely restate passing unit tests. Replay multiple days of source fixtures and introduce restart, overlap, missing editions, publisher backoff, permission changes, and uncertain Discord outcomes.

**Acceptance scenarios:**

1. Configure both destinations in one guild, restart, and observe eligible news delivered only to the configured channels.
2. Configure a second guild after collection already runs; no continuous bootstrap replay and no extra publisher requests. Verify daily activation at 19:00, 20:30, 21:30, and 22:00, both with and without a cached current-day edition; re-enable without duplicating a sent/uncertain daily publication.
3. Fresh 20:00 edition gives one daily message and no 21:00 scrape; absent 20:00 edition succeeds at 21:00; absent both yields zero messages.
4. Discord fails after a successful 20:00 collection; retry/uncertain handling never creates a second edition or fallback scrape. Extend the outage past 22:00 and into the next morning: pending work expires and no late daily message is admitted.
5. Channel/role changes and disable during queued work respect revision checks; disabling cannot retract a request Discord already accepted, and this race is documented accurately.
6. Duplicate/updated source IDs and importance promotion produce the agreed behavior; continuous backlog is paced and bounded. Evaluate delays and expired important stories against timestamped publisher observations, not only synthetic traffic, and explicitly accept or revise the default pacing before release.
7. At every DST/local-date boundary, daily identity and attempt times remain correct.
8. Existing AI conversations, permissions, spending, command registration, media reposting, and shutdown continue to pass their checks.

**Proof:** an R01–R10 evidence matrix, review findings/dispositions, final `pnpm format`, `pnpm check`, and `pnpm build` on the integrated revision. A green unit suite alone is not acceptance. Unresolved correctness or privacy failures return to implementation.

### N11 — Operational documentation and release packet

**Dependencies:** N10. **Owned paths:** `README.md`, `SECURITY.md`, `.env.example`, a bounded read-only news smoke script if needed, and rollout evidence. **Requirements:** R03–R10.

Document commands, CET/CEST interpretation, fallback semantics, notification choice, source limitations, privacy/retention, dry-run and kill switch, status meanings, and recovery from missing permissions or changed parsers. Explain that source access from a developer laptop does not establish access from Railway.

Prepare a read-only deployment-network retrieval check and exact rendered previews. Prepare a controlled Discord verification in designated test channels and a rollback procedure that disables news without affecting AI/media. Actual deployment or external sends require existing session authorization and concrete target channels; do not assume a generic feature implementation request authorizes sending to friends' channels. Complete all local work before any approval step that is actually required.

**Acceptance:** local tests and build complete; no secrets or raw destination IDs in artifacts; one documented way to stop news; no catch-up flood after rollback/re-enable; operational checks either completed with evidence or explicitly pending with the required external action identified. Optional multi-day observation does not keep local implementation artificially incomplete.

**Proof:** final review packet, deployment-network outcomes if available, and separate local-complete versus live-verified status. Never label the feature deployed merely because the code is ready.

## 6. Dependency order and parallel work

N00 → N01 establishes accepted contracts. Then N02, N05, and N07 are eligible, but run at most two implementation writers at once. After N02, N03 and N04 can run independently. N06 follows N05; N08 follows N05, N06, and N07. N09 joins all feature paths. N10 reviews the integrated behavior; N11 prepares release documentation/evidence.

Use isolated worktrees for concurrent implementation. Shared `package.json`, lockfile, Mongo schema/store wiring, command registration, and startup files each have one owner at a time. The orchestrator integrates sequentially. A worker whose dependency changes must refresh its base, rerun affected tests, and obtain review of any integration repair. In a single shared checkout, use one writer because `pnpm format` rewrites the whole repository.

No task is accepted merely because an agent reports success. The ledger advances only after reviewer findings are resolved, relevant deterministic checks pass, and the orchestrator verifies the requested behavior at the integrated revision. N00's read-only preparation can be accepted by the orchestrator without an implement/review ceremony. N11's documentation review can be combined with final acceptance; the runtime/state/permission cards require independent review.

## 7. Guidance behind the execution method

Research checked on 14 September 2026. These are primary-source practices adapted to this repository, not a claim that one workflow is universally best.

- **Context by role:** LangChain's 8 September 2026 guidance distinguishes continuation workers, which may benefit from inherited context, from verifiers, which should judge independently. We give reviewers the contract and evidence with fresh context; exploration can be reused rather than repeated. [Organizing Context in a Multi-Agent Harness](https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness)
- **Independent evaluation, proportionate overhead:** Anthropic's 24 March 2026 experiments support a planner, generator, and evaluator, but also found value in removing rigid sprint ceremony as model capability improved. We keep explicit chunks for execution and review high-risk behavior without mandating three new agents for every edit. [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- **Durable progress:** Anthropic's 26 November 2025 work uses persistent feature/progress artifacts and incremental verification across sessions. Our ledger and revision-bound handoffs keep acceptance status separate from conversational memory. [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Parallelize independent work:** Anthropic's 13 June 2025 report stresses explicit delegation boundaries and notes that tightly coupled coding offers fewer parallel opportunities than research. We parallelize separate adapters/read-only investigations and serialize shared integration. Research speedup figures are not treated as expected coding gains. [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Workflow plus bounded evaluation:** The foundational orchestrator–worker and evaluator–optimizer patterns provide a vocabulary for decomposition and repair. The current plan fixes acceptance gates while allowing the orchestrator to choose tasks, add focused exploration, or re-scope a stalled pair. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

The two-writer limit, two repair rounds before re-planning, task boundaries, and chosen news policies are project defaults. Measure whether they help using review defects, repair rounds, stale handoffs, integration conflicts, and time spent waiting. Do not add a framework or more agents merely to match a diagram.
