# Jolanda

Jolanda is a privacy-conscious, multilingual Discord assistant for one server. Mention her to ask a
question, mention her while replying to quote a message, or reply to one of her answers to continue
the same conversation. She answers in the language the user writes in.

## Behavior and settings

- `@Jolanda What is happening today?` starts a conversation.
- Mentioning Jolanda in a reply includes that explicitly replied-to message.
- Replying to any chunk of Jolanda's answer continues the conversation without another mention.
- A conversation is private to its creator, channel, and guild and ends after 10 Jolanda replies.
- Ambient context defaults to `0`. When enabled, it includes only preceding human messages in the
  same channel, up to the configured count and prompt-size ceiling.
- Server settings are read fresh for every interaction, including an ongoing reply chain.
- Responses stream through throttled Discord edits and are bounded to six messages. Generated
  mentions and link previews are disabled.

There are intentionally no per-message model or reasoning overrides. Every interaction inherits
the server-scoped settings.

`/jolanda privacy` is available to every member. The following commands require **Manage Server**:

- `/jolanda settings` shows model, reasoning, context, and committed spend.
- `/jolanda model` selects GPT-5.6 Luna or DeepSeek V4 Flash and that model's safe reasoning default.
- `/jolanda reasoning` changes the effort supported by the selected model.
- `/jolanda context` accepts `0` through `MAX_CONTEXT_MESSAGES` (default maximum `50`). Explicit
  replies still work when ambient context is zero.

Defaults are Luna, medium reasoning, and zero ambient context.

## Architecture

- The Discord adapter owns bounded gateway admission, command authorization, reply detection,
  deadline-bound history/reference reads, and progressive rendering.
- The Jolanda core authorizes work before context reads, builds prompts, enforces ownership and
  concurrency, orchestrates inference, settles usage, and drains active turns on shutdown.
- The OpenRouter adapter runs two isolated stages: optional public research with one bounded web
  search, then final answering with Discord context and no tools.
- MongoDB exposes transactional settings, conversation, locking, rate-limit, budget-reservation,
  settlement, and expired-lease recovery operations through a small store interface.

Private Discord context never enters the search stage. Search notes, replies, history, and prior
turns are labeled as untrusted data in the final prompt.

## Local setup

Requirements: Node.js 22+, pnpm 11+, a Discord application, an OpenRouter API key, and MongoDB Atlas.

```sh
pnpm install
cp .env.example .env
# For a local non-Atlas MongoDB only, set NODE_ENV=development.
pnpm dev
```

Generate `DATA_PROTECTION_SECRET` with `openssl rand -base64 32`. Configure the Discord application:

1. Create a bot named **Jolanda** in the Discord Developer Portal.
2. Enable **Message Content Intent**.
3. Invite it with the `bot` and `applications.commands` scopes.
4. Grant **View Channels**, **Send Messages**, and **Read Message History** only where it may operate.
5. Copy the server ID to `DISCORD_GUILD_ID`; commands are registered to that guild at startup.

## Limits and accounting

The defaults enforce three accepted prompts per member in a rolling minute, `$2` total server spend
per UTC day, `$10` per UTC month, two concurrent turns process-wide, one active turn per conversation,
one web search per eligible prompt, at most 20 active Discord adapter handlers, and bounded
prompt/output/SSE sizes.

Before inference, Jolanda computes a conservative reservation from the chosen model, reasoning,
prompt ceiling, completion ceiling, provider price ceilings, and the search allowance. MongoDB
reserves that amount transactionally. Exact combined stage usage replaces it when OpenRouter reports
usage; otherwise the full reservation is charged. Configuration fails when a budget cannot cover one
maximum-cost turn. Money is stored as integer microdollars.

Set a separate `$10` monthly cap on the production OpenRouter key as defense in depth. Pricing and
provider behavior can change, so review the ceilings in `src/models.ts` before upgrading models.

## Privacy and security

- Context is opt-in and disabled by default. Transcript retention defaults to seven days.
- Guild, channel, member, Discord-message, request, and interaction IDs are HMAC-pseudonymized before
  MongoDB persistence or application logging. Structured Discord mentions, message links, custom
  emoji IDs, and standalone snowflakes inside transcript text are replaced with generic labels.
- OpenRouter routing denies provider data collection, requires parameter support, and enables Zero
  Data Retention by default. Keep `ENFORCE_ZDR=true` unless you deliberately accept another policy.
- Public research is disabled for likely credentials, personal contact data, private URLs, and
  secret-bearing questions. Output is bounded; only exact public URLs carried by OpenRouter's
  structured citation annotations can remain clickable, with query strings and fragments removed.
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
the release command additionally covers every reasoning effort, web search on both models,
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
