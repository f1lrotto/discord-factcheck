# Synthetic Aktuality variants

`weekly-only.html` removes the actual daily anchors from the captured listing, retaining its real weekly anchor. The resulting missing-daily page is synthetic, not a second actual listing observation.

`alternate-edition.html` is wholly synthetic: a two-heading daily edition with JSON-LD `@graph` metadata and one explicit synthetic section link. No section links were present in either actual edition capture.

Tests also deliberately mutate the captured September 10 and 11 editions to create current/future publication dates, alternate name/property metadata, invalid/missing fields, changed headings, missing images and fallback availability. Those changed pages are explicitly synthetic. Original captured editions and dates remain untouched under `../publishers/`; both were stale on September 14. No new live requests were made.

A recognizable weekly-only roundup listing means no daily candidate. A page without recognizable daily/weekly article anchors is malformed, since there is no captured evidence for an empty-listing container contract. An HTTP 200 challenge/login/schema change must not become a successful empty result.
