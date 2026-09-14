# Jolanda news acceptance

The complete feature is implemented in the existing Jolanda bot. Local feature
acceptance passed at code/test revision `0fede26`; the release packet is independently
reviewed. All N00–N11 tasks are accepted locally. Exact decisions and integrated revisions are in
[NEWS_TASKS.json](NEWS_TASKS.json).

## Implemented behavior

- Denník N important news is collected once per source every 20 minutes. Each
  configured destination receives at most one quiet message per 20 minutes;
  queued items expire after two hours. Activation establishes a baseline, and
  source IDs, importance promotion, pacing and receipts survive restart.
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

## Verification

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
This does not establish publisher access from Railway.

The replay uses 50 captured source IDs/publication timestamps across five dates
with partial boundary days. Under explicitly simulated observation/promotion and
poll timing, 301 shared polls produce 50 sends per guild, zero simulated expiries,
a maximum 29.57-minute publication delay and a 20-minute queue delay. A separate
synthetic ten-story burst through real Mongo sends six and expires four. The
20-minute/two-hour pacing defaults are retained on this limited evidence; these
are not measurements of historical delivery, promotion frequency or complete days.

[NEWS_PREVIEWS.json](NEWS_PREVIEWS.json) contains exact locally rendered payloads.
The daily sample has one introduction and seven editorial headings in one embed;
its stale status is explicit. No section links or summary were invented. Client
rendering, image availability and push notifications still need live verification.

## Operations and remaining external checks

[NEWS_OPERATIONS.md](NEWS_OPERATIONS.md) documents configuration, status, retention,
secret maintenance, read-only previews, permission/parser recovery and rollback.
Set `NEWS_ENABLED=false` and restart normally to stop news deployment-wide while
retaining settings and deduplication. A request already issued cannot be recalled.

Live Discord verification is pending an explicitly authorized test guild/channel.
A local bot token is present, but its validity has not been checked as part of this
feature. No Discord message or command-registration change has been sent live.
Deployment-network verification needs access to the deployment host to run the
read-only smoke command. **No deployment has been performed.** Multi-instance news
coordination does not authorize scaling the existing AI/media Gateway deployment.

The original implementation baseline was `7f38348`. Unrelated user changes were
preserved. Local temporary logs/worktrees are supplementary; the tracked plan,
ledger, verification packet, previews and operations guide form the portable handoff.
