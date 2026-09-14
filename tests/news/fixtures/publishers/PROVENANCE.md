# Publisher exploration handoff

Base: repository `66b12f3`; exploration only. No production/test edits, installations, Discord writes, deployment, or project verification claims. Artifacts below are sanitized publisher structures for implementers to copy into their owned fixture paths. `retrieval-outcomes.json` records every actual request; no cookies or full pages were retained.

## Request evidence and explicit adjustment

Capture date: 2026-09-14 UTC. Anonymous direct HTTPS requests used a fixed `JolandaNewsFixture/1.0` identity, 25-second transport timeout, 3 MB body limit, and rejected all redirects. These exploratory requests are not a substitute for N02's production DNS/address checks or a total-operation deadline. All five requests returned HTTP 200. No restrictions were bypassed.

Original budget was Denník N one listing request and Aktuality one listing plus one edition. Initial Denník minimization accidentally omitted the unexpected snake_case timestamp keys after observing their names. The orchestrator explicitly authorized one corrective Denník request and one additional older Aktuality daily edition to meet fixture requirements. Final counts are exactly Denník N 2; Aktuality listing 1 plus editions 2. No further retrieval is authorized by this packet. Corrective data replaced the incomplete Denník capture; its provenance is the second request, 07:39:32.136001Z. All outcomes remain recorded separately.

## Denník N

Source: https://dennikn.sk/minuta/dolezite

- `dennikn-initial-state.json`: actual minimized state preserving `postsApi.queries[queryKey].data.pages[].posts`. The observed query key is `getInfinitePosts({"important":1,"language":"sk"})`. Ignore unrelated query state; fail explicitly when required posts structure is absent.
- `dennikn-initial-state.html`: reconstructed minimal HTML envelope around the same actual state, with a `window.__INITIAL_STATE__` assignment. Outer whitespace/markup is fixture construction, not a saved page.
- Stable `id` is a number; URL is `https://dennikn.sk/minuta/<id>/`; title can be empty; `excerpt` contains HTML. Both an opening `<strong>` title and an opening linked sentence without bold occur. `isImportant` is boolean. Tags are objects with name/id/slug/type/url. `image` can be null, otherwise an object with `id`, `sizes` array of width/height/url, and optional `target_link`.
- **Actual timestamp fields**: `published_at` is ISO with timezone, e.g. `2026-09-14T08:45:35+02:00`; `published_at_date` is matching epoch milliseconds, e.g. `1789368335000`. Do not assume camelCase or seconds.
- Sanitization removed `content`, client display state, unused tag metadata, excess image sizes, and tracking attributes/query parameters from excerpts. Publication timestamps/IDs and importance flags are unchanged. No full linked article was requested.
- `dennikn-publication-snapshot.json` retains all 50 actual IDs/timestamps/importance flags and the **single actual observation time**. Published-date counts: Sep 10 = 14 (partial oldest day), Sep 11 = 9, Sep 12 = 9, Sep 13 = 15, Sep 14 = 3 (partial current day). All 50 are important in this observation.
- This supports a **publisher-grounded publication-time replay spanning five dates**, but cannot prove actual historical first-seen times, delayed promotions, revisions, complete daily volume, or multiple historical observations. Any simulated poll schedule, first-seen time, promotion, or extra edge-case records must be labeled synthetic. Do not present simulated delivery delays as historically observed delivery behavior.

## Aktuality

Listing: https://www.aktuality.sk/spravy/denny-vyber-sprav/

- `aktuality-listing-links.json` preserves 20 relevant actual article anchors in source order, deduplicated by URL. `aktuality-listing.html` reconstructs only these anchors. No publication dates were retained from the listing, so freshness must be checked on the edition.
- First candidate is a **weekly** roundup (`vyber-tyzdna`, title `výber týždňa`); first daily candidate is the next link (`hAUs7Al`). Excluding weekly content before choosing the one allowed edition request matters.
- `aktuality-edition.html` and `aktuality-edition-older.html` contain two distinct real minimized editions, with metadata/JSON-LD and seven real `<h2 class="font-bold">` headings each inside `#articleContent`. Section count is observed data, not a required count. Parallel `*-metadata.json` and `*-content.html` files separate the structures for inspection.
- Newer edition `hAUs7Al` published **2026-09-11T17:13:38.000Z**; older `E0rnklb` published **2026-09-10T17:13:20.000Z**. JSON-LD exposes the same moments with `+02:00`. Both are stale on capture date, Sep 14. This is actual stale/missing-current-day listing evidence; no current-day edition was observed.
- Metadata uses **`name="article:published_time"`**, not `property`. `og:title`, `og:url`, `og:description`, `og:image` use `property`; general description uses `name`. JSON-LD includes separate `WebPage` and `NewsArticle` nodes. Multiple unrelated JSON-LD scripts existed and were removed. Do not assume a single JSON-LD script or always an `@graph` wrapper.
- Original paragraph bodies, advertising, styles, empty cards, and scripts were removed. Headings and actual publication metadata remain unchanged. The short source introduction is available in description metadata. The older article root was observed with `itemprop="articleBody"`, retained in its minimized structure.
- **No anchor elements were present inside either returned `#articleContent`.** Its editorial sections had text and empty article cards after “Viac informácií nájdete tu”. The captures therefore establish actual section headings but no per-section source article URLs. Use the validated edition URL as the source link, or obtain additional authorized evidence before claiming extraction of per-section links. Do not invent links.
- The optional public image URL is on `img.aktuality.sk`; the long path contains encoded transform data and an expiring signature query. Embedded encoded text is not another request origin. No image was fetched. Adapter origin validation should inspect the actual parsed hostname.

## Remaining acceptance limits

Two real editions are captured, but both share the same metadata/headings pattern. Alternate placement, malformed fields, future publication, missing headings, and a current-day fallback becoming available need explicitly modified/synthetic fixtures. Repeated-observation promotion/revision replay is synthetic. Actual production source HTTP, parser correctness, pacing simulation, Mongo/Discord behavior, and project check/format gates belong to downstream implementation; this exploration establishes only the retrieval and structure facts above.

## Checked-in fixture preparation (N02)

These files were copied from the bounded explorer capture; N02 made zero publisher requests. The Denník HTML envelope was reconstructed from the actual minimized JSON, with a `prettier-ignore` script directive so formatting cannot turn JSON into JavaScript object syntax. The fixture test verifies strict JSON equality after formatting. This envelope and its outer markup are constructed; IDs, publication dates and source content remain those of the capture. Aktuality minimized HTML preserves captured metadata/headings; whitespace may be formatted.

`preliminary-pacing.json` is the explorer's **synthetic simulation**, grounded in the 50 real publication timestamps. Its assumptions are instant importance at publication, an empty baseline before the earliest timestamp, synthetic UTC-aligned 20-minute polls, and no outages or errors. The `observed` and `sent` fields are simulated epoch seconds, not actual observations/deliveries. The 50 simulated sends, zero expiries, 29.57-minute maximum publication delay and 20-minute maximum queue delay are preliminary policy exploration, **not runtime proof** or historical delivery evidence. The N03/N10 replay must exercise the accepted runtime policy independently.

Transport edge cases in `tests/news/http.test.ts` are explicitly synthetic in-memory responses. They perform no DNS, socket or publisher requests. Fixture retrieval outcomes establish availability only for the explorer's machine and capture times; no deployment-network verification is claimed.

## HTTP/cache contract for source adapters

`createNewsHttp` returns `ok` with HTML, final URL and proposed validators; it owns no source state. Only a successful source parse may return those validators in `NewsSourceResult.cache`. On missing schema or malformed content, return a domain failure without cache and retain previously good source state. A conditional `unchanged` response merges absent validators from the request. An unconditional 304 is malformed. Redirects drop the original resource's validators and cannot claim a valid unchanged target.

Request budget remains one listing plus at most one selected edition per daily attempt; the transport performs no retries. Each request has a total 25-second deadline including DNS, redirects and body, a 3,000,000-byte body cap, at most three redirects, and a 16 KiB header cap. Smaller test bounds are injectable. UTF-8 HTML/XHTML only; compressed responses are rejected after requesting identity. Page URLs admit the important/minute routes and Aktuality roundup/article routes; images admit only observed publisher origins/paths and are never fetched here. No caller-supplied headers, credentials, cookies or rotating identity are supported.
