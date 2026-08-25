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
- Discord identifiers are HMAC-pseudonymized before MongoDB persistence or structured logging.
- Conversation text remains plaintext in MongoDB until its configured expiry so reply chains work.
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
permissions, and network targets. Jolanda deliberately has no tools that can write data, send
messages outside the current Discord response, execute code, or access private services.

## Required production controls

1. Generate `DATA_PROTECTION_SECRET` independently from every API credential and keep it stable.
   Rotating it makes existing pseudonymous records unreachable until their TTL expires.
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
