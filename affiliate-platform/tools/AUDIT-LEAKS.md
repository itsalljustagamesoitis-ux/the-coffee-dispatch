# audit-leaks.mjs — Implementation Spec

Planned tool: `affiliate-platform/tools/audit-leaks.mjs`

Runs the 17-leak audit against a live site URL or a local `dist/` build.
Replaces the Chrome Claude manual crawl pass. Each new site runs this before
launch and after any major platform change.

---

## CLI surface

```bash
# Audit a live site
node tools/audit-leaks.mjs --site https://thecoffeedispatch.com

# Audit a local build (faster, no network latency)
node tools/audit-leaks.mjs --dist ./dist

# Only run specific leaks
node tools/audit-leaks.mjs --site https://... --leaks L4,L6,L8,L14,L15

# Emit JSON report
node tools/audit-leaks.mjs --site https://... --json > audit-$(date +%F).json

# Fail the process if any leak has >0 failures (for CI)
node tools/audit-leaks.mjs --site https://... --strict
```

---

## Per-leak probe spec

Probes run against fetched HTML. For live sites, use a 15s timeout per URL
and batch 15 pages in parallel.

| Leak | Probe |
|------|-------|
| L1 | For each `<img>` src in article body: HTTP HEAD → expect 200 |
| L2 | For each `<a href="https://www.amazon.com">`: HTTP HEAD → expect 200; check `?tag=` param present |
| L3 | Cannot be checked structurally. Flag for manual review. |
| L4 | DOM: `document.querySelector('.bottom-cta-box')` !== null |
| L5 | DOM: `document.querySelector('.quick-picks')` !== null |
| L6 | Text scan: "Check Price" must not appear anywhere in article body. "Buy on Amazon" or "See * on Amazon" must appear ≥1 time. |
| L7 | (deferred — no scraped prices policy) |
| L8 | DOM: `document.querySelector('table.comparison-table')` !== null for articles with ≥2 products |
| L9 | DOM: `document.querySelector('.related-articles')` !== null |
| L10 | For each `<img>` in article body (excluding hero): HTTP HEAD → expect 200 |
| L11 | DOM: `.affiliate-disclosure` or `[data-disclosure]` appears before first `<a href="*amazon.com*">` in document order |
| L12 | DOM: `<a href="/{hub}/">` exists in article intro section |
| L13 | DOM: `document.querySelector('.author-bio')` !== null |
| L14 | Source: `<script type="application/ld+json">` contains `"@type": "FAQPage"` |
| L15 | DOM: `document.querySelector('.safety-notice')` !== null — only required on articles whose frontmatter has `safety_topics:` |
| L16 | `<title>` text is 45–70 chars; `<h1>` text is present and not identical to `<title>` |
| L17 | Word count of article body text (excluding nav, aside, footer) ≥ 1,800 |

---

## Output format

```
Auditing https://thecoffeedispatch.com — 279 articles

L1  Broken images       HEALTHY   279/279 pass
L2  Dead buy links      HEALTHY   279/279 pass
L3  Wrong product       MANUAL    —
L4  End-of-article CTA  HEALTHY   279/279 pass
L5  Quick Picks         HEALTHY   279/279 pass
L6  Generic CTA text    HEALTHY   279/279 pass
L7  Price slot          DEFERRED  —
L8  Comparison table    HEALTHY   241/241 multi-product pages pass (38 single-product, N/A)
L9  Cross-sell strip    HEALTHY   279/279 pass
L10 Body images         HEALTHY   279/279 pass
L11 Disclosure          HEALTHY   279/279 pass
L12 Hub link            HEALTHY   279/279 pass
L13 Author bio          HEALTHY   279/279 pass
L14 FAQ schema          HEALTHY   279/279 pass
L15 Safety notice       HEALTHY   65/65 tagged pages pass (214 untagged, N/A)
L16 Page title          WARN      12 titles outside 45-70 char range
L17 Thin content        HEALTHY   0 articles < 1,800 words

FAIL: 0  WARN: 1  MANUAL: 1
```

Exit 0 on HEALTHY/WARN. Exit 1 if any FAIL. `--strict` exits 1 on any WARN too.

---

## Sitemap discovery

```js
async function discoverArticleUrls(siteUrl) {
  const sitemapIndex = await fetch(`${siteUrl}/sitemap-index.xml`)
  // Parse child sitemaps, filter to article slugs only
  // Exclude: /about, /contact, /privacy-policy, /terms, /search,
  //          /affiliate-disclosure, /disclaimer, /how-we-test,
  //          /{hub}/  (category index pages)
}
```

---

## Implementation notes

- Use `node-fetch` or native `fetch` (Node 22+)
- HTML parsing: `node-html-parser` (lightweight, no browser required)
- L1/L2/L10 network checks: use `AbortController` with 10s timeout
- L14 JSON-LD: `JSON.parse` the raw script content; check `@type`
- L15: must cross-reference sitemap against article frontmatter to know which
  pages have `safety_topics:` — either read from `content/articles/` or embed
  a data attribute in the HTML at build time

---

## Integration points

- Run in CI after `npm run build`: `node tools/audit-leaks.mjs --dist ./dist --strict`
- Add to pre-deploy checklist in `CLAUDE.md` section 3 (Build Contract)
- Update `LEAKS.md` status matrix after each run

---

## Estimated implementation

- Sitemap discovery + URL list: 1h
- L4/L5/L6/L8/L9/L11/L12/L13/L15 DOM probes: 2h
- L1/L2/L10 network probes: 1h
- L14 JSON-LD probe: 30m
- L16/L17 text analysis: 1h
- CLI flags + output formatting: 1h
- Integration test (run against TCD dist/): 1h

Total: ~7.5h. Suitable for a focused Claude Code session with test-driven approach.
