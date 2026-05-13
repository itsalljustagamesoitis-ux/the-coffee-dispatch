# @platform/core — Operating Contract

Canonical behaviour guard for all Claude Code sessions in this monorepo. Site-level CLAUDE.md files are stubs that reference this file. This file wins on all conflicts.

---

## 1. Repo Map and Ownership Boundary

```
~/
├── affiliate-platform/          ← @platform/core — edit here for cross-site changes
│   ├── src/layouts/             5 Astro layouts (Base, BuyerGuide, Comparison, Review, Roundup)
│   ├── src/components/          16 Astro components
│   ├── src/lib/config.ts        Site config loader (reads site.config.yaml via process.cwd())
│   ├── src/styles/global.css    Shared stylesheet
│   ├── scripts/
│   │   ├── build-validator.mjs  Post-build validator — runs inside npm run build
│   │   └── validate-asins.mjs   Pre-launch ASIN checker
│   ├── schemas/                 Zod schemas
│   ├── prompts/                 Article generation prompts
│   ├── pipelines/               Pipeline scripts
│   └── registries/              Product/persona registries
│
├── four-season-gardener/        FSG — consumes @platform/core
├── my-little-tablespoon/        MLT — consumes @platform/core
└── one-happy-table/             OHT — consumes @platform/core
```

### Ownership rule

One session, one repo. A session scoped to a site repo must not modify `affiliate-platform/`. A session scoped to `affiliate-platform/` must not modify site repos except to run `npm install` after a platform change.

**Check:** `git diff --name-only` — does the diff span two different top-level repos? → Stop. Declare scope and get confirmation before continuing.

**Exception:** A session explicitly declared as a cross-repo migration task (e.g. "migrate all sites to @platform/core") may touch both. This must be stated in the first user message, not inferred mid-session.

### What each site owns exclusively

- `site.config.yaml` — domain, brand, tracking IDs, analytics, visual config
- `config/` — credentials, navigation, personas
- `content/articles/` and `content/products/` — content and product catalog
- `data/` — pipeline, keyword data
- `producer/` — article generator, publisher, tests
- `public/` — brand images, static assets
- `src/pages/` — page files that import from platform

### What no site owns

`src/layouts/`, `src/components/`, `src/lib/`, `src/styles/` must not exist in any site repo.

**Check:** `ls {site}/src/` — permitted entries: `content`, `content.config.ts`, `pages`. Any other entry is a violation. Fix: delete it, ensure the equivalent lives in `affiliate-platform/src/`.

---

## 2. Three Non-Negotiable Rules

### Rule 1 — No shared persona professional background

No two sites may have the same value for the `background:` field in their persona YAML file.

**Resolved 2026-05-04:** MLT Emily Prescott updated to `background: "Food scientist, consumer packaged goods"`. FSG retains `background: "Senior HR Director, financial services"`. Check below must now return empty.

**Check:**
```bash
grep -h "^background:" \
  four-season-gardener/config/personas/*.yaml \
  my-little-tablespoon/config/personas/*.yaml \
  one-happy-table/config/personas/*.yaml \
  | sort | uniq -d
```
Output must be empty. Any duplicate line → violation. Do not proceed with production.

### Rule 2 — No product-hub mismatch in published articles

Every product `id` referenced in an article's `products:` frontmatter must exist in `content/products/products.yaml`, and its `hub` field must match the article's `hub` frontmatter field.

**Check (manual until preflight.py exists):**
```bash
# For each article being published, confirm:
# 1. Every product id exists in products.yaml
grep -c "id: \"<PRODUCT_ID>\"" content/products/products.yaml  # must be 1
# 2. That product's hub matches the article's hub frontmatter
```

**Check (automated when preflight.py is built):**
```bash
python3 producer/preflight.py --check-product-match
```
Any FAIL → do not publish that article.

### Rule 3 — No unverified ASINs in production

No article with a product referencing `amazon_asin: VERIFY` may be published or deployed.

**Check:**
```bash
grep -c "amazon_asin: VERIFY" content/products/products.yaml
```
Must return `0` before any production deploy. Non-zero → stop. Resolve ASINs on Amazon first.

---

## 3. Build and Run Contract

### Build command

```bash
npm run build
```

This runs: `astro build && npx pagefind --site dist && node scripts/build-validator.mjs`

Do not call `astro build` directly. It skips pagefind and the validator.

### Build passes when

- Exit code 0
- No `FAIL` lines in build-validator output
- `WARN` lines are permitted but must be noted

### Mandatory pre-production sequence (in order, no skipping)

1. `grep -c "amazon_asin: VERIFY" content/products/products.yaml` → must be `0`
2. `cd producer && python3 -m pytest tests/ -v` → all tests green
3. `node scripts/validate-asins.mjs` → exit 0
4. Run `--count 5` test batch; open and read all five staging docx files
5. Run full production batch
6. Review and approve; move to `staging/approved/`
7. `python3 producer/publish.py --all`
8. `npm run build` → no FAIL lines
9. Push to main (Cloudflare Pages auto-deploys)
10. Confirm deployment URL responds 200
11. IndexNow runs automatically as postbuild on CF; run manually otherwise

**Check for step 4:** Has the agent read the staging files, not just confirmed they exist? Reviewing means: word count ≥ 2,000, persona voice present, correct products referenced by name, hub link present.

### Forbidden actions

- Running full production (`--count 50+`) without completing steps 1–4 above
- Skipping the 5-article test batch for any reason including "this is the same prompt as last time"
- Modifying `affiliate-platform/` during a site-scoped session
- Recreating `src/layouts/`, `src/components/`, `src/lib/`, or `src/styles/` in any site repo
- Calling `astro build` without the `npm run build` wrapper
- Force-pushing to main (`git push --force`)
- Deleting files outside `staging/`, `dist/`, `logs/`, `output/` without explicit operator instruction
- Publishing articles whose product hub does not match the article hub (Rule 2)
- Deploying while `grep -c "amazon_asin: VERIFY" content/products/products.yaml` returns non-zero

---

## 4. Decision Authority

### Agent decides without asking

- Which layout to use for a given article `type` value (mapping lives in `[slug].astro`)
- Whether a build-validator `WARN` is acceptable to proceed (it is, by default)
- Fixing a bug that exists identically across all three sites — fix in `affiliate-platform/`, then `npm install` in each site
- Order of articles in a production batch

### Agent must confirm before acting

- Adding a new article `type` (requires: new layout in platform, schema update in content.config.ts, and `[slug].astro` update across all sites)
- Modifying `astro.config.mjs` in any site
- Modifying `content.config.ts` in any site
- Changing `@platform/core` version reference in any site's `package.json`
- Any diff that touches more than one top-level repo
- Deleting any file outside the permitted directories listed above
- Changing a persona's name, background, or voice notes after articles have been published under that persona
- Adding a new site to the monorepo

### Keith decides

- Whether to launch a new site
- Domain, niche, and persona identity for each site
- Amazon tracking IDs and AWIN publisher IDs
- Production volume per session
- Whether a Rule 2 exception is warranted for a specific product-article pairing

---

## 5. Done-Criteria

### Site migration to @platform/core

- [ ] `package.json` contains `"@platform/core": "file:../affiliate-platform"`
- [ ] `node_modules/@platform/core/src/layouts/` exists (symlink installed)
- [ ] All `src/pages/` imports use `@platform/core/src/layouts/` and `@platform/core/src/lib/config`
- [ ] `src/layouts/`, `src/components/`, `src/lib/`, `src/styles/` are absent from `src/`
- [ ] `npm run build` exits 0 with no FAIL lines

### New content type

- [ ] New `.astro` layout added to `affiliate-platform/src/layouts/`
- [ ] New export entry added to `affiliate-platform/package.json` exports map
- [ ] Zod schema added or updated in `affiliate-platform/schemas/`
- [ ] `content.config.ts` updated in all three site repos to accept the new `type` value
- [ ] `[slug].astro` updated in all three site repos to route to the new layout
- [ ] `npm run build` passes in all three site repos
- [ ] `affiliate-platform/CHANGELOG.md` updated

### New site spin-up

- [ ] `site.config.yaml` has no null values except `analytics.ga4_measurement_id` and `analytics.bing_uet_tag` (permitted null until launch)
- [ ] Persona `background:` field is distinct from all other sites (Rule 1 check passes)
- [ ] Persona name is distinct from all other sites
- [ ] `content/products/products.yaml` has ≥1 product per hub before first production run
- [ ] `data/pipeline.json` exists and has ≥1 article
- [ ] `src/layouts/`, `src/components/`, `src/lib/`, `src/styles/` are absent
- [ ] `npm run build` passes
- [ ] `npm run validate:asins` passes (after VERIFY ASINs resolved)
- [ ] `BING_SITE_VERIFICATION` env var set in Cloudflare Pages before first production deploy (hard build failure if missing on CF main branch)

### Prompt update

- [ ] Updated prompt saved to `affiliate-platform/prompts/`
- [ ] `--count 5` test batch run against updated prompt
- [ ] All five output files reviewed for voice, product references, and word count
- [ ] `npm run test` (producer tests) still green
- [ ] No regression in build-validator output

### Validator update (build-validator.mjs or validate-asins.mjs)

- [ ] Change made only in `affiliate-platform/scripts/`
- [ ] `npm run build` run in all three site repos after update
- [ ] No new FAIL lines introduced by the validator change itself on existing clean content
- [ ] `affiliate-platform/CHANGELOG.md` updated

---

## 6. Footprint Diversification Policy

### Required per-site distinctives

Each field below must have a unique value across all three sites. Sharing any field is a violation.

| Field | FSG | MLT | OHT |
|-------|-----|-----|-----|
| `site.domain` | fourseasongardener.com | mylittletablespoon.com | onehappytable.com |
| `affiliate.amazon_tracking_id` | fourseasong-20 | mylittletbsp-20 | onehappytable-20 |
| `affiliate.awin_clickref_pattern` | fsg | mlt | oht |
| `deployment.cloudflare_pages_project` | four-season-gardener | my-little-tablespoon | one-happy-table |
| Persona name | Wendy Hartley | Emily Prescott | Wendy Collins |
| Persona background | Senior HR Director, financial services | Food scientist, consumer packaged goods | Interior design / event styling |
| `visual.primary_color` | `#2D5016` forest green | `#2B4A7C` slate blue | `#8B3A52` burgundy-rose |
| `visual.accent_color` | `#C19A4B` gold | `#C27A3B` copper | `#D4A853` amber |
| `visual.font_headings` | Lora | Bitter | Playfair Display |
| Niche | Gardening | Kitchen cookware | Home entertaining |

### Checks

```bash
# Tracking ID uniqueness
grep "amazon_tracking_id:" */site.config.yaml | awk '{print $NF}' | sort | uniq -d
# Must return empty

# Persona name uniqueness
grep "name_formal:" */config/personas/*.yaml | awk '{print $NF}' | sort | uniq -d
# Must return empty

# Persona background uniqueness (Rule 1 — repeated here for completeness)
grep -h "^background:" */config/personas/*.yaml | sort | uniq -d
# Must return empty
```

### Content angle independence

No two sites may target articles with identical `target_keyword` values. If two sites are found to have the same keyword in their pipeline or published articles, one must be removed or rephrased before the next production run.

**Check:**
```bash
grep "target_keyword:" */content/articles/*.md | awk -F': ' '{print $2}' | sort | uniq -d
```
Output must be empty.
