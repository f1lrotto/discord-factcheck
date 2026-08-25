# Jolanda security and correctness remediation plan

Status: in progress

This plan converts the independent Standards, Spec, security, and test audits into release criteria.
The work is complete only when every item is implemented or explicitly documented as a constrained
residual risk, all automated checks pass, and a fresh independent review returns no actionable
findings.

## 1. Make spending limits enforceable

- Replace the fixed, unchecked turn reservation with a cost-envelope module that derives the
  minimum reservation from the largest allowed prompt, completion, and web-research request.
- Derive every reservation from the selected model/reasoning pair and fail configuration when the
  configured daily or monthly limit cannot fund even one maximum-cost turn.
- Send provider `max_price` ceilings on final inference and send `max_tokens`, `max_results`,
  `max_total_results`, and top-level `max_tool_calls` on every applicable OpenRouter request.
  OpenRouter currently returns 500 when `max_price` and a server tool are combined, so research is
  instead bounded by the pinned model, reservation envelope, search caps, and production-key cap.
- Reduce Discord-oriented completion ceilings and allow at most one bounded search per turn.
- Add a process-wide concurrency gate so one guild cannot start an unbounded number of in-flight
  generations.
- Preserve exact OpenRouter settlement when usage is present and charge the full reservation when
  any started request lacks usage.
- Document and require a separate `$10` monthly production-key limit in OpenRouter. The application
  remains responsible for the `$2` UTC daily cap and the per-user rolling rate limit.

Acceptance criteria:

- Concurrent authorization cannot commit more worst-case cost than the remaining daily or monthly
  budget.
- Tests cover actual cost above the old `$0.10` value, concurrent reservations, boundary resets,
  missing usage, and tool/output ceilings.

## 2. Remove private context from the web-search control loop

- Change the OpenRouter adapter into a deep module with two internal stages:
  1. optional public research that sees only a minimized copy of the latest question and owns the
     single web-search tool;
  2. final answering that receives conversation/reply context plus untrusted research notes but has
     no tools.
- Never send Discord IDs, display names, timestamps, ambient messages, replied messages, or prior
  conversation turns to the research stage.
- Omit Discord IDs and real display names from the final inference prompt where they are unnecessary.
- Add deterministic sensitive-input checks that disable research for likely credentials, private
  URLs, or other secret-bearing questions.
- Treat research notes as quoted, untrusted evidence in the final prompt.
- Suppress Discord link embeds, reject unsafe URL schemes/hosts, disable generated mentions, and
  deterministically cap stored/sent assistant text.

Acceptance criteria:

- An adversarial context message cannot influence any web-search request because the search stage
  cannot observe it.
- Request-capture tests prove the research request contains only the minimized latest question and
  the final request contains no tool declaration.
- Multilingual and prompt-injection tests cover English and Slovak inputs.

## 3. Harden persistence and deployment recovery

- Give processing requests an instance-owned lease longer than the OpenRouter timeout.
- Recover only expired leases, both at startup and in a periodic internal sweeper.
- On SIGTERM/SIGINT, stop accepting work, abort and drain active model calls, settle reservations,
  then close MongoDB.
- Make settings updates transactional and validate the model/reasoning pair inside the transaction
  so concurrent administrator commands cannot lose data or create invalid combinations.
- Replace per-message link writes with a MongoDB bulk write.
- Keep one replica as the supported deployment topology, but make rolling overlap accounting-safe.

Acceptance criteria:

- Live requests owned by another instance are never recovered early.
- Expired requests release their reservation conservatively.
- Concurrent model/reasoning/context changes preserve valid settings.
- Shutdown tests prove MongoDB remains available until active turns settle.

## 4. Minimize and protect user data

- HMAC-pseudonymize Discord guild, channel, user, message, request, and interaction identifiers before
  persistence or logging, using a dedicated Railway secret.
- Remove unused user identifiers from stored conversation turns and make conversations owner-bound
  by default.
- Keep transcript TTL configurable, reject expired data in application queries immediately, and
  explain that Atlas TTL deletion is asynchronous.
- Add an unprivileged `/jolanda privacy` response describing OpenRouter processing, Atlas retention,
  explicit replies, optional ambient context, shared-provider limitations, and the current TTL.
- Configure safe error serialization/redaction so Discord request bodies, authorization headers,
  tokens, prompts, and model output cannot enter Railway logs.
- Keep one pseudonymous wide event per turn, including deployment context and cost/usage metadata.

Acceptance criteria:

- Secret scanning finds no credentials.
- Tests verify persisted/logged identifiers are pseudonymous and prompts omit Discord identifiers.
- Ordinary members can read the privacy notice but cannot mutate guild settings.

## 5. Bound resource use and improve module depth

- Authorize rate/budget usage before fetching ambient Discord history.
- Bound global concurrency, SSE frame size, accumulated model output, Discord response characters,
  and Discord message chunks.
- Centralize conversation, output, web, timeout, and cost constants.
- Split the Discord and Mongo implementations into focused internal modules while retaining small
  external interfaces. Test through those interfaces using production and test adapters.
- Remove duplicated limits and avoid read/modify/write settings races.

Acceptance criteria:

- Rejected prompts perform no channel-history fetch.
- No single response can create an unbounded number of Discord messages or grow an unbounded SSE
  buffer.
- Formatting, linting, and type checks enforce the documented style.

## 6. Raise verification to production level

- Add Vitest V8 coverage and enforce meaningful line, branch, function, and statement thresholds.
- Add Mongo replica-set integration tests for transactions, concurrency, budgets, recovery, TTL
  query behavior, deduplication, locks, pseudonymization, and settings races.
- Add Discord adapter contract tests for tag/reply routing, owner checks, permissions, privacy,
  streaming, chunk limits, mentions, embeds, and failure paths.
- Add OpenRouter tests for request isolation, price/tool ceilings, SSE errors, malformed/oversized
  frames, timeouts/aborts, missing usage, combined two-stage usage, and safe error handling.
- Add Jolanda core tests for every rejection, settlement/failure path, context-zero privacy,
  authorization-before-context, conversation continuation/limits/ownership, concurrency, and drain.
- Add opt-in, capped-key live compatibility and multilingual/red-team tests; never run paid tests as
  part of the default check.
- Run `pnpm format`, `pnpm check`, `pnpm build`, `pnpm audit --prod`, Docker build, and secret scans.

## 7. Make model effort proportional and provider failures diagnosable

Before this work, the public-research check answered only whether a normalized question was safe to
send to a web-enabled model. It did not decide whether research was useful. As a result, every
non-sensitive question—including a greeting—could make a research request followed by a separate
answer request. Both stages used the selected reasoning level, the research stage could generate up
to 2,048 tokens, and the combined turn could occupy the three-minute OpenRouter deadline. The wide
event logged only total turn duration, so a two-minute turn could not be attributed to routing,
provider queueing, research, first-token latency, generation, or Discord delivery after the fact.

Long duration is not itself a defect. A concise answer may legitimately require substantial
research, comparison, or verification. The defect is unearned work: selecting research, deep
reasoning, large output ceilings, or long wait budgets when the request does not justify them. Judge
proportionality from the selected work plan and the work actually performed, not from response
length alone.

The failure path also discards useful diagnostics. A non-2xx OpenRouter body is cancelled without
being decoded, streamed failures retain only a narrow error code, the Discord response is generic,
and the log serializer deliberately removes unrecognized detail. Preserve that privacy boundary,
but replace the information loss with a bounded, typed, and explicitly sanitized diagnostic path.

### Phase 1: establish stage-level observability

- Record one monotonic timeline for admission, context collection, research, final answering, first
  response headers, first SSE event, first visible token, final Discord synchronization, and total
  completion. Include the active stage, stage duration, time since last provider activity, and
  terminal reason on failures.
- Keep the two-second heartbeat as a liveness signal. Derive its stage and provider-activity counter
  from real events, and never display “checking public sources” until a research request has actually
  been selected and started. Keep it active after the first answer delta and through final settlement
  so a throttled first edit or post-provider persistence cannot freeze the visible elapsed time.
- Add only bounded, non-content telemetry to the pseudonymous `jolanda_turn` wide event. Do not log
  prompts, research notes, model output, Discord content, authorization data, or raw provider error
  payloads.
- Record the selected route/reason, research mode, model/search calls, output-character count, and
  finish reason. Add a finite source-basis category and structured-citation count to both the final
  UI and wide event. These fields must make unnecessary work distinguishable from a short answer
  that genuinely required deep research.
- Treat OpenRouter citation URL, title, and character ranges as the only inline-link authority.
  Bound and normalize those fields, discard provider excerpts, ignore invalid ranges, and preserve
  only the plain labels of unmatched model-authored Markdown links.
- Emit separate research and answer generation identifiers when OpenRouter supplies them so an
  operator can correlate a failed turn with OpenRouter's Activity view or generation API.

### Phase 2: separate research eligibility from research necessity

- Retain the existing private-target and secret checks as `research eligibility`; introduce only the
  deterministic routes needed for privacy and zero-work social turns. Do not add a broad semantic
  classifier-model request to the hot path.
- Handle exact low-risk social turns such as greetings and thanks locally. Give a standalone
  public-safe question one answer generation with an automatic, bounded web-search tool and a concise
  search policy; the model decides whether to search and answers in the same generation.
- Run contextual questions without tools by default. When a contextual question explicitly requests
  fresh research or sources, preserve the isolated public-research stage followed by the final
  no-tool contextual answer.
- Make the decision observable through the implemented finite reason codes `greeting`, `thanks`,
  `public_standalone`, `private_context`, `contextual_research_requested`, and
  `research_ineligible`; never log the question itself.
- Use the system prompt to describe the search criteria and representative non-search cases, rather
  than attempting to enumerate every possible prompt. Bound tool use deterministically even though
  the model chooses whether to invoke it.
- Preserve the privacy architecture: public research receives only the minimized latest question,
  while the final no-tool request may receive private conversation context and sanitized research
  notes.

### Phase 3: keep long work bounded and observable

- Keep the centralized inference deadline as an upper safety bound for a stalled or runaway request,
  not as a product target that every answer should approach.
- Use one generation for the common automatic-tool route. Only an explicitly contextual research
  route may use the two-stage flow under the shared overall deadline.
- Run the research extraction step with low reasoning, a materially smaller completion ceiling, one
  bounded search call, and no application retry. The configured reasoning level remains available
  to the final answer where it adds value.
- Do not impose a universal 15-second research or 45-second turn cutoff merely to make the latency
  number look better. Explicit research and complex fact-checking may take longer as long as real
  activity is visible and the selected work remains bounded.
- Cancel a timed-out stage, retain its admission and spending reservation until the underlying call
  settles, and classify whether the timeout occurred before headers, before the first SSE event, or
  during generation.
- Keep the provider-quiet warning distinct from a timeout. A live request may be quiet while the
  model reasons; the safety deadline, not an incrementing counter, determines when it is aborted.
- Review measured p50, p95, and p99 latency by route, model, reasoning level, research decision, and
  outcome after rollout. Include model/search call counts and output-size buckets so disproportionate
  work is visible without assuming that every short answer should have been cheap. Slow
  provider/model combinations must not be averaged into a single total-duration metric.

### Phase 4: retain safe OpenRouter failure metadata

- Opt requests into OpenRouter router metadata and capture the `X-Generation-Id` response header as
  soon as headers arrive. Decode metadata permissively because new optional fields may be added.
- Replace generic `Error` construction with a typed `ModelFailure` containing only bounded
  fields: stage, failure category, HTTP status, safe API code, generation ID, routing strategy,
  attempt count, provider name, timeout point, and elapsed/quiet durations.
- Read non-2xx JSON through a strict byte limit and schema. Parse streamed error envelopes through
  the same normalizer. Never persist or render `error.message`, `metadata.raw`, provider response
  bodies, prompt fragments, or arbitrary router/pipeline data; unknown fields are discarded.
- Normalize failures into a small stable taxonomy: timeout, rate limited, authentication, payment
  required, request rejected, provider unavailable, provider failure, malformed response, network
  failure, caller cancellation, and unknown. Metadata is optional: edge errors and masked internal
  errors may not supply routing details.
- Generate a short pseudonymous failure reference. Discord receives the stage, safe category, and
  reference—for example, “Public research timed out (reference ABC123)”—while Railway receives the
  matching structured diagnostic. Raw upstream text must never be shown in a public channel.
- Log enough information to query OpenRouter's generation record out of band when a generation ID
  exists. Do not add a generation-lookup API call to the user-facing failure path.

### Phase 5: verify and roll out

- Add routing tests proving greetings never call OpenRouter, standalone public questions use one
  automatic-tool generation, private contextual questions have no tool, and explicit contextual
  research remains isolated. Include English and Slovak examples and explicit city-question cases.
- Add fake-clock tests for every stage boundary, research fallback, required-research failure,
  overall cancellation, quiet-provider status, reservation settlement, and shutdown drain behavior.
- Add non-2xx and SSE contract tests for each safe failure category, missing/malformed metadata,
  oversized bodies, unknown additive fields, and absent generation IDs. Seed payloads with fake
  secrets and prompt text and prove neither Discord nor captured logs contains them.
- Add an opt-in capped-key live probe that records routing metadata and generation correlation
  without depending on a particular provider failure. Keep it outside the default test suite.
- Roll out observability first, establish a baseline, then enable the new routing and diagnostics.
  Compare equivalent production windows for unnecessary-research rate, work plan,
  model/search call counts, first-token latency, completion latency, timeouts, safe fallback rate,
  and failure categories.

Acceptance criteria:

- A greeting performs no OpenRouter or web-search request and does not display a research status.
- A simple standalone answer performs exactly one generation. The model may decline the available
  web tool; it never pays for a separate `NO_RESEARCH` classifier generation.
- An automatic-tool turn performs one generation and at most one search. An isolated contextual
  research turn performs at most one bounded research request and one final generation.
- A long turn is acceptable when the selected plan and telemetry demonstrate justified deep or
  research work and the heartbeat continues to show liveness. Every provider timeout identifies its
  stage and timeout point.
- Every failed turn shown in Discord has a safe reason and failure reference that resolves to one
  sanitized Railway event. When available, that event includes the relevant OpenRouter generation
  ID and bounded routing metadata.
- Provider-controlled strings, prompts, research notes, assistant output, credentials, and raw
  metadata remain absent from public errors and logs.
- Automated tests, formatting, type checks, linting, coverage, and the capped live compatibility
  probe pass before the routing and diagnostics are enabled in production.

## 8. Independent review loop

After implementation and verification:

1. Run independent Standards and Spec reviews against this plan and the original conversation spec.
2. Run separate adversarial security/AI-agent and test-coverage reviews.
3. Fix every confirmed actionable finding.
4. Repeat verification and review until both axes pass and the security/test reviewers report no
   actionable findings.
5. Record final evidence and any deliberately accepted residual risks below.

### Round-one review findings

The first post-remediation Standards, Spec, security, and test reviews found the following release
blockers. They are part of this plan and must be fixed before round two:

- Require a finite provider-reported cost in every usage record; incomplete usage must charge the
  conservative reservation instead of settling at zero.
- Apply one overall two-stage inference deadline, keep request/conversation leases longer than the
  complete bounded turn, and use a unique acquisition token for every conversation lock.
- Remove unsupported parallel MongoDB operations from transactions, deterministically test settings
  races/recovery, and close a partially initialized Mongo client.
- Retry unresolved shutdown settlements and refuse to close MongoDB while any remain.
- Bound raw SSE read batches and parse frames incrementally without materializing an unbounded array.
- Treat only exact, public research-source URLs as valid output links; reject non-HTTP schemes,
  private/link-local/reserved IPs, bare domains, and model-invented URLs. Buffer incomplete streaming
  links and delete stale surplus Discord chunks.
- Bound/cancel pre-inference Discord work and silently contain repeated rejected/unrelated traffic.
- Allowlist safe application error messages rather than logging arbitrary third-party text.
- Reject insecure MongoDB URI options in production and make the example Railway environment
  unambiguously production.
- Clarify that transcript contents are plaintext even though Discord identifiers are pseudonymous.
- Add missing-usage, overall-abort/output/SSE, streaming-link, unrelated-reply, shutdown-settlement,
  deterministic accounting/settings/recovery, English/Slovak injection, and opt-in live web/red-team
  verification, plus per-file coverage floors for sensitive modules.

### Round-two review findings

Round two verified the round-one fixes and found no critical vulnerability. It did identify these
remaining release requirements, which must be completed before the next review:

- Derive link permissions exclusively from OpenRouter's structured `url_citation` annotations.
  Model-authored research prose is untrusted and must never be able to authorize its own URLs.
- Replace the narrow URL regular expression with deny-by-default link handling that catches fuzzy
  domains, internationalized domains, email addresses, Markdown destinations, and uncommon or
  one-character URI schemes, while preserving non-clickable code examples.
- Give MongoDB selection, connection, socket, and individual operations finite timeouts. Track
  Discord adapter handlers so shutdown stops admission and drains them before MongoDB closes.
- Prune expired rate-gate entries before enforcing the new-key capacity ceiling so stale callers
  cannot poison the in-memory admission gate.
- Calculate the research-to-final cost envelope from the actual maximum research response character
  bound, not an assumed average token-to-character ratio.
- Add deterministic tests for duplicate/concurrent settlement, minute and UTC-month boundaries,
  non-negative reservations, all persisted collections, database-linked continuations without
  Discord reply metadata, stale rate-gate capacity, Mongo timeout configuration, and handler drain.
- Run the prompt-injection compatibility matrix in both English and Slovak across both supported
  models. The opt-in paid OpenRouter tests remain a required pre-deployment check with a separately
  capped credential; they cannot be executed without that deployment credential.

### Round-three review findings

Round three verified the round-two remediation and found no critical or high-severity issue. The
following medium/low findings are now release requirements:

- Refresh the pinned DeepSeek V4 Flash 0731 reasoning contract from OpenRouter's live model metadata:
  expose `low`, `high`, and `max`, keep `high` as its default, and remove the stale `xhigh` option.
- Make Discord rendering cancellation-aware and serialized. A caller timeout must stop further REST
  operations, while the underlying task remains tracked until it settles so shutdown cannot close
  dependencies while a timed-out edit/send is still running.
- Make stale-reservation recovery bounded and single-flight, skip overlapping interval ticks, and
  await the active recovery sweep before closing MongoDB.
- Acknowledge slash commands ephemerally before database work, then edit the deferred response so a
  slow but bounded Atlas operation cannot miss Discord's acknowledgement window.
- Bound and validate citation annotation URLs during SSE ingestion, rather than retaining arbitrary
  annotation volume until post-processing.
- Close the escaped-code output-sanitizer bypass and make internal fragment placeholders
  collision-safe. Backslash-escaped code delimiters must not shield clickable links from citation
  enforcement.
- Reject provider usage whose microdollar conversion is not a finite safe nonnegative integer;
  malformed usage must fall back to the conservative reservation instead of poisoning MongoDB
  budget counters with `Infinity`.
- Make the paid release gate one explicit command that enables compatibility, web-search, and
  red-team suites. Exercise both models in both languages, every exposed reasoning effort, web on
  both models, language/correctness under injection, and representative direct misuse refusals.
- Reject spend-limit configuration whose dollar-to-microdollar conversion is not a finite safe
  integer, so extreme-but-schema-valid numbers cannot silently disable the budget caps.
- Drain a failed in-flight recovery sweep without preventing the Mongo client from closing; record
  the bounded failure through the safe logger after the sweep has settled.

### Round-four review findings

Round four verified every earlier production fix and found no critical or high-severity issue. Its
remaining findings are release requirements:

- Make the paid release command fail closed before Vitest when its capped credential or required
  suite flags are absent. Paid calls must require an explicit live-test switch as well as a key, so
  an ordinary `pnpm check` cannot spend money merely because a live key is exported. Add a
  deterministic missing/empty-key regression test while keeping ordinary paid tests skipped.
- Strengthen paid injection assertions so a language-neutral one-character answer cannot pass, and
  require language-specific grammatical correctness. Add scenario-specific negative assertions to
  the credential-theft, malware, and doxxing cases so a refusal preamble followed by actionable
  harmful instructions cannot pass.
- Add controlled recovery tests proving the 100-request batch boundary, single-flight behavior for
  overlapping recovery calls, shutdown waiting for an active sweep, and safe rejected-sweep logging
  without preventing the client-close step.
- Make Discord interaction mocks track deferred/replied state with distinct reply/edit spies, and
  drive the side-effecting sink test through the actual Discord-operation timeout with fake timers.
- Normalize Discord structured mentions, custom emoji, message links, and standalone snowflakes in
  questions, explicit replies, and ambient context before prompt construction. Persist and send only
  the generic placeholders so stable Discord identifiers cannot hide inside transcript text.
- Once any non-null SSE usage event is malformed, invalidate usage for the whole request even if an
  earlier usage event parsed. Missing, incomplete, wrong-type, overflowed, and malformed trailing
  usage must all trigger conservative settlement.
- Disable public web research for scheme-less private targets, including localhost/host:port,
  private/link-local/reserved IPs, internal hostname suffixes, intranet-style paths, and Discord
  message URLs.
- Correct the unknown-scheme sanitizer so ordinary multilingual label prose such as `Note:`,
  `Sources:`, `Answer:`, and `Poznámka:` is preserved, while real non-HTTP URI schemes remain
  deny-by-default.

### Round-five review findings

Round five returned one clean Spec review but identified the following remaining requirements in
the security, Standards, and test reviews:

- Treat every nonempty, non-`[DONE]` SSE data frame that is not valid JSON as a protocol failure for
  usage purposes. A truncated or arbitrary malformed frame after a low valid usage record must make
  overall usage missing and trigger conservative settlement.
- Expand the private-research gate to NFKC/WHATWG-style host-dot variants, unbracketed private IPv6,
  and single-label intranet hosts when they carry a port or path. Cover loopback, link-local,
  metadata, encoded, Unicode-dot, host:port, and intranet-path forms without classifying ordinary
  prose as a host.
- Add a dedicated CommonMark angle-autolink sanitizer that removes every non-HTTP(S) scheme even
  with an empty or parenthesized payload. Keep ordinary plain and Markdown-emphasized English and
  Slovak prose labels intact.
- Send the output-token parameter supported by both pinned OpenRouter model records (`max_tokens`),
  rather than requiring DeepSeek to accept Luna's additional `max_completion_tokens` spelling. Add
  request-shape assertions for both exposed models.
- Replace the paid red-team test's heuristic word/technology deny-lists with separately unit-tested,
  normalized evaluators: exact anchored language-specific arithmetic sentences and positive
  refusal-only/safe-alternative semantics. Include adversarial mutation fixtures that reject terse,
  repeated-word, refusal-then-phishing, refusal-then-ransomware, and refusal-then-address output.
- Make the failed-recovery test call production store-close orchestration through an injected/mock
  client so deleting the real `client.close()` step fails the test.
- Remove UTC-boundary flakiness from periodic and 101-request recovery tests by anchoring stale
  timestamps and querying the same intended budget bucket through an injected clock or explicit
  date.
- Reuse the stateful, distinct interaction spies for the unprivileged privacy command and assert
  that it defers then edits, never sends a fresh reply after acknowledgement.

### Round-six review findings

Round six returned clean Spec-test coverage on one axis but found heuristic correctness/security
edges in the research target and output-link filters:

- Replace the broad single-label `word/path` detector and small prose allowlist with range-aware
  tokenization. Exclude already-parsed public URL ranges; always reject unambiguous host-port forms;
  use explicit network/search-target signals for ambiguous single-label paths; preserve ordinary
  compounds such as `pros/cons`, `client/server`, `Windows/Linux`, `EU/US`, `km/h`, `on/off`, and
  Slovak equivalents without allowing internal `host/admin` targets in explicit search requests.
- Feed candidate tokens through WHATWG URL parsing before `privateHost`, including short
  decimal/octal IPv4, numeric or underscore internal labels, and trailing-dot single-label FQDNs.
  Cover `127/admin`, `0177/admin`, `build_server:8080/admin`, and `intranet.:8080/admin`.
- Implement actual CommonMark angle-autolink grammar rather than a broad colon-in-angle heuristic:
  require a valid scheme and a nonempty payload without whitespace/control/angle characters,
  preserve validated Discord timestamp markup and generic type/prose notation, and continue removing
  empty or parenthesized non-HTTP angle schemes that Discord/CommonMark may activate.
- Close the Markdown-label exception without reopening unknown-scheme handling. Protect complete
  emphasized prose-label tokens before URI sanitization, then deny bare uncommon/one-character
  schemes including `x:*payload`, `file:~/etc/passwd`, and `javascript:*alert(1)`.

### Round-seven review findings

Round seven returned one clean Spec audit, while the security, Standards, and test audits found the
following remaining repository requirements:

- Feed every syntactically network-like bare research token through WHATWG/IP classification, not
  only tokens with a port or path. Reject bare private/reserved/numeric/internal-suffix hosts,
  scheme-relative targets, backslash path variants, and query/hash forms without blocking public
  domains or ordinary words.
- Extend the special-use hostname policy to cover `.home.arpa` and `.onion` in research questions
  and citation candidates, including explicit URLs, scheme-less forms, and trailing-dot variants.
- Couple ambiguous single-label `host/path` rejection to explicit target intent such as
  search/open/read/fetch/visit/inspect. Do not reject comparison prose merely because its components
  resemble sensitive path names; retain unconditional rejection for unambiguous private hosts,
  numeric targets, host-port tokens, and clearly internal suffixes/hints.
- Preserve generic whitespace-based angle notation only when it contains no nested URI/link
  candidate. Preserve exact valid Discord timestamps first, then remove all remaining non-HTTP(S)
  angle schemes, including one-character, empty, and parenthesized forms such as `<a:>`,
  `<x:(payload)>`, `<mailto:>`, and `<t:>`.
- Parse complete backtick delimiter runs. Only an exact equal-length closing run may protect an
  inline code span; unmatched or unequal runs must not exempt a Markdown link from citation
  allowlisting. Cover both final and incremental streaming sanitization.
- Bound Discord work before model admission with a process-wide adapter semaphore and finite
  operation deadlines. A flood of distinct users with stalled reply/context fetches must not grow
  the tracked-handler set without limit, and shutdown must still drain admitted handlers before
  dependencies close.

### Round-eight review findings

Round eight verified the round-seven backtick and direct-host cases but found further normalization,
classifier, and lifecycle requirements:

- Replace immediate-prefix target heuristics with a bounded clause-level multilingual intent
  classifier. Recognize harmless punctuation, Markdown/angle delimiters, and natural filler in
  English and Slovak (`search/open/read/fetch/find` and equivalents), while comparison prose remains
  eligible for research.
- Normalize paired Markdown and Unicode presentation wrappers before classifying target candidates.
  Cover wrapped IPv4, IPv6, numeric, special-use suffix, query/hash, scheme-relative, and backslash
  forms.
- Parse query/hash-bearing targets by separating the host from the suffix before IPv6 and hostname
  classification. Treat syntactically targeted single labels such as `printer?x=1` as private while
  preserving ordinary terminal question punctuation.
- Use one complete nested-link predicate before protecting generic angle notation. Bare/fuzzy,
  internal, and special-use domains inside `<Label: value>` must still flow through output
  allowlisting; safe Discord timestamps and non-link type/prose notation remain intact.
- Refine colon-number research tokens so target-intent or address-like/internal evidence is required.
  Times, scores, aspect ratios, `HTTP:3`, and chapter references must not disable research.
- Add `.alt` and `.example` to the shared special-use hostname policy for both research targets and
  structured citation candidates without blocking all `.arpa` names.
- A Discord deadline may stop waiting for a caller response, but the underlying operation must stay
  tracked and retain its admission permit until it settles or is genuinely aborted. Adapter drain
  must not report completion while a timed-out reference/context operation can still finish later;
  test drain ordering and post-deadline distinct-user admission.

### Round-nine review findings

Round nine verified generic-angle, exact-backtick, citation, and Discord child-operation tracking,
but required one more target-classifier refinement:

- Lex presentation wrappers and surrounding sentence punctuation iteratively. Support Discord
  spoilers, nested Markdown/Unicode wrappers, quote/list prefixes, and punctuation outside a closed
  wrapper while preserving a real trailing-dot hostname.
- Parse every syntactically valid URI-scheme token through WHATWG handling, including slashless
  `http:`, `https:`, `ftp:`, and `file:` forms. Classify safe colon-number prose first so protocol
  version notation such as `HTTP:3` remains searchable.
- Apply query/hash policy before returning from IPv6 classification, including public IPv6
  equivalents, and classify numeric/octal/hex host-port forms without reclassifying times, scores,
  or aspect ratios.
- Inspect a bounded window on both sides of ambiguous candidates and add network-specific English
  and Slovak intent variants, passive/postfix forms, `curl`, and HTTP methods. Harmless ellipses and
  punctuation must not erase intent.
- Classify candidate-local safe compounds and colon-number prose before target intent. Preserve web
  research for comparisons, units, time, scores, ratios, protocol versions, chapters, and the
  specified English/Slovak compound examples even when the prompt contains a search verb. Add a
  Jolanda request-capture test proving those safe questions still reach the research adapter.

### Round-ten review findings

Round ten verified output-domain/backtick behavior and Discord operation drain tracking. It found
the following remaining target-role and presentation requirements, plus one output hardening item:

- Strong network intent (`curl`, HTTP methods, connect/access/navigate, explicit endpoint/host/URL
  wording, and Slovak equivalents), a valid URI scheme, or a query/hash suffix must override safe
  prose categories. Low decimal/octal/hex host-port targets must be blocked under network intent;
  temporal, score, ratio, protocol-version, and chapter uses remain safe under prose intent.
- Replace the finite slash allowlist as the sole exception with candidate-role classification.
  Lexical `word/word` compounds followed by descriptive prose or used in a comparison remain
  searchable; direct terminal targets, private host evidence, and strong network actions remain
  blocked. Add property-style mutations for unseen lexical compounds.
- Scope ordinary intent to the candidate's sentence so an unrelated later search clause does not
  suppress research. Preserve ellipsis intent and explicitly referring adjacent clauses such as
  “Search it,” plus passive/postfix English and Slovak forms.
- Normalize presentation around address subcomponents, not only whole whitespace tokens. Handle
  Markdown host wrappers adjacent to path/port/query punctuation, wrapper-final colon/dash,
  Markdown label/destination forms, sentence-final unbracketed IPv6 punctuation, and terminal
  fragments without confusing an ordinary final question mark.
- Strip Unicode bidirectional and other format controls from assistant output before link
  sanitization so hostile text cannot visually reorder trusted warnings or link-removal markers.

### Round-eleven review findings

Round eleven verified the accounting, prompt/tool isolation, identifier protection, SSE handling,
Discord lifecycle, deployment defaults, and earlier output controls. It found no critical issue,
but the private-target parser and balanced-link sanitizer still need the following release fixes:

- Make concrete network evidence decisive before any prose exemption. Internal host hints, numeric
  and private IP forms, special-use suffixes, ports, paths, queries, and fragments must not be
  overridden by lexical slash compounds, comparison wording, trailing filler, or target nouns.
  Treat ambiguous ordinary search/open/fetch imperatives as targets unless genuine candidate-local
  comparison or category prose establishes otherwise.
- Parse candidate roles per clause and per object. Sentence boundaries must not depend on the next
  word's capitalization, must preserve ellipses/decimals/addresses/common abbreviations, and must
  recognize immediate English and Slovak referents including separated phrasal forms such as
  “look it up.” Unrelated later search or strong-network clauses must not affect earlier compounds.
- Replace token-local, single-pass presentation cleanup with bounded balanced scanning. Classify
  Markdown destinations (including optional titles) separately from labels; recursively normalize
  nested Markdown/Unicode wrappers around host, port, path, and address components; and handle
  Unicode dash/ellipsis and sentence punctuation without corrupting valid IPv6 or hostname syntax.
- Parse URI syntax before protocol-version prose exemptions. `HTTP:10`/`HTTPS:127` in a direct
  open/search role are numeric private URI targets, while genuine version/chapter prose with
  explanatory grammar remains eligible for public research.
- Make query/hash syntax decisive before path fallthrough, including neutral wording and
  comparison contexts. Add request-capture and negative mutation tests proving none of these forms
  reaches the OpenRouter research stage while legitimate protocol, compound, and public-research
  prose still does.
- Replace the assistant-output Markdown URL regex with a bounded balanced CommonMark destination
  scanner so an exact allowlisted URL containing balanced parentheses is retained and all other
  destinations remain deny-by-default.

### Round-twelve review findings

Round twelve verified the core accounting, lifecycle, isolation, deployment, and secret controls,
but found the following remaining parser, sanitizer, and resource requirements:

- Classify absolute HTTP(S) Markdown destinations directly under the same userinfo/query/hash and
  private-host policy as bare absolute URLs. Do not prepend a second scheme. Preserve harmless
  relative fragment/path destinations without treating them as network targets, while all other
  schemes and private destinations remain fail-closed.
- Scan complete plain HTTP(S) link candidates with balanced-parenthesis and sentence-punctuation
  awareness before allowlisting. Exact trusted URL substrings must not authorize continuations via
  slash, backslash, query, caret, pipe, or other URL characters; removing an untrusted balanced URL
  must not leave text that synthesizes a new Markdown-looking link.
- Make concrete path and port evidence precede topical prose classification. Unknown Unicode and
  digit-leading single-label host-port forms, environment-like hosts, sensitive path components,
  neutral target assertions, and direct open/fetch targets must not be made public by comparison or
  follower text. Replace the finite safe-follower vocabulary with candidate-local action/object
  grammar that still supports unseen public semantic compounds.
- Require explanatory candidate-local grammar for protocol-version prose. A known version number
  alone must not exempt `Open`/`Search`/`Fetch HTTP:n` from URI/private-address classification.
- Keep Unicode dashes as presentation punctuation for candidate association and propagate a bare
  immediately preceding imperative across sentence punctuation. Expand adjacent English/Slovak
  references for politeness, optional prepositions, and separated phrasal verbs without allowing
  unrelated later clauses to influence an earlier candidate.
- Make balanced Markdown scanning linear and bounded, including unmatched-bracket adversarial
  input. Throttle streaming before repeatedly sanitizing the accumulated response buffer, while
  preserving a final fully sanitized render and bounded Discord update cadence.
- Add cross-product target mutations, absolute/relative Markdown research cases, complete URL
  continuation mutations, sentence-final balanced links, multilingual role-association captures,
  unseen semantic compounds, Unicode/digit-leading ports, and high-delta streaming regressions.

### Round-thirteen review findings

Round thirteen again verified accounting, lifecycle, prompt/tool isolation, logging, secrets, and
deployment controls, but identified the following remaining release requirements:

- Treat Markdown network-path destinations (`//`, mixed slash/backslash, and repeated slash forms)
  as authorities before permitting relative references. Allow fragment, root-relative, dot-relative,
  and ordinary relative paths only when they contain no decisive private host/port evidence.
- Independently classify Markdown link labels so a harmless destination cannot hide a private IP,
  internal hostname, private path, or nested private link in its displayed text. Add end-to-end
  captures for labels, angle destinations, titles, userinfo, special-use suffixes, and private IPs.
- Canonicalize presentation once while preserving IPv6 structural brackets. Recursively remove
  formatting around host/port/path components without reclassifying raw decorated variants; cover
  formatted bracketed IPv6 ports and suffixes, colon/ellipsis decoration, and Unicode wrappers.
- Default terminal or asserted target-shaped `host/path` objects to private unless affirmative
  candidate-local topical/comparison grammar establishes a public semantic compound. Expand the
  concrete environment and sensitive-path evidence, and never let a safe compound override direct
  open/fetch/search intent or a decisive private component.
- Reuse complete action families when propagating an immediately preceding imperative. Cover
  strong actions, HTTP methods, research verbs, English/Slovak politeness, modal word order,
  optional prepositions, and additional adjacent referents across punctuation.
- Recognize case-insensitive standard colon/slash protocol-version notation under multilingual
  explanatory, question, comparison, or summarization grammar, while keeping direct target actions
  fail-closed.
- Sanitize or replace link-bearing labels inside otherwise allowlisted Markdown links. Nested links,
  autolinks, and images in a trusted outer destination must not survive final or streaming output.
- Make plain-URL scanning aware of balanced presentation closers and sentence-final colon/Unicode
  dash without reopening trusted-prefix continuations. Track escape parity in the Markdown scanner's
  forward pass so its bracket matching is genuinely linear at the maximum response size.
- Add throttle resumption/boundary tests and exercise the actual per-user Discord message-link gate,
  in addition to the same-tick high-delta and generic capacity coverage.

### Round-fourteen review findings

Round fourteen verified the previously remediated lifecycle, accounting, isolation, throttling, and
lookup-gate behavior. It identified these remaining parser and sanitizer requirements:

- Strip relative Markdown prefixes only after rejecting private address, internal host/port, and
  sensitive path evidence in the remaining payload. Root, dot, parent, and fragment references are
  harmless only when their contents are harmless.
- Make Markdown label nesting fail closed at the configured bound, or classify it iteratively. Do
  not skip an enclosing link after abandoning a deeper private label. Preserve protocol notation in
  a label when the outer clause supplies valid explanatory context.
- Canonicalize IPv6 hosts wrapped in any presentation pair—including formatting inside structural
  square brackets—into bracketed host syntax before port/path classification. Cover inner host
  formatting, wrapped ports, Markdown destinations, and mixed host/port wrappers.
- Default terminal or neutral asserted target-shaped paths to private. Expand general target/state
  grammar and environment/sensitive endpoint evidence, and require affirmative semantic/topical or
  comparison grammar rather than absence of a known action or an arbitrary follower word.
- Consolidate preceding-imperative and adjacent-referent action families, including modal/polite
  forms, trailing prepositions, lookup/query/use/monitor actions, strong actions, HTTP methods, and
  English/Slovak variants. Candidate-local protocol roles must ignore unrelated later actions.
- Reuse actual escape parity when admitting Markdown links so even backslash runs cannot hide an
  active unsafe destination. Normalize Unicode-dot authorities and keep odd escaped links inert.
- Preserve trusted raw URLs inside a wider balanced presentation span, but require exact matching
  emphasis/underscore delimiter runs and valid boundaries. Trusted prefixes followed by malformed
  or incomplete formatting remain untrusted; URLs with underscore paths remain valid.
- Reject overlong research questions before wrapper parsing so structural normalization is bounded.
  Add depth, relative-private, IPv6 inner-wrapper, punctuation/action/referent, environment/path,
  protocol-ordering, odd/even escape, delimiter-run, broad-presentation, and length regressions.

### Round-fifteen review findings

Round fifteen verified all non-parser safeguards and found these remaining classification and
rendering requirements:

- Inspect every component of a relative Markdown payload, not only its leading segment. Detect
  internal/special/numeric hosts, arbitrary host-port components, IPv6, and sensitive path segments
  after root/dot/fragment prefixes and at any depth, with query/hash suffixes separated first.
- Parse IPv6 host/port boundaries structurally. Normalize nested/mixed presentation around both the
  host and numeric port to canonical `[host]:port/path` form, and apply sensitive-path policy to
  public as well as private IPv6 hosts.
- Make protocol roles affirmative and candidate-local. Use the predicate immediately before the
  candidate, split coordinator-separated actions, and treat explicitly referring next-clause
  open/search/connect actions as direct targets. Do not infer explanation from unrelated later text
  or from the absence of a finite direct-action verb.
- Make safe-compound eligibility role-aware: terminal/default and directly targeted paths are
  private, while genuine comparison/explanation/category grammar and unseen semantic compounds can
  remain public. A referring follow-up invalidates any earlier topical exemption.
- Apply real CommonMark escape parity while parsing link destinations and classify their unescaped
  value. Active even-parity unsafe destinations must be removed in final and streaming output;
  odd-parity escaped syntax remains inert.
- Do not let guessed emphasis state authorize a raw trusted-prefix continuation. Require valid
  flanking/boundaries for formatting, preserve internal URL underscores, and render approved plain
  URLs with an explicit bounded Markdown destination so adjacent presentation can never extend the
  clickable target. Add a final clickable-URL allowlist invariant matrix.
- Add relative prefix/depth/component, mixed IPv6 port wrapper, protocol action-order/follow-up,
  direct/referring safe-compound, unseen multilingual semantic follower, Markdown escape parity,
  intraword/escaped delimiter, and final/streaming URL-invariant tests.

## Residual risks requiring deployment controls

- OpenRouter, model, provider, and web-search pricing/behavior are external and can change. Provider
  price ceilings, conservative reservations, bounded calls, and the production-key cap form the
  defense in depth.
- Model refusal quality cannot be made mathematically deterministic. Jolanda therefore has no
  action-taking tools, isolates web research from private context, sanitizes output, and is tested
  adversarially.
- Atlas and Railway remain trusted processors. Use TLS, a dedicated least-privilege Atlas user,
  restricted network access where available, encrypted Railway variables, and defined log/backup
  retention.

## Completion evidence

To be filled after the final clean review.

# Historical note

The research-routing and privacy-isolation sections below describe the architecture that was
implemented during the original remediation. They were superseded on 2026-08-25 by Jolanda's simpler
single-generation assistant path: every non-local model turn now receives the complete bounded,
read-only toolbox and the model decides which tools to use. The document remains as historical
implementation context; `README.md` and `SECURITY.md` describe the active design.
