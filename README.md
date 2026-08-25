# Jolanda

Jolanda is a privacy-conscious, multilingual Discord assistant for one server. Mention her to ask a
question, mention her while replying to quote a message, or reply to one of her answers to continue
the same conversation. She answers in the language the user writes in.

## Behavior and settings

- `@Jolanda What is happening today?` starts a conversation.
- `@Jolanda +context Fact-check the discussion above` opts into the server-approved context window
  for that interaction only; `+context=10` requests a smaller explicit number.
- Mentioning Jolanda in a reply includes that explicitly replied-to message.
- Replying to any chunk of Jolanda's answer continues the conversation without another mention.
- A conversation is private to its creator, channel, and guild and ends after 10 Jolanda replies.
- Ambient context defaults to `0` on every interaction. When explicitly requested, it includes only
  preceding human messages in the same channel, up to the server policy and prompt-size ceilings.
- Server settings are read fresh for every interaction, including an ongoing reply chain.
- While a turn is running, one throttled Discord message shows the answering or finalizing stage and
  any provider-generated reasoning summary. Its elapsed-time heartbeat keeps
  updating every two seconds after answer text starts and until final rendering, distinguishing an
  open request from recent provider stream activity. Raw reasoning is never displayed. The status
  is replaced by the streamed answer, which is bounded to six messages; generated mentions and link
  previews are disabled.
- Every model-generated final answer has a trusted source-basis footer. It says when no public web
  research ran, renders bounded OpenRouter source links once in the footer when available, or
  reports missing usage/source metadata instead of guessing. The footer also shows the total cost
  of that response at microdollar precision; when usage is missing, it labels the conservative
  reservation charged by the accounting system. Model-authored URLs that
  do not match a structured citation stay non-clickable, but their readable Markdown labels remain.
  Local greetings are not labeled as model answers.
- Model responses use a compact Discord Markdown subset: normal-sized emphasis, lists, quotes, and
  code are allowed, while headings and other expansive document-style formatting are prohibited.
  A renderer-side clamp converts any model-generated Markdown heading into ordinary bold text.

There are intentionally no per-message model or reasoning overrides. Every interaction inherits
the server-scoped settings.

`/jolanda privacy` is available to every member. The following commands require **Manage Server**:

- `/jolanda settings` shows model, reasoning, context, and committed spend.
- `/jolanda model` selects an atomic model/reasoning profile. Discord only offers reasoning efforts
  supported by that model and labels profiles without a Zero Data Retention route as `[no ZDR]`.
- `/jolanda context-limit` controls how many preceding messages members may explicitly request,
  from `0` through `MAX_CONTEXT_MESSAGES` (default maximum `50`). It never changes the per-interaction
  default of zero, and explicit replies still work when the limit is zero.

Defaults are DeepSeek V4 Flash, high reasoning, zero ambient context, and an opt-in context limit of
zero until a server administrator enables it.

## Architecture

- The Discord adapter owns bounded gateway admission, command authorization, reply detection,
  deadline-bound history/reference reads, and progressive rendering.
- The Jolanda core authorizes work before context reads, builds prompts, enforces ownership and
  concurrency, orchestrates inference, settles usage, and drains active turns on shutdown.
- Exact greetings and acknowledgements are answered locally. Every model turn receives one immutable,
  trusted clock snapshot in `JOLANDA_TIME_ZONE` (default `Europe/Bratislava`), OpenRouter's datetime
  tool, local calculator and IANA time-zone conversion tools, and bounded public web-search and
  web-fetch tools. The model decides which tools a question needs. Local function calls run through a
  bounded two-round loop and return structured results to the model; there is no research classifier
  or separate research generation.
- MongoDB exposes transactional settings, conversation, locking, rate-limit, budget-reservation,
  settlement, and expired-lease recovery operations through a small store interface.

Replies, explicitly requested context, history, and prior turns are labeled as untrusted data in the
prompt. Because every model turn has direct web tools, that context can influence a model-generated
public search query; members must not send secrets. Calculator and time-zone tools are deterministic
and receive no network access. Progress and reasoning summaries are ephemeral
rendering state: they are not written to transcripts or structured logs. Source-basis labels are
derived from structured usage/citation metadata; the canonical turn event records only the finite
basis category and source count, while stored conversation text keeps the answer without the UI
footer.

## Local setup

Requirements: Node.js 22+, pnpm 11+, a Discord application, an OpenRouter API key, and MongoDB Atlas.

```sh
pnpm install
cp .env.example .env
# For a local non-Atlas MongoDB only, set NODE_ENV=development.
pnpm dev
```

Generate `DATA_PROTECTION_SECRET` with `openssl rand -base64 32`. Configure the Discord application:

Set `JOLANDA_TIME_ZONE` to the deployment's default IANA time zone if it should differ from
`Europe/Bratislava`, for example `America/New_York`. It is shared by every server using the bot.

1. Create a bot named **Jolanda** in the Discord Developer Portal.
2. Enable **Message Content Intent**.
3. Invite it with the `bot` and `applications.commands` scopes.
4. Grant **View Channels**, **Send Messages**, and **Read Message History** only where it may operate.
5. Invite the same application to every server where Jolanda should operate. Slash commands are
   registered globally at startup and settings, budgets, and conversations remain isolated per server.

## Limits and accounting

The defaults enforce three accepted prompts per member in a rolling minute, `$2` total server spend
per UTC day, `$10` per UTC month, two concurrent turns process-wide, one active turn per conversation,
at most five provider tool calls per request, two local function-call rounds, four local calls per
round, three search results, two fetched pages, at most 20 active Discord adapter handlers, and
bounded prompt/output/SSE sizes. Each OpenRouter request has ten minutes to produce its first
non-empty stream chunk; after streaming starts, inference has no application-level deadline and is
cancelled only by shutdown or an upstream caller.

Before inference, Jolanda computes a conservative reservation from the chosen model, reasoning,
prompt ceiling, completion ceiling across tool rounds, provider price ceilings, and search/fetch
allowances. MongoDB
reserves that amount transactionally. Exact request usage replaces it when OpenRouter reports
usage; otherwise the full reservation is charged. Configuration fails when a budget cannot cover one
maximum-cost turn. Money is stored as integer microdollars.

OpenRouter currently rejects `provider.max_price` when a server tool is present. Assistant generations
therefore rely on the pinned model price, conservative reservation, bounded tools, and production-key
cap instead of a request-side price ceiling.

Set a separate `$10` monthly cap on the production OpenRouter key as defense in depth. Pricing and
provider behavior can change, so review the ceilings in `src/models.ts` before upgrading models.

## Privacy and security

- Context is opt-in and disabled by default. Transcript retention defaults to seven days.
- Context explicitly requested for a turn becomes part of the stored conversation transcript until
  that transcript expires.
- Guild, channel, member, Discord-message, request, and interaction IDs are HMAC-pseudonymized before
  MongoDB persistence or application logging. Structured Discord mentions, message links, custom
  emoji IDs, and standalone snowflakes inside transcript text are replaced with generic labels.
- OpenRouter routing denies provider data collection and requires parameter support. It enforces
  Zero Data Retention automatically for models with a compatible route; models labeled `[no ZDR]`
  remain selectable and may be retained by their provider under that provider's policy.
- The system prompt tells the model never to search for credentials, personal data, or private
  targets; this is model behavior rather than a deterministic request gate. Web tools are read-only
  and bounded. Output is bounded; only exact public URLs carried by OpenRouter's
  structured citation annotations can remain clickable, with query strings and fragments removed.
  Citation titles, ranges, and URLs are bounded, provider excerpts are discarded, and source
  annotations are rendered only in the trusted footer rather than rewriting answer text.
- Failed responses show a safe reason and correlation reference. The matching Railway
  `jolanda_turn` event records bounded OpenRouter status, code, stage, generation/provider routing,
  and timing fields when available; raw provider messages and response bodies are discarded.
- Model output cannot ping members or roles and cannot generate Discord embeds.

Atlas TTL cleanup is asynchronous; application queries reject expired transcripts immediately.
Atlas backups and Railway logs have their own retention. See [SECURITY.md](SECURITY.md) for the
threat model, production checklist, incident response, and residual risks.

## Verification

```sh
pnpm format
pnpm check
pnpm build
pnpm audit --prod
```

`pnpm check` runs TypeScript, ESLint, MongoDB replica-set integration tests, adapter/core tests, and
enforced V8 coverage thresholds. The required predeployment provider gate is opt-in and paid:

```sh
OPENROUTER_LIVE_TEST_KEY=... pnpm test:release-live
```

Use only a deliberately capped key. `pnpm test:live` remains a smaller compatibility smoke test;
the release command additionally covers every reasoning effort, web search on each model,
English/Slovak prompt injection, and direct misuse refusals. Both paid commands fail before Vitest
when the live-test key is absent; `pnpm check` never enables paid calls merely because a key exists
in the environment.

## Railway deployment

Deploy the included Dockerfile as one Railway worker replica and add every variable from
`.env.example`. Jolanda uses the outbound Discord Gateway and needs no public domain. Shutdown stops
new work, aborts and drains active inference, settles reservations, and only then closes MongoDB.
Keep `NODE_ENV=production`; startup rejects Railway deployment metadata in any other mode.

Use a dedicated least-privilege Atlas user and a TLS-enabled URI. Railway static outbound IPs may
require a paid networking feature; otherwise Atlas must allow changing egress addresses. If a broad
Atlas access-list rule is unavoidable, compensate with a long unique password, strict database
permissions, TLS, and provider/database usage alerts.
