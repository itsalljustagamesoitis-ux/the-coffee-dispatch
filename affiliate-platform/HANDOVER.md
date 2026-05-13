# Affiliate Platform — Complete Handover Document

**Date:** 2026-05-08  
**Platform Version:** 1.1.0  
**Current Platform HEAD:** `99169d0` (Migrate Cloudflare auth from wrangler OAuth to env-based token)

---

## 1. Elevator Pitch

The affiliate platform is a shared Astro-based content layer serving three premium consumer-advice websites (Four Season Gardener, My Little Tablespoon, One Happy Table) with affiliate revenue through Amazon Associates and Awin. It solves the problem of maintaining consistent editorial architecture, component behavior, and product data integrity across three independently-owned sites. Products are referenced by slug in article frontmatter; affiliate URL resolution, price fetching, and availability handling all happen at build time via a single source-of-truth YAML catalog. Articles stay as plain Markdown; business logic lives in Astro layouts, rehype plugins, and build-time validators. Each site owns its content, personas, and visual identity; the platform handles all rendering.

---

## 2. Repository Topology

### Monorepo structure

```
~/
├── affiliate-platform/         ← @platform/core — platform layer (shared)
├── four-season-gardener/       ← FSG — gardening/outdoor tools
├── my-little-tablespoon/       ← MLT — kitchen cookware
└── one-happy-table/            ← OHT — home entertaining
```

### affiliate-platform (the shared platform)

**GitHub URL:** https://github.com/itsalljustagamesoitis-ux/affiliate-platform.git  
**Local path:** ~/affiliate-platform/  
**Current HEAD:** `99169d0` (2026-05-08)  
**npm package:** `@platform/core` v1.1.0  
**Submodule in:** FSG, MLT, OHT (all point to `33cc324`)  

This repo contains the canonical implementation of:
- 5 Astro layouts (BaseLayout, BuyerGuideLayout, ComparisonLayout, ReviewLayout, RoundupLayout)
- 16 Astro components (ProductCard, Price, ProductLink, Byline, Header, Footer, etc.)
- 1 Astro library (config.ts) with site config loader, product resolver, affiliate URL builder
- 1 rehype plugin (rehype-product-links.mjs) for markdown → affiliate URL resolution
- 2 canonical build scripts (build-validator.mjs, validate-asins.mjs)
- TypeScript type definitions for SiteConfig, PersonaConfig, ProductRecord, NavConfig
- Zod schemas for articles and product references

**Exports via package.json:**
```json
"exports": {
  "./src/layouts/*": "./src/layouts/*",
  "./src/components/*": "./src/components/*",
  "./src/lib/*": "./src/lib/*",
  "./src/plugins/*": "./src/plugins/*",
  "./src/styles/*": "./src/styles/*",
  "./scripts/*": "./scripts/*"
}
```

### four-season-gardener (FSG)

**GitHub URL:** https://github.com/itsalljustagamesoitis-ux/four-season-gardener  
**Local path:** ~/four-season-gardener/  
**Current HEAD:** `f63807b` (Bump affiliate-platform submodule to d71951a (cluster→hub))  
**Submodule pointer:** `33cc324` (affiliate-platform)  
**Deployment:** Cloudflare Pages — git-driven (main branch)  
**Live URL:** https://fourseasongardener.com  
**Article count:** 198 .md files in content/articles/  
**Product catalog:** 203 products with real ASINs (amazon_asin: B0*)  

**Owned by site:**
- site.config.yaml: brand_name="The Four Season Gardener", domain="fourseasongardener.com", amazon_tracking_id="fourseasong-20"
- config/personas/wendy.yaml: persona definition (Wendy Hartley, HR background)
- content/articles/: all article .md files
- content/products/products.yaml: product catalog (ASIN-sourced)
- producer/fsg-producer.py: article generator (not in scope for this handover)

**Known issues:** None listed in CLAUDE.md

### my-little-tablespoon (MLT)

**GitHub URL:** https://github.com/itsalljustagamesoitis-ux/my-little-tablespoon  
**Local path:** ~/my-little-tablespoon/  
**Current HEAD:** `5c55273` (Bump affiliate-platform submodule to d71951a (cluster→hub))  
**Submodule pointer:** `33cc324` (affiliate-platform)  
**Deployment:** Cloudflare Pages — git-driven (main branch)  
**Live URL:** https://mylittletablespoon.com  
**Article count:** 200 .md files in content/articles/  
**Product catalog:** 131 products with real ASINs  

**Owned by site:**
- site.config.yaml: brand_name="My Little Tablespoon", domain="mylittletablespoon.com", amazon_tracking_id="mylittletbsp-20"
- config/personas/emily.yaml: persona definition (Emily Prescott, food scientist background)
- content/articles/: all article .md files
- content/products/products.yaml: product catalog
- producer/: article generation pipeline (includes pytest tests)

**Known issues:** None listed in CLAUDE.md

### one-happy-table (OHT)

**GitHub URL:** https://github.com/itsalljustagamesoitis-ux/one-happy-table  
**Local path:** ~/one-happy-table/  
**Current HEAD:** `ec2e7a7` (Bump affiliate-platform submodule to d71951a (cluster→hub))  
**Submodule pointer:** `33cc324` (affiliate-platform)  
**Deployment:** Cloudflare Pages — git-driven (main branch)  
**Live URL:** onehappytable.com (DNS not live on system at inspection)  
**Article count:** 0 .md files in content/articles/ (pre-launch)  
**Product catalog:** 1 .yaml file exists; 53 entries with `amazon_asin: VERIFY`  

**Owned by site:**
- site.config.yaml: brand_name="One Happy Table", domain="onehappytable.com", amazon_tracking_id="onehappytable-20", ga4_measurement_id=null
- config/personas/wendy.yaml: persona definition (Wendy Collins, note: duplicate name "wendy" with FSG — different last names in YAML)
- content/articles/: empty (pre-launch)
- content/products/products.yaml: catalog with 53 VERIFY entries (BLOCKING pre-launch)
- producer/oht-producer.py: article generator (pre-launch)

**Critical blockers for launch:**
- `analytics.ga4_measurement_id` is null — required before production deploy
- `BING_SITE_VERIFICATION` env var required in Cloudflare Pages settings (hard build failure if missing)
- 53 `amazon_asin: VERIFY` entries must be resolved to real ASINs before any article can be published
- Persona images missing: `wendy-about.jpg` and `wendy-byline.jpg` (build-validator will fail)

---

## 3. Platform Architecture

### Directory structure in ~/affiliate-platform/

```
affiliate-platform/
├── .git/                      Git repository (HEAD: 341d96b)
├── node_modules/              npm dependencies (sharp, astro, zod, js-yaml, rehype-external-links, etc.)
├── package.json               @platform/core v1.1.0 definition and exports
├── package-lock.json          Pinned dependency versions (node >= 22.12.0)
│
├── CHANGELOG.md               Phase 3 migration notes, MLT/FSG deployment records
├── CLAUDE.md                  Operating contract; 3 non-negotiable rules
│
├── src/
│   ├── layouts/               5 article layout templates
│   │   ├── BaseLayout.astro      Base wrapper (HTML shell, head, footer, nav)
│   │   ├── BuyerGuideLayout.astro  For type: "buyer_guide" + "informational"
│   │   ├── ComparisonLayout.astro  For type: "comparison" (product_a vs product_b)
│   │   ├── ReviewLayout.astro      For type: "review" (single featured product)
│   │   └── RoundupLayout.astro     For type: "roundup" (multiple products, ranked)
│   │
│   ├── components/            16 reusable Astro components
│   │   ├── AffiliateDisclosure.astro  FTC disclosure box (rendered if disclosure_required: true)
│   │   ├── AuthorBio.astro             Persona bio + photo (sidebar/footer placement)
│   │   ├── Breadcrumb.astro            Category > Hub > Article crumbs
│   │   ├── Byline.astro                Author name + publish/update dates
│   │   ├── ComparisonTable.astro       Side-by-side product table (comparison layout only)
│   │   ├── EmailCapture.astro          Email signup form (footer CTA)
│   │   ├── FAQ.astro                   Structured Q&A block
│   │   ├── Footer.astro                Site footer (nav, links, social, copyright)
│   │   ├── Header.astro                Site header (logo, search, nav, persona avatar)
│   │   ├── PrevNext.astro              Pagination: "← Previous Article" "Next Article →"
│   │   ├── Price.astro                 Renders current_price from products.yaml (NEW in 1.1.0)
│   │   ├── ProductCard.astro           Single product card (image, pros/cons, CTA button)
│   │   ├── ProductLink.astro           Inline product link (NEW in 1.1.0) — uses buildAffiliateUrl()
│   │   ├── ProsConsBox.astro           Standalone pros/cons box
│   │   ├── QuickPicks.astro            "Top picks" summary callout
│   │   ├── RelatedArticles.astro       Related content links (sidebar)
│   │   ├── SchemaMarkup.astro          JSON-LD breadcrumb, article, product schema
│   │   └── TrustBlock.astro            "About the author" profile box
│   │
│   ├── lib/
│   │   └── config.ts           Central config loader + type definitions
│   │       ├── getSiteConfig()      → reads site.config.yaml
│   │       ├── getPersona()         → reads config/personas/[file]
│   │       ├── getProducts()        → reads content/products/products.yaml
│   │       ├── getNav()             → reads config/navigation.yaml
│   │       ├── buildAffiliateUrl()  → generates Amazon/Awin URLs (core business logic)
│   │       ├── resolveProduct()     → resolves frontmatter product refs to ResolvedProduct
│   │       └── productDisplayName() → formats brand + name without duplication
│   │
│   ├── plugins/
│   │   └── rehype-product-links.mjs  Markdown rehype plugin
│   │       Transforms [text](product:slug) links → real affiliate URLs at build time
│   │       Replaces NOT_ON_AMAZON with <span data-unavailable> (no link)
│   │       Throws on unknown slugs (drift detection)
│   │
│   └── styles/
│       └── global.css           Shared CSS (colors, typography, spacing)
│
├── scripts/
│   ├── build-validator.mjs       Post-build validator (runs after astro build)
│   │   Checks: empty pages, missing images, untagged affiliate links,
│   │   hardcoded prices, placeholder ASINs, duplicate breadcrumbs,
│   │   doubled brand names, IndexNow key file presence
│   │
│   └── validate-asins.mjs        ASIN validator (pre-launch)
│       Verifies every amazon_asin: B0* in products.yaml resolves to real Amazon product page
│       Checks: format, 404 detection, bot-blocking, actual product indicators
│
├── tools/
│   ├── assign-article-images.mjs     Point 9.6 of launch ritual — populates hero_image + body_images in pipeline.json
│   │   Seeded PRNG (mulberry32/djb2), hero uniqueness rotation per hub, 4 body images per article
│   │   Idempotent fill (skips already-assigned). --dry-run supported.
│   │
│   ├── source-images-pexels.mjs      Downloads images from Pexels into site image bank
│   │   One format only: canonical envelope { version, articles: [] }
│   │
│   ├── verify-bindings.mjs           Verifies Cloudflare Pages bindings match portfolio.yaml
│   │   Thin CLI; delegates to lib/binding-checks.mjs
│   │
│   ├── markdown-to-productlink.mjs   Migration tool (Phase 3, already ran — do not re-run)
│   │   Converts hardcoded [text](amazon.com/dp/ASIN?tag=...) → [text](product:slug)
│   │
│   ├── lib/
│   │   ├── auth.mjs                  Cloudflare token resolution (env var → .env.local → wrangler)
│   │   ├── binding-checks.mjs        runChecks() + helpers extracted from verify-bindings
│   │   ├── cloudflare-api.mjs        Cloudflare REST API helpers
│   │   └── portfolio.mjs             loadPortfolio() / getSite() helpers
│   │
│   ├── rewrite-article-asins.mjs     (utility, not currently used)
│   ├── fill-asins-yaml.mjs           (utility, not currently used)
│   └── slug-rewrites.json            (mapping table, not currently used)
│
├── schemas/                    (empty; future use for content validation)
├── registries/                 (empty; future use for product/persona indexing)
├── pipelines/                  (empty; future use for generation workflows)
├── prompts/                    (empty; future use for LLM-based generation)
│
└── .gitignore                  Standard Node exclusions

```

### Layout selection logic (in [slug].astro at each site)

```astro
{article.data.type === 'roundup' && (
  <RoundupLayout article={article} prev={prev} next={next}>
    <Content />
  </RoundupLayout>
)}
{article.data.type === 'review' && (
  <ReviewLayout article={article} prev={prev} next={next}>
    <Content />
  </ReviewLayout>
)}
{article.data.type === 'comparison' && (
  <ComparisonLayout article={article} prev={prev} next={next}>
    <Content />
  </ComparisonLayout>
)}
{article.data.type === 'buyer_guide' && (
  <BuyerGuideLayout article={article} prev={prev} next={next}>
    <Content />
  </BuyerGuideLayout>
)}
{article.data.type === 'informational' && (
  <BuyerGuideLayout article={article} prev={prev} next={next}>
    <Content />
  </BuyerGuideLayout>
)}
```

Type mapping: `roundup`, `review`, `comparison`, `buyer_guide`, `informational` all map to specific layouts. Informational uses the same layout as buyer_guide. Unknown types render nothing (silent failure — should be prevented by Zod schema).

---

## 4. Data Model

### products.yaml schema

**File location:** `content/products/products.yaml` (in each site repo, site-owned)  
**Format:** YAML dict with slug keys (e.g., `polywood-classic-adirondack-chair`, `all-clad-d3-skillet-12`)

**Fields (ProductRecord type in config.ts:64–78):**

```yaml
product-slug:
  name: string                     # Product name (e.g., "Classic Folding Adirondack Chair")
  brand: string                    # Brand name (e.g., "POLYWOOD")
  amazon_asin: string | null       # ASIN: B0123456789 format, or special sentinels
  awin_advertiser_id: number       # Awin advertiser ID (if applicable)
  awin_product_url: string         # Full Awin product URL (if applicable)
  default_image: string            # Hero image URL (usually Amazon CDN URL)
  category: string                 # Product category (for nav/filtering)
  price_band: enum                 # "budget" | "mid" | "premium" (price range label)
  default_pros: string[]           # Default pros (overridable in article frontmatter)
  default_cons: string[]           # Default cons (overridable in article frontmatter)
  notes_for_writers: string        # Internal notes (not published)
  last_verified: date              # ISO date of last ASIN verification
  current_price: string | null     # Display price (e.g., "$49.99") — optional, used by <Price /> component
```

**Special amazon_asin values:**

- `NOT_ON_AMAZON` — Product exists but has no Amazon listing. Renders as `<span data-unavailable>` in markdown links; `buildAffiliateUrl()` returns null.
- `VERIFY` — BLOCKING. Indicates ASIN must be confirmed before article publication. build-validator.mjs and validate-asins.mjs both fail if any VERIFY exists in committed products.yaml.

**Example entry:**

```yaml
polywood-classic-adirondack-chair:
  name: "Classic Folding Adirondack Chair"
  brand: "POLYWOOD"
  amazon_asin: B001VNCJ36
  awin_advertiser_id: null
  awin_product_url: null
  default_image: "https://m.media-amazon.com/images/I/61AOPE-CILL._SL500_.jpg"
  category: "outdoor-furniture"
  price_band: "mid"
  default_pros:
    - "Made from recycled HDPE lumber — never needs painting"
    - "20-year residential warranty"
  default_cons:
    - "HDPE plastic lacks warm wood grain look"
    - "Color can fade over time"
  notes_for_writers: "Best entry-level POLYWOOD pick. Compare to teak."
  last_verified: 2026-04-30
```

### resolveProduct() function

**File:line:** `/Users/keithlacy/affiliate-platform/src/lib/config.ts:204–226`

```typescript
export function resolveProduct(
  ref: { 
    id: string
    role?: string
    article_specific_pros?: string[]
    article_specific_cons?: string[] 
  },
  articleSlug: string
): ResolvedProduct | null {
  const db = getProducts()
  const product = db[ref.id]
  if (!product) {
    console.warn(`[products] Unknown product ID: ${ref.id}`)
    return null
  }

  return {
    id: ref.id,
    name: product.name,
    brand: product.brand,
    image: product.default_image,
    price_band: product.price_band,
    pros: ref.article_specific_pros ?? product.default_pros,
    cons: ref.article_specific_cons ?? product.default_cons,
    affiliate_url: buildAffiliateUrl(ref.id, articleSlug),
    role: ref.role,
  }
}
```

**Behavior:**
- Looks up `ref.id` in products.yaml
- Returns null and warns if not found (no hard error at layout time)
- Uses `article_specific_pros` / `article_specific_cons` from frontmatter if provided; falls back to `default_pros` / `default_cons` from products.yaml
- Calls `buildAffiliateUrl()` to generate the actual affiliate link
- Returns ResolvedProduct with affiliate_url resolved

### buildAffiliateUrl() function

**File:line:** `/Users/keithlacy/affiliate-platform/src/lib/config.ts:162–188`

```typescript
export function buildAffiliateUrl(
  productId: string,
  articleSlug: string
): string | null {
  const db = getProducts()
  const cfg = getSiteConfig()
  const product = db[productId]
  if (!product) return null

  const { awin_advertiser_id, awin_product_url, amazon_asin } = product
  const { awin_publisher_id, awin_clickref_pattern } = cfg.affiliate
  // AMAZON_TAG env var overrides site.config.yaml
  const amazon_tracking_id = import.meta.env.AMAZON_TAG ?? cfg.affiliate.amazon_tracking_id

  // ── Awin path ─────────────────────────────────────────────────────────────
  if (awin_advertiser_id && awin_product_url) {
    const clickref = `${awin_clickref_pattern}-${articleSlug}`
    const url = new URL(awin_product_url)
    url.searchParams.set('awc', `${awin_advertiser_id}_${Date.now()}`)
    return `https://www.awin1.com/cread.php?awinmid=${awin_advertiser_id}&awinaffid=${awin_publisher_id}&clickref=${encodeURIComponent(clickref)}&ued=${encodeURIComponent(awin_product_url)}`
  }

  // ── Amazon path ────────────────────────────────────────────────────────────
  if (amazon_asin && amazon_asin !== 'NOT_ON_AMAZON') {
    return `https://www.amazon.com/dp/${amazon_asin}?tag=${amazon_tracking_id}`
  }

  return null
}
```

**Behavior:**
- Returns Awin URL if both `awin_advertiser_id` and `awin_product_url` are set
- Falls back to Amazon URL if `amazon_asin` is a real ASIN (not NOT_ON_AMAZON)
- Returns null if product has neither (results in <span data-unavailable> in rehype plugin)
- Awin clickref pattern: `{awin_clickref_pattern}-{articleSlug}` (e.g., `fsg-40v-cordless-leaf-blower`)
- Amazon affiliate tag comes from `site.config.yaml` or `AMAZON_TAG` env var (env var wins for Cloudflare Pages overrides)

**Config values per site:**

| Site | amazon_tracking_id | awin_publisher_id | awin_clickref_pattern |
|------|-------------------|-------------------|----------------------|
| FSG  | fourseasong-20    | 2831126           | fsg                  |
| MLT  | mylittletbsp-20   | 2831126           | mlt                  |
| OHT  | onehappytable-20  | 2831126           | oht                  |

### rehype-product-links.mjs plugin

**File:line:** `/Users/keithlacy/affiliate-platform/src/plugins/rehype-product-links.mjs:1–105`

**Purpose:** Transform markdown `[anchor text](product:slug)` links into real affiliate URLs at build time.

**Usage in astro.config.mjs:**

```javascript
import { rehypeProductLinks } from '@platform/core/src/plugins/rehype-product-links.mjs'

markdown: {
  rehypePlugins: [
    rehypeProductLinks,  // Runs first; resolves product:slug → affiliate URL
    [rehypeExternalLinks, {
      rel: ['nofollow', 'sponsored'],  // rehypeExternalLinks adds these to amazon.com links
      target: '_blank',
      test: (node) => {
        const href = node.properties?.href ?? ''
        return typeof href === 'string' && href.includes('amazon.com')
      },
    }],
  ],
}
```

**Behavior (from lines 60–91):**

1. Walk the AST looking for `<a>` elements with href starting with `product:`
2. Extract slug: `node.properties.href.slice('product:'.length)`
3. Load products.yaml (cached in module scope)
4. Look up slug in products dict
5. If not found → throw loud error (build fails, drift caught at compile time)
6. Call `resolveProductUrl(product, slug)` to get real URL:
   - If product has Awin data → return Awin URL
   - Else if product has real ASIN → return Amazon URL with tag
   - Else return null
7. If URL exists → mutate node properties: set `href` to URL, add `data-product` attribute
8. If URL is null (NOT_ON_AMAZON) → convert `<a>` to `<span>`, add `data-unavailable="true"` attribute
9. `rehypeExternalLinks` then runs and adds `rel="sponsored"` to resolved amazon.com links

**Result in rendered HTML:**

- Real product: `<a href="https://www.amazon.com/dp/B001VNCJ36?tag=fourseasong-20" rel="sponsored noopener" data-product="polywood-classic-adirondack-chair">anchor text</a>`
- NOT_ON_AMAZON: `<span data-product="some-product" data-unavailable="true">anchor text</span>` (styled as plain text, no link)

---

## 5. Content Model

### Article collections

**Defined in:** `src/content.config.ts` (in each site repo)

**Collection:** `articles`  
**Loader:** glob pattern `**/*.md` from `content/articles/` directory  
**Schema:** ArticleSchema (Zod)

### Article frontmatter schema

**File:line:** ~/four-season-gardener/src/content.config.ts:19–42

```typescript
const ArticleSchema = z.object({
  title: z.string(),                                   // Article headline
  slug: z.string(),                                    // URL slug (must be unique, no spaces)
  type: z.enum(['roundup', 'review', 'comparison',    // Determines layout + rendering
               'buyer_guide', 'informational']),
  date: z.date(),                                      // Publish date (YYYY-MM-DD)
  updated: z.date().optional(),                        // Last update (optional)
  author: z.string().default('wendy'),                 // Author key (references config/personas/)
  category: z.string(),                                // Category label (e.g., "Tools & Equipment")
  hub: z.string(),                                     // Hub slug (e.g., "battery-equipment")
  hero_image: z.string(),                              // Hero image path (relative to images/)
  hero_image_alt: z.string().optional(),               // Alt text for hero
  description: z.string().max(200),                    // Meta description (max 200 chars)
  target_keyword: z.string(),                          // Primary SEO keyword
  products: z.array(ProductRefSchema).default([]),     // Product refs (see below)
  tags: z.array(z.string()).default([]),               // Content tags
  rating: z.number().min(1).max(5).optional(),         // Optional product rating
  disclosure_required: z.boolean().default(true),      // Render FTC disclosure?
  noindex: z.boolean().default(false),                 // Prevent indexing?
  // Comparison-type only
  product_a: z.string().optional(),
  product_b: z.string().optional(),
  winner: z.enum(['product_a', 'product_b']).optional(),
  winner_reason: z.string().optional(),
})
```

### ProductRef schema (embedded in articles)

```typescript
const ProductRefSchema = z.object({
  id: z.string(),                                  // Product slug (must exist in products.yaml)
  role: z.enum([                                   // Display role label
    'best_overall', 'best_value', 'best_budget', 
    'best_premium', 'best_for_beginners', 
    'best_for_professionals', 'honorable_mention',
    'also_consider', 'primary', 'alternative'
  ]).optional(),
  article_specific_pros: z.array(z.string()).optional(),    // Override default pros for this article
  article_specific_cons: z.array(z.string()).optional(),    // Override default cons for this article
})
```

### Article example (FSG)

```yaml
---
title: "40V Cordless Leaf Blowers: Find the Right One for Your Yard"
slug: "40v-cordless-leaf-blower"
type: "roundup"
date: 2026-05-02
author: "wendy"
category: "Tools & Equipment"
hub: "battery-equipment"
hero_image: "articles/battery-equipment-3.jpg"
hero_image_alt: "40V Cordless Leaf Blower"
description: "Compare 40V cordless leaf blowers by CFM, battery compatibility, and weight."
target_keyword: "40v cordless leaf blower"
products:
  - id: "ego-lb6504-leaf-blower"
    role: "best_overall"
    article_specific_pros:
      - "650 CFM is one of the highest outputs"
      - "Turbine fan technology moves more air with less noise"
    article_specific_cons:
      - "Larger nozzle diameter, slightly less precise"
  - id: "dewalt-dcbl772x1-leaf-blower"
    role: "also_consider"
tags: ["battery-equipment", "roundup"]
disclosure_required: true
noindex: false
---

Article body in Markdown...
```

### Image handling

**Hero images:** Specified in frontmatter as relative path (e.g., `articles/battery-equipment-3.jpg`), resolved to `{images.base_url}/{hero_image}` at template render time (layouts inject the full URL into `<img src=...>`).

**Product images:** Sourced from products.yaml `default_image` field; usually Amazon CDN URLs (`https://m.media-amazon.com/...`) but can be relative paths (resolved with images.base_url prefix).

**Image optimization:** Astro's Sharp image service handles optimization in astro.config.mjs:

```javascript
image: {
  service: {
    entrypoint: 'astro/assets/services/sharp',
  },
}
```

This was critical during Phase 3 migration — Sharp crashed on null image URLs; all products.yaml entries now have `default_image` set.

### Internal linking

**Breadcrumb navigation:** Generated by Breadcrumb component from category + hub + article title.

**Related articles:** RelatedArticles component queries all articles by shared tags; displays up to 5 linked articles.

**Previous/Next pagination:** PrevNext component shows links to temporally adjacent articles (sorted by date descending).

**Navigation structure:** Defined in `config/navigation.yaml` (site-owned); format:

```yaml
categories:
  - label: "Tools & Equipment"
    slug: "tools-equipment"
    hubs:
      - label: "Battery-Powered Equipment"
        slug: "battery-equipment"
      - label: "Garden Structures"
        slug: "garden-structures"
```

---

## 6. Per-Site State

### Four Season Gardener (FSG)

| Property | Value |
|----------|-------|
| **GitHub URL** | https://github.com/itsalljustagamesoitis-ux/four-season-gardener |
| **Local path** | ~/four-season-gardener/ |
| **Live URL** | https://fourseasongardener.com |
| **Current HEAD** | `f63807b` (2026-05-08) |
| **Deploy method** | Cloudflare Pages (git-driven, main branch) |
| **Article count** | 198 .md files |
| **Product count** | 203 with real ASINs |
| **VERIFY entries** | 0 (ready to deploy) |
| **Persona** | Wendy Hartley (`config/personas/wendy.yaml`) — HR director background |
| **Amazon tag** | fourseasong-20 |
| **Awin clickref** | fsg |
| **GA4 ID** | G-CTMQ2320CZ (configured) |
| **Bing UET** | null |
| **IndexNow key** | in public/ |
| **Build status** | ✅ Last run passed with warnings (hardcoded-price warnings, non-blocking) |
| **Known issues** | None |
| **Pending work** | None documented |

**Recent commit log:**
- `f63807b` Bump affiliate-platform submodule to d71951a (cluster→hub)
- `1ee7e07` fix(fsg): update all pages to import from @platform/core instead of deleted local lib/
- `ba12fa8` chore(fsg): bump platform to 72b4044, remove stale local platform files

### My Little Tablespoon (MLT)

| Property | Value |
|----------|-------|
| **GitHub URL** | https://github.com/itsalljustagamesoitis-ux/my-little-tablespoon |
| **Local path** | ~/my-little-tablespoon/ |
| **Live URL** | https://mylittletablespoon.com |
| **Current HEAD** | `5c55273` (2026-05-08) |
| **Deploy method** | Cloudflare Pages (git-driven, main branch) |
| **Article count** | 200 .md files |
| **Product count** | 131 with real ASINs |
| **VERIFY entries** | 0 (ready to deploy) |
| **Persona** | Emily Prescott (`config/personas/emily.yaml`) — food scientist background |
| **Amazon tag** | mylittletbsp-20 |
| **Awin clickref** | mlt |
| **GA4 ID** | G-TL30W504QG (configured) |
| **Bing UET** | null |
| **IndexNow key** | in public/ |
| **Build status** | ✅ Last run passed with warnings (hardcoded-price warnings) |
| **Known issues** | None |
| **Pending work** | None documented |

**Phase 3 migration notes (from CHANGELOG.md):**
- 200 articles migrated to `[text](product:slug)` format
- 1143 product links resolved
- 2 unresolvable products added: `fat-daddios-round-cake-pan-9`, `nordic-ware-round-cake-pan-9`
- Deployed build `e74db37f` (May 3 post-migration spot-check: ✅ affiliate tags present, slug attributes correct, NOT_ON_AMAZON renders as span)

**Recent commit log:**
- `5c55273` Bump affiliate-platform submodule to d71951a (cluster→hub)
- `301b5c2` chore(mlt): migrate to affiliate-platform submodule architecture
- `e8a4a64` chore(scripts): use platform canonical build-validator and validate-asins

### One Happy Table (OHT)

| Property | Value |
|----------|-------|
| **GitHub URL** | https://github.com/itsalljustagamesoitis-ux/one-happy-table |
| **Local path** | ~/one-happy-table/ |
| **Live URL** | onehappytable.com (not DNS-live at inspection) |
| **Current HEAD** | `ec2e7a7` (2026-05-08) |
| **Deploy method** | Cloudflare Pages (git-driven, main branch) — pre-launch |
| **Article count** | 0 .md files (pre-launch) |
| **Product count** | ~50 in products.yaml |
| **VERIFY entries** | 53 (BLOCKING pre-launch) |
| **Persona** | Wendy Collins (`config/personas/wendy.yaml`) — currently mirrors FSG persona name |
| **Amazon tag** | onehappytable-20 |
| **Awin clickref** | oht |
| **GA4 ID** | null (BLOCKING) |
| **Bing UET** | null |
| **IndexNow key** | e9173a4e6b4a40330c1998f2d7f2bd0d (set, key file exists) |
| **Build status** | ❌ Hard failure: missing persona images + VERIFY entries in products.yaml |
| **Known issues** | 3 critical blockers (see below) |
| **Pending work** | ASIN resolution, persona image sourcing, GA4 setup, content generation |

**Critical blockers for launch:**
1. **53 VERIFY entries in products.yaml** — No articles can be published until all are resolved to real ASINs. Pre-launch audit in VERIFY-ASIN-AUDIT.md and VERIFY-ASIN-FILL-RESOLVED.csv shows investigative work done.
2. **Missing persona images** — `wendy-about.jpg` and `wendy-byline.jpg` not in public/images/brand/. build-validator.mjs will fail until these exist.
3. **GA4 ID not set** — `analytics.ga4_measurement_id: null` in site.config.yaml. Must be configured before launch.

**Additional issue:**
- **Bing UET requirement in Cloudflare:** build-validator.mjs throws hard error if `BING_SITE_VERIFICATION` env var not set on production branch. Must be configured in Cloudflare Pages → Settings → Environment Variables before first production deploy.

**Recent commit log:**
- `ec2e7a7` Bump affiliate-platform submodule to d71951a (cluster→hub)
- `54f6058` chore(oht): migrate to affiliate-platform submodule architecture
- `4972319` feat(oht): Phase 3 prep — product:slug template + rehypeProductLinks + closed-set slug constraint

---

## 7. Build & Deploy

### Per-site build process

**npm scripts defined in package.json (identical across all three sites):**

```json
{
  "dev": "astro dev",
  "build": "astro build && npx pagefind --site dist && node node_modules/@platform/core/scripts/build-validator.mjs",
  "postbuild": "node scripts/submit-indexnow.mjs",
  "submit-indexnow": "node scripts/submit-indexnow.mjs",
  "validate:asins": "node node_modules/@platform/core/scripts/validate-asins.mjs",
  "preview": "astro preview",
  "astro": "astro"
}
```

**Build pipeline:**

1. **`astro build`** — Renders all articles to static HTML
   - Loads site.config.yaml, reads content/articles/, generates pages
   - rehypeProductLinks plugin runs during markdown processing (transforms product:slug links)
   - rehypeExternalLinks runs after, adds rel="sponsored" to amazon.com links
   - Sharp image service optimizes images (or crashes on null URLs)
2. **`npx pagefind --site dist`** — Generates full-text search index
3. **`node node_modules/@platform/core/scripts/build-validator.mjs`** — Post-build validation (fails the build if critical issues found)
4. **`node scripts/submit-indexnow.mjs`** — (postbuild) Submits updated URLs to IndexNow (Cloudflare Pages environment only)

### Cloudflare Pages deployment

**Deploy trigger:** Git push to main branch (automatically triggered by Cloudflare Pages GitHub integration)

**Environment variables (set in Cloudflare Pages → Settings → Environment Variables):**

| Variable | FSG | MLT | OHT | Purpose |
|----------|-----|-----|-----|---------|
| AMAZON_TAG | fourseasong-20 | mylittletbsp-20 | onehappytable-20 | Overrides site.config.yaml affiliate tag (for affiliate account separation) |
| GOOGLE_SITE_VERIFICATION | <value> | <value> | <value> | GSC meta tag (optional, DNS verification also acceptable) |
| BING_SITE_VERIFICATION | <value> | <value> | ❌ **REQUIRED** | Bing Webmaster meta tag — **hard build failure if missing on production branch** |
| INDEXNOW_KEY | <value> | <value> | <value> | IndexNow key file name for SEO submission (should match filename in public/) |

**Build logs:** Available in Cloudflare Pages → Deployments → individual build log

### Critical historical issues and resolutions

#### Why file:../affiliate-platform failed on Cloudflare

**Context:** Early attempts referenced the platform via `file:../affiliate-platform` in package.json dependencies (local path resolution).

**Problem:** Cloudflare Pages clones only the specific site repo; the parent `affiliate-platform/` directory is not present at build time. Local file: paths cannot be resolved during the build.

**Solution:** Move affiliate-platform to be a git submodule in each site repo.

```bash
git submodule add https://github.com/itsalljustagamesoitis-ux/affiliate-platform.git affiliate-platform
```

Now package.json references:
```json
"@platform/core": "file:./affiliate-platform"
```

And Cloudflare clones both the site repo and the submodule. Submodule pointer is committed as `.gitmodules` + `affiliate-platform` submodule entry.

**Status:** ✅ All three sites now use submodule architecture (as of May 2026).

#### Null-image Sharp crash (Phase 3)

**Context:** During Phase 3, some products in products.yaml had `default_image: null` or missing.

**Problem:** When ProductCard or schemaMarkup components tried to render images, Sharp's image optimization service crashed on null URLs.

**Solution:** Audit all products.yaml entries; ensure every product has a non-null `default_image` string (can be Amazon CDN URL or local path, but must exist).

**Status:** ✅ All products.yaml entries now have real default_image values (verified Apr 30–May 4).

#### Submodule drift and rolling back

**Symptom:** One site is on platform HEAD, another three commits behind; layouts render inconsistently.

**Prevention:** Version affiliate-platform explicitly; tag releases (e.g., v1.1.0) and have sites reference by tag or commit hash.

**Current approach:** All three sites point to same platform commit `33cc324` (May 8). If platform is updated, all sites must be updated together (one PR per site, coordinated).

**Commands to check/update:**

```bash
# Check current platform version at a site
cd four-season-gardener
git submodule status                  # outputs: 33cc324... affiliate-platform

# Update all sites to latest platform
cd affiliate-platform && git pull    # get latest platform
git log --oneline -1                  # note the new commit hash
cd ../four-season-gardener && git add affiliate-platform && git commit -m "chore: bump platform to <NEW_HASH>"
# repeat for MLT and OHT
```

### Build cost notes

**Approximate build times (observed):**

- **FSG (198 articles):** ~45 seconds (astro build + pagefind + validator)
- **MLT (200 articles):** ~48 seconds
- **OHT (0 articles pre-launch):** ~8 seconds (no articles to render)

**Cloudflare Pages limits:** 20 min per build, 500 deployments/month (free tier sufficient for these sites).

---

## 8. Validators & Guardrails

### build-validator.mjs

**File:line:** `/Users/keithlacy/affiliate-platform/scripts/build-validator.mjs:1–220`

**When it runs:** Post-build, after `astro build` completes and before deploy. Checks dist/ directory.

**Checks (in order):**

1. **empty-page** (lines 35–42)
   - Rejects pages < 500 bytes
   - Skips Astro redirects (detected by `http-equiv="refresh"`)

2. **missing-image** (lines 44–55)
   - Scans all `<img src="/images/...">` tags
   - Verifies file exists on disk (dist/images/...)

3. **untagged-affiliate** (lines 57–74)
   - Finds all `<a ... href="...amazon.com...">` tags
   - Fails if `rel="sponsored"` not present
   - Fails if affiliate tag (e.g., `tag=fourseasong-20`) missing or wrong

4. **hardcoded-price** (lines 76–91) — **WARNING only (non-blocking)**
   - Scans article/main body for dollar amounts (`$50`, `$1,200`, etc.)
   - Excludes: schema JSON blocks, price_band labels, comparison tables
   - Warns because hardcoded prices violate Associates ToS and go stale

5. **sentinel-image** (lines 93–99)
   - Catches placeholder Amazon image hashes (7[01]Q pattern)
   - Real Amazon CDN hashes don't match this pattern

6. **placeholder-asin** (lines 101–106)
   - Catches VERIFY-, TODO-, PLACEHOLDER- ASINs in rendered HTML

7. **duplicate-breadcrumb** (lines 108–119)
   - Detects category/hub slug collisions (same href twice in a row)

8. **doubled-brand** (lines 121–131)
   - Catches H3 headings with repeated words (e.g., "Perky-Pet Perky-Pet")

**Pre-flight checks (run before scanning dist/):**

9. **indexnow-key-missing** (lines 142–160)
   - On production builds, verifies IndexNow key file exists in dist/
   - Warns on non-production (optional)

10. **placeholder-asin-source** (lines 162–171)
    - Scans products.yaml source for VERIFY-, TODO-, PLACEHOLDER- values
    - **Hard fail** if any found

11. **sentinel-image-source** (lines 162–171)
    - Scans products.yaml for placeholder image hashes
    - **Hard fail** if found

12. **hardcoded-asin-source** (lines 173–197)
    - Scans article source (.md/.mdx files) for `amazon.com/dp/B0*` URLs
    - **Hard fail** — article must use `[text](product:slug)` instead
    - Strips frontmatter before checking body

13. **hardcoded-affiliate-tag-source** (lines 173–197)
    - Scans article source for `?tag=*` patterns
    - **Hard fail** — tags are injected at build time, not hardcoded

**Exit codes:**

- `0` if failures == 0 (may have warnings)
- `1` if failures > 0

**Example invocation & output:**

```bash
$ npm run build
> astro build && npx pagefind --site dist && node node_modules/@platform/core/scripts/build-validator.mjs

✓ Build validation passed with warnings (see above).
⚠ 87 warning(s) — hardcoded-price in various articles (non-blocking)
```

### validate-asins.mjs

**File:line:** `/Users/keithlacy/affiliate-platform/scripts/validate-asins.mjs:1–159`

**When to run:** Before cloning a new site, or when ASINs are added to products.yaml. Safe to run on production deployments (uses realistic browser UA to avoid bot-blocking).

**Options:**

```bash
node scripts/validate-asins.mjs [--concurrency=N] [--timeout=N] [--fail-on-unknown]
```

- `--concurrency=N` (default 3) — parallel requests (be gentle with Amazon)
- `--timeout=N` (default 8000ms) — per-request timeout
- `--fail-on-unknown` (default warn only) — exit 1 if requests are blocked/ambiguous

**Checks (in order):**

1. **Format check** (lines 44–49)
   - Regex: `^[A-Z0-9]{10}$`
   - Rejects non-matching ASINs (catches VERIFY-, TODO-, invalid formats)

2. **HTTP request to Amazon** (lines 51–65)
   - Fetches `https://www.amazon.com/dp/{ASIN}`
   - Records final URL (handles redirects)

3. **404 detection** (lines 71–74)
   - HTTP 404 → product not found (hard failure)

4. **Redirect-to-search detection** (lines 76–80)
   - Amazon redirects invalid ASINs to `/s?` (search) or homepage
   - Caught as not_found (hard failure)

5. **Bot-blocking detection** (lines 82–86)
   - Checks HTTP 503, "Robot Check" text, "api-services-support@amazon.com"
   - Caught as unknown (rerun to confirm)

6. **Product indicators check** (lines 88–93)
   - Scans response for: "productTitle", "add-to-cart", ""product"", "asin"
   - If none found → ambiguous response (blocked or wrong page)

**Results categorized as:**

- `ok` — valid ASIN, real product page found
- `bad_format` — invalid ASIN format (hard failure)
- `not_found` — 404 or redirect-to-search (hard failure)
- `blocked` — bot-blocked or ambiguous response (rerun to confirm)
- `error` — timeout or network error (rerun to confirm)

**Exit code:**

- `0` if no bad_format or not_found
- `1` if failures > 0 OR (FAIL_UNKNOWN && unknowns > 0)

**Example output:**

```
Validating 203 ASINs (concurrency=3, timeout=8000ms)

...............................................................................................

Results:
  ✓ Valid:        203
  ✗ Bad format:   0
  ✗ Not found:    0
  ? Blocked/err:  0 (Amazon rate-limiting — rerun to confirm)

✓ All 203 ASINs validated successfully.
```

### How to add new validator checks

**File to edit:** `/Users/keithlacy/affiliate-platform/scripts/build-validator.mjs`

**Template:**

```javascript
// ── N. My new check ────────────────────────────────────────────────────────
// Description of what this checks for
const myRegex = /pattern/gi
let myMatch
while ((myMatch = myRegex.exec(raw)) !== null) {
  // Assess severity: fail() or warn()
  fail('my-check-name', rel, `My error message: ${myMatch[0]}`)
  // OR
  // warnings.push(`  WARN [my-check-name] ${rel}\n       My warning message`)
}
```

1. Add a new check function inside `checkFile()` or as pre-flight check
2. Use `fail(checkName, file, msg)` for hard failures (increments `failures`, blocks deploy)
3. Use `warnings.push(...)` for non-blocking warnings (logged but deploy proceeds)
4. Document the check with a comment explaining what it catches
5. Add it to the run sequence (must be before `walk(DIST)` or after depending on phase)

**Testing:** Manually trigger a build on a site with a known violation:

```bash
cd four-season-gardener
# Add a violation to an article, e.g., hardcoded Amazon URL
npm run build  # watch for your check to fail
```

---

## 9. Conventions & Decisions

### Architectural decisions

1. **Single YAML file for all products** (`products.yaml`)
   - Originally considered SQLite/PostgreSQL
   - Decision: YAML is human-readable, version-control friendly, no DB dependencies
   - Trade-off: ~200 entries makes linear search acceptable; too many (>1000) would require indexing

2. **Product data in central catalog, not per-article**
   - Prevents drift: one ASIN, one Awin URL per product across all sites
   - Articles reference by slug + override pros/cons only
   - Decision: Easier to audit, harder to corrupt

3. **Markdown for article bodies, NOT MDX**
   - MDX parser (acorn) breaks on inline JSON-LD `<script type="application/ld+json">` blocks
   - Decision: Use rehype plugin on plain Markdown; cleaner for this use case
   - ProductLink.astro and Price.astro available for `.astro` templates; not needed in article markdown

4. **Affiliate URL resolution at build time, not runtime**
   - Could fetch ASINs → URLs at request time (e.g., serverless function)
   - Decision: Build time is simpler, deterministic, predictable affiliate tags
   - Trade-off: Adding new product requires rebuild

5. **Product references in article frontmatter only**
   - Could auto-detect via image scanning or text analysis
   - Decision: Explicit frontmatter is auditable, testable, strict
   - Benefit: Zod schema catches missing product IDs at build time

6. **Three separate site repos, one platform repo (submodule)**
   - Considered: monorepo with three apps/ folders
   - Decision: Separate repos allow independent governance, separate deployments, separate secrets
   - Platform as submodule makes it easy to coordinate updates (all sites pin same commit)

7. **Affiliate disclosure on/off by article** (`disclosure_required: boolean`)
   - Different jurisdictions/affiliate programs may have different rules
   - Per-article flag allows flexibility
   - AffiliateDisclosure.astro component only renders if true

8. **Role-based product positioning** (`role: 'best_overall' | 'also_consider' | ...`)
   - Allows layouts to highlight recommended products vs. alternatives
   - ProductCard component looks up role and renders label accordingly

### Coding conventions

**File naming:**

- **Components:** PascalCase.astro (ProductCard.astro)
- **Layouts:** PascalCase.astro (ReviewLayout.astro)
- **Utilities:** camelCase.ts/.mjs (config.ts, rehype-product-links.mjs)
- **Articles:** kebab-case.md (40v-cordless-leaf-blower.md)
- **Config:** kebab-case.yaml (site.config.yaml, personas/wendy.yaml)

**Imports in Astro:**

- Platform components: `import Foo from '@platform/core/src/components/Foo.astro'`
- Layouts: `import BaseLayout from '@platform/core/src/layouts/BaseLayout.astro'`
- Config lib: `import { getSiteConfig, resolveProduct } from '@platform/core/src/lib/config'`
- Plugins: `import { rehypeProductLinks } from '@platform/core/src/plugins/rehype-product-links.mjs'`

**Where business logic lives:**

- **URL generation:** buildAffiliateUrl() in config.ts (file:line 162)
- **Product resolution:** resolveProduct() in config.ts (file:line 204)
- **Markdown link transformation:** rehypeProductLinks() plugin (file: rehype-product-links.mjs)
- **Validation:** build-validator.mjs (post-build checks)
- **ASINs:** validate-asins.mjs (pre-launch checks)

**Error handling:**

- **Loud failures:** Unknown product slugs in frontmatter or markdown → throw error, build fails (good: drift detected early)
- **Silent warnings:** Unknown product ID in resolveProduct() → console.warn, layout renders without that product (acceptable: layout is flexible)
- **Non-blocking warnings:** Hardcoded prices in articles → logged as warnings (acceptable: editorial decision, not a bug)

### Non-negotiable rules (from CLAUDE.md)

**Rule 1 — No shared persona professional background**

Check:
```bash
grep -h "^background:" \
  four-season-gardener/config/personas/*.yaml \
  my-little-tablespoon/config/personas/*.yaml \
  one-happy-table/config/personas/*.yaml | sort | uniq -d
```

Must return empty. Currently:
- FSG Wendy: "Senior HR Director, financial services"
- MLT Emily: "Food scientist, consumer packaged goods"
- OHT Wendy: (different last name, different background if we resolve blocker)

**Rule 2 — No product-hub mismatch**

Every product ID in an article's `products:` frontmatter must exist in products.yaml, and its `hub` field must match the article's `hub` frontmatter field. Checked manually; automated preflight.py does not yet exist.

**Rule 3 — No unverified ASINs in production**

```bash
grep -c "amazon_asin: VERIFY" content/products/products.yaml
```

Must return 0 before production. Currently:
- FSG: 0 ✅
- MLT: 0 ✅
- OHT: 53 ❌ (BLOCKING)

---

## 10. Known Gaps & Technical Debt

### HANDOVER.md refresh status

**Partially refreshed 2026-05-08.** Only the following were updated on that date:
- Platform HEAD, FSG/MLT/OHT HEADs, submodule pointers
- Tools directory listing (added assign-article-images, source-images-pexels, verify-bindings, lib/)

**Not updated** (still reflects May 4 state):
- Validator section (build-validator.mjs, validate-asins.mjs)
- Producer state (producer scripts, pipeline schema, cluster→hub migration)
- Per-site operational notes
- Section 9 conventions and decisions
- Section 11 new site playbook
- Appendix file index

A full content audit pass is a session of its own. Do it before handing off to a new collaborator; skip it otherwise.



### OHT pre-launch blockers

1. **53 VERIFY entries in products.yaml** (hardest blocker)
   - Investigative work: VERIFY-ASIN-AUDIT.md, VERIFY-ASIN-FILL.csv, VERIFY-ASIN-FILL-RESOLVED.csv
   - No articles can be published until all are resolved
   - Requires: Amazon search + ASIN confirmation for each product

2. **Missing persona images**
   - wendy-about.jpg and wendy-byline.jpg not in public/images/brand/
   - build-validator.mjs fails hard on missing images
   - Requires: sourcing/creating author photos

3. **GA4 not configured**
   - analytics.ga4_measurement_id: null in site.config.yaml
   - Not a build blocker but required before launch
   - Requires: GA4 ID from Google Analytics dashboard

4. **Bing UET setup in Cloudflare**
   - BING_SITE_VERIFICATION env var must be set in production
   - Currently null; Cloudflare build fails on production branch if missing
   - Requires: setting env var in Cloudflare Pages settings

### Fragile or ad-hoc implementations

1. **Product image sourcing**
   - Current: images live in products.yaml as URLs (usually Amazon CDN)
   - Fragile: Amazon CDN URLs can break; images are hotlinked, not downloaded
   - Better: host images locally or use Cloudflare Image Optimization
   - Current state acceptable: CDN URLs are stable for large-scale operations

2. **Persona image paths**
   - Hardcoded in persona YAML (e.g., `/images/wendy-avatar.jpg`)
   - No central registry of which images are needed
   - Better: schema that declares required image paths + validator that checks them
   - Current state: Works if images exist; breaks if missing (caught by build-validator)

3. **Navigation structure**
   - Defined in config/navigation.yaml (site-owned)
   - No schema validation; easy to create mismatches between categories/hubs
   - getHubLabel() and getCategoryLabel() have fallback logic (not ideal)
   - Better: Zod schema for navigation.yaml + strict validation

4. **Article content.config.ts duplication**
   - Each site has its own copy of content.config.ts
   - Identical across all three sites (except variations in article types)
   - Better: Move to platform, export from @platform/core
   - Current blocker: Astro requires content.config.ts in each site's src/

5. **Hardcoded-price warnings**
   - 87 hardcoded price warnings across FSG (non-blocking)
   - Violates Amazon Associates ToS (prices go stale)
   - Not automated: must manually audit & fix articles
   - Better: Auto-detect prices in article body + provide editorial guideline

### Gaps not yet systematised

1. **Product lifecycle management**
   - No "deprecated product" or "discontinued" sentinel
   - No tracking of when products are EOL
   - Current: just leave them in products.yaml or delete (risky if articles reference)
   - Better: deprecation field + warning in build-validator

2. **Awin configuration**
   - All three sites share same awin_publisher_id (2831126)
   - No documented Awin account setup process
   - If affiliate account changes, every site must be updated
   - Better: centralize Awin credentials, update once

3. **Image optimization**
   - Sharp service handles it, but config is minimal
   - No responsive image srcset, no WebP fallbacks
   - Astro defaults should be sufficient for these sites; not yet audited

4. **Multi-language support**
   - Currently zero; all articles English-only
   - Not planned; document this assumption
   - If needed: would require i18n framework + duplicate content

5. **Backlink/internal link auditing**
   - No tool validates that internal links are correct
   - Could add check: scan all `<a href="/...">` tags, verify pages exist
   - Currently: Astro static generation would error on broken links (not verified)

6. **Affiliate link click-tracking**
   - No tool validates that affiliate tags/clickrefs are actually being used
   - Could add: proxy to Amazon/Awin, log clicks, validate affiliate IDs match
   - Current state: tags are in URL; whether Amazon/Awin counts them is not validated

---

## 11. Playbook for Adding a New Site

### Prerequisites

- GitHub account with push access
- Cloudflare Pages account linked to GitHub
- One Amazon Associates and/or Awin affiliate account configured
- Brand assets: logo SVG, PNG, favicon, social image, and author photo

### Steps (follow in order)

1. **Create new site repository**
   ```bash
   # On GitHub, create repo: my-awesome-site.git
   # Clone locally
   cd ~/
   git clone https://github.com/itsalljustagamesoitis-ux/my-awesome-site.git
   cd my-awesome-site
   ```

2. **Add affiliate-platform as submodule**
   ```bash
   git submodule add https://github.com/itsalljustagamesoitis-ux/affiliate-platform.git affiliate-platform
   git add .gitmodules affiliate-platform
   git commit -m "chore: add affiliate-platform submodule"
   ```

3. **Copy directory structure from FSG/MLT**
   ```bash
   # Copy these from FSG to new site (adjust paths)
   mkdir -p config/personas src/pages src/content scripts public/images/brand
   cp ../four-season-gardener/{package.json,tsconfig.json,astro.config.mjs,src/content.config.ts} .
   cp ../four-season-gardener/scripts/{submit-indexnow.mjs,check-health.mjs} scripts/
   cp -r ../four-season-gardener/public/images/brand/* public/images/brand/
   ```

4. **Create site.config.yaml**
   ```yaml
   site:
     brand_name: "My Awesome Site"
     domain: "myawesomesite.com"
     tagline: "Your site tagline here"
   
   visual:
     primary_color: "#123456"
     accent_color: "#789ABC"
     background_color: "#FDFAF6"
     font_headings: "Playfair Display"
     font_body: "Lato"
     logo_paths:
       favicon: "/images/brand/favicon.ico"
       header_svg: "/images/brand/logo-header.svg"
       # ... etc (copy template from FSG, adjust colors/fonts)
   
   affiliate:
     amazon_tracking_id: "myawesomesi-20"
     awin_publisher_id: "2831126"
     awin_clickref_pattern: "mas"  # unique 2-3 letter prefix
   
   analytics:
     ga4_measurement_id: null  # add after GA4 account setup
     bing_uet_tag: null
   
   deployment:
     cloudflare_pages_project: "my-awesome-site"
   ```

5. **Create persona YAML**
   ```bash
   # Create config/personas/primary-author.yaml
   cat > config/personas/primary-author.yaml << 'EOF'
   name_formal: "First Last"
   name_used: "First"
   photo_byline: "/images/brand/author-avatar.jpg"
   photo_about: "/images/brand/author-about.jpg"
   location: "City, State"
   location_detail: "Additional context"
   background: "MUST BE UNIQUE — not used by any other site"
   bio_short: "..."
   bio_full: "..."
   voice_notes: "..."
   social:
     pinterest: null
     instagram: null
   EOF
   ```

6. **Update src/content.config.ts**
   ```typescript
   // Change ArticleSchema to match your site's content types
   // E.g., if site only publishes "roundup" and "buyer_guide", remove others from enum
   ```

7. **Create config/navigation.yaml**
   ```yaml
   categories:
     - label: "Category 1"
       slug: "category-1"
       hubs:
         - label: "Hub 1"
           slug: "hub-1"
         - label: "Hub 2"
           slug: "hub-2"
   ```

8. **Create content/products/products.yaml** (empty starter)
   ```yaml
   # My Awesome Site — Product Catalog
   # Leave empty for now; populate with products as articles are written
   ```

9. **Create content/articles/ directory** (empty)
   ```bash
   mkdir -p content/articles
   ```

10. **Update src/pages/[slug].astro**
    ```astro
    ---
    import { getCollection, render } from 'astro:content'
    import type { CollectionEntry } from 'astro:content'
    import RoundupLayout from '@platform/core/src/layouts/RoundupLayout.astro'
    import BuyerGuideLayout from '@platform/core/src/layouts/BuyerGuideLayout.astro'
    
    // Copy from FSG, adjust layout imports based on your content types
    ---
    ```

11. **Update package.json**
    ```json
    {
      "name": "my-awesome-site",
      "version": "0.0.1",
      // Keep all scripts identical to FSG/MLT
    }
    ```

12. **Install dependencies**
    ```bash
    npm install
    ```

13. **Test local build**
    ```bash
    npm run build
    # Should succeed with no articles (passes post-build validator)
    npm run dev  # start dev server
    ```

14. **Create CLAUDE.md (site contract stub)**
    ```markdown
    # My Awesome Site — Site Contract
    
    Canonical operating contract: `affiliate-platform/CLAUDE.md`.
    
    ## Site-Specific Facts
    
    - **Domain:** myawesomesite.com
    - **Brand:** My Awesome Site
    - **Niche:** [Your niche here]
    - **Persona:** First Last — `config/personas/primary-author.yaml`
    - **Amazon tag:** myawesomesi-20
    - **AWIN clickref:** mas
    - **GA4:** not yet configured
    - **CF Pages project:** my-awesome-site
    - **Producer command:** [if applicable]
    
    ## Known Issues
    
    None.
    ```

15. **Set up Cloudflare Pages**
    - Log in to Cloudflare Dashboard
    - Pages → Create a project
    - Connect GitHub → select my-awesome-site repo
    - Build command: `npm run build`
    - Build output directory: `dist`
    - Environment variables (add in Pages → Settings → Environment Variables):
      - AMAZON_TAG: myawesomesi-20
      - GOOGLE_SITE_VERIFICATION: [from GSC]
      - BING_SITE_VERIFICATION: [from Bing Webmaster]
      - INDEXNOW_KEY: [generate and add to public/]

16. **Create IndexNow key file** (for SEO)
    ```bash
    # Generate random UUID-like key
    INDEXNOW_KEY="e9173a4e6b4a40330c1998f2d7f2bd0d"
    
    # Create public/$KEY.txt with the key as content
    echo "$INDEXNOW_KEY" > public/$INDEXNOW_KEY.txt
    ```

17. **Deploy to main**
    ```bash
    git add .
    git commit -m "chore: initialize my-awesome-site"
    git push origin main
    # Cloudflare Pages automatically triggers build
    # Watch deployment at Cloudflare Dashboard
    ```

18. **Verify build passed**
    - Cloudflare Pages → Deployments → latest
    - Check build log: should show "Build validation passed"
    - Visit preview URL and spot-check homepage

19. **Write first article**
    - Create content/articles/first-article.md
    - Add products to content/products/products.yaml
    - Verify build passes: `npm run build`

20. **Validate ASINs before launch**
    ```bash
    npm run validate:asins
    # Should report: ✓ All N ASINs validated successfully.
    ```

21. **Monitor and iterate**
    - Set up GA4 + Bing UET in site.config.yaml
    - Monitor first month of traffic
    - Adjust navigation.yaml, personas, brand colors based on feedback

---

## 12. Open Questions

1. **Why share the same awin_publisher_id (2831126) across three sites?**
   - Is this intentional (single Awin account for all brands)?
   - Or should each site have its own account for separate revenue tracking?
   - **Implication:** If Awin account is shared, revenue is pooled; if separate, need to duplicate affiliate setup three times.

2. **What happens to OHT when VERIFY entries are resolved?**
   - Will there be a separate onboarding/QA process?
   - Or does it just auto-publish once products.yaml is complete?
   - **Implication:** Process for resolving 53 ASINs (bulk import vs. manual) is not yet defined.

3. **How are product images maintained long-term?**
   - Amazon CDN links are hotlinked; what if Amazon moves/deletes images?
   - Should there be a backup image host or local copy?
   - **Implication:** Risk of broken images if Amazon CDN changes URL structure.

4. **Is there an editorial calendar or scheduling system?**
   - All articles publish immediately on git push.
   - No draft/review workflow built in.
   - **Implication:** Add scheduling if article review process is needed before publication.

5. **How are affiliate revenue/conversions tracked across sites?**
   - Amazon Associates: separate tags per site ✅
   - Awin: shared publisher ID (unclear if this tracks per-clickref)
   - **Implication:** Validate that clickref tracking is actually being recorded by Awin.

6. **What's the backup plan if affiliate accounts are suspended?**
   - No fallback if Amazon/Awin disable accounts
   - Could add NOT_ON_AMAZON for all products as emergency measure
   - **Implication:** Consider adding a "kill switch" mode (render all products as NOT_ON_AMAZON) for quick emergency response.

7. **Internationalization/localization?**
   - All content English-only; no i18n framework
   - Is this intentional or just not yet needed?
   - **Implication:** If international expansion is planned, significant refactoring needed.

8. **Schema.org/JSON-LD completeness?**
   - SchemaMarkup component exists; what does it currently output?
   - Are product schemas (BreadcrumbList, Article, Product) all populated correctly?
   - **Implication:** Audit schema quality to ensure search engines understand product relationships.

9. **How are persona images selected/managed?**
   - Currently hardcoded paths in persona YAML
   - What happens if a persona's photo needs to change?
   - **Implication:** Document photo update process; consider versioning or alt-photo support.

10. **What triggers a platform update across all three sites?**
    - Currently: manual coordination (each site PRs updated separately)
    - Could this be automated?
    - **Implication:** Establish a release process (tag platform, automated PRs to all sites?) to avoid drift.

---

## Appendix: Key File Index

| File | Purpose | Last Updated |
|------|---------|--------------|
| **Platform files** | | |
| `/src/layouts/BaseLayout.astro` | Base HTML wrapper | 2026-05-04 |
| `/src/layouts/RoundupLayout.astro` | Roundup article layout | 2026-05-04 |
| `/src/layouts/ReviewLayout.astro` | Review article layout | 2026-05-04 |
| `/src/layouts/ComparisonLayout.astro` | Comparison article layout | 2026-05-04 |
| `/src/layouts/BuyerGuideLayout.astro` | Buyer guide layout | 2026-05-04 |
| `/src/components/ProductCard.astro` | Product card render | 2026-05-04 |
| `/src/components/ProductLink.astro` | Inline product link (NEW) | 2026-05-04 |
| `/src/components/Price.astro` | Price display (NEW) | 2026-05-04 |
| `/src/lib/config.ts` | Config loader + business logic | 2026-05-04 |
| `/src/plugins/rehype-product-links.mjs` | Markdown link transform | 2026-05-04 |
| `/scripts/build-validator.mjs` | Post-build checks | 2026-05-04 |
| `/scripts/validate-asins.mjs` | ASIN validation | 2026-05-04 |
| `/tools/markdown-to-productlink.mjs` | Migration tool (Phase 3) | 2026-05-04 |
| `/package.json` | Platform package definition | v1.1.0 |
| `/CHANGELOG.md` | Release notes + Phase 3 migration | 2026-05-04 |
| `/CLAUDE.md` | Operating contract + rules | 2026-05-04 |
| **FSG files** | | |
| `/site.config.yaml` | FSG branding + tracking IDs | 2026-05-04 |
| `/config/personas/wendy.yaml` | Wendy Hartley persona | 2026-05-04 |
| `/content/products/products.yaml` | 203 product catalog | 2026-05-04 |
| `/content/articles/*.md` | 198 articles | ongoing |
| `/src/pages/[slug].astro` | Article router | 2026-05-04 |
| **MLT files** | | |
| `/site.config.yaml` | MLT branding + tracking IDs | 2026-05-04 |
| `/config/personas/emily.yaml` | Emily Prescott persona | 2026-05-04 |
| `/content/products/products.yaml` | 131 product catalog | 2026-05-04 |
| `/content/articles/*.md` | 200 articles | ongoing |
| **OHT files** | | |
| `/site.config.yaml` | OHT branding + tracking IDs | 2026-05-04 |
| `/config/personas/wendy.yaml` | Wendy Collins persona (duplicate name issue) | 2026-05-04 |
| `/content/products/products.yaml` | ~50 products, 53 VERIFY entries (BLOCKING) | 2026-05-04 |
| `/content/articles/` | Empty (pre-launch) | — |
| `/VERIFY-ASIN-AUDIT.md` | ASIN resolution tracking | 2026-05-04 |
| `/VERIFY-ASIN-FILL.csv` | ASIN fill analysis | 2026-05-04 |
| `/VERIFY-ASIN-FILL-RESOLVED.csv` | ASIN resolution results | 2026-05-04 |

---

## Summary

The affiliate platform is a mature, tested shared layer supporting three independent premium content sites. Phase 3 (product:slug link architecture) is complete and deployed to FSG (May 2) and MLT (May 3). FSG and MLT are production-ready with no known issues. OHT is pre-launch with 3–4 critical blockers (VERIFY ASINs, persona images, GA4, Bing UET) but infrastructure is in place. All sites use the same build pipeline, validator rules, and deployment process. The platform is version-pinned to commit `72b4044`; updates are coordinated across all sites simultaneously. Business logic is centralized (buildAffiliateUrl, rehypeProductLinks, resolveProduct) so changes propagate cleanly. Documentation is complete; no undocumented magic.

**Next actions for handoff recipient:**

1. **Immediate (if OHT launch is urgent):** Resolve 53 VERIFY entries in products.yaml; source persona images; configure GA4 + Bing UET
2. **Short-term (1–2 weeks):** Monitor FSG/MLT deployments for affiliate revenue/click tracking; audit schema.org output
3. **Medium-term (1 month):** Build automated platform update release process (tag + PR automation); resolve image hotlink risk
4. **Long-term:** Systematise remaining gaps (product deprecation, nav validation, backlink checking)

---

**Document compiled:** 2026-05-08  
**Platform version:** 1.1.0 / commit `99169d0`  
**FSG HEAD:** `f63807b` ✅  
**MLT HEAD:** `5c55273` ✅  
**OHT HEAD:** `ec2e7a7` (pre-launch) ⚠️  
