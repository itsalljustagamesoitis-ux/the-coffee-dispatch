# VALIDATORS.md

Validator rule classification reference for the affiliate platform.

This document classifies every validator rule as Hard fail, Soft fail, or Manual review. PIPELINE.md Section 7 defines the framework; this document applies it.

---

## Table of contents

1. Framework summary
2. Rule classification — Frontmatter (F)
3. Rule classification — Body structure (B)
4. Rule classification — FAQ (Q)
5. Rule classification — Anti-patterns (A)
6. Rule classification — Length (L)
7. Rule classification — Manual/meta (M)
8. Implementation notes
9. Maintenance

---

## 1. Framework summary

**Hard fail** — failing breaks site functionality, violates legal/compliance, produces visibly broken content, embarrasses the brand under scrutiny, or breaks the editorial contract with the reader. Articles must regenerate or be hand-edited.

**Soft fail** — failing produces editorially-fine content, the miss is arithmetic within 10% of target (exclusive), a reader wouldn't notice the difference between passing and failing. Articles ship with logged warning.

**Manual** — rule requires human judgment to evaluate. Surfaced in validator report but doesn't auto-block.

The 10% boundary applies to numeric range rules. For "exactly N" count rules, soft fail boundary is ±1.

Soft fails are still surfaced in logs at `~/affiliate-platform/calibration-log.yaml` for periodic editorial review. Patterns of soft fails on a single rule indicate platform calibration may need adjustment.

---

## 2. Rule classification — Frontmatter (F)

| Rule | Description | Class | Reasoning |
|---|---|---|---|
| F01 | Required frontmatter fields present | Hard | Build breaks without them |
| F02 | type = "buyer_guide" | Hard | Wrong type = wrong template |
| F03 | Title 45–70 chars | Soft | Arithmetic boundary |
| F04 | Description 135–165 chars | Soft | Arithmetic boundary |
| F05 | disclosure_required = true | Hard | Legal/FTC compliance |
| F06 | noindex = false | Hard | Page won't be indexed |
| F07 | Tags include hub slug and "buyer_guide" | Hard | Navigation/routing breaks |
| F08 | Products count 3–5 | Hard | Structural format requirement |
| F09 | Each product has id, role, pros[], cons[] | Hard | Product cards render broken |
| F10 | Exactly one best_overall | Hard | Editorial contract + template logic |
| F11 | All roles in valid vocabulary | Hard | Templating breaks on invalid roles |

---

## 3. Rule classification — Body structure (B)

| Rule | Description | Class | Reasoning |
|---|---|---|---|
| B01 | Intro content before first H2 | Hard | Article visibly broken without intro |
| B02 | Intro contains hub link | Hard | Internal linking is editorial contract |
| B03 | Intro has 2–3 paragraph blocks | Soft | Arithmetic, reader doesn't notice |
| B04 | Intro word count 85–165 | Soft | Arithmetic boundary |
| B05 | Section order: WTLF → Top Picks → How to Choose → FAQ | Hard | Structural information flow |
| B06 | Exactly one ## Top Picks | Hard | Structural |
| B07 | Exactly one ## How to Choose | Hard | Structural |
| B08 | Exactly one ## Frequently Asked Questions | Hard | Structural |
| B09 | H3 count matches products array | Hard | Missing/extra product = broken |
| B10 | 2–5 prose paragraphs per product section | Soft | Arithmetic, with editorial monitoring |
| B11 | Image policy enforcement | Hard | Visibly broken without images |
| B12 | Product section ends with "Check current price on Amazon." | Hard | Affiliate CTA, editorial contract |
| B13 | Comma separator required when images expected | Hard | Markdown rendering breaks |
| B14 | Buying guide has 3–5 H3 subsections | Soft | Arithmetic |
| B15 | Buying guide word count 475–700 | Soft | Arithmetic |
| B16 | Buying guide contains a hub link | Hard | Internal linking |
| B17 | "What to Look For" word count 400–700 | Soft | Arithmetic |
| B18 | "What to Look For" has 3–5 H3 subsections | Soft | Arithmetic |
| B19 | "What to Look For" heading present (exactly one) | Hard | Structural section requirement |
| B20 | "What to Look For" contains a hub link | Hard | Internal linking |

---

## 4. Rule classification — FAQ (Q)

| Rule | Description | Class | Reasoning |
|---|---|---|---|
| Q01 | Exactly 5 FAQ H3 questions | Soft | ±1 still reads fine |
| Q02 | FAQPage JSON-LD block present | Hard | Rich results require schema |
| Q03–Q04 | JSON-LD valid, FAQPage type, 5 entities | Hard | Invalid schema = no rich results |
| Q05 | Answer 2–4 sentences | Soft | Arithmetic |
| Q06 | FAQ total word count 300–500 | Soft | Arithmetic |
| Q07 | Answer doesn't end with "Check current price on Amazon." | Hard | Wrong CTA placement |
| Q08 | No bullet lists in answers | Hard | Format breaks JSON-LD rich results |

---

## 5. Rule classification — Anti-patterns (A)

| Rule | Description | Class | Reasoning |
|---|---|---|---|
| A01 | No "## Top Picks at a Glance" | Hard | Banned section, structural anti-pattern |
| A02 | No Pros: / Cons: bullet lists | Hard | Duplicates product object data |
| A03 | No banned price/dollar patterns | Hard | Amazon Operating Agreement compliance |
| A04 | No AI-tell phrases | Hard | Brand credibility |
| A05 | No parenthetical role labels in H3s | Hard | Format anti-pattern |
| A06 | No bold-only subtitle line below H3 | Hard | Visibly broken layout |
| A07 | No "Who buys this:" coda | Hard | Format anti-pattern |
| A08 | No markdown comparison table | Hard | Format anti-pattern |
| A09 | No placeholder ASINs | Hard | Currently warning-only — needs flip |
| A10 | No Price: / Best for: label-value codas | Hard | Format anti-pattern |

---

## 6. Rule classification — Length (L)

| Rule | Description | Class | Reasoning |
|---|---|---|---|
| L01 | Total body word count within range | Soft | Arithmetic boundary |

---

## 7. Rule classification — Manual/meta (M)

Some M-rules can be auto-validated; others require human judgment. M-rules currently flagged as manual-only in the validator, but classification below indicates which should be promoted to auto-validation.

| Rule | Description | Current | Target | Class |
|---|---|---|---|---|
| M01 | Voice matches persona YAML voice_notes | Manual | Manual | Manual |
| M02 | Product sections don't all open with product name in first sentence | Manual | Auto | Soft |
| M03 | FAQ questions are category-specific, not generic filler | Manual | Manual | Manual |
| M04 | At least one FAQ addresses a trade-off between two named products | Manual | Auto | Hard |
| M05 | At least one FAQ addresses a pre-purchase buyer decision | Manual | Auto | Soft |
| M06 | FAQ answers don't duplicate buying guide subsections verbatim | Manual | Auto | Hard |
| M07 | Persona name doesn't appear in article body prose | Manual | Auto | Hard |
| M08 | Regional references ≤ 1 in article body | Manual | Manual | Manual |
| M09 | No explicit credential declaration | Manual | Auto | Hard |
| M10 | In-body images use hub-matched filename prefix | Manual | Auto | Hard |
| M11 | In-body image numbers not repeated (hero vs body) | Manual | Auto | Hard |
| M12 | Buying guide subsections cover category-specific decision variables | Manual | Manual | Manual |
| M13 | First product mention in each H3 links to Amazon URL | Manual | Auto | Hard |
| M14 | At least one FAQ extends a "What to Look For" criterion (not repeats) | Manual | Manual | Manual |
| M15 | "What to Look For" is criteria-oriented, doesn't name specific products | Manual | Auto | Hard |
| M16 | Intro hub link appears in paragraph 1, not deferred | Manual | Auto | Hard |

**Manual-only rules (7):** M01, M03, M08, M12, M14 — plus M02 and M05 if auto-validation reliability proves poor.

**To promote from Manual to Auto-validated (11 rules):** M02, M04, M05, M06, M07, M09, M10, M11, M13, M15, M16.

---

## 8. Implementation notes

### 8.1 Tally

- **Total rules:** 67 (54 currently auto-validated + 13 manual)
- **After implementation:** 65 auto-validated + 7 manual = 65 auto + 7 manual

Wait — that's wrong. Let me recount:
- Currently auto: F (11) + B (20) + Q (7) + A (10) + L (1) = 49
- Currently manual: M (16) = 16
- Total: 65 rules

After classification:
- Auto-validated Hard: 47
- Auto-validated Soft: 13
- Manual-only: 5

That's 60 auto + 5 manual = 65 total. (Some M-rules promoted to auto, some stay manual.)

### 8.2 Code changes required

**Tag every rule with classification:**

Each rule in `validate-buyer-guide.mjs` and `validate-roundup.mjs` needs a classification tag (`hard` / `soft` / `manual`). Validator output distinguishes hard fails (block) from soft fails (log and pass).

**Soft fail logging:**

Soft fails write to `~/affiliate-platform/calibration-log.yaml` rather than blocking publication. Format:

```yaml
- timestamp: 2026-05-08T14:30:00Z
  site: the-coffee-dispatch
  article: lucca-espresso-machine
  rule: B15
  observed: 460
  target_min: 475
  target_max: 700
  deviation_pct: 3.2
```

Periodic review of this log catches calibration drift across the portfolio.

**A09 behavior change:**

Currently warning-only. Flip to hard fail.

**M-rules promotion to auto-validation (11 rules):**

Implement auto-detection logic for:

- M02: regex check first sentence of each H3 product section for product name
- M04: parse FAQ questions for two product names + comparison phrase ("vs", "or", "compared to", "difference between")
- M05: pattern-match FAQ questions for decision phrases ("should I", "which", "is it worth", "do I need")
- M06: text similarity between FAQ answers and buying guide H3 content
- M07: regex check for persona name in body prose
- M09: regex match credential phrases at sentence starts ("As a [X]...", "With [N] years...", etc.)
- M10: parse image references, check filename prefix matches article hub
- M11: parse image references, check no number repeats across hero + body
- M13: parse each H3 product section, verify first product name mention is wrapped in link to Amazon URL
- M15: parse WTLF section, check for product names from article's products array (should not appear)
- M16: locate hub link in intro, verify it's in paragraph 1

### 8.3 Hard fail rate target

Hard target: 0% hard fails before publish.

If hard fail rate consistently exceeds 5% across multiple sites for the same rule, that's a platform-level review (rule is mis-calibrated or prompt needs tightening), not site-level iteration.

### 8.4 Soft fail tolerance

No fixed ceiling. Soft fails ship by definition. Periodic review of `calibration-log.yaml` identifies patterns:
- Single rule producing high soft fail volume → tighten prompt or accept as model variance
- Rule producing zero soft fails → consider tightening boundary
- Rule producing both hard and soft fails distributed evenly → boundary may be incorrectly placed

---

## 9. Maintenance

When adding a new validator rule:

1. Define what the rule checks
2. Classify at definition time using the framework (Hard / Soft / Manual)
3. Document reasoning briefly
4. Add to this file in appropriate section
5. Implement in validator code with classification tag
6. If soft fail, ensure logging is wired to `calibration-log.yaml`

When changing an existing rule's classification:

1. Document the change rationale (what evidence drove it)
2. Update this file
3. Update validator code
4. Note the change in CHANGELOG.md at platform root

When promoting a Manual rule to Auto-validated:

1. Implement detection logic
2. Test against existing corpus to estimate false positive/negative rates
3. Classify as Hard or Soft based on framework
4. Update this file (move from Manual to appropriate auto-validated section)
5. Keep manual flag for one platform version as parallel signal before fully promoting

---

*End of VALIDATORS.md*
