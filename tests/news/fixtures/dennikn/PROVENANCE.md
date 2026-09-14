# Synthetic Denník N variants

`synthetic-post.json` is invented test data, shaped like the actual captured records. Its ID, title, excerpt and timestamp are synthetic. Tests change its fields for missing metadata, malformed timestamps, promotion, corrections and bursts; these variants are never presented as actual publisher observations. Original real records remain under `../publishers/`.

The five-date publisher replay uses actual captured IDs/publication timestamps, but synthetic UTC-aligned polls, an empty activation snapshot before the earliest item, and importance at publication. Its simulated first-seen/sent times are not historical observations. The test uses the accepted policy functions for observations, publication identity, pacing, eligibility and send admission. The separate 10-post burst and delayed promotion scenarios are entirely synthetic.
