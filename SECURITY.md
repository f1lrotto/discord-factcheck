# Security policy

Jolanda handles Discord messages and a paid OpenRouter credential. Treat its deployment as a
small production service even when it is used by only one server.

## Security boundaries

- The Discord guild allowlist and per-channel Discord permissions define where Jolanda operates.
- Only members with **Manage Server** can change model, reasoning, or ambient-context settings.
- Conversations are bound to the member who started them, their channel, and their guild.
- Public web research is an isolated first stage. It sees only a minimized latest question and can
  make at most one bounded search. The final stage sees Discord context but has no tools.
- Spend is authorized transactionally against a worst-case model/search envelope before inference.
- Discord identifiers are HMAC-pseudonymized before MongoDB persistence or structured logging.
- Conversation text remains plaintext in MongoDB until its configured expiry so reply chains work.
- Model output cannot create mentions or embeds, is length-bounded, and has private, credentialed,
  query-bearing, and fragment-bearing links removed. Only exact URLs supplied by isolated public
  research are allowlisted as citations.
- Discord gateway work is admitted through a fixed process-wide gate before reference or database
  lookups; Discord REST and adapter operations have finite deadlines.

Prompting and model refusals are defense in depth, not authorization controls. Jolanda deliberately
has no tools that can write data, send messages outside the current Discord response, execute code,
or access private services.

## Required production controls

1. Generate `DATA_PROTECTION_SECRET` independently from every API credential and keep it stable.
   Rotating it makes existing pseudonymous records unreachable until their TTL expires.
2. Use a dedicated, least-privilege Atlas database user and a TLS-enabled Atlas URI. Restrict the
   network access list where Railway networking permits it.
3. Keep `ENFORCE_ZDR=true`. Verify the selected OpenRouter endpoints support Zero Data Retention and
   parameter enforcement before deployment.
4. Create a dedicated OpenRouter key and set its provider-side monthly cap to `$10`. The application
   separately enforces the `$2` UTC daily and `$10` UTC monthly server budgets.
5. Keep Railway variables encrypted and do not put `.env`, database dumps, logs, or Discord exports
   in source control.
6. Run one Railway replica. Lease-based recovery protects rolling overlap, but active-active gateway
   operation is not a supported deployment topology.
7. Review Atlas backup retention and Railway log retention against your privacy policy. Atlas TTL
   deletion is asynchronous and does not immediately remove backup copies.

Members can run `/jolanda privacy` to see the current context and transcript-retention settings.

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
