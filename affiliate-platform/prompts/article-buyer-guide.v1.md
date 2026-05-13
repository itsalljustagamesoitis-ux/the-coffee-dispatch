# Buyer Guide Article Prompt — v1

**Version:** 1.1  
**Type:** `buyer_guide`  
**Scope:** All sites consuming `@platform/core` (FSG, MLT, OHT)  
**Status:** Active  
**Derived from:** FSG corpus (deer-repellent-granules, bird-feeder-for-finches, outdoor-gazebo-curtains) + MLT corpus (all-clad-non-stick-sauce-pan, 5-inch-santoku-knife, all-clad-8-quart-stock-pot)

---

## 1. Output Contract

### Required frontmatter

```yaml
---
title: "{headline — must contain target keyword, 50–70 chars}"
slug: "{target-keyword-slug}"
type: "buyer_guide"
date: {YYYY-MM-DD}
author: "{persona_id}"                     # from {{BRIEF}} — e.g. wendy, emily
category: "{hub_category}"                 # from hub-map.json, matches hub below
hub: "{hub_slug}"                          # from hub-map.json
hero_image: "articles/{hub_slug}-{N}.jpg"  # hub-matched image from image bank
hero_image_alt: "{full article title}"
description: "{140–160 chars, target keyword front-loaded}"
target_keyword: "{exact keyword from brief}"
products:
  - id: "{product_id}"                     # must exist in products.yaml
    role: "{role_slug}"                    # see role vocabulary below
    article_specific_pros:
      - "{pro — product-specific, not generic}"
      - "{pro}"
    article_specific_cons:
      - "{con — product-specific, not generic}"
      - "{con}"
tags: ["{hub_slug}", "buyer_guide"]
disclosure_required: true
noindex: false
---
```

Every field above is required. No null values except `updated`. `disclosure_required` is always `true` for buyer guides — affiliate links are always present.

**Role vocabulary:** `best_overall`, `best_value`, `best_budget`, `best_premium`, `best_for_beginners`, `best_for_professionals`, `also_consider`. Exactly one product must carry `best_overall`. All remaining products use one of the other roles. Do not invent role slugs.

### Product count

```yaml
product_count:
  min: 3
  max: 5
```

If the brief specifies fewer than {{PRODUCT_COUNT.min}} products that match the article's hub, the producer halts and surfaces the shortfall. If the brief specifies more than {{PRODUCT_COUNT.max}}, the producer trims to {{PRODUCT_COUNT.max}} highest-fit (highest-rated, then most relevant by category match).

Buyer guide articles do not use tier grouping. All H3 product sections live directly under a single `## Top Picks` H2. The tier grouping exception available to roundups (8+ products) does not apply to this format.

### Amazon link format

```
https://www.amazon.com/dp/{ASIN}?tag={amazon_tracking_id}
```

The `amazon_tracking_id` comes from `{{BRIEF}}` — it differs per site and must not be hardcoded in the prompt or generated article. The correct tag for each site is:

- FSG: `fourseasong-20`
- MLT: `mylittletbsp-20`
- OHT: `onehappytable-20`

First mention of each product in the article body links to its Amazon URL. Subsequent mentions within the same section may link again where natural.

### Body component order

The layout renders components before and after the article body. This order is fixed:

```
[layout]  Hero image
[layout]  <QuickPicks /> — top 3 products with role label, image, first pro, price button
[body]    intro paragraphs + hub link
[body]    ## What to Look For in {category_noun}
[body]      ### Subsection × 3–5
[body]    ## Top Picks
[body]      ### Product Name × N (prose reviews)
[body]    ## {STYLE_POLICY.buying_guide_heading.style}
[body]      ### Subsection × 3–5
[body]    ## Frequently Asked Questions
[body]      ### Question × 5 (H3s)
[body]    <script type="application/ld+json"> FAQPage schema
[layout]  <h2>Detailed Reviews</h2>
[layout]  <ProductCard showRole /> × N — role badge, rank, image, pros, cons, price button
[layout]  AuthorBio, RelatedArticles, PrevNext
```

---

## 2. Component Injection Points

### What the layout provides — never duplicate in the article body

**`<QuickPicks />`** renders automatically above the article body. It shows the top 3 products with role label, product image, product name, first item from `article_specific_pros`, and a "Check Price" button. Do not write a "Top Picks at a Glance" section, a bullet summary of picks, or any prose equivalent in the article body.

**`<ProductCard showRole />`** renders automatically below the article body for every product in the `products:` list. Each card shows the role badge, rank number, product image, linked product name, full `article_specific_pros` list, full `article_specific_cons` list, and "Check Price on Amazon" button. Do not write `**Pros:**` or `**Cons:**` bullet lists anywhere in the article body. Do not write a role label (bold or otherwise) below any product H3 heading. The article body product sections are qualitative prose only.

There is no `<ComparisonTable />` in the buyer guide layout. Do not write a comparison table, grid, or matrix in the article body.

### What the article body provides

The article body is the voice and education layer. It provides:

- Introductory framing that establishes search intent and evaluation context
- A "What to Look For" section that teaches the buyer which criteria matter and why — before any product is named
- Qualitative framing and persona-grounded prose review per product
- Buying guide reasoning under `## {STYLE_POLICY.buying_guide_heading.style}` (decision factors specific to this product category)
- FAQ answers with accompanying schema

### "Check current price on Amazon." sentence

Each product H3 section in the article body ends with the sentence:

> Check current price on Amazon.

The product name in that sentence links to its Amazon URL. This is the only pricing signal in the article body. No dollar figures, price ranges, or pricing language of any kind appear anywhere else (see Section 4).

---

## 3. Voice Rules

### Person and tense

First person singular throughout. Active voice. Present tense for product characteristics ("the blade holds an edge well"). Past tense for personal use and testing experience ("I've owned one long enough to say that without hedging").

### Sentence length

Vary sentence length deliberately. Target 12–18 words for declarative statements. Short sentences (5–9 words) are for emphasis — use sparingly, maximum two in sequence. Never open three consecutive sentences at the same length. No sentence over 35 words.

### Paragraph length

2–4 sentences per paragraph. A single-sentence paragraph is permitted as a deliberate rhetorical beat, maximum once per product section, not at all in the buying guide. No paragraph over 5 sentences.

### Hedging

Minimize. Maximum one hedge per product section. Acceptable: "I'd argue," "in my experience," "for most buyers." Not acceptable: "I think," "I believe," "it seems," "arguably," "perhaps," "might," "could potentially."

### Directness

State the recommendation plainly and early. Do not bury who the product is for. If a product is the right answer for a specific buyer type, name that buyer and the reason in the first or second sentence. If it is not the right answer for most readers, say that clearly rather than softening the conclusion.

### Persona register

Persona-specific register is injected via `{{PERSONA_YAML}}` (see Section 7). The voice rules above apply universally. The persona YAML adds domain vocabulary, authority framing, and the persona's relationship to the product category. Do not apply a persona's register to content generated for another site.

---

## 4. Banned Patterns

### Price and dollar patterns

Governed by `STYLE_POLICY.dollar_figures.allowed` (injected via `{{STYLE_POLICY}}`).

**When `allowed: false` (hard ban):** No dollar figures anywhere in the article body — not in prose, not in bullet lists, not in headings, not in FAQ answers. Banned patterns:

- Any `$X` amount
- Any `$X–$Y` range
- "around $"
- "starting at"
- "typically around"
- "priced at"
- "costs about"
- "for under $"
- "at the $X price point"

The single permitted pricing signal is "Check current price on Amazon." as the final sentence of each product section (Section 2).

**When `allowed: true`:** Dollar figures are permitted in prose to anchor a recommendation (e.g., "At under $40, this is the most practical option for occasional bakers"). Use sparingly — one dollar reference per product section maximum. The "Check current price on Amazon." closing sentence still applies regardless.

### AI-tell phrases — hard ban

Absent from all corpus articles. Do not use:

- "in today's world"
- "when it comes to"
- "look no further"
- "let's dive in"
- "the perfect"
- "game-changer" / "game changer"
- "elevate your"
- "navigate the world of"
- "in this article" / "in this guide"
- "without further ado"

**Implementation note:** Banned-phrase enforcement applies to article prose only. Validator must exclude `<script type="application/ld+json">` blocks. FAQ answer text echoed verbatim in JSON-LD is the same string and would otherwise double-trigger this rule.

### Structural bans

These follow from Section 2 but are stated here for completeness:

- No `## Top Picks at a Glance` section or any prose bullet summary of picks
- No `**Pros:**` or `**Cons:**` bullet lists anywhere in the article body
- No comparison tables or grids in the article body
- No role label in H3 product headings — e.g., not `### Best Overall: Product Name`
- No bold role subtitle below product H3 headings — e.g., not `**Best for induction cooking**`
- No `**Price:**`, `**Best for:**`, or similar label-value codas at the end of product sections
- No `**Who buys this:**` coda at the end of product sections
- No hardcoded dollar amounts anywhere

---

## 5. Length Contract

### Total word count

`STYLE_POLICY.word_count.min`–`STYLE_POLICY.word_count.max` words (injected via `{{STYLE_POLICY}}`). Count the article body only — frontmatter and JSON-LD schema blocks are excluded. Below the minimum: the "What to Look For" section, product reviews, or buying guide sections are too thin. Above the maximum: sections are being padded. If the natural endpoint falls short, add one "What to Look For" or buying guide subsection rather than inflating product prose.

### Intro

2–3 paragraphs, 100–160 words total. Structure is fixed:

**Paragraph 1 (required):** Establishes search intent and product category. Names what the reader is trying to accomplish and why this category of product serves that goal. Contains a contextual link to the hub page using a **site-relative path** (e.g., `[dinnerware](/dinnerware/)`) — never an absolute URL — this link must appear in paragraph 1, not deferred to a later paragraph. One specific detail that signals the persona's domain knowledge without stating credentials.

**Paragraph 2 (required):** Frames the evaluation criteria — what separates a good choice from a poor one in this category, at the level of principle (not yet naming specific features or products). Sets up the "What to Look For" section without duplicating it.

**Paragraph 3 (optional):** Use only if paragraph 2 cannot contain the framing naturally in 3–4 sentences. A third paragraph must not introduce product names, pricing context, or buying guide content.

### "What to Look For in {category_noun}" section

3–5 H3 subsections. Each subsection 2–3 paragraphs. Total section: 400–600 words. Subsections cover the evaluation criteria specific to this product category — the factors a buyer must understand before they can choose confidently. This section is educational, not product-comparative. Do not name specific products from the roundup. **Hub link required:** In the final paragraph of the last H3 subsection in this section, include a sentence that links to the hub using a site-relative path and different anchor text from the intro — for example: "Exploring the full range of [dinnerware](/dinnerware/) options before committing to a style is worth the time." Adapt the anchor text to the hub; do not use the identical wording from the intro.

### Per-product sections (H3s under `## Top Picks`)

2–4 paragraphs of prose per product section. `best_overall` picks and products with complex trade-offs warrant 3–4 paragraphs. `also_consider` picks where the key differentiation from `best_overall` is already established warrant 2 paragraphs.

Do not open every product section with the product name in the first sentence — vary the entry point across sections.

### Buying guide (`## {STYLE_POLICY.buying_guide_heading.style}`)

3–5 H3 subsections. Each subsection 2–3 paragraphs. Total section: 500–700 words (hard floor: if your draft comes in under 500 words, add a sentence to the thinnest subsection — do not pad, add a genuinely useful point). Subsections cover the purchase-decision variables specific to this product category — the factors that determine which pick is right for a given buyer's situation. This section is decision-oriented where "What to Look For" was criteria-oriented; they are complementary, not redundant. At least one subsection must include a contextual link to the hub page using a site-relative path (different anchor text from the intro and "What to Look For" hub links). Generic advice that applies to any product category is not appropriate.

### FAQ (`## Frequently Asked Questions`)

5 questions. Each answer 2–3 sentences, 50–80 words. Total section: 300–450 words. See Section 6 for full FAQ contract.

---

## 6. FAQ Contract

### Count

Exactly 5 questions. No more, no fewer.

### Question selection

Each question is an H3. Questions must be full interrogative sentences. They must reflect real buyer questions for the target keyword — not generic questions applicable to any product category. Requirements:

- At least one question addresses a trade-off between two specific products named in the article
- At least one question addresses a decision the buyer faces before purchase (sizing, compatibility, maintenance, material, etc.)
- At least one question addresses a criterion covered in the "What to Look For" section — the FAQ answer must extend or complement that section, not repeat it verbatim
- Questions must not duplicate the buying guide subsections word-for-word

### Answer format

2–3 sentences of plain prose per answer, 50–80 words maximum. No bullet lists inside FAQ answers. Where natural, name a specific product from the article and link to its Amazon URL. Do not end FAQ answers with "Check current price on Amazon." — that closing sentence is reserved for product sections only.

### Schema block

Immediately following the last FAQ answer (no intervening content), include:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "{exact H3 question text}",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "{exact answer prose text}"
      }
    }
  ]
}
</script>
```

The `name` and `text` fields must exactly match the rendered question and answer text. No truncation, paraphrase, or summarization.

---

## 7. Persona Injection Point

### How persona hooks in

The persona is not hardcoded in this prompt. The generating script passes `{{PERSONA_YAML}}` — the full contents of `config/personas/{name}.yaml` — as a variable before generation. Fields used:

| Field | How it's used |
|-------|---------------|
| `name`, `name_formal`, `name_casual` | Byline only — do not use in article body prose |
| `background`, `career_note` | Informs domain vocabulary and authority framing |
| `voice_notes` | Governs register throughout — technically precise, evaluative-sceptical, warm, etc. |
| `region` | One grounded regional reference permitted if it anchors a practical claim |

The persona's `voice_notes` govern product review tone and the educational register of the "What to Look For" section. The `background` and `career_note` inform specific vocabulary — use professional domain language naturally, not as explicit credential-dropping.

### What must NOT be hardcoded

- Persona name anywhere in article body prose
- Persona background as an explicit credential declaration ("As a food scientist..." / "With fifteen years in HR...")
- More than one regional reference
- Any `bio_full` passage verbatim — voice, not biography

---

## 8. Brief Injection Point

The generating script passes `{{BRIEF}}` before generation. A valid buyer guide brief must contain:

```yaml
target_keyword: "{exact keyword phrase}"
hub: "{hub_slug from hub-map.json}"
category: "{category from hub-map.json}"
category_noun: "{product category noun for H2 — e.g. 'a garden hose', 'cast iron cookware'}"
search_intent: "commercial investigation"   # buyer guides are always commercial investigation
products:
  - id: "{product_id}"          # must exist in products.yaml
    asin: "{10-char ASIN}"      # must not be the placeholder value VERIFY
    name: "{product display name}"
    role: "{role_slug}"
competitor_angle: "{optional — what the top-ranking competitor article does well or poorly}"
persona_id: "{e.g. wendy, emily}"
amazon_tracking_id: "{site-specific tag — e.g. fourseasong-20}"
```

**`category_noun` is required.** It fills the `## What to Look For in {category_noun}` H2 heading. If absent, the generating script must halt before calling the model.

**If the brief contains an `h2_structure` field, ignore it.** The prompt defines article structure authoritatively. The brief's role is keyword + products + intent + angle + `category_noun` — not structure.

### Pre-generation checks

The generating script must run all four checks before passing the brief to the model. Halt and report on any failure — do not proceed with a partial brief.

1. **ASIN check:** All product `asin` values must be non-VERIFY. Any VERIFY ASIN → halt.
2. **Product existence check:** All product `id` values must exist in `content/products/products.yaml`. Any missing ID → halt.
3. **Hub match check (Rule 2):** Each product's `hub` field in products.yaml must match the brief `hub`. Any mismatch → halt.
4. **Cannibalization check:** The `target_keyword` must not already appear as a `target_keyword` frontmatter value in any file under `content/articles/`. Duplicate → halt.

---

## 9. Style Policy Injection Point

The generating script passes `{{STYLE_POLICY}}` before generation. This block is sourced from `style_policy` in `site.config.yaml` for the active site. A valid `{{STYLE_POLICY}}` must contain all five fields:

```yaml
word_count:
  min: {integer}
  max: {integer}
dollar_figures:
  allowed: {boolean}
buying_guide_heading:
  style: "{How to Choose | Buying Guide}"
```

If `{{STYLE_POLICY}}` is absent or malformed, the generating script must halt before calling the model with exit code 2. No silent defaults.

**How policy values are applied in the generated article:**

| Policy field | Where it applies |
|---|---|
| `word_count.min` / `word_count.max` | Section 5 length contract |
| `dollar_figures.allowed` | Section 4 dollar ban rule |
| `buying_guide_heading.style` | H2 heading for the buying guide section |

---

## 10. Style Guide Reference

Full voice and style rules — opening patterns, transition words, paragraph structure, sentence cadence, punctuation conventions — are defined in:

```
affiliate-platform/prompts/style-guide.v1.md
```

This file does not exist yet. Until it is written, apply the voice rules in Section 3 of this prompt. When the style guide is written, Section 3 of this prompt defers to it on any conflicting rule.

The style guide is not site-specific. Voice rules defined there apply across FSG, MLT, and OHT. Site-specific voice is handled entirely through the persona YAML (Section 7).
