# Corpus Backlog — v1.2.0 Self-Test Results

## Fail counts by rule (198 FSG articles, 200 MLT articles)

| Site | L01  | A03 | B05 | B07 | B11 | B13 | Total articles | L01 pass rate |
|------|------|-----|-----|-----|-----|-----|----------------|---------------|
| FSG  | 102  | 197 | 133 | 131 | 86  | 48  | 198            | 48%           |
| MLT  | 160  | 40  | 38  | 25  | 0   | 0   | 200            | 20%           |

All failures are corpus debt from articles generated before the v1.0.3+ roundup spec. None are validator bugs.

## Triage

1. **A03 — FSG, 197 articles (highest priority).** Dollar figures in article bodies. Amazon Associates Operating Agreement compliance risk. When corpus work is scheduled this goes first.

2. **L01 — MLT, 160 articles below 2,000 words (second priority).** Genuine content quality issue. All 160 failures are under-floor (1,400–1,990 words), none over-ceiling. Articles need expansion to 2,000–3,000, not trimming.

3. **B05/B07 — section heading format drift (lowest priority).** Pre-spec articles used `## How to Choose` on FSG (now `## Buying Guide`) and had no `## Top Picks` structure. Format-only; no compliance or quality risk. Addressed naturally when articles are rewritten for other reasons.

## Decision

Corpus remediation deferred until after OHT launch validates the calibrated system end-to-end.

## Platform Structural Bugs

Issues with the platform generator/validator architecture — distinct from corpus debt on existing articles.

1. **P01 — inject_body_images vs B11 validator mismatch (High, all sites).** `inject_body_images` places images at H2-level structural anchors (before the next `##` heading). `validate-buyer-guide.mjs` B11 counts images inside H3 product sections. These are incompatible — all sites with `in_body_images: fixed_count: 5` fail B11 silently on every article generated. Validator is advisory not blocking, so articles ship. TCD switched to `policy: none` as workaround (product H3 sections correctly contain zero images). Real fix: pick one truth and align the other side. Options: (a) fix injector to place images inside H3 product sections, (b) change validator to count H2-anchor images, (c) canonicalize `policy: none` as platform default and remove `fixed_count`.
