# Jolanda news operations

Consult [NEWS_ACCEPTANCE.md](NEWS_ACCEPTANCE.md) for current verification and deployment status.
Installing this code does not authorize posting to any server. Keep the existing single-replica
deployment topology; news coordinates rolling overlap, while the rest of the bot still assumes one
active Gateway deployment.

## Configure and stop

Use the native selectors under `/jolanda continuous feed` and `/jolanda daily feed`. Both require
Manage Server and accept guild text or announcement channels. Each guild has one destination per
feed; channel renames are harmless. Daily alone accepts `notify-role`. An invocation in channel A
can configure channel B: permissions are checked in B, including role authorization.

Use the matching `disable` command to erase that feed's encrypted routing reference and cancel
unsent work. The other feed, AI, and media settings remain independent. Use `NEWS_ENABLED=false`
to stop news deployment-wide without clearing settings or receipts; apply it with a normal restart.
A request already admitted before shutdown or disable may have been accepted by Discord and cannot
be recalled. Previously posted messages remain subject to Discord retention and moderation.

Re-enabling continuous news establishes a current baseline rather than replaying the source listing.
Daily re-enabling during 20:00–22:00 may deliver a stored current-day edition only if that guild/date
has no sent or uncertain tombstone. Never clear delivery records to force a retry.

## Timing and delivery

- All news dates and evening times use `Europe/Bratislava`, independently of `JOLANDA_TIME_ZONE`.
  Winter is CET, summer is CEST; the schedule follows both DST transitions.
- Denník N collection is shared across guilds every 20 minutes. Empty intervals send nothing.
  Every newly eligible story from a collection is sent promptly as a separate quiet embed message,
  sequentially and subject to Discord rate limits. There is no 20-minute gap between stories. Unsent work expires
  two hours after first observation as important; promotion eligibility is bounded to stories
  published within the preceding 24 hours. There is no minimum or maximum daily story quota.
- Aktuality primary collection recovers within 20:00–21:00. Fallback recovers within 21:00–22:00
  only if no current-day edition was collected. Starting at 21:30 performs one fallback, not two
  immediate requests. After 22:00 there is no catch-up collection or new daily send.
- A collected edition suppresses fallback even if Discord is unavailable. Known rejections can
  retry the same publication within its deadline. Missing or stale editions produce no message.
  A weekly roundup never substitutes for the publisher's daily edition.
- On upgrade from the original pacing policy, never-attempted continuous publications become
  immediately eligible. Saved deadlines on attempted publications remain in force: the old writer
  could mix pacing with a genuine retry deadline, so that ambiguous legacy state is conservatively
  retained until due. New batches have no pacing delay. Sent and uncertain receipts are never cleared. No channel reconfiguration or database reset is required.
- Continuous posts suppress push notifications. Daily posts use normal channel notifications and
  optionally one explicit role mention; members' notification settings still determine delivery.
  Announcement channels are not automatically crossposted.

The captured publisher-time replay is a limited simulation:
50 captured stories across five publication dates, partial boundary days, and no historical promotion
observations. Batch delivery removes the old artificial queue delay; source outages and Discord failures can still exhaust the two-hour recovery window.

## Read-only previews and network checks

Build once, then explicitly choose a mode:

```sh
pnpm build
node scripts/news-smoke.mjs --fixtures > NEWS_PREVIEWS.json
node scripts/news-smoke.mjs --live
```

`--fixtures` has no network access and renders captured publisher examples. `--live` makes one
bounded collection per publisher: one Denník N listing and one Aktuality listing plus at most one
candidate. Neither mode opens Mongo or Discord, consumes attempt/publication slots, or stores
delivery receipts. The JSON includes exact payload previews; stale daily examples are visibly
classified as stale and must not be interpreted as eligible publications. Unexpected source failures
set a nonzero exit status. Missing/stale editions are valid source outcomes.

The runtime Docker image includes the script. Run `node scripts/news-smoke.mjs --live` on the
deployment host to verify that network separately. Success on one machine does not establish
access from a different future deployment host. The current bot runs locally under herdr. Do not run a second full bot process just to perform this check. Do not introduce
cookies, proxies, or alternate feeds if a publisher blocks the host.

## Status and recovery

The dedicated feed `status` commands read news state without touching AI accounting. They expose
the configured destination, deployment state, next local collection, last source outcome/success,
stored daily edition, pending count, uncertain count, and pause reason. A stored edition is evidence
of collection; it does not imply delivery. No subscription and an empty source are separate states.

- `empty` or `stale`: the publisher has no qualifying edition. Wait for the remaining scheduled
  fallback, if eligible. Never manufacture a replacement digest.
- `malformed`: source structure changed or invalid data failed validation. Good cache state remains.
  Reproduce with the read-only smoke tool, update minimized fixtures/parser tests, and deploy a repair.
- `access-denied`, `rate-limited`, `unavailable`, or `timeout`: inspect the finite source outcome and
  backoff. Ordinary backoff doubles from 20 minutes up to six hours; access denial has a six-hour
  minimum, and a longer Retry-After wins. This may intentionally suppress that evening's fallback.
- `destination-unavailable`: restore the selected channel/role permissions, then issue `feed` again
  to revalidate and resume. Do not expect recurring public failure messages.
- `decryption-failed`: restore the correct deployment secret first. With the correct key, explicit
  `feed` reconfiguration can replace corrupt routing ciphertext after permission validation.
- `uncertain`: Discord acceptance cannot be established. Inspect the designated channel manually;
  there is no automatic resend or message-history reconciliation. Keep the tombstone. An operator
  may decide how to address a missed message outside this automated feed.

The outbox's pending/claimed work can recover after a crash; an expired `sending` lease becomes
uncertain. Mongo TTL cleanup is not an eligibility mechanism: deadlines are checked before sending.
Restarts preserve collection slots, backoff, pending batches, genuine retry deadlines, and terminal deduplication. There is no morning
delivery of the previous evening's pending daily edition.

## Secret maintenance

Keep `DATA_PROTECTION_SECRET` stable. News derives domain-separated HMAC and authenticated-encryption
keys from it and stores a verification marker to detect a wrong deployment key. Restoring the old
secret is the supported recovery for accidental changes. HMAC lookup keys cannot be decrypted.

There is no online key-rotation tool. A deliberate rotation requires a reviewed maintenance migration
of news lookup keys, encrypted routing, and deduplication state, using the old secret. Alternatively,
an operator may explicitly authorize a clean news reconfiguration: stop/drain news, perform the
database reset only outside the 20:00–22:00 delivery window, replace the secret, and reconfigure the
feeds before the next evening. Such a reset must be limited to the six `news_*` collections and
understand that it discards news tombstones. Do not delete the key marker alone to suppress the
diagnostic. Rotation also affects existing AI/media HMAC records; see [SECURITY.md](SECURITY.md).
No database reset, secret change, or rotation is performed by this feature's installation.

## Controlled live acceptance and rollback

After local acceptance, use an explicitly authorized test guild/channel with the existing bot.
Verify the registered native selectors and ephemeral Manage Server enforcement, then one quiet
continuous embed and one daily edition message without a role ping initially. Inspect title/link,
timestamp, optional image, headings, and notification behavior on Discord clients. A role ping needs
its own explicit test configuration. Verify status, channel replacement, disable, permission loss,
and restart without duplicate messages. Record actual channel verification separately from mocked
transport tests and publisher retrieval. Do not enable friends' channels merely to test the feature.

Rollback by disabling both test subscriptions or setting `NEWS_ENABLED=false` and restarting normally.
Leave Mongo scheduling and tombstones intact, and drain before closing Discord/Mongo. Re-enable
through the same commands after repair; the continuous baseline and daily tombstones prevent a
catch-up flood. Deployment and live Discord acceptance are separate actions, not implied by a
green local build.
