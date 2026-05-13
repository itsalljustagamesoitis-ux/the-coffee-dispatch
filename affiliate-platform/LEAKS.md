# Revenue Leak Taxonomy — Platform Reference

Canonical 17-leak framework used for site revenue audits. Every audit pass
references these IDs. Fixes in components, layouts, and frontmatter contracts
are keyed to these IDs.

---

## The 17 Leaks

| ID  | Name | Severity | Detection | Fix contract |
|-----|------|----------|-----------|--------------|
| L1  | Broken product images | CRITICAL | Image HTTP 200 check per article | `src/` paths must resolve; hero images via `hero_image` frontmatter |
| L2  | Dead buy links / ASIN 404 | CRITICAL | HTTP 200 check on all Amazon hrefs | `validate-asins.mjs` pre-deploy; no `amazon_asin: VERIFY` in prod |
| L3  | Wrong product linked | CRITICAL | Manual spot-check | Product `id` must exist in `products.yaml`; hub must match article hub (Rule 2) |
| L4  | No end-of-article buy button | HIGH | DOM: `.bottom-cta-box` present | `BottomLineCTA` rendered in every layout after FAQ, uses `(winner ?? productA)` fallback |
| L5  | No Quick Picks above fold | HIGH | DOM: `.quick-picks` present | `QuickPicks` component renders when article has ≥2 products in frontmatter |
| L6  | Generic CTA button text | MEDIUM / CRITICAL | String match: "Check Price" = FAIL | All buy buttons must read "Buy on Amazon" or "See [Product] on Amazon" — never "Check Price" |
| L7  | Price slot in comparison table | MEDIUM | DOM: price column content | Compliance: no scraped/static prices. Price column shows tier labels or empty. Deferred unless PA-API is wired. |
| L8  | Missing comparison table | HIGH | DOM: `<table class="comparison-table">` | `ComparisonTable` renders when article has ≥2 products. Threshold was ≥3 (bug), corrected to ≥2. |
| L9  | No cross-sell strip | MEDIUM / HIGH | DOM: `.related-articles` present | `RelatedArticles` component; renders related articles by hub. `hub` frontmatter required. |
| L10 | Body images not loading | HIGH | Image HTTP 200 check in article body | Body image paths must resolve. Check after any CDN or path migration. |
| L11 | Affiliate disclosure missing / misplaced | HIGH compliance | Disclosure block before first affiliate link | Disclosure component in layout; renders above first product card |
| L12 | Hub link missing / broken | MEDIUM SEO | Anchor to `/{hub}/` in article intro | `hub` frontmatter required; layout injects hub link in breadcrumb + intro. |
| L13 | Author bio missing | MEDIUM | DOM: `.author-bio` present | `AuthorBio` component at article foot; requires `author` frontmatter resolved to persona YAML |
| L14 | FAQ schema not present | HIGH CTR | `<script type="application/ld+json">FAQPage` in source | `faq:` frontmatter array triggers FAQPage JSON-LD + visible accordion. Requires ≥1 Q&A pair. |
| L15 | Safety disclaimer missing | HIGH compliance + liability | DOM: `.safety-notice` present on relevant articles | `SafetyNotice` renders when `safety_topics:` frontmatter is non-empty. Topics are niche-specific — see `SAFETY-TOPICS.md`. |
| L16 | Page title not optimised | MEDIUM | `<title>` vs `<h1>` text check; length 45–70 chars | `target_keyword` frontmatter feeds title/meta. Run `build-validator.mjs` F03 check. |
| L17 | Thin / incomplete content | MEDIUM / HIGH | Word count < 1,800 | Producer min word count; build-validator W01. Any article < 1,800 words is a candidate for expansion or removal. |

---

## Audit Workflow (Astro + CF Sites)

1. Fetch `sitemap-index.xml` → recursively pull child sitemaps
2. Exclude category hubs, legal/admin pages (only article slugs)
3. Crawl all eligible articles in parallel batches of 15
4. Per article, extract: word count, CTA texts, FAQ schema presence, comparison table presence, safety notice presence, hub breadcrumb, disclosure placement, author block, product card count, Amazon link count + tag, ASIN list, bottom-quarter link density
5. Aggregate: per-leak pass/fail counts + per-page slug fail lists
6. Deliver consolidated brief in priority order (L1 → L17)

---

## Site Audit Status Matrix

Last updated: 2026-05-13

| Leak | FSG | MLT | OHT | TCD | BCB |
|------|-----|-----|-----|-----|-----|
| L1 | healthy | healthy | healthy | ? | unaudited |
| L2 | healthy | healthy | healthy | ? | unaudited |
| L3 | healthy | healthy | healthy | ? | unaudited |
| L4 | CLOSED | CLOSED | CLOSED | CLOSED | unaudited |
| L5 | healthy | healthy | healthy | healthy | unaudited |
| L6 | CLOSED | CLOSED | CLOSED | CLOSED | unaudited |
| L7 | deferred | deferred | deferred | deferred | deferred |
| L8 | CLOSED | CLOSED | CLOSED | CLOSED | unaudited |
| L9 | healthy | healthy | healthy | healthy | unaudited |
| L10 | healthy | healthy | healthy | ? | unaudited |
| L11 | healthy | healthy | healthy | healthy | unaudited |
| L12 | healthy | healthy | healthy | healthy | unaudited |
| L13 | healthy | healthy | healthy | healthy | unaudited |
| L14 | CLOSED | CLOSED | CLOSED | CLOSED | unaudited |
| L15 | CLOSED | CLOSED | n/a | CLOSED | unaudited |
| L16 | healthy | healthy | healthy | ? | unaudited |
| L17 | CLOSED | healthy | healthy | healthy | unaudited |

Notes:
- L15 OHT = n/a (dinnerware niche, no safety hazards)
- L7 deferred across all sites (compliance: no scraped prices)
- L1/L2/L10/L16 TCD = not crawled with per-image checker; framework healthy
- BCB = Bear Creek Barbecue, not yet launched

---

## Platform Deploy Modes (as of 2026-05-13)

After the audit cycle, three sites have CF git integration status:

| Site | CF trigger | Notes |
|------|-----------|-------|
| FSG | `github:push` | Auto-deploys on push to main |
| MLT | `ad_hoc` | Git integration broken. Deploy via `npx wrangler pages deploy dist --project-name=my-little-tablespoon --branch=main` |
| OHT | `ad_hoc` | Git integration broken. Deploy via `npx wrangler pages deploy dist --project-name=one-happy-table --branch=main` |
| TCD | `github:push` | Auto-deploys on push to main |
| BCB | TBD | Verify before first deploy |

Fix for MLT/OHT: CF Dashboard → Pages → project → Settings → Builds & deployments → reconnect GitHub App.

---

## Platform Vendoring Decision (2026-05-13)

All three live sites converted from git submodule to vendored regular files during the audit cycle. Root cause: CF Pages could not clone the private `affiliate-platform` submodule repo, causing it to fall back to a stale cached `node_modules/` from an old commit.

**Current canonical pattern: vendor affiliate-platform as regular tracked files.**

`initialise-site.mjs` (if it exists) should be updated to reflect this. New sites should copy `affiliate-platform/` from a reference site's repo and commit it as regular files — not use `git submodule add`.
