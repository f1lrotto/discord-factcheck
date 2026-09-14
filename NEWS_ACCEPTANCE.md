# Jolanda news acceptance

The original feature passed local acceptance at code/test revision `0fede26`.
N00–N11 remain accepted against that original contract. The user corrected continuous
delivery on 14 September 2026: send all newly eligible stories together after each
20-minute collection, without the original per-story delay. N12 implements and
verifies this amendment; N12 is accepted at `46a2f36`. Exact decisions and integrated revisions are in
[NEWS_TASKS.json](NEWS_TASKS.json).

## Implemented behavior

- Denník N important news is collected once per source every 20 minutes. Each
  configured destination receives every newly eligible story promptly as a separate
  quiet embed message, subject to Discord rate limits. Unsent items expire after
  two hours. Activation establishes a baseline, and source IDs, importance promotion,
  pending batches and receipts survive restart.
- Aktuality's own daily edition is collected at 20:00 Europe/Bratislava, with one
  21:00 fallback only when no fresh edition was collected. Recovery windows end
  at 21:00 and 22:00 respectively. Missing editions are skipped; no replacement
  digest is generated. No new daily send is admitted at or after 22:00.
- `/jolanda continuous feed channel:#news` and
  `/jolanda daily feed channel:#daily-news [notify-role:@role]` configure persistent
  guild-scoped destinations. Each group also has `disable` and `status`.
  Manage Server is required; the selected destination's effective permissions
  are checked. Routing and optional role references are authenticated/encrypted.
- Durable Mongo claims, configuration revisions and publication identities fence
  competing instances and stale work. Unknown Discord acceptance stays uncertain;
  confirmed rejections retain their retry/pause behavior. Shutdown drains news
  before Discord and Mongo close. Existing AI/media regression gates remain intact.

## Batch-delivery correction (N12)

The correction plans the complete eligible batch and drains it sequentially in one
runtime tick, yielding to other work between chunks without a timer delay. Per-subscription
claims serialize sends across instances. A rejected batch waits for its persisted retry
deadline while other subscriptions can proceed. Existing unattempted pacing reservations
become due after upgrade; attempted retries and sent/uncertain receipts are preserved.
The old writer lost retry-deadline provenance on some attempted jobs, so an ambiguous
legacy saved deadline is conservatively retained until due. This one-time upgrade
exception does not impose pacing on new batches.

The candidate's check passed **1,113 tests with 30 existing opt-in skips**, including
25-story command-to-transport and competing-instance journeys using real Mongo replica
sets. The updated publisher replay sends all 50 captured stories per guild with zero
simulated expiry, 19.5 minutes maximum publication delay and zero queue delay. These
are synthetic delivery timings over real publisher timestamps, not live Discord latency.
Independent review approved candidate `8ef7e99`, identical in production/test content
to integrated `46a2f36`. The integrated format/check/build gates passed with the
same 1,113 passing tests and unchanged coverage thresholds. The reviewer independently
proved that ambiguous legacy retry histories produce identical persisted state; the
conservative one-time compatibility exception is explicit in the operations guide.

## Original verification (before the batch-delivery amendment)

The fresh evaluator passed `pnpm format`, `pnpm check` and `pnpm build` on the
same production/test tree: **1,109 tests passed, 30 existing opt-in live tests
skipped**. Coverage: 95.78% statements, 91.10% branches, 95.88% functions and
97.90% lines. After integration, 31 complete feature/application tests passed
again. Final orchestrator gate details are in
[NEWS_VERIFICATION.json](NEWS_VERIFICATION.json).

Tests use real local Mongo replica sets. Source HTTP, Discord REST and Gateway
boundaries are controlled fixtures/fakes. The 26 new whole-journey cases exercise
both feeds and guilds through commands, actual parsers, persistence, planning,
production rendering/publishing and restart. They cover late activation with and
without cache, primary/fallback/missing editions, outage past the deadline,
channel/role revisions, disable races, permission loss, sent/uncertain re-enable,
competing instances, promotion/corrections, backlog expiry and CET/CEST/DST dates.
Existing suites additionally cover HTTP/cache failures, transaction rollback,
lease expiry, tamper/wrong-key handling, process startup and shutdown, AI and media.

Independent reviews found six blocking component defects, all repaired and
re-reviewed: backoff, inactive payload retention, a REST-library timer,
asynchronous body cleanup, start/shutdown ordering, and preservation of definite
publisher results after cancellation. The fresh whole-feature evaluation found
no remaining blocker. The portable verification file contains the R01–R10 matrix,
all eight N10 scenario dispositions and revision-bound review evidence.

## Publisher and preview evidence

On 14 September 2026 at 08:28:57 UTC, the production HTTP/parser adapters made
three bounded read-only requests from the developer host: Denník N returned 50
important stories; Aktuality's listing and one candidate returned the September
11 edition, correctly classified as stale. No Mongo or Discord state was touched.
The user subsequently ran this same repository locally under herdr; production
Mongo and process logs confirmed successful scheduled publisher collections.

The original pacing replay used 50 captured source IDs/publication timestamps across five dates
with partial boundary days. Under explicitly simulated observation/promotion and
poll timing, 301 shared polls produce 50 sends per guild, zero simulated expiries,
a maximum 29.57-minute publication delay and a 20-minute queue delay. A separate
synthetic ten-story burst through real Mongo sends six and expires four. The
one-message-per-20-minutes default was superseded by the user's explicit batch-delivery
requirement. These original figures are historical implementation evidence, not
acceptance of the corrected delivery behavior or measurements of historical delivery.

[NEWS_PREVIEWS.json](NEWS_PREVIEWS.json) contains exact locally rendered payloads.
The daily sample has one introduction and seven editorial headings in one embed;
its stale status is explicit. No section links or summary were invented. The user's 14 September screenshot confirms one live continuous embed with its image
and suppressed-notification indicator. Daily rendering and complete client verification
remain outstanding.

## Operations and remaining external checks

[NEWS_OPERATIONS.md](NEWS_OPERATIONS.md) documents configuration, status, retention,
secret maintenance, read-only previews, permission/parser recovery and rollback.
Set `NEWS_ENABLED=false` and restart normally to stop news deployment-wide while
retaining settings and deduplication. A request already issued cannot be recalled.

The user started the existing bot locally under herdr at 12:46 Bratislava time on
14 September 2026 and configured both feeds through Discord. Read-only production
checks confirmed successful collection and one continuous sent receipt at 13:27,
corroborated by the user's screenshot. The three-story test was explicitly authorized
by the user; only three observation records and the source cache validator were reset,
with no delivery receipts erased. This confirms a live continuous message on the
original revision, not the amended batch delivery or the full daily acceptance matrix.

After independent approval, Jolanda was gracefully restarted in the same herdr pane
at 13:55 Bratislava time with code revision `46a2f36`. Mongo and Discord reconnected.
Two different eligible stories were acknowledged at 13:55:54.147 and 13:55:55.853
and persisted as sent, proving live batch delivery with a 1.706-second completion gap.
The previously queued story no longer waited until 14:08. The next source collection
remained scheduled for 14:08:03. There are four distinct sent story receipts in total,
with no duplicate delivery records. No manual database reset was needed for the upgrade.

This is live Discord transport/persistence evidence, not a new client screenshot or
complete daily-feed acceptance. The daily delivery and wider live acceptance matrix
remain unverified. Existing AI/media Gateway deployment remains a single process.

The original implementation baseline was `7f38348`. Unrelated user changes were
preserved. Local temporary logs/worktrees are supplementary; the tracked plan,
ledger, verification packet, previews and operations guide form the portable handoff.
