# News execution and acceptance

## Baseline and decisions

The actual starting revision is `7f38348e632e5c219bfed95d7bbcc3b9fa0dc370`.
Only the four supplied NEWS documents were untracked; there were no runtime edits.
Baseline `pnpm check` passed on 14 September 2026. Existing opt-in live tests remain
separate from local verification. Baseline coverage: statements 94.78%, branches
87.92%, functions 95.65%, lines 97.29%.

The implementation retains all R01–R10 requirements and the task ownership mapping
in NEWS_TASKS.json. Daily attempts use Europe/Bratislava 20:00–21:00 primary and
21:00–22:00 conditional fallback windows. Daily sends stop at 22:00. Continuous
delivery begins at one message per 20 minutes with two-hour replay expiry, subject
to publisher-grounded replay evaluation. Optional daily role notifications require
destination-specific validation. Each daily attempt fetches only the listing and
at most one candidate. No replacement digest or live Discord writes are authorized.

Integration seams inspected: mongo-store/schema/context own the shared Mongo
connection; discord-bot owns command registration and Gateway lifecycle;
discord-commands needs group-aware dispatch; index owns startup/shutdown. Existing
clock conversion and MongoMemoryReplSet tests are reusable. The module will not
reuse irreversible Reel HMACs as retrievable routing references.

Primary risks are cross-instance fencing, activation baselines, ambiguous Discord
acceptance, parser drift, destination permission checks, and final integrated
coverage. Each has explicit implementation and independent review ownership in
the task ledger. Publisher capture belongs to one read-only explorer; workers
reuse its minimized evidence rather than repeatedly retrieving pages.

## Resumed execution — 14 September 2026

The implementation session re-inspected commit `66b12f3`, the documentation commit
above the original baseline. There were no integrated news runtime changes. The
existing modified task ledger and untracked `NEWS_ARCHITECTURE.html` were preserved.
An unfinished N01 worktree was recovered and reassigned; its contents require tests
and independent review before acceptance. A fresh baseline `pnpm check` passed:
639 tests, with 30 existing opt-in live skips; coverage is unchanged from above.

Fixture capture uses one owner. A bounded correction permits two Denník N listing
requests because the first minimizer omitted the actual timestamp fields, and one
Aktuality listing plus two edition requests to satisfy N04's two-structure fixture
requirement. This adjusts only development evidence gathering; the runtime daily
budget remains one listing and at most one candidate per attempt. Capture results
and limitations are recorded separately from parser correctness.

## Accepted foundation

- N01: scheduling/domain policy reviewed at `7980016`, integrated as `6340b5c`;
  28 policy tests passed in the integration checkout.
- N05: encrypted subscriptions reviewed at `7876746`, integrated as `148b301`;
  real Mongo persistence, tamper/swap/wrong-key behavior, revisions, and erasure
  verified. Atomic outbox and source-activation interleavings remain N06 work.
- N02: bounded HTTP and minimized fixtures reviewed at `d24af68`, integrated as
  `ec03abe`; 103 HTTP cases passed after integration and frozen-lockfile install.

The combined foundation passed `pnpm check` at `ec03abe`: coverage 95.11%
statements, 89.22% branches, 95.81% functions, 97.60% lines. Existing opt-in live
skips remain. Reviewer approvals contain no blocking findings for these scopes.
Detailed local receipts live under `.news-work/N01`, `N02`, and `N05`; the final
release packet will preserve the relevant sanitized evidence in tracked files.

## Source and Discord component acceptance

N07 was reviewed after repairing the REST-library shutdown timer (N07-F1), then
integrated as `e87cbe6`. The replacement uses bounded native requests and timestamp
cooldowns. The original reproduction now exits in about five milliseconds; 66
focused tests passed after integration. No live Discord messages have been sent.

N03/N04 were independently reviewed at `e81ed8b`, integrated as `7777a4a`, and
verified with 200 source/HTTP/replay tests plus build. The replay uses actual
captured IDs/publication timestamps and explicitly simulated polling/promotion
assumptions: 301 shared polls, two subscriptions, 50 sends each, zero expiries,
29.57-minute maximum publication delay and 20-minute maximum queue delay. The
20-minute pacing/two-hour catch-up defaults are retained on this limited evidence.
A separate synthetic ten-story burst sends six and expires four; this demonstrates
bounded catch-up rather than historical publisher loss.

At 08:28:57 UTC on 14 September 2026, one read-only production-adapter collection
per publisher succeeded from the developer machine: Denník N listing returned 50
important stories; Aktuality listing plus one candidate returned the September 11
edition, correctly classified as stale. All three HTTP requests returned usable
200 responses. One-message payload previews were rendered locally. No Mongo state,
Discord messages, deployment, or deployment-network verification was involved.
Sanitized evidence is in `.news-work/live-publishers/check.json` pending release
packet consolidation.

## Verification status

N06 is accepted at `58a57ac` after independent verification of transaction fencing,
ambiguous-send recovery, exponential backoff, and bounded source-body retention.
N08 is accepted at `bd03bde`: native channel commands, independent status,
permission gates, guild cleanup, and persistent configuration passed review.
The integrated checkout passed format, check (1,030 passed; 30 existing live
skips), and build.

N09a is accepted at `de86b49`. Independent runtime review found and verified
repairs for asynchronous publisher cleanup, same-turn start/shutdown ordering,
and preservation of confirmed publisher results after cancellation. The reviewed
assembly passed 1,077 tests with 30 existing skips and build; its code matches the
integrated checkout, where 77 runtime/command tests passed.

N09b application wiring is accepted at `825334a` after independent review.
The exact-code candidate passed format, check (1,083 passed; 30 existing skips),
and build. Thirteen entrypoint/configuration tests passed again after integration,
including the real Mongo command-to-publication flow and process shutdown cases.
Fresh whole-feature acceptance remains N10.

The portable [NEWS_VERIFICATION.json](NEWS_VERIFICATION.json) preserves component
reviews, publisher-check outcomes, and replay assumptions. Exact offline payloads
are in [NEWS_PREVIEWS.json](NEWS_PREVIEWS.json); these are previews, not Discord
delivery receipts.

Feature acceptance, live Discord verification, and deployment are not complete.
Detailed task evidence is recorded as work progresses.
