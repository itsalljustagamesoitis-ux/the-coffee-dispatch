"""
Article builder for site producer.
Takes a pipeline article + loaded data, calls Claude, returns a markdown string.
"""

import anthropic
import json
import os
import yaml
from datetime import date
from pathlib import Path


def _get_site_config() -> dict:
    cfg_path = Path(__file__).parent.parent / "site.config.yaml"
    with open(cfg_path) as f:
        return yaml.safe_load(f)


def _get_persona(cfg: dict) -> dict:
    persona_path = Path(__file__).parent.parent / cfg["persona"]["config_path"]
    with open(persona_path) as f:
        return yaml.safe_load(f)


def _get_amazon_tag(cfg: dict) -> str:
    """AMAZON_TAG env var overrides site.config.yaml — matches Astro build behaviour."""
    if tag := os.environ.get("AMAZON_TAG"):
        return tag
    return cfg.get("affiliate", {}).get("amazon_tracking_id", "")


_CFG    = _get_site_config()
_PERSONA = _get_persona(_CFG)
AMAZON_TAG = _get_amazon_tag(_CFG)


# ── Type-specific H2 templates ────────────────────────────────────────────────

H2_STRUCTURES = {
    "Roundup":      "Our Top Picks → How We Tested → Full Reviews → What to Look For → FAQ",
    "Review":       "Quick Verdict → What We Tested → Performance → Pros & Cons → Who Should Buy → FAQ",
    "Comparison":   "Head-to-Head Verdict → Side-by-Side Specs → Testing Notes → Who Each Is Best For → FAQ",
    "Informational":"The Short Answer → What You Need to Know → Step-by-Step → Common Mistakes → FAQ",
    "Buyer Guide":  "What to Look For → Top Picks → How to Choose → FAQ",
}

TYPE_WORD_COUNTS = {
    "Roundup": "2,200–2,800",
    "Review": "1,800–2,200",
    "Comparison": "1,800–2,200",
    "Informational": "1,500–2,000",
    "Buyer Guide": "2,000–2,500",
}


def _build_system(persona: dict, cfg: dict) -> str:
    brand_name      = cfg.get("site", {}).get("brand_name", "")
    name_formal     = persona.get("name_formal", persona.get("display_name", ""))
    name_used       = persona.get("name_used", name_formal.split()[0] if name_formal else "")
    background      = persona.get("background", "")
    location        = persona.get("location", "")
    location_detail = persona.get("location_detail", "")
    bio_short       = persona.get("bio_short", "")
    voice_notes     = persona.get("voice_notes", "").strip()

    return f"""You are a ghostwriter for {brand_name}, writing as {name_formal}.

PERSONA: {name_formal}. {background}. {location_detail}
{bio_short}

VOICE:
{voice_notes}

VOICE TECHNIQUES — use these actively, not occasionally:

1. USE PRICE BANDS, NOT DOLLAR FIGURES. Amazon pricing changes constantly and showing specific dollar amounts violates affiliate program terms. Instead: reference the product's price_band field (budget / mid / premium) and frame it in plain language. "It's mid-range pricing" or "in the budget category" or "one of the pricier options in this class." For direct comparisons, use relative language: "costs roughly twice the [other model]." Never write "$280" or "around $350-$400" or any specific dollar figure. If price matters to the verdict, say so — just don't pin it to a number. Direct readers to Amazon for current pricing ("check current price on Amazon").

2. SELF-AWARE ASIDES. {name_used} occasionally steps back from the review voice with a brief aside. Dry, never cute. "(I timed this)" or "(go me)" or "which I realise is a specific complaint" or "and your life will be easier" or "my advice would be". One or two per article, placed where the tone would otherwise be unrelentingly formal.

3. ADDRESS THE READER'S ACTUAL SITUATION. Not "this is good for large properties" but "if you've ever abandoned a [task] mid-session because [specific reason], that's what this solves." Frame features as solutions to specific physical or practical moments the reader will recognise.

4. CATCH YOURSELF. Occasionally {name_used} starts a sentence prescriptively and qualifies it — "if that's what you were to do" or "though I appreciate that's not everyone's priority". Not hedging a verdict, just a person acknowledging she's one person with one property.

5. COMPETITOR SPECIFICITY. Name the competing product being implicitly compared against — actual model numbers where known. Not generic "the competition" — real alternatives by name.

PERSONA LOCATION — use sparingly:
- Reference {location} context at most once per article, in passing, as personal context.
- Describe conditions and climate in plain, accessible language rather than technical jargon.
- {name_used}'s property and background are personal context, not credentials to keep citing.

BANNED WORDS: unlock, navigate, navigating, journey, transformative, holistic, robust, seamless, dive deep, elevate, game-changer, genuinely, truly, certainly, impressive, comprehensive, nuanced, leverage, crucial, essential, vital

BANNED PHRASES: "the key is", "here's what", "moving forward", "you're not alone", "the good news is", "research shows", "studies show", "it's worth noting", "with that in mind", "at its core", "when it comes to", "in terms of", "not only... but also", "whether you're a", "one thing to keep in mind", "that said", "all in all", "now let's", "let's take a look"

AVOID THESE PATTERNS — they mark AI-generated text:
- False balance: never hedge a clear verdict. If one product is better, say so. Do not add "though it may not suit everyone" to soften every opinion.
- Transition announcements: never write a sentence whose only job is to announce the next section. Cut it — the next sentence stands on its own.
- Pre-explaining obvious context: do not explain background that the reader already knows. Assume competence.
- Summarising conclusions: do not recap what you just wrote. End sections on a specific opinion, a number, or a warning — not a summary.
- Parallel list padding: not every section needs 3 items. Vary list lengths. Collapse thin sections into prose.
- Overusing "This": avoid starting consecutive sentences with "This means...", "This makes...", "This allows...". Rewrite with a stronger verb.
- "You'll want to..." / "You'll find that...": don't narrate the reader's experience. Cut these constructions.

FORMATTING:
- H1: article title only (do not include in body)
- H2 for all main sections
- H3 for subsections under H2
- ABSOLUTELY NO em dashes (—) or double dashes (--) anywhere in the text. This is a hard rule with no exceptions. Instead: use a period and start a new sentence, use a comma, use "but" or "because", or use parentheses.
- No colons to introduce lists or clauses mid-sentence. Use a period instead.
- No semicolons joining two clauses. Use "but", "and", or a period instead.
- No horizontal rules.
- FAQ section: exactly 5 Q&A pairs.

LANGUAGE: American English throughout. No exceptions.
- aluminum (not aluminium)
- color, flavor, honor, neighbor (not colour, flavour, honour, neighbour)
- realize, recognize, organize, prioritize (not realise, recognise, organise, prioritise)
- center, meter, fiber (not centre, metre, fibre)
- gray (not grey)
- while (not whilst), among (not amongst), toward (not towards)
- traveling, canceled, labeled (not travelling, cancelled, labelled)
- fertilizer, minimizer (not fertiliser, minimiser)

OUTPUT FORMAT: Return the article body only (no frontmatter). Start with the intro paragraph directly. Use markdown headings."""


SYSTEM = _build_system(_PERSONA, _CFG)


def build_products_brief(article: dict, products: dict) -> str:
    """Build a concise product brief for the prompt."""
    lines = []
    for key in article.get("products", []):
        p = products.get(key)
        if not p:
            continue
        asin = p.get("amazon_asin", "")
        amazon_url = f"https://www.amazon.com/dp/{asin}?tag={AMAZON_TAG}" if asin else ""
        lines.append(
            f"- **{p['name']}** (key: {key})\n"
            f"  Brand: {p.get('brand','')} | Price band: {p.get('price_band','')} | ASIN: {asin}\n"
            f"  Amazon link: {amazon_url}\n"
            f"  Pros: {'; '.join(p.get('default_pros',[]))}\n"
            f"  Cons: {'; '.join(p.get('default_cons',[]))}\n"
            f"  Writer notes: {p.get('notes_for_writers','')}"
        )
    return "\n\n".join(lines) if lines else "No products assigned."


def build_eeat_brief(eeat: dict) -> str:
    lines = []
    if eeat.get("experiences"):
        lines.append("PERSONA'S RELEVANT EXPERIENCES:")
        for e in eeat["experiences"]:
            lines.append(f"- {e.get('story','')}")
    if eeat.get("failures"):
        lines.append("\nPERSONA'S FAILURES TO REFERENCE:")
        for f in eeat["failures"]:
            lines.append(f"- {f.get('lesson','')}")
    if eeat.get("opinions"):
        lines.append("\nPERSONA'S STRONG OPINIONS:")
        for o in eeat["opinions"]:
            lines.append(f"- {o.get('opinion','')}")
    return "\n".join(lines)


def build_prompt(article: dict, products: dict, eeat: dict, persona: dict) -> str:
    article_type = article["type"]
    h2_structure = article.get("h2_structure") or H2_STRUCTURES.get(article_type, "")
    word_count = TYPE_WORD_COUNTS.get(article_type, "1,800–2,200")

    products_brief = build_products_brief(article, products)
    eeat_brief = build_eeat_brief(eeat)

    hub_url = article.get("hub_url", f"/{article.get('hub_slug','')}/")
    hub_label = article.get("hub_label", "")
    category_label = article.get("category_label", "")

    # For comparison articles, identify the two products
    comparison_note = ""
    if article_type == "Comparison" and len(article.get("products", [])) >= 2:
        p_keys = article["products"]
        p1 = products.get(p_keys[0], {})
        p2 = products.get(p_keys[1], {})
        comparison_note = f"\nThis is a head-to-head comparison: **{p1.get('name','Product A')}** vs **{p2.get('name','Product B')}**."

    # Sibling articles in same cluster that are already published
    siblings = article.get("_siblings", [])
    sibling_block = ""
    if siblings:
        sibling_lines = "\n".join(
            f'- [{s["keyword"].title()}](/{s["slug"]}/)'
            for s in siblings[:6]
        )
        sibling_block = f"""
INTERNAL LINKS — SIBLING ARTICLES:
These articles are already published on the site in the same topic area.
Link to 2-3 of them naturally where relevant in the body — not in a list, but as contextual anchor text mid-sentence.
{sibling_lines}
"""

    prompt = f"""Write a {article_type} article for {_CFG.get('site', {}).get('brand_name', '')}.

TARGET KEYWORD: {article['keyword']}
ARTICLE TYPE: {article_type}
ANGLE / PERSONA HOOK: {article['angle']}
TARGET WORD COUNT: {word_count} words
CATEGORY: {category_label}
HUB: {hub_label} ({hub_url})
{comparison_note}

H2 STRUCTURE TO FOLLOW:
{h2_structure}

PRODUCTS TO COVER:
{products_brief}

{eeat_brief}

HUB LINK REQUIREMENT:
Include a contextual link to the hub page ({hub_url} — "{hub_label}") at least twice:
once naturally in the first half of the article (before or just after the first H2),
and once in the second half (before the FAQ or in a closing paragraph).
Use varied phrasing — don't repeat the same anchor text.
{sibling_block}
AFFILIATE LINKS:
When mentioning a product by name, link to its Amazon URL using the product name as anchor text.
Format: [Product Name](https://www.amazon.com/dp/ASIN?tag={AMAZON_TAG})

FAQ SECTION:
End with an H2 "Frequently Asked Questions" section containing exactly 5 Q&A pairs.
Use H3 for each question. Questions should be the kind a real buyer would search.

Write the full article body now. Do not include frontmatter. Start with the intro paragraph."""

    return prompt


def generate_title_and_desc(article: dict, body: str, client: anthropic.Anthropic) -> tuple:
    """Draft a title (<65 chars) and meta description (150-160 chars) from the article body."""
    prompt = f"""Write a title and meta description for this article.

Keyword: {article['keyword']}
Type: {article['type']}
Article opening:
{body[:600]}

Rules:
- Title: under 65 characters, keyword near the front, specific and honest (no "ultimate", no "best ever")
- Meta description: 150–160 characters exactly, plain sentence, no em dashes, no exclamation marks

Return JSON only:
{{"title": "...", "description": "..."}}"""

    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        messages=[{"role": "user", "content": prompt}],
    )
    text = resp.content[0].text.strip()
    start = text.find("{")
    end = text.rfind("}") + 1
    data = json.loads(text[start:end])
    return data.get("title", ""), data.get("description", "")


def generate_article(article: dict, products: dict, eeat: dict, persona: dict,
                     client: anthropic.Anthropic) -> tuple:
    """Returns (body_text, title, description)."""
    prompt = build_prompt(article, products, eeat, persona)

    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    body = resp.content[0].text.strip()
    body = _fix_punctuation(body)
    body = _americanize(body)
    title, description = generate_title_and_desc(article, body, client)
    return body, title, description


def _americanize(text: str) -> str:
    """Convert British spellings to American English."""
    import re
    replacements = [
        # -our → -or
        (r'\bcolours?\b', lambda m: 'colors' if m.group().endswith('s') else 'color'),
        (r'\bcolour(ed|ing|ful|less|s)?\b', lambda m: 'color' + (m.group(1) or '')),
        (r'\bflavours?\b', lambda m: 'flavors' if m.group().endswith('s') else 'flavor'),
        (r'\bhonours?\b', lambda m: 'honors' if m.group().endswith('s') else 'honor'),
        (r'\bhumours?\b', lambda m: 'humors' if m.group().endswith('s') else 'humor'),
        (r'\blabours?\b', lambda m: 'labors' if m.group().endswith('s') else 'labor'),
        (r'\bneighbou?rs?\b', lambda m: 'neighbors' if m.group().endswith('s') else 'neighbor'),
        (r'\bfavou?r(ite|s|ed|ing)?\b', lambda m: 'favor' + (m.group(1) or '')),
        # -ise → -ize
        (r'\brealise(d|s|r|rs|ing)?\b', lambda m: 'realize' + (m.group(1) or '')),
        (r'\brecognise(d|s|r|rs|ing)?\b', lambda m: 'recognize' + (m.group(1) or '')),
        (r'\borganise(d|s|r|rs|ing|ation|ations)?\b', lambda m: 'organize' + (m.group(1) or '')),
        (r'\bprioritise(d|s|ing)?\b', lambda m: 'prioritize' + (m.group(1) or '')),
        (r'\bminimise(d|s|ing)?\b', lambda m: 'minimize' + (m.group(1) or '')),
        (r'\bmaximise(d|s|ing)?\b', lambda m: 'maximize' + (m.group(1) or '')),
        (r'\bemphasise(d|s|ing)?\b', lambda m: 'emphasize' + (m.group(1) or '')),
        (r'\bspecialise(d|s|ing)?\b', lambda m: 'specialize' + (m.group(1) or '')),
        (r'\bcentralise(d|s|ing)?\b', lambda m: 'centralize' + (m.group(1) or '')),
        # -re → -er
        (r'\bcentre(d|s|ing)?\b', lambda m: 'center' + (m.group(1) or '')),
        (r'\bmetres?\b', lambda m: 'meters' if m.group().endswith('s') else 'meter'),
        (r'\bfibres?\b', lambda m: 'fibers' if m.group().endswith('s') else 'fiber'),
        (r'\btheatres?\b', lambda m: 'theaters' if m.group().endswith('s') else 'theater'),
        # -ise spellings (nouns)
        (r'\bfertiliser(s)?\b', lambda m: 'fertilizer' + (m.group(1) or '')),
        (r'\bfertilise(d|s|ing)?\b', lambda m: 'fertilize' + (m.group(1) or '')),
        # doubled consonants
        (r'\btravell(ing|ed|er|ers)\b', lambda m: 'travel' + m.group(1)),
        (r'\bcancell(ed|ing)\b', lambda m: 'cancel' + m.group(1)),
        (r'\blabelled?\b', 'labeled'),
        (r'\bchannelled?\b', 'channeled'),
    ]
    for pattern, repl in replacements:
        if callable(repl):
            text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
        else:
            text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    return text


def _fix_punctuation(text: str) -> str:
    """Replace em/en dashes with commas or periods."""
    import re
    text = re.sub(r'\s*—\s*', ', ', text)
    text = re.sub(r'\s*–\s*', ', ', text)
    text = text.replace('--', ', ')
    return text


def build_frontmatter(article: dict, products: dict, title: str, description: str) -> str:
    """Build YAML frontmatter for a content/articles/*.md file."""
    persona_slug = _PERSONA.get("slug", _PERSONA.get("name_used", "author").lower())
    hub_n = ((article.get("id", 1) - 1) % 8) + 1
    hero_image = f"articles/{article.get('hub', 'general')}-{hub_n}.jpg"

    product_keys = article.get("products", [])
    products_yaml = ""
    if product_keys:
        lines = []
        for key in product_keys:
            p = products.get(key, {})
            role = p.get("role", "primary")
            lines.append(f"  - id: {key}\n    role: {role}")
        products_yaml = "products:\n" + "\n".join(lines)
    else:
        products_yaml = "products: []"

    today = date.today().isoformat()
    fm = f"""---
title: "{title}"
slug: "{article['slug']}"
type: "{article['type'].lower().replace(' ', '_')}"
date: {today}
author: "{persona_slug}"
category: "{article.get('category_label', article.get('category', ''))}"
hub: "{article.get('hub_slug', article.get('hub', ''))}"
hero_image: "{hero_image}"
description: "{description}"
target_keyword: "{article['keyword']}"
{products_yaml}
tags: []
disclosure_required: true
---
"""
    return fm
