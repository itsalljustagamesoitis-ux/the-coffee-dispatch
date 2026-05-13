# PIPELINE.md

The complete operational specification for building, launching, and operating affiliate sites in the portfolio.

This document is the source of truth. Every site follows the same sequence. No skipping, no reordering, no deviation. When this document and reality diverge, fix reality or update this document — never silently work around it.

---

## Table of contents

1. Meta-rules
2. The launch-site ritual (the ONE entry point)
3. The 21-point per-site launch pipeline
4. Operational layer — recurring tasks
5. Operational automation tiering
6. Platform additions required before site 4
7. Validator hard fail vs soft fail framework
8. Technical SEO documentation task
9. Homepage strategy
10. Pending operational fixes for current sites
11. Document maintenance

---

## 1. Meta-rules

These rules apply to every step of every site build. They exist to prevent the operational drift that compounds when sequence is variable.

### 1.1 Sequential execution with hard pause

Steps are sequential. Every site follows the same order. No skipping, no reordering, even when dependencies would technically allow it.

When a step cannot be completed, the build halts at that step. No proceeding with placeholders or known gaps. Nothing in the sequence moves forward until the step is genuinely complete.

### 1.2 Categories → hubs → articles

Every site has the same hierarchy: categories at the top, hubs within categories, articles within hubs.

Sites that are naturally flat (one category, multiple hubs) just have N=1 categories. The structure is consistent even when the data is simple.

### 1.3 One persona per site

Each site has exactly one persona. Persona file at `config/personas/<persona-slug>.yaml`, photos at `public/images/brand/<persona-slug>-byline.jpg` and `<persona-slug>-about.jpg`. The producer reads this single persona for all article generation. About page is one page about one person.

### 1.4 wrangler.toml + Git push deploy pattern

Sites deploy via Git push triggering Cloudflare Pages auto-deploy. wrangler.toml in the repo declares project name and non-secret environment variables (NODE_VERSION). Secrets (AMAZON_TAG) are set in the Cloudflare Pages dashboard for both Production and Preview environments.

The CLI `wrangler` command is not used for active deployment in normal operation. Configuration lives in version control; deploys are triggered by pushes.

### 1.5 Deploy completion criterion

After every Claude Code task that produces deployable changes, the task is not complete until:

1. Changes committed locally with a meaningful message
2. Pushed to GitHub origin
3. Cloudflare Pages deployment fired and reached green
4. Live verification passes

Live verification consists of 5 hard checks. All 5 must pass. Single failure = deploy not complete:

- `curl https://<domain>` returns 200
- `curl https://<domain>/sitemap-index.xml` returns 200
- Sample 3 article URLs return 200
- HTML source contains GA4 measurement ID
- HTML source contains correct AMAZON_TAG in affiliate links

Tool retries once after 30 seconds before final fail. State is binary — pass or fail.

Cloudflare deploy timeout: 10 minutes. Past timeout = hard fail.

Tooling: `tools/deploy-and-verify.mjs --site <slug>` automates steps 2-4. Step 1 stays in Claude Code's normal flow.

### 1.6 Catalog seeded from real Amazon search

Per-article product sourcing. For each article topic, search Amazon, pick listings, capture real ASINs at creation time. No invented brand names, no products generated from memory, no pre-built bucket of products distributed across articles.

Catalog populated before article generation runs, with all entries verified-on-Amazon at the moment of creation.

### 1.7 Domain registered through Cloudflare

Every domain registered through Cloudflare's registrar. DNS managed natively by Cloudflare.

### 1.8 AMAZON_TAG source of truth

The Amazon Associates tracking ID lives in `site.config.yaml` under `affiliate.amazon_tracking_id` as the primary source of truth. The Astro layout reads this value at build time and renders it into affiliate links via the rehype-product-links plugin.

Optionally, AMAZON_TAG may also be set as a Cloudflare Pages encrypted Secret on Production and Preview environments as an override mechanism. When present, the Cloudflare env var takes precedence over site.config.yaml. When absent, site.config.yaml is used.

Per-site tracking ID format: `<site-slug-truncated-to-fit-amazon-limit>-20`. Amazon Associates enforces a 20-character maximum for tracking IDs, so longer slugs are truncated (e.g. `four-season-gardener` becomes `fourseasong-20`, `my-little-tablespoon` becomes `mylittletbsp-20`).

Verification: `tools/verify-bindings.mjs` checks the live rendered HTML on each site, confirming the actual tracking ID in deployed affiliate links matches portfolio.yaml expectations. This catches both source-of-truth issues and Cloudflare env var override mismatches.

### 1.9 No backlinks, social, or PR strategy

Quantity over per-site optimization. Backlinks, social presence, PR outreach are explicitly not part of the launch or operational pipeline.

### 1.10 Validators classify as hard fail or soft fail

Validator rules are classified at definition time. See VALIDATORS.md for full rule classification.

- **Hard fail** — blocks publication, regenerate or hand-edit
- **Soft fail** — ships with logged warning to `~/affiliate-platform/calibration-log.yaml`

10% deviation boundary: `abs(observed - target) / target * 100`. Under 10% = soft. 10% or more = hard. For "exactly N" count rules, ±1 is soft.

Regeneration pass only — no iterative validator widening per site. Hard fail rate consistently above threshold across multiple sites becomes a platform-level review.

### 1.11 Placeholders are obvious, not plausible

All template content uses obvious placeholder tokens (`{{TOKEN_NAME}}`) or visibly-broken text (`LOREM_IPSUM_REPLACE_ME`), never realistic-but-wrong content. Templates that inherit content from another site are forbidden — site shells start empty of content and get filled, never copy-and-edit.

Build verification at multiple points (site shell verification, local build smoke, deploy-and-verify) checks for remaining placeholder tokens and hard-fails if any found.

### 1.12 Affiliate link format

Articles use the `product:slug` markdown protocol for affiliate links:

```
[Product Name](product:product-slug)
[Check current price on Amazon.](product:product-slug)
```

The platform's rehype plugin (`src/plugins/rehype-product-links.mjs`) resolves these to affiliate URLs at build time using `buildAffiliateUrl()`. The `ProductLink.astro` component exists as a parallel resolution mechanism but is not used in article bodies.

Producer emits `product:slug` directly. No raw Amazon URLs, no `?tag=` strings should ever appear in article source files. Build-validator blocks these as `hardcoded-asin-source` and `hardcoded-affiliate-tag-source` errors.

### 1.13 Locked vs judgment vs TBC

**Locked specifications cannot be overridden site-by-site:**

- Sequential execution with hard pause (1.1)
- Categories → hubs → articles hierarchy (1.2)
- One persona per site (1.3)
- wrangler.toml + Git push deploy pattern (1.4)
- All 5 deploy verification checks hard required (1.5)
- AMAZON_TAG single source of truth (1.8)
- 10% hard/soft fail boundary (1.10)
- Placeholders obvious, not plausible (1.11)
- product:slug affiliate link format (1.12)
- Cookie consent platform default (Consent Mode v2)
- Image bank: 150 images per site, 1200x630, hub-based naming
- Image assignment: random within hub
- Producer run mode: foreground with `tee` to log file
- Producer output destination: `staging/` (not `content/articles/`)
- Regeneration pass once, then publish (no iterative calibration per site)
- Cloudflare deploy timeout: 10 minutes hard fail
- Dashboard phase transitions: Phase 1 sites 1-10, Phase 2 sites 11-30, Phase 3 sites 31+

**Judgment with documented defaults:**

- Niche selection: 60% Amazon density typical default
- Keyword research thresholds: 300 launch / 500 reserve / 100 vol min / KD 40 max / Commercial+Transactional+Informational intent
- Domain selection: guidance, not gates
- Persona photo source: judgment per site
- Brand colors: Claude Code derives from niche, you override if needed
- Source products workflow: Chrome Claude default with escalation
- Legal text source: Claude Code generates from master templates with token substitution

**TBC (deferred until real decisions need making):**

- Pause point assessment criteria after 10 sites
- Operational task cadences
- Automation tiering build targets
- Phase 2 sweep timing and fix priority
- De-footprinting strategy for sites 11+

---

## 2. The launch-site ritual

The 21-point pipeline executes as a single ritual prompt that Claude Code follows from end to end. There is ONE entry point for launching a new site.

### 2.1 The ritual concept

A single launch prompt — `/launch-site` — that Claude Code follows step by step, pausing only for required inputs at defined gates. Each point's completion criteria are verified before moving to the next. State persists between sessions so an interrupted launch can resume from where it left off.

### 2.2 Tool

`tools/launch-site.mjs` — orchestrator that reads PIPELINE.md, runs each point's logic, persists state, surfaces required inputs through structured questionnaires.

### 2.3 Principles

**One site at a time.** Ritual checks portfolio.yaml for in-progress sites; refuses to start a new launch if another is in flight.

**State file persistence.** Each completed point recorded in `~/affiliate-platform/sites/<slug>/state.yaml`. Resumable from any point.

**Hard pauses are real.** When user input is required, ritual halts and surfaces clear "next action" instructions. No fudging forward.

**Rigid questionnaires.** When asking user for input, format is structured (numbered questions, expected answer types), not freeform conversation.

**Verification at every step.** Each point ends with verification checks. Fails → halt and surface. No moving forward until verification passes.

**No skipping.** Even if user says "I already did that" — ritual verifies state file. If state file says incomplete, the step runs.

### 2.4 Questionnaire pattern

For inputs requiring human judgment, the ritual presents a structured checklist:

```
POINT 5: PERSONA INPUT REQUIRED

Please provide the following:

1. First name:
2. Last name:
3. Location (city, state/country):
4. Domain expertise (one sentence):
5. Voice characteristics (warm/direct/formal/technical/playful — multiple OK):
6. Brief bio (2-3 sentences):
7. Path to byline photo:
8. Path to about photo:

Photos must be real (not template placeholders). Build will halt if MD5 matches existing portfolio persona photos.
```

User answers each. Ritual proceeds only when all required fields are populated and verification passes.

### 2.5 Resumability

State file at `~/affiliate-platform/sites/<slug>/state.yaml` records:

```yaml
slug: example-site
domain: example.com
started: 2026-05-08T10:00:00Z
current_point: 5
points_complete: [1, 2, 3, 4]
inputs:
  niche_statement: "..."
  density_score: 70
  keyword_research_xlsx: "/path/to/file.xlsx"
  domain: example.com
  persona_name: "Sarah Collins"
```

Running `/launch-site --resume <slug>` picks up at the current_point. Inputs already provided don't get re-asked.

### 2.6 What this gives you

- Every site goes through the same gates
- No "I forgot to set up X" — gates enforce
- Resumable from any point if interrupted
- Observable progress via state file
- Operational discipline encoded in the tool, not in your head

The ritual is the highest-priority platform addition before site 4.

---

## 3. The 21-point per-site launch pipeline

Each point describes: what it does, what it produces, what tools are involved, what's automatable, what requires judgment, decision points, verification, and failure modes.

These are the steps the launch-site ritual executes.

---

### Point 1: Niche selection

**What it does:** Pick the topic the site will be about.

A niche is narrow enough to credibly own, broad enough to support 250-300+ articles.

**What it produces:** A one-line niche statement.

**Critical check — Amazon density:**

Search Amazon for 10 representative product types in the niche. Count clean Amazon-sold listings with strong reviews.

**Default threshold:** 60%+ density (6 of 10) is the typical comfortable zone. Below 60% is a judgment call requiring conscious decision about monetization path before proceeding. The ritual surfaces below-60% as a halt-and-confirm, not auto-reject.

**Tools:** External — Amazon search via browser. `tools/check-niche-density.mjs` could automate this; currently manual.

**Verification:**

- Niche statement written
- Amazon density check performed and documented
- If density < 60%, explicit override with justification documented

**Failure modes:**

- Niche too narrow (can't generate 300 articles)
- Niche overlaps existing portfolio sites
- Low Amazon density without alternative monetization path

---

### Point 2: Keyword research

**What it does:** Generate the article topic list with full metrics for each keyword.

**What it produces:** An xlsx file with one row per article, plus three supporting sheets.

**Required columns:**

Category, Hub, Hub Slug, Hub URL, Keyword, Slug, Locked URL, Article Type, Required Product Count, Angle, H2 Structure, Volume, KD, CPC, Intent, Quality, AI Overview flag, Premium Brand flag, Source Seed.

**Required sheets:**

- Launch — articles being built at launch
- Site Architecture — categories, hubs, article counts per hub
- Hub Strategy — AOV tier, notes per hub
- Reserve Pool — additional keywords for future expansion

**Default targets (judgment, override per niche):**

- Launch article count: 300
- Reserve Pool count: 500
- Minimum search volume: 100/month
- Maximum keyword difficulty: KD 40
- Intent filter: Commercial + Transactional + Informational

**Tools:** External keyword research tool (Ahrefs, SEMrush).

**Verification:**

- xlsx exists with all required columns populated
- All four sheets present
- Launch sheet row count matches target
- No duplicate slugs across Launch and Reserve Pool

**Failure modes:**

- Keyword volume estimates inflated
- Keywords accepted with no real Amazon affiliate path
- Slug duplicates
- Article type misassigned

---

### Point 3: Article pipeline (pipeline.json)

**What it does:** Convert the keyword research xlsx into pipeline.json.

**What it produces:** `data/pipeline.json` in the site repo. One JSON object per article with: id, slug, hub, category, type, keyword, angle, H2 structure, product_count target, products array (initially empty), hero_image (empty until point 12), body_images (empty until point 12).

**Tools:** `tools/xlsx-to-pipeline.mjs --input <xlsx> --output data/pipeline.json` (needs to be built).

**Verification:**

- Total article count matches xlsx row count
- Every article has a valid hub from site config
- Every article has a valid type
- Every slug is unique

**Failure modes:**

- xlsx has a hub not present in site config
- Article type column has invalid value
- Pipeline.json schema mismatch

---

### Point 4: Domain / brand name

**What it does:** Source a suitable domain, verify its profile, register it.

**Process:**

1. Search expireddomains.net filtered against the niche
2. Check backlink profile in SEMrush for candidates
3. Optional: Wayback Machine check
4. Apply judgment — does this domain have enough residual SEO value?
5. If no suitable expired domain exists, register a fresh domain
6. Register through Cloudflare

**Domain selection is judgment, not gates.** Considerations: age, backlink quality, referring domains count, TLD preference, Wayback content history.

**Tools:** External — expireddomains.net, SEMrush, Cloudflare.

**Hard pause if:** No suitable domain available.

**Verification:**

- Domain shows in Cloudflare dashboard under Registrar
- WHOIS shows you as registrant
- DNS resolves
- Backlink profile reviewed

**Failure modes:**

- Suitable expired domain not found within reasonable search effort
- Toxicity discovered post-registration
- DNS misconfigured

---

### Point 5: Persona

**What it does:** Define the human voice readers will attribute the site's recommendations to.

**Required inputs (rigid questionnaire):**

1. First name
2. Last name
3. Location
4. Domain expertise (one sentence)
5. Voice characteristics
6. Banned phrases (or use platform defaults)
7. Brief bio (2-3 sentences)
8. Path to byline photo
9. Path to about photo

**What it produces:**

- `config/personas/<persona-slug>.yaml`
- `public/images/brand/<persona-slug>-byline.jpg`
- `public/images/brand/<persona-slug>-about.jpg`

**Photo source: judgment.** AI-generated, real, stock — whatever produces a credible match.

**Photo presence: gated.** Hard pause if photos aren't real-and-in-place. No placeholder MD5 of another site's persona.

**Voice depth: basic notes + banned phrases default.** Detailed style guide override-able if specific niche warrants.

**Verification:**

- Persona yaml exists at correct path
- All required fields populated (no `{{TOKEN}}` remaining)
- Both photos exist
- Photos are NOT placeholder MD5 of any other portfolio site's persona
- Producer reads this persona file

**Failure modes:**

- Photo MD5 matches another portfolio site's persona
- Persona yaml has placeholder tokens remaining
- Voice notes inconsistent with niche

---

### Point 6: Visual identity

**What it does:** Establish the visual brand — colors, logo, favicon — before site shell consumes them.

**Brand colors: Claude Code derives from niche understanding.** You override if you don't like it.

**5 standardized visual slots** in `site.config.yaml` under `visual:`: 3 colors (`primary_color`, `accent_color`, `background_color`) and 2 typography fields (`font_headings`, `font_body`).

**Logo: Claude Code generates.** Header SVG (color on light) and footer SVG (white on dark). Favicon derived from logo mark.

**What it produces:**

- `public/images/brand/logo-header.svg`
- `public/images/brand/logo-footer.svg`
- `public/favicon.ico` and `public/favicon.svg`
- 5 visual slot values committed to `site.config.yaml` (repo root)

**Verification:**

- Both logo SVG files render correctly at 240x40 viewport
- Favicon displays in browser tab
- 5 visual slots populated (no `{{TOKEN}}` remaining)
- No FSG/MLT/OHT identifiers in logo or color values

**Failure modes:**

- Logo inherited from template
- Color values inherited from template
- Favicon missing

---

### Point 7: Site shell (technical scaffolding)

**What it does:** Build the technical site repo from template, configured for the new site identity.

**Tools:** `tools/initialise-site.mjs` — needs to be built.

**What it produces:**

- Astro config pointing at the right domain
- `site.config.yaml` (repo root) with site name, domain, brand colors, hubs, categories, GA4 placeholder
- `config/navigation.yaml` matching hub structure
- `config/personas/<persona-slug>.yaml` (from point 5)
- `producer/<site-slug>-producer-v2.py` thin shell calling platform producer
- `producer/indexnow-submit.py` with site-specific User-Agent
- `producer/tests/*.py` with site-specific hub fixtures
- `public/images/brand/<persona>-byline.jpg`, `<persona>-about.jpg` (from point 5)
- `public/images/brand/logo-header.svg`, `logo-footer.svg` (from point 6)
- `public/<32-char-hex>.txt` IndexNow key file
- `wrangler.toml` with `name = "<site-slug>"` and `[vars] NODE_VERSION = "22"`
- `affiliate-platform/` submodule pinned to current platform commit
- `data/pipeline.json` populated (from point 3)
- `content/products/products.yaml` empty
- `content/articles/` empty (at shell creation; populated after Point 14 publish)
- `staging/` empty (producer's output destination)
- `.gitignore`, `package.json`, `tsconfig.json`

**Technical SEO included via platform defaults:**

- Schema markup (Article, Product, BreadcrumbList, FAQPage, Organization, Person)
- Meta tags (title, description, canonical, robots, Open Graph, Twitter Card, language)
- Sitemap structure
- robots.txt with sitemap reference
- URL structure (trailing slashes, kebab-case slugs)
- Image optimization (webp, sized variants, lazy loading)
- Internal linking
- Cookie consent (Consent Mode v2 with localStorage gating)
- Affiliate click tracking (GA4 events with link_position)
- Affiliate link resolution (rehype-product-links plugin transforms `product:slug` at build time)

**Verification:** `tools/verify-site-shell.mjs`:

- No FSG/MLT/OHT identifiers in the new site (template inheritance check)
- All required files exist
- Producer test fixtures match site hubs
- Submodule pin is current
- wrangler.toml name matches site slug
- 5 visual slots populated (`primary_color`, `accent_color`, `background_color`, `font_headings`, `font_body`)
- No `{{PLACEHOLDER_TOKEN}}` text remaining anywhere

**Failure modes:**

- Template inheritance not fully cleaned
- Wrangler.toml has wrong name
- Persona/logo files are placeholders
- Submodule not pinned, points to floating HEAD
- Placeholder tokens remaining

---

### Point 8: Site furniture (about, contact, compliance pages)

**What it does:** Create static content pages every site needs.

**Pages required:**

- About page — uses persona content from point 5, plus site mission statement
- Contact page — contact form (no email displayed)
- Affiliate disclosure
- Privacy policy
- Cookie policy (or merged into privacy)
- Terms of use (optional)

**Legal text source:** Claude Code generates from master templates at `~/affiliate-platform/templates/legal/` with token substitution. Templates reviewed once by you.

**Contact form:** FormSpree (existing portfolio pattern — single shared endpoint across portfolio routing to your personal email).

**Cookie consent:** Already implemented platform-wide via Consent Mode v2 with localStorage gating.

**Site mission statement input (rigid questionnaire):**

```
POINT 8: SITE MISSION STATEMENT REQUIRED

In 1-2 paragraphs, what does this site stand for? Who is it for?

Mission:
```

**Verification:**

- All required pages exist at expected URLs
- Footer links to all of them
- Affiliate disclosure visible above the fold on article pages
- Pages render with correct site name (no template inheritance, no placeholder tokens)

**Failure modes:**

- Pages missing entirely (Amazon enforcement risk)
- Pages have wrong site name in copy (template inheritance)
- Contact form FormSpree endpoint wrong

---

### Point 9: Amazon Associates tracking ID

**What it does:** Register a tracking ID with Amazon for the site, configure in code and Cloudflare.

**Process:**

1. Log into Amazon Associates dashboard
2. Create a new tracking ID: `<site-slug>-20`
3. Configure the tracking ID:
   - Primary source of truth: `site.config.yaml` under `affiliate.amazon_tracking_id` (see §1.8). The build reads this value by default.
   - Optional override: Cloudflare Pages dashboard → Environment variables → Production AND Preview as `AMAZON_TAG = "<tracking-id>"`. When present, the Cloudflare env var takes precedence over site.config.yaml.

**Hard pause if:** Amazon Associates rejects the tracking ID application.

**Single Amazon Associates account supports up to 50 sites.** Portfolio of 100 sites can use one account; tracking IDs are the per-site identifier.

**Verification:**

- Tracking ID exists in Amazon Associates dashboard
- `site.config.yaml` `affiliate.amazon_tracking_id` matches Amazon Associates ID
- If Cloudflare env var is set: Production AND Preview match site.config.yaml value
- Live affiliate link contains correct `?tag=<tracking-id>` after rehype plugin resolution

**Failure modes:**

- Tracking ID copy-pasted from another site
- Cloudflare env var set but mismatches site.config.yaml value
- Tracking ID hardcoded in platform code

---

### Point 10: Source products + ASINs per article

**What it does:** For each article in pipeline.json, source 1-7 real Amazon-stocked products by searching for that article's keyword.

**The principle:** Per-article fresh sourcing. No bucket. No invented brands. No products generated from memory.

**Per-article product counts:**

- buyer_guide: 5 products
- roundup: 7 products
- comparison: 2 products
- review: 1 product

**Canonical workflow — Rainforest API (recommended for all production runs):**

```
# Step 1: Bulk source products for all articles with empty products[]
python3 tools/source-products-rainforest.py --site <slug>

# Step 2: Generate real pros/cons for every product via Claude Haiku
python3 tools/generate-product-pros-cons.py --site <slug>

# Step 3 (optional): Resolve any remaining VERIFY entries with a second Rainforest pass
python3 tools/resolve-verify-asins.py --site <slug>
```

**Prerequisites:** `RAINFOREST_KEY` and `ANTHROPIC_API_KEY` in `<site_root>/config/credentials.env`. The `config/credentials.env` stub is created by `initialise-site.mjs` Phase 1.

**Cost transparency (300-article site):**

| Step | Cost |
|---|---|
| source-products-rainforest.py | ~$1.50–3.00 (1 call/article × ~$0.005–0.01/call) |
| generate-product-pros-cons.py | ~$0.80–1.00 (1,300 products × ~$0.0007/product via Haiku) |
| resolve-verify-asins.py | ~$0.25–0.50 (typically 50–80 VERIFY entries) |
| **Total realistic** | **~$3–7 for a 300-article site** |

**Resume support:** All three tools write a state file to `/tmp/<tool-name>-<slug>-state.json`. If interrupted, rerun with `--resume` to skip already-processed entries.

**Deprecated alternative — Amazon scraping:**

`tools/source-products-per-article.mjs` uses LLM + Amazon scraping. It rate-limits at scale (hits blocks within ~30 articles on a 300-article run). Retained for small jobs (< 30 articles) and smoke testing. Do not use for production bulk runs.

**What it produces:**

- pipeline.json article entries with populated `products: []`
- `content/products/products.yaml` populated with unique products
- All ASINs are real (B0...) or NOT_ON_AMAZON
- All products have `default_pros` and `default_cons` (generated by step 2)

**Verification:**

- All articles have minimum products assigned for their type
- products.yaml has zero VERIFY entries
- All ASINs match format `B0[A-Z0-9]{8}` or value is `NOT_ON_AMAZON`
- All products have non-placeholder `default_pros` / `default_cons`
  (`grep -c "Well-reviewed\|Strong customer ratings" content/products/products.yaml` → 0)

**Failure modes:**

- Picking product variants that don't match article topic
- High NOT_ON_AMAZON rate in premium-brand niches (judgment: accept or find substitutes)
- RAINFOREST_KEY not set — tool exits with clear error pointing to credentials.env

---

### Point 11: Source image bank

**What it does:** Source 150 unique topical images from Pexels for the site, organized by hub.

**Locked specs:**

- 150 images per site
- 1200x630, 16:9 aspect ratio
- Hub-based naming: `<hub>-1.jpg`, `<hub>-2.jpg`, etc.
- Sourced from Pexels API
- Stored at `public/images/articles/`

**Post-launch upgrade:** Traffic winners get DALL-E upgrades (operational layer, not launch).

**Tools:** `tools/source-images-pexels.mjs` — needs to be built.

**Verification:**

- 150 images downloaded
- Images are webp format
- Images organized by hub with sequential numbering
- All images at 1200x630 minimum

**Failure modes:**

- Pexels API rate limit hit
- Images not optimized
- Topic mismatches

---

### Point 12: Assign images per article

**What it does:** Walk pipeline.json, assign image references per article from the topical pool.

**Default:** 1 hero + 4 body images per article (5 total). Body images injected at 4 fixed structural positions (after intro H2, after Top Picks H2, after How to Choose H2, after FAQ H2).

**Per-site override:** `site.config.yaml` under `style_policy.in_body_images`. Permitted modes:
- `policy: 'fixed_count', fixed_count: N` — exact body image count per article
- `policy: 'per_product'` — one image per product mention in body
- `policy: 'none'` — no body images (hero only)

Sites pick a policy at initialisation and stick with it; changing policy mid-life requires regenerating affected articles.

**Selection algorithm:** Random within hub. Hero and body images selected from the hub's image pool.

**What it produces:**

- pipeline.json article entries with populated `hero_image:` and `body_images: [...]`

**Tools:** `tools/assign-article-images.mjs`

**Verification:**

- Every article has hero_image and body_images populated per site policy
- All referenced images exist in image bank

**Failure modes:**

- Image bank too small for article count
- Image references broken
- Policy changed after initial article generation without regeneration pass

---

### Point 13: Article generation

**What it does:** Producer runs against fully populated pipeline.json (products + images + article configs), generates one .md file per article.

**Run mode:** Foreground with `tee` to log file.

**Output destination:** Producer writes to `staging/`. Articles move to `content/articles/` in point 14 after regeneration is complete.

**Command:**

```
python3 producer/<site-slug>-producer-v2.py --site ~/<site-slug> --count 300 2>&1 | tee logs/produce-300.log
```

Runs unattended for 1.5-3 hours.

**Producer changes needed for v1.8.0:**

- Embed `hero_image` in frontmatter from pipeline.json
- Embed body images at predictable positions in markdown (after intro H2, after Top Picks H2, after How to Choose H2, after FAQ H2 — 4 fixed positions)
- Affiliate links already use `product:slug` format (verified — no change needed)

**Verification:**

- All articles in pipeline.json got attempted (no silent skips)
- Pass/fail counts surfaced
- Failure distribution by validator rule surfaced

**Failure modes:**

- Producer skips articles silently
- Model rate limits / API errors mid-run
- Persona file missing or empty
- products.yaml missing for some pipeline products

---

### Point 14: Regeneration pass and publish

**What it does:** Regenerate failed articles once in staging, then move all staged articles to content/articles/.

**No iterative calibration cycles per site.**

**Process:**

1. Identify articles in `staging/failed/` after first generation
2. Regenerate each once with `--force --id N` (writes back to staging/)
3. Articles still failing after regeneration: hand-edit in staging/, drop, or accept (judgment per article)
4. Soft fails ship with logged warning to calibration-log.yaml
5. Strip any validator output appended to failed articles
6. Move all staged articles to `content/articles/` via `tools/publish-staging.mjs`
7. Verify count matches expected publish count

**Hard fail rate consistently above threshold (>5%) across multiple sites becomes a platform-level review.**

**Tools:** `tools/publish-staging.mjs` — needs to be built. Moves files from staging to content/articles/, strips validator output, reports counts.

**Verification:**

- All articles in content/articles/ are publishable
- Hard fail count = 0
- Soft fail count surfaced and accepted
- After a publish run completes, `staging/` and `staging/failed/` contain only files from the current pending batch (failed regenerations or unapproved drafts). Across the lifecycle of a live site, these directories accumulate artifacts of in-flight work — they are not asserted empty as a steady state.

**Failure modes:**

- Persistent hard fails on a small set of articles
- Calibration drift if validators get widened during a site (forbidden)
- Validator output not stripped before publish (causes Astro build issues)

---

### Point 15: Local build smoke

**What it does:** Verify the site builds locally before pushing.

**Command:**

```
cd ~/<site-slug>
npm install  # first time only
npm run build
```

**Build runs build-validator** which checks for VERIFY entries, NOT_ON_AMAZON rendering, broken links, hardcoded affiliate tags, placeholder tokens.

**Verification:**

- `npm run build` exits 0
- `dist/` directory contains expected file count
- Build log has no errors
- No placeholder tokens in dist/

**Failure modes:**

- Article frontmatter malformed
- Image reference broken
- Internal link broken
- Build-validator finding raw Amazon URLs (shouldn't happen — producer emits product:slug)
- Placeholder tokens that escaped earlier checks

---

### Point 16: Push live

**What it does:** Push to GitHub, Cloudflare auto-deploys, verify live.

**Tool:** `tools/deploy-and-verify.mjs --site <slug>` — needs to be built.

**Pre-condition gate: `tools/verify-bindings.mjs --site <slug>` runs first.**

This catches the OHT-style "wires connected to wrong endpoints" failures. Eight checks performed:

1. Cloudflare project name = site slug
2. Cloudflare project's GitHub repo = expected repo (`itsalljustagamesoitis-ux/<site-slug>`)
3. Cloudflare project's custom domain = site domain
4. AMAZON_TAG in Cloudflare Production env = `affiliate.amazon_tracking_id` in site.config.yaml (if env var is set)
5. AMAZON_TAG in Cloudflare Preview env = same value (if env var is set)
6. GA4 measurement ID unique across portfolio (cross-check against portfolio.yaml)
7. IndexNow key file at site root matches BWT registration
8. DNS for site domain points at correct Cloudflare Pages project

If any check fails, deploy doesn't even start. Tool reports specifically which binding is wrong.

**Process (after bindings verified):**

1. Commit any pending changes locally
2. Push to GitHub origin
3. Wait for Cloudflare Pages deployment (10-minute timeout, hard fail past it)
4. Verify deployment reaches green status
5. Run live verification (5 hard checks per Section 1.5)
6. Report outcome

**Hard pause if:** Any binding check fails or any verification check fails.

**Verification:** All 5 live checks pass (per Section 1.5).

**Failure modes (the OHT lessons, now caught by verify-bindings):**

- Cloudflare project doesn't exist
- Cloudflare project name mismatches wrangler.toml
- AMAZON_TAG missing on Preview environment
- NODE_VERSION not set
- Repo visibility unexpected
- Cloudflare GitHub App lost access after repo visibility changed

---

### Point 17: GA4 setup

**What it does:** Create GA4 property, get measurement ID, inject into site.

**Google Analytics side (browser, ~10 minutes):**

1. Sign in to analytics.google.com
2. Admin → Create Property → name after site
3. Add web data stream pointing at site URL
4. Copy measurement ID (`G-XXXXXXXXXX`)

**Site side:**

1. Add measurement ID to `site.config.yaml` (repo root) under `analytics.ga4_measurement_id`
2. Astro Layout reads config, injects script
3. Push triggers deploy with GA4 active

**Platform defaults (already implemented):**

- IP anonymization: enabled
- Consent Mode v2: enabled
- Custom events: `affiliate_click` with link_position tracking

**Verification (built into deploy-and-verify):**

- HTML source contains correct `googletagmanager.com/gtag/js?id=G-XXXX`
- DevTools shows requests to google-analytics.com firing on page load (after consent)
- GA4 Realtime shows traffic when site visited

**Failure modes:**

- Measurement ID typo
- Property created but data stream not configured

---

### Point 18: Bing Webmaster Tools — verify and submit sitemap

**What it does:** Add site to BWT, verify ownership, submit sitemap.

**Process (browser, ~5-10 minutes):**

1. Sign in to bing.com/webmasters
2. Add a Site → enter domain
3. Verify via DNS TXT record in Cloudflare
4. Sitemaps → Submit `https://<domain>/sitemap-index.xml`
5. Configure: enable IndexNow integration, register IndexNow key (point 20)

**Verification:**

- Site appears as verified property
- Sitemap status: Success within 24 hours
- Discovered URL count matches site's article count

**Failure modes:**

- Sitemap URL wrong
- Sitemap blocked by robots.txt
- Verification fails (DNS propagation delay)

---

### Point 19: Google Search Console — verify and submit sitemap

**What it does:** Add site to GSC, verify ownership, submit sitemap.

**Process (browser, ~5-10 minutes):**

1. Sign in to search.google.com/search-console
2. Add property → enter domain (use Domain property)
3. Verify via DNS TXT record in Cloudflare
4. Sitemaps → Add `sitemap-index.xml`
5. Optional: link to GA4 property

**Verification:**

- Property verified
- Sitemap status: Success within 24-48 hours
- Discovered URLs match article count

**Failure modes:**

- Sitemap "Couldn't fetch"
- Verification fails (DNS propagation)

---

### Point 20: IndexNow — wiring and verification

**What it does:** Set up IndexNow protocol for instant URL submission to Bing.

**Three pieces:**

1. IndexNow key file at site root — generated at point 7, deployed at point 16
2. Producer integration to fire IndexNow on publish — `producer/indexnow-submit.py`
3. Bing Webmaster Tools registration — register key in BWT (point 18)

**Trigger:** Batch after deploy-and-verify completes.

**Verification:**

- `curl https://<domain>/<key>.txt` returns the key string
- IndexNow submission logs show successful POST (200 response)
- BWT shows IndexNow as enabled
- Within 24-48 hours, BWT shows recent submissions

**Failure modes:**

- Key file content doesn't match what's submitted to API
- Producer integration not actually firing (FSG/MLT concern)
- BWT not registered with key

---

### Point 21: Plug into operational dashboard

**What it does:** Add site to portfolio operational dashboard.

**What it produces:** Entry in `~/affiliate-platform/portfolio.yaml`:

```yaml
sites:
  - slug: <site-slug>
    domain: <domain>
    persona: <persona-name>
    tracking_id: <amazon-tracking-id>
    ga4_id: <ga4-measurement-id>
    cloudflare_project: <cloudflare-project-name>
    github_repo: itsalljustagamesoitis-ux/<repo-name>
    status: live
    launched: <date>
```

Optional fields:
- `notes`: per-site operational notes (e.g., known deploy quirks, manual workarounds, anything an operator should know before touching the site)

**Dashboard implementation phases (locked):**

- Phase 1 (sites 1-10): YAML manifest + CLI tool. Refresh: on-demand.
- Phase 2 (sites 11-30): Static dashboard site. Refresh: scheduled rebuild.
- Phase 3 (sites 31+): Real web app with live data, history, alerts.

**Performance dashboard is separate and built later** when there's traffic data worth visualizing.

**Verification:**

- `node ~/affiliate-platform/tools/dashboard.mjs` shows new site
- Live status check passes
- Static config matches what's set in Cloudflare/GA4/BWT/GSC

---

### Move to next site

After 21 points complete and dashboard shows green:

- Site shifts from "in launch" to "operating"
- Site no longer in active build queue
- Goes into portfolio operations bucket

**Cadence: immediately to next site, no cool-off period.** Run sites in sequence at full pace until 10 sites live, then pause and assess.

**Pause point at 10 sites: judgment.**

---

## 4. Operational layer — recurring tasks

### 4.1 Per-site recurring tasks

- ASIN health checks
- Article freshness review
- Domain renewals (automatic via Cloudflare, monitor expiry 60 days out)
- SSL certificate monitoring (Cloudflare auto-renews)
- Article expansion (50-100 articles from Reserve Pool periodically)
- DALL-E image upgrades (traffic-driven for winning articles)

### 4.2 Cross-portfolio recurring tasks

- Uptime monitoring with alerts
- Earnings polling (Amazon Associates daily pull)
- GSC/Bing data ingestion
- Cloudflare deploy status
- Search ranking polling
- Calibration drift detection
- Platform updates / submodule pin bumps
- Bindings verification across portfolio (`tools/verify-bindings.mjs --all`)

### 4.3 Cadences

**TBC** — set when operational automation gets built. Annual domain renewal is the only locked cadence.

---

## 5. Operational automation tiering

Three tiers, sequenced by site count and value.

### Tier 1 — Hands-off operations

- Uptime monitoring + alerts
- ASIN monitoring (detection)
- ASIN auto-fix with confidence scoring + human escalation
- Deploy verification
- SSL/DNS monitoring
- Sitemap freshness checks
- Earnings polling
- Search ranking polling
- Bindings verification across portfolio

### Tier 2 — Performance optimization

- Article-level traffic analysis
- Underperformer flagging
- Content refresh suggestions
- DALL-E image upgrades for traffic winners
- Article expansion timing detection

### Tier 3 — Strategic intelligence

- Cross-site pattern detection
- Algorithmic risk monitoring
- New niche identification

### Build sequencing

**TBC** — built when manual operations start consuming meaningful weekly time.

---

## 6. Platform additions required before site 4

**Critical (must build before site 4):**

- `tools/launch-site.mjs` — the ritual orchestrator (Section 2)
- `tools/initialise-site.mjs` — site shell scaffolding (point 7)
- `tools/verify-site-shell.mjs` — verifies no template inheritance (point 7)
- `tools/verify-bindings.mjs` — pre-deploy binding verification + portfolio audit (point 16)
- `tools/source-products-per-article.mjs` — per-article ASIN lookup (point 10)
- `tools/source-images-pexels.mjs` — image bank from Pexels (point 11)
- `tools/assign-article-images.mjs` — per-article image assignment (point 12)
- `tools/publish-staging.mjs` — move from staging to content/articles/ (point 14)
- `tools/deploy-and-verify.mjs` — push, wait, verify live (point 16)
- `tools/dashboard.mjs` — operational dashboard CLI (point 21)
- `tools/xlsx-to-pipeline.mjs` — keyword research xlsx → pipeline.json (point 3)

**Producer changes (v1.8.0):**

- Embed `hero_image` in frontmatter from pipeline.json
- Embed body images at predictable positions in markdown (4 fixed positions: after intro, after Top Picks, after How to Choose, after FAQ)
- Hub-distributed homepage article selection (site template change, bundled with v1.8.0)

**Build-validator cleanup:**

- Update stale error messages from `<ProductLink>` references to `product:slug` (the actual format in use)

**Validator changes (from VALIDATORS.md):**

- Tag every rule with hard/soft/manual classification
- Implement soft fail logging to calibration-log.yaml
- Flip A09 from warning to hard fail
- Promote 11 M-rules from manual to auto-validated (M02, M04, M05, M06, M07, M09, M10, M11, M13, M15, M16)

**Important but not site-4-blocking:**

- `tools/check-niche-density.mjs` (point 1)
- `tools/expand-articles.mjs` (article expansion)
- `tools/asin-health-check.mjs` (Tier 1)
- `tools/earnings-poll.mjs` (Tier 1)

**Documentation:**

- `~/affiliate-platform/CATALOG-BEHAVIOUR.md` Section 7 — site initialisation: catalog seeding from Amazon search per article
- `~/affiliate-platform/TECHNICAL-SEO.md` — audit existing implementations
- `~/affiliate-platform/templates/legal/` — master legal templates with token placeholders
- `~/affiliate-platform/VALIDATORS.md` — validator rule classification (already drafted)

---

## 7. Validator hard fail vs soft fail framework

See `~/affiliate-platform/VALIDATORS.md` for full rule classification. Summary:

- **Hard fail** — breaks site functionality, violates legal/compliance, produces visibly broken content, embarrasses brand under scrutiny, breaks editorial contract
- **Soft fail** — produces editorially-fine content, arithmetic miss within 10% of target (exclusive)
- **Manual** — requires human judgment

10% deviation boundary calculated as `abs(observed - target) / target * 100`. Under 10% = soft. 10% or more = hard. For "exactly N" count rules, ±1 is soft.

Soft fails ship with logged warning to `~/affiliate-platform/calibration-log.yaml` for periodic editorial review.

Hard fail rate consistently above 5% across multiple sites = platform-level review.

---

## 8. Technical SEO documentation task

Audit existing platform/sites for technical SEO implementations and document findings.

**Areas to cover:**

- Schema markup types implemented
- Meta tag patterns
- Sitemap structure
- robots.txt content
- URL conventions
- Internal linking strategy
- Image optimization
- Performance baseline (Core Web Vitals)
- Cookie consent posture (Consent Mode v2 already confirmed implemented)
- Affiliate link resolution (rehype-product-links plugin already confirmed)

**Output:** `~/affiliate-platform/TECHNICAL-SEO.md`

**Approach:** Audit pass on FSG/MLT/OHT codebases and platform. Document findings. Surface gaps for decision. Don't fix in audit pass.

**Pairs with Phase 2 sweep** to verify existing sites are correctly configured.

---

## 9. Homepage strategy

Algorithmic, opinionated platform default, no manual curation.

**Logic:**

- Show ~12 articles on homepage
- Diversity enforcement: no more than 1-2 articles per hub
- For each hub, randomly pick 2-3 articles
- Combine, shuffle for visual variety

**OHT example of failure mode:** Homepage initially showed 4 Anchor Hocking articles in visible slice. Concentration looked weird.

**Adding to platform v1.8.0:** Update homepage component to do hub-distributed article selection.

---

## 10. Pending operational fixes for current sites

**Phase 2 sweep timing and priority: TBC.**

### 10.1 Across all live sites (FSG, MLT, OHT)

- Audit GA4 firing on live sites
- Audit IndexNow wiring and actual firing
- Audit GSC verification, sitemap submission status, indexed page count
- Audit Bing Webmaster Tools verification, sitemap submission status
- Run `tools/verify-bindings.mjs --all` once tool exists to catch any wrong-wiring issues
- Audit for template inheritance bugs (FSG content appearing in MLT/OHT)

### 10.2 FSG-specific

- 197 articles violate Amazon Operating Agreement on dollar figures
- 102 articles below 2000 words
- Sitemap issue (specifics to investigate)

### 10.3 MLT-specific

- Producer architecture: migrated to platform-shell pattern (`mlt-producer.py` delegates to `affiliate-platform/producer/producer_main.py`)
- IndexNow wiring verification

### 10.4 OHT-specific

- Catalog cleanup: re-resolve high-blast-radius NOT_ON_AMAZON entries (Lenox Opal Innocence in 15 articles is highest priority)
- Remove genuinely-fake products (Maison Arts, Bamboofest, Lillian Rose, Dwell Studio)
- Verify Sarah Collins persona photos installed correctly across both byline and about page
- Categories: retroactively add single category "Home Entertaining" wrapping the 5 hubs
- Site config description has FSG-inherited text. Update to OHT-appropriate description.

---

## 11. Document maintenance

This document is the source of truth. When reality diverges:

- If reality is wrong: fix reality
- If document is wrong: update the document
- Never silently work around a divergence

When new lessons emerge:

- Update relevant section
- Note the change in CHANGELOG.md at platform root

---

*End of PIPELINE.md*
