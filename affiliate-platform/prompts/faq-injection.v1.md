# FAQ Injection Prompt — v1

**Version:** 1.0
**Type:** operational (Claude Code session task — not an article generation prompt)
**Scope:** FSG (`four-season-gardener/`) — adapt persona section for MLT/OHT
**Status:** Active

---

## Task Overview

For each article in the target list below, read the full article markdown, draft 4–5 FAQ Q&A pairs that faithfully reflect what the article actually says, then write them into the article's frontmatter as a `faq:` array. Do not invent claims the article doesn't support. Do not copy product names or facts from products.yaml without confirming the article references them.

This drives two outputs automatically at build time:
- FAQPage JSON-LD schema (via `SchemaMarkup.astro`)
- Rendered accordion FAQ section above the author bio (via `FAQ.astro`)

---

## Process — One Article at a Time

For each slug in the target list:

1. `Read content/articles/{slug}.md` — read the full file, frontmatter and body
2. Identify: what is the primary question the article answers? What decisions does it help the reader make? What objections or concerns does the body address?
3. Draft 4–5 Q&A pairs using the rules below
4. Open the file with `Edit` and insert the `faq:` block into frontmatter, immediately before the closing `---`
5. Move to the next slug

Do not batch or generate Q&As without reading each article first. Content-to-schema alignment is the entire point.

---

## Q&A Rules

### Quantity
Exactly 4–5 pairs per article. No more. Google's FAQ rich results cap their display at 2–3 expanded items; beyond 5 pairs adds schema weight with diminishing return.

### Question format
- Write as a real person would type it into Google
- Natural phrasing: "Is the X worth the money?", "How long does X last?", "What's the difference between X and Y?"
- No "In today's world" / "As a gardener" / "That being said" phrasing
- Lead with the subject, not a clause: "Does the Birdies raised bed rust?" not "For those considering Birdies, does it rust?"
- Questions must be genuinely answerable from the article — do not ask questions the body dodges

### Answer format
- 2–5 sentences. Enough to be useful; not a paragraph.
- Plain text only — no markdown, no HTML tags. `acceptedAnswer.text` is rendered as-is by Google; HTML tags will appear literally.
- Honest and specific: "The cedar version is around $45 more than the pine equivalent but significantly outlasts it in wet climates" beats "it depends on your needs."
- If the article includes Wendy's personal view, carry it through: "In my experience, …"
- Do not state specific current prices unless the article already does (and even then, add "at time of writing" context)
- Do not make safety, medical, or legal claims beyond what the article explicitly says

### Coverage spread
Across the 4–5 pairs, aim to cover at least three of:
- **Decision question** — helps the reader decide whether to buy or which to choose
- **Durability/longevity** — how long does it last, what maintenance is needed
- **Comparison** — how does it compare to the main alternative
- **Use-case specificity** — is it suitable for X condition / garden size / climate
- **Value question** — is the premium model worth the extra cost

Do not write five variations of the same question type.

---

## Persona — Wendy Hartley (FSG)

Wendy is a former Senior HR Director in financial services. She came to serious gardening in her late forties after her kids left home. She is methodical, skeptical of marketing claims, and allergic to gear-snobbery. She does not fake enthusiasm; if something has a meaningful flaw she says so. She writes in plain British-inflected English (she grew up in the north of England but has lived in the US for twenty years, so spelling is Americanised). She is knowledgeable but never condescending.

In FAQ answers, Wendy's voice is:
- Direct, with no hedging filler ("The short answer is yes, but with a caveat" — not "It really depends on many factors")
- Personal where the article already is: "I've had mine outside through two winters with no issues" carries more weight than "many users report"
- Practical: she closes answers with an actionable implication, not an open question

---

## Frontmatter Target Format

Insert this block into the article's frontmatter, immediately before the closing `---`:

```yaml
faq:
  - question: "Question text here — plain English, no markdown"
    answer: "Answer text here — plain text only, no HTML or markdown. 2–5 sentences. Honest and specific."
  - question: "..."
    answer: "..."
```

The `faq:` key must be at the top-level frontmatter indentation level (same as `title:`, `slug:`, etc.).

---

## Validation Before Moving On

After editing each file, confirm:
- `faq:` block is valid YAML (proper indentation, no unescaped colons or quotes that would break parsing)
- Every answer references something the article body actually states — not inferred, not sourced from products.yaml alone
- No HTML tags inside answer strings
- 4 or 5 pairs — not 3, not 6

If a YAML parse error is likely (e.g. the answer contains a colon or single quote), wrap the string in double quotes and escape internal double quotes with `\"`.

---

## Priority Target List — FSG

Work in this order. These are ranked by traffic and commercial intent (highest-value pages first).

**Tier 1 — fix immediately (high traffic, high commercial intent):**
1. `best-fire-pit-tables`
2. `best-pergola-kits`
3. `best-gazebo-for-high-winds`
4. `screen-gazebo-for-deck`
5. `cedar-raised-bed-kit`
6. `birdies-metal-raised-garden-beds`
7. `vego-elevated-garden-bed`
8. `teak-outdoor-dining-set`
9. `hdpe-outdoor-dining-set`
10. `best-deer-repellent-devices`

**Tier 2 — high value, do after Tier 1:**
11. `ego-robot-mower`
12. `stihl-cordless-lawn-mower`
13. `dewalt-cordless-lawn-mower`
14. `best-solar-lights-for-the-garden`
15. `best-security-lights-outdoor`
16. `patio-heater-portable`
17. `bromic-patio-heater`
18. `outdoor-sofa-curved`
19. `cast-aluminum-outdoor-dining-set`
20. `composite-outdoor-dining-set`

**Tier 3 — complete the cluster:**
21. `cedar-greenhouse-kit`
22. `glass-greenhouse-kit`
23. `lean-to-greenhouse-kits`
24. `bird-feeder-for-window`
25. `squirrel-dome-for-bird-feeder`
26. `bird-feeder-baffles-for-squirrels`
27. `bird-bath-water-wiggler`
28. `solar-bird-bath-bubbler`
29. `teak-outdoor-rocking-chair`
30. `large-adirondack-chair`

---

## After All Articles Are Updated

Run `npm run build` from the site root. Confirm:
- No new FAIL lines introduced
- The hardcoded-price WARN count did not increase (FAQ answers must not introduce price claims that weren't already in the article body)
- No `faq-parse-error` or Zod validation errors in the build output

Then confirm one page's FAQPage schema validates in Google's Rich Results Test before reporting done.
