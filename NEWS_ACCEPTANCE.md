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

## Verification status

Implementation, feature acceptance, live Discord verification, and deployment are
not complete. Detailed task evidence is recorded as work progresses.
