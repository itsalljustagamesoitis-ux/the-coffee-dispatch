"""
Platform article builder.
Takes a pipeline article + loaded data, calls Claude, returns (body, title, description).

Key changes from per-site builders:
  - No embedded SYSTEM constant — system prompt comes from prompt_loader (R1)
  - No TYPE_WORD_COUNTS — word count comes from style_policy (R2)
  - No H2_STRUCTURES — pipeline h2_structure ignored with warning (R3/R4)
  - product_count enforcement: halt on shortfall, trim on excess (R5)
  - Catalog-growth path: writes VERIFY entries for unknown product slugs (R6)
  - Validator integration: roundup articles validated before write (R7)
  - author/category read from site_config (R10)
  - _fix_punctuation and _americanize preserved verbatim from MLT (R9)
"""

import json
import os
import re
import shutil
import subprocess
import sys
import yaml
from datetime import date, datetime
from pathlib import Path

PLATFORM_ROOT = Path(__file__).parent.parent


# ---------------------------------------------------------------------------
# Catalog-growth helpers (CATALOG-BEHAVIOUR.md Section 2)
# ---------------------------------------------------------------------------

def _slugify(brand: str, name: str) -> str:
    """Derive product slug per CATALOG-BEHAVIOUR.md slug derivation rules."""
    stop_words = {"the", "a", "an", "and", "for", "of", "in", "with", "by"}
    combined = f"{brand} {name}".lower()
    combined = re.sub(r"[^a-z0-9]+", "-", combined)
    parts = [p for p in combined.split("-") if p and p not in stop_words]
    slug = "-".join(parts)
    return re.sub(r"-+", "-", slug).strip("-")


def _ensure_products_in_catalog(article: dict, products: dict, site_root: Path) -> dict:
    """
    For any product slug in article["products"] missing from products dict:
      - Write a VERIFY entry to products.yaml (CATALOG-BEHAVIOUR.md §2)
      - Log a prominent warning
      - Return reloaded products dict

    Raises ValueError on slug collision (same slug, different name/brand).
    """
    missing = [k for k in article.get("products", []) if k not in products]
    if not missing:
        return products

    products_path = site_root / "content/products/products.yaml"
    with open(products_path) as f:
        raw = yaml.safe_load(f) or {}

    hub = article.get("hub_slug", article.get("hub", ""))
    timestamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    for slug in missing:
        parts = slug.split("-")
        display_name = " ".join(p.title() for p in parts)
        brand = parts[0].title() if parts else slug

        if slug in raw:
            ex = raw[slug]
            if ex.get("name") == display_name and ex.get("brand") == brand:
                continue
            raise ValueError(
                f"Slug collision: '{slug}' exists in products.yaml with "
                f"name='{ex.get('name')}' / brand='{ex.get('brand')}' but "
                f"auto-derived entry would be name='{display_name}' / brand='{brand}'. "
                f"Resolve manually before generating."
            )

        raw[slug] = {
            "name": display_name,
            "brand": brand,
            "hub": hub,
            "amazon_asin": "VERIFY",
            "price_band": "mid",
            "default_pros": ["[PLACEHOLDER — update before next build]"],
            "default_cons": ["[PLACEHOLDER — update before next build]"],
            "notes_for_writers": (
                f"added by producer during {article['slug']} generation, {timestamp}"
            ),
        }
        print(
            f"  CATALOG GROWTH: Added VERIFY entry for '{slug}' "
            f"(auto-derived name: '{display_name}')"
        )
        print(
            f"  WARNING: Review and update this products.yaml entry "
            f"(name, brand, pros, cons) before the next build."
        )

    tmp = products_path.with_suffix(".yaml.tmp")
    bak = products_path.with_suffix(".yaml.bak")
    with open(tmp, "w") as f:
        yaml.dump(raw, f, default_flow_style=False, allow_unicode=True, sort_keys=True)
    if products_path.exists():
        shutil.copy2(products_path, bak)
    os.replace(tmp, products_path)

    # Reload
    from data_loader import load_products
    return load_products(site_root)


# ---------------------------------------------------------------------------
# Product-count enforcement (CATALOG-BEHAVIOUR.md + prompt §1)
# ---------------------------------------------------------------------------

def _enforce_product_count(article: dict, products: dict, metadata: dict) -> list:
    """
    Returns the final list of product keys for generation.

    Rules:
      - Shortfall (assigned < min): halt with clear error message
      - Excess (assigned > max): trim to max (highest-rated then most relevant)
      - No assigned products: use hub-matched products (min-max enforced)
    """
    assigned = article.get("products", [])
    pc = metadata.get("product_count", {"min": 6, "max": 8})
    min_count = pc["min"]
    max_count = pc["max"]

    if assigned:
        # Filter to products that actually exist in catalog
        valid = [k for k in assigned if k in products]
        if len(valid) < min_count:
            raise ValueError(
                f"Product shortfall for '{article['slug']}': "
                f"brief has {len(valid)} valid products "
                f"(min required: {min_count}). "
                f"Add products to products.yaml or update the pipeline brief."
            )
        if len(valid) > max_count:
            print(
                f"  TRIM: {len(valid)} products exceeds max {max_count}. "
                f"Trimming to first {max_count}."
            )
            valid = valid[:max_count]
        return valid
    else:
        # Fall back to hub-matched products
        hub_slug = article.get("hub_slug", article.get("hub", ""))
        hub_prods = {k: v for k, v in products.items() if v.get("hub") == hub_slug}
        if len(hub_prods) < min_count:
            raise ValueError(
                f"Insufficient hub products for '{article['slug']}' (hub: {hub_slug}): "
                f"found {len(hub_prods)}, need at least {min_count}."
            )
        keys = list(hub_prods.keys())[:max_count]
        return keys


# ---------------------------------------------------------------------------
# Validator integration (CATALOG-BEHAVIOUR.md §3)
# ---------------------------------------------------------------------------

def _run_validator(article_type: str, md_path: Path, site_root: Path) -> tuple:
    """
    Run platform validator for this article type.
    Returns (passed: bool, output: str).
      passed=True when no validator exists for this type (not an error).
    Logs result. Does NOT sys.exit — caller handles on False.
    """
    norm_type = article_type.lower().replace(" ", "_")
    validator_map = {
        "roundup": PLATFORM_ROOT / "validators/validate-roundup.mjs",
        "buyer_guide": PLATFORM_ROOT / "validators/validate-buyer-guide.mjs",
    }
    validator_path = validator_map.get(norm_type)

    if not validator_path:
        msg = f"  VALIDATOR: No platform validator for type '{article_type}' — skipping."
        print(msg)
        return True, msg

    if not validator_path.exists():
        msg = f"  VALIDATOR: {validator_path.name} not found — skipping."
        print(msg)
        return True, msg

    result = subprocess.run(
        ["node", str(validator_path), "--site", str(site_root), str(md_path)],
        capture_output=True,
        text=True,
    )

    output = result.stdout + (("\n" + result.stderr) if result.stderr else "")

    if result.returncode != 0:
        print(f"  VALIDATOR FAIL ({validator_path.name}) exit={result.returncode}")
        print(output[-2000:])
        return False, output

    print(f"  VALIDATOR: {validator_path.name} PASS")
    print(output[-500:] if output.strip() else "")
    return True, output


# ---------------------------------------------------------------------------
# EEAT brief builder
# ---------------------------------------------------------------------------

def build_eeat_brief(eeat: dict, persona: dict) -> str:
    persona_name = persona.get("name", "PERSONA").upper()
    lines = []
    if eeat.get("experiences"):
        lines.append(f"{persona_name}'S RELEVANT EXPERIENCES:")
        for e in eeat["experiences"]:
            lines.append(f"- {e.get('story', '')}")
    if eeat.get("failures"):
        lines.append(f"\n{persona_name}'S FAILURES TO REFERENCE:")
        for f in eeat["failures"]:
            lines.append(f"- {f.get('lesson', '')}")
    if eeat.get("opinions"):
        lines.append(f"\n{persona_name}'S STRONG OPINIONS:")
        for o in eeat["opinions"]:
            lines.append(f"- {o.get('opinion', '')}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Products brief builder
# ---------------------------------------------------------------------------

def build_products_brief(product_keys: list, products: dict, amazon_tag: str) -> str:
    lines = []
    for key in product_keys:
        p = products.get(key)
        if not p:
            continue
        asin = p.get("amazon_asin", "")
        lines.append(
            f"- **{p['name']}** (product-slug: `{key}`)\n"
            f"  Brand: {p.get('brand', '')} | Price band: {p.get('price_band', '')} | ASIN: {asin}\n"
            f"  Pros: {'; '.join(p.get('default_pros', []))}\n"
            f"  Cons: {'; '.join(p.get('default_cons', []))}\n"
            f"  Writer notes: {p.get('notes_for_writers', '')}"
        )
    return "\n\n".join(lines) if lines else "No products assigned."


# ---------------------------------------------------------------------------
# Prompt builder (user message / {{BRIEF}})
# ---------------------------------------------------------------------------

def build_prompt(
    article: dict,
    product_keys: list,
    products: dict,
    eeat: dict,
    persona: dict,
    site_config: dict,
    metadata: dict,
) -> str:
    """
    Build the user-message ({{BRIEF}}) for the model.
    The system message comes from prompt_loader.load_prompt().

    For article types with a platform prompt, h2_structure from the pipeline
    is ignored (R4) — the platform prompt defines structure.
    """
    article_type = article["type"]
    norm_type = article_type.lower().replace(" ", "_")

    # R4: Ignore pipeline h2_structure for platform-prompted types
    has_platform_prompt = metadata.get("article_type") in ("roundup", "buyer_guide")
    if has_platform_prompt and article.get("h2_structure"):
        print(
            f"  NOTE: Ignoring pipeline h2_structure for {norm_type} "
            f"(platform prompt defines structure per CATALOG-BEHAVIOUR spec)."
        )

    # Word count from style_policy (R2)
    wc = metadata.get("word_count", site_config.get("style_policy", {}).get("word_count", {}))
    word_count_str = f"{wc.get('min', 2000):,}–{wc.get('max', 3000):,}"

    amazon_tag = site_config.get("affiliate", {}).get("amazon_tracking_id", "")
    products_brief = build_products_brief(product_keys, products, amazon_tag)
    eeat_brief = build_eeat_brief(eeat, persona)

    hub_url = article.get("hub_url", f"/{article.get('hub_slug', '')}/")
    hub_label = article.get("hub_label", "")
    category_label = article.get("category_label", "")

    comparison_note = ""
    if norm_type == "comparison" and len(product_keys) >= 2:
        p1 = products.get(product_keys[0], {})
        p2 = products.get(product_keys[1], {})
        comparison_note = (
            f"\nThis is a head-to-head comparison: "
            f"**{p1.get('name', 'Product A')}** vs **{p2.get('name', 'Product B')}**."
        )

    siblings = article.get("_siblings", [])
    sibling_block = ""
    if siblings:
        sibling_lines = "\n".join(
            f'- [{s["keyword"].title()}](/{s["slug"]}/)'
            for s in siblings[:6]
        )
        sibling_block = (
            f"\nINTERNAL LINKS — SIBLING ARTICLES:\n"
            f"These articles are already published on the site in the same topic area.\n"
            f"Link to 2-3 of them naturally where relevant in the body "
            f"— not in a list, but as contextual anchor text mid-sentence.\n"
            f"{sibling_lines}\n"
        )

    # For non-platform-prompted types, include H2 structure in prompt
    h2_block = ""
    if not has_platform_prompt:
        h2_structure = article.get("h2_structure", "")
        if h2_structure:
            h2_block = f"\nH2 STRUCTURE TO FOLLOW:\n{h2_structure}\n"

    prompt = f"""Write a {article_type} article for {site_config.get('site', {}).get('brand_name', 'this site')}.

TARGET KEYWORD: {article['keyword']}
ARTICLE TYPE: {article_type}
ANGLE / PERSONA HOOK: {article['angle']}
TARGET WORD COUNT: {word_count_str} words
CATEGORY: {category_label}
HUB: {hub_label} ({hub_url})
{comparison_note}
{h2_block}
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
When mentioning a product by name, link using the product-slug from the product list above.
Format: [Product Name](product:product-slug)
Example: [Shun Classic 7-Inch Santoku](product:shun-classic-santoku-7)
Use the exact product-slug value shown in backticks in the product list. Never use raw Amazon URLs.

H3 PRODUCT HEADING FORMAT (REQUIRED):
H3 product section headings must be plain text product names only. DO NOT make the H3 a hyperlink.
Correct: `### Shun Classic 7-Inch Santoku`
Wrong: `### [Shun Classic 7-Inch Santoku](url)`
Wrong: `### Shun Classic 7-Inch Santoku (Best Overall)`
The first mention of the product name IN THE BODY TEXT of the section should use the product:slug link — not the heading itself.

PRODUCT SECTION CLOSER (REQUIRED — every product H3):
Each product H3 section MUST end with this exact line (the full phrase is the hyperlink):
[Check current price on Amazon.](product:product-slug)
Replace product-slug with the product's slug from the list above. This line is mandatory on EVERY product section, no exceptions.

INTRO LENGTH (HARD LIMIT):
Write exactly 2 intro paragraphs. Target 80–95 words total. Hard ceiling: 105 words — if your draft exceeds 105 words, cut the longest sentences until you're under. Two short paragraphs only. Do NOT write a third paragraph. Do NOT add transitional bridge sentences between the intro and the first H2.

PRODUCT SECTION COUNT (HARD REQUIREMENT):
Write one H3 section for EVERY product listed above. {len(product_keys)} products = {len(product_keys)} H3 sections under ## Top Picks. Do not skip any product.

FAQ SECTION (HARD LIMITS):
End with an H2 "Frequently Asked Questions" section containing exactly 5 Q&A pairs.
Use H3 for each question. Each answer: MAXIMUM 4 sentences. STOP at 4. If you have written a 5th sentence, delete it before moving to the next question.
Target 55–75 words per answer. Total FAQ section: 300–450 words — if your draft exceeds 450 words, cut the longest answer.
No bullet lists inside answers.
Questions should reflect real buyer decisions specific to this product category.
Immediately after the last FAQ answer, include the FAQPage JSON-LD schema block.

BUYING GUIDE LENGTH: The buying guide section must be 500–700 words total. Write 3–5 H3 subsections. Each H3 subsection: 2–3 paragraphs, 80–120 words per subsection (hard max 120 per subsection). STOP the buying guide when you reach 700 words total — do not overshoot.
BUYING GUIDE HUB LINK: At least one subsection of the buying guide must include a contextual link to the hub page ({hub_url}). This is separate from the hub links in the intro and closing — the buying guide needs its own hub link.

BANNED PHRASES (never use anywhere in the article body):
"in this article", "in this guide", "let's dive in", "look no further", "the perfect", "game-changer", "when it comes to", "in today's world", "without further ado"

PRICE RULE (HARD BAN — applies everywhere in this article):
No dollar figures ($X, $X–$Y), no "around $", no "starting at", no "typically around", no "priced at", no "costs about", no "for under $", no "at the $X price point". Use price band language only (budget, mid-range, premium). The ONLY pricing signal allowed is "Check current price on Amazon." at the end of each product section.

Write the full article body now. Do not include frontmatter. Start with the intro paragraph."""

    return prompt


# ---------------------------------------------------------------------------
# Title + meta description (Haiku, two-model pattern preserved)
# ---------------------------------------------------------------------------

def generate_title_and_desc(article: dict, body: str, client) -> tuple:
    """Draft title (50-70 chars) and meta description (140-160 chars) from body."""
    import anthropic

    base_prompt = f"""Write a title and meta description for this article.

Keyword: {article['keyword']}
Type: {article['type']}
Article opening:
{body[:600]}

Rules:
- Title: MINIMUM 50 characters, maximum 70 characters. Count the characters. Titles under 50 chars are rejected. Keyword near the front, specific and honest (no "ultimate", no "best ever"). If your draft is under 50 chars, extend it: add "Reviewed", "Tested", "for Home Cooks", "Top Picks", etc.
- Meta description: MINIMUM 140 characters, MAXIMUM 160 characters. Count the characters. Target 150. If under 140, add a phrase. Plain sentence, no em dashes, no exclamation marks.

Return JSON only — no other text:
{{"title": "...", "description": "..."}}"""

    def _parse(text: str):
        start = text.find("{")
        if start == -1:
            return None
        try:
            decoder = json.JSONDecoder()
            data, _ = decoder.raw_decode(text, start)
            return data
        except json.JSONDecodeError:
            try:
                end = text.rfind("}") + 1
                return json.loads(text[start:end])
            except json.JSONDecodeError:
                return None

    best_title, best_desc = "", ""
    best_score = float('-inf')
    feedback = ""

    for attempt in range(3):
        prompt = base_prompt + feedback
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        data = _parse(resp.content[0].text.strip())
        if data is None:
            continue
        title = data.get("title", "")
        description = data.get("description", "")
        t_len = len(title)
        d_len = len(description)
        t_ok = 50 <= t_len <= 70
        d_ok = 140 <= d_len <= 160
        score = -(abs(t_len - 60) if not t_ok else 0) - (abs(d_len - 150) if not d_ok else 0)
        if score > best_score:
            best_title, best_desc, best_score = title, description, score
        if t_ok and d_ok:
            break
        issues = []
        if not t_ok:
            issues.append(f"title={t_len} chars — {'ADD words to reach 50+' if t_len < 50 else 'CUT to reach 70 or less'}")
        if not d_ok:
            issues.append(f"description={d_len} chars — {'ADD a phrase to reach 140+' if d_len < 140 else 'CUT to reach 160 or less'}")
        feedback = f"\n\nPrevious attempt issues: {'; '.join(issues)}. Fix and return JSON only."
    return best_title, best_desc


# ---------------------------------------------------------------------------
# Main generation entry point
# ---------------------------------------------------------------------------

def generate_article(
    article: dict,
    products: dict,
    eeat: dict,
    persona: dict,
    client,
    site_config: dict,
    site_root: Path,
    system_text: str,
    metadata: dict,
) -> tuple:
    """
    Returns (body_text, title, description).

    system_text: rendered platform prompt (from prompt_loader.load_prompt()).
      If None (unsupported article type), falls back to a minimal persona-based system.
    """
    if system_text is None:
        # Fallback for non-platform-prompted types: build minimal system from persona
        system_text = _build_fallback_system(persona, site_config)

    # R5: product count enforcement (after catalog-growth in caller)
    try:
        product_keys = _enforce_product_count(article, products, metadata)
    except ValueError as e:
        raise

    prompt = build_prompt(article, product_keys, products, eeat, persona, site_config, metadata)

    resp = client.messages.create(
        model="claude-sonnet-4-6",
        # 8192: platform system prompt is ~23K chars vs legacy ~4K — output budget compressed at 4096
        max_tokens=8192,
        system=system_text,
        messages=[{"role": "user", "content": prompt}],
    )
    body = resp.content[0].text.strip()
    dollar_allowed = site_config.get("style_policy", {}).get("dollar_figures", {}).get("allowed", False)
    body = _fix_punctuation(body)
    body = _americanize(body)
    body = _enforce_price_ban(body, dollar_allowed)
    body = _enforce_faq_sentence_limit(body)
    body = _enforce_ai_tell_bans(body)
    body = _strip_spurious_commas(body)
    hub = article.get("hub_slug", article.get("hub", ""))
    body = inject_body_images(body, article.get("body_images"), hub)
    title, description = generate_title_and_desc(article, body, client)
    return body, title, description, product_keys


def _build_fallback_system(persona: dict, site_config: dict) -> str:
    """Minimal system prompt for article types without a platform prompt."""
    brand = site_config.get("site", {}).get("brand_name", "this site")
    name = persona.get("name", "")
    voice_notes = persona.get("voice_notes", "")
    background = persona.get("background", "")
    banned_words = "unlock, navigate, navigating, journey, transformative, holistic, robust, seamless, dive deep, elevate, game-changer"
    dollar_allowed = site_config.get("style_policy", {}).get("dollar_figures", {}).get("allowed", False)
    dollar_rule = (
        "Dollar figures are permitted in prose to anchor a recommendation. Use sparingly."
        if dollar_allowed
        else "NO dollar figures anywhere. Use price band (budget/mid/premium/luxury) and relative language only."
    )

    return f"""You are a ghostwriter for {brand}, writing as {name}.

PERSONA BACKGROUND: {background}

VOICE: {voice_notes}

PRICE RULE: {dollar_rule}

BANNED WORDS: {banned_words}

FORMATTING:
- H1: article title only (do not include in body)
- H2 for all main sections, H3 for subsections
- NO em dashes (—) or double dashes (--) anywhere. Use commas, periods, or parentheses instead.
- No horizontal rules.
- FAQ section: exactly 5 Q&A pairs.

LANGUAGE: American English throughout.

OUTPUT FORMAT: Return the article body only (no frontmatter). Start with the intro paragraph directly."""


# ---------------------------------------------------------------------------
# Frontmatter builder
# ---------------------------------------------------------------------------

def build_frontmatter(
    article: dict,
    product_keys: list,
    products: dict,
    title: str,
    description: str,
    site_config: dict,
) -> str:
    """Build YAML frontmatter. Reads author from site_config persona path (R10)."""
    today = date.today().isoformat()
    article_type = article["type"].lower().replace(" ", "_")
    layout_type = article_type  # buyer_guide maps 1:1 in platform

    # R10: derive author ID from persona config_path
    persona_path = site_config.get("persona", {}).get("config_path", "config/personas/unknown.yaml")
    author_id = Path(persona_path).stem  # "config/personas/emily.yaml" → "emily"

    # Build products list
    assigned_keys = product_keys
    if article_type == "comparison" and len(assigned_keys) >= 2:
        roles = ["primary", "alternative"]
    elif article_type == "roundup":
        roles = ["best_overall"] + ["also_consider"] * (len(assigned_keys) - 1)
    elif article_type == "review":
        roles = ["primary"]
    elif article_type == "buyer_guide":
        roles = ["best_overall"] + ["also_consider"] * (len(assigned_keys) - 1)
    else:
        roles = ["also_consider"] * len(assigned_keys)

    def _cy(s):
        return s.replace("\u2014", ",").replace("\u2013", ",").replace('"', '\\"')

    prod_refs = []
    for i, key in enumerate(assigned_keys):
        role = roles[i] if i < len(roles) else "also_consider"
        p = products.get(key, {})
        pros = [_cy(x) for x in p.get("default_pros", [])[:2]]
        cons = [_cy(x) for x in p.get("default_cons", [])[:1]]
        ref = f'  - id: "{key}"\n    role: "{role}"'
        if pros:
            ref += "\n    article_specific_pros:\n" + "\n".join(f'      - "{pr}"' for pr in pros)
        if cons:
            ref += "\n    article_specific_cons:\n" + "\n".join(f'      - "{c}"' for c in cons)
        prod_refs.append(ref)

    products_yaml = "\n".join(prod_refs) if prod_refs else "  []"

    comparison_fields = ""
    if article_type == "comparison" and len(assigned_keys) >= 2:
        comparison_fields = (
            f'product_a: "{assigned_keys[0]}"\n'
            f'product_b: "{assigned_keys[1]}"\n'
            f'# winner: product_a  # SET THIS after review\n'
            f'# winner_reason: ""  # SET THIS after review\n'
        )

    hub_slug_tag = article.get("hub_slug", article.get("hub", ""))
    tags = [hub_slug_tag, article["type"].lower()]

    def _clean_yaml(s: str) -> str:
        return s.replace("\u2014", ",").replace("\u2013", ",").replace('"', '\\"')

    safe_title = _clean_yaml(title) if title else article["keyword"].title()
    safe_desc = _clean_yaml(description) if description else ""
    hub = article.get("hub_slug", article.get("hub", ""))
    img_n = (article.get("id", 1) - 1) % 8 + 1
    hero_image = article.get("hero_image") or f"articles/{hub}-{img_n}.jpg"
    hero_alt = _clean_yaml(article.get("hero_image_alt", "") or safe_title)

    # R10: category from article (populated by enrich_article)
    category = article.get("category_label", article.get("category_slug", ""))

    return f"""---
title: "{safe_title}"
slug: "{article['slug']}"
type: "{layout_type}"
date: {today}
author: "{author_id}"
category: "{category}"
hub: "{hub}"
hero_image: "{hero_image}"
hero_image_alt: "{hero_alt}"
description: "{safe_desc}"
target_keyword: "{article['keyword']}"
products:
{products_yaml}
tags: {json.dumps(tags)}
disclosure_required: true
noindex: false
{comparison_fields}---

"""


# ---------------------------------------------------------------------------
# Review .txt builder
# ---------------------------------------------------------------------------

def build_review_txt(
    article: dict, product_keys: list, body: str, title: str, description: str
) -> str:
    products_line = ", ".join(product_keys) or "none"
    return f"""TITLE: {title}
DESC: {description}

---
Article ID {article['id']} | {article['type']} | Hub: {article['hub']}
Hub: {article.get('hub_label', '')} ({article.get('hub_url', '')}) | KD: {article.get('kd', 0)} | Vol: {article.get('volume', 0)}
Products: {products_line}
---

{body}
"""


# ---------------------------------------------------------------------------
# Post-processing (preserved verbatim from MLT — R9)
# ---------------------------------------------------------------------------

def _americanize(text: str) -> str:
    """Convert British spellings to American English."""
    replacements = [
        (r"\bcolours?\b", lambda m: "colors" if m.group().endswith("s") else "color"),
        (r"\bcolour(ed|ing|ful|less|s)?\b", lambda m: "color" + (m.group(1) or "")),
        (r"\bflavours?\b", lambda m: "flavors" if m.group().endswith("s") else "flavor"),
        (r"\bhonours?\b", lambda m: "honors" if m.group().endswith("s") else "honor"),
        (r"\bhumours?\b", lambda m: "humors" if m.group().endswith("s") else "humor"),
        (r"\blabours?\b", lambda m: "labors" if m.group().endswith("s") else "labor"),
        (r"\bneighbou?rs?\b", lambda m: "neighbors" if m.group().endswith("s") else "neighbor"),
        (r"\bfavou?r(ite|s|ed|ing)?\b", lambda m: "favor" + (m.group(1) or "")),
        (r"\brealise(d|s|r|rs|ing)?\b", lambda m: "realize" + (m.group(1) or "")),
        (r"\brecognise(d|s|r|rs|ing)?\b", lambda m: "recognize" + (m.group(1) or "")),
        (r"\borganise(d|s|r|rs|ing|ation|ations)?\b", lambda m: "organize" + (m.group(1) or "")),
        (r"\bprioritise(d|s|ing)?\b", lambda m: "prioritize" + (m.group(1) or "")),
        (r"\bminimise(d|s|ing)?\b", lambda m: "minimize" + (m.group(1) or "")),
        (r"\bmaximise(d|s|ing)?\b", lambda m: "maximize" + (m.group(1) or "")),
        (r"\bemphasise(d|s|ing)?\b", lambda m: "emphasize" + (m.group(1) or "")),
        (r"\bspecialise(d|s|ing)?\b", lambda m: "specialize" + (m.group(1) or "")),
        (r"\bcentralise(d|s|ing)?\b", lambda m: "centralize" + (m.group(1) or "")),
        (r"\bcentre(d|s|ing)?\b", lambda m: "center" + (m.group(1) or "")),
        (r"\bmetres?\b", lambda m: "meters" if m.group().endswith("s") else "meter"),
        (r"\bfibres?\b", lambda m: "fibers" if m.group().endswith("s") else "fiber"),
        (r"\btheatres?\b", lambda m: "theaters" if m.group().endswith("s") else "theater"),
        (r"\bfertiliser(s)?\b", lambda m: "fertilizer" + (m.group(1) or "")),
        (r"\bfertilise(d|s|ing)?\b", lambda m: "fertilize" + (m.group(1) or "")),
        (r"\btravell(ing|ed|er|ers)\b", lambda m: "travel" + m.group(1)),
        (r"\bcancell(ed|ing)\b", lambda m: "cancel" + m.group(1)),
        (r"\blabelled?\b", "labeled"),
        (r"\bchannelled?\b", "channeled"),
        (r"\bcatalogued?\b", "cataloged"),
        (r"\baluminium\b", "aluminum"),
        (r"\bgrey\b", "gray"),
        (r"\bGrey\b", "Gray"),
        (r"\bwhilst\b", "while"),
        (r"\bamongst\b", "among"),
        (r"\btowards\b", "toward"),
        (r"\bafterwards\b", "afterward"),
        (r"\bdefence\b", "defense"),
        (r"\blicence\b", "license"),
        (r"\bpractise\b", "practice"),
        (r"\btyre(s)?\b", lambda m: "tires" if m.group().endswith("s") else "tire"),
        (r"\bkerb(s)?\b", lambda m: "curbs" if m.group().endswith("s") else "curb"),
    ]
    for pattern, repl in replacements:
        if callable(repl):
            text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
        else:
            text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    return text


def _enforce_price_ban(body: str, dollar_allowed: bool) -> str:
    """
    Post-process: replace banned price phrases when dollar_figures.allowed = false.
    The model occasionally writes these despite instructions — catch them here.
    """
    if dollar_allowed:
        return body
    # Replace banned phrases with neutral alternatives that preserve meaning
    # Only applied outside <script> blocks (JSON-LD schema)
    script_pattern = re.compile(r'<script[^>]*>.*?</script>', re.DOTALL)
    scripts = script_pattern.findall(body)
    body_no_scripts = script_pattern.sub('\x00SCRIPT\x00', body)

    replacements = [
        (r'\bpriced at\b', 'positioned at'),
        (r'\btypically around\b', 'generally'),
        (r'\bstarting at\b', 'beginning at'),
        (r'\bcosts about\b', 'falls in the'),
        (r'\bfor under \$', 'for a budget buy, '),
        (r'\baround \$\d+', 'in the mid-range'),
        (r'\$\d+[\.,]?\d*', ''),  # remove any remaining dollar amounts
    ]
    for pattern, replacement in replacements:
        body_no_scripts = re.sub(pattern, replacement, body_no_scripts, flags=re.IGNORECASE)

    # Restore script blocks
    script_iter = iter(scripts)
    body = re.sub(r'\x00SCRIPT\x00', lambda _: next(script_iter), body_no_scripts)
    return body


def _enforce_intro_length(body: str, max_words: int = 120) -> str:
    """Post-process: trim intro to max_words if over limit."""
    lines = body.split('\n')
    h2_idx = next((i for i, l in enumerate(lines) if l.startswith('## ')), None)
    if h2_idx is None:
        return body
    intro_lines = lines[:h2_idx]
    rest_lines = lines[h2_idx:]
    intro_text = '\n'.join(intro_lines).strip()
    words = intro_text.split()
    if len(words) <= max_words:
        return body
    # Truncate at last sentence boundary within max_words
    truncated = ' '.join(words[:max_words])
    # Walk back to nearest sentence end [.!?]
    for i in range(len(truncated) - 1, max(0, len(truncated) - 40), -1):
        if truncated[i] in '.!?':
            truncated = truncated[:i + 1]
            break
    return truncated + '\n\n' + '\n'.join(rest_lines)


def _enforce_faq_sentence_limit(body: str, max_sentences: int = 4) -> str:
    """
    Post-process: truncate FAQ answers that exceed max_sentences.
    Uses the same sentence-counting heuristic as the validator (validate-roundup.mjs).
    """
    faq_marker = "\n## Frequently Asked Questions"
    faq_start = body.find(faq_marker)
    if faq_start == -1:
        return body

    pre_faq = body[:faq_start]
    faq_section = body[faq_start:]

    def count_sentences(text: str) -> int:
        t = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
        t = re.sub(r'[*_`]', '', t).strip()
        if not t:
            return 0
        matches = re.findall(r'[.!?](?=\s+[A-Z]|$)', t)
        return len(matches) if matches else (1 if len(t) > 20 else 0)

    def truncate_to_n(text: str, n: int) -> str:
        if count_sentences(text) <= n:
            return text
        # Find inter-sentence boundaries: [.!?] followed by space+capital
        ends = list(re.finditer(r'[.!?](?=\s+[A-Z])', text))
        # n boundaries → n+1 sentences; cut after boundary n-1 (0-indexed n-1)
        if len(ends) >= n:
            cut = ends[n - 1].end()
            return text[:cut].strip()
        return text

    # Split FAQ on H3 boundaries
    lines = faq_section.split('\n')
    result_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        result_lines.append(line)
        if line.startswith('### '):
            # Collect answer lines until next H3, H2, or script block
            answer_lines = []
            i += 1
            while i < len(lines):
                l = lines[i]
                if l.startswith('### ') or l.startswith('## ') or l.startswith('<script'):
                    break
                answer_lines.append(l)
                i += 1
            answer_text = '\n'.join(answer_lines).rstrip()
            truncated = truncate_to_n(answer_text, max_sentences)
            result_lines.append(truncated)
            # Don't increment i — outer loop will handle the break line
            continue
        i += 1

    return pre_faq + '\n'.join(result_lines)


def _fix_punctuation(text: str) -> str:
    """Hard-fix punctuation the model generates despite instructions."""
    # Em/en dashes at line boundaries produce orphan commas — strip rather than replace
    text = re.sub(r"[ \t]*[\u2014\u2013][ \t]*\n", "\n", text)   # trailing dash before newline
    text = re.sub(r"\n[ \t]*[\u2014\u2013][ \t]*", "\n", text)   # leading dash after newline
    # Intra-sentence dashes: replace with comma-space
    text = text.replace("\u2014", ", ")
    text = text.replace("\u2013", ", ")
    text = text.replace("---", ", ")
    text = text.replace(" -- ", ", ")
    text = text.replace("--", ", ")
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r",\s*\)", ")", text)
    text = re.sub(r"\(\s*,", "(", text)
    text = re.sub(r",\s*,", ",", text)
    text = re.sub(r",\s*\.", ".", text)
    text = re.sub(r"[^\S\n]{2,}", " ", text)
    return text


def _strip_spurious_commas(body: str) -> str:
    """Remove all comma-only lines — they are model artifacts now that image injection is post-process."""
    lines = body.split("\n")
    out = [line for line in lines if line.strip() not in (",", ", ")]
    result = "\n".join(out)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result


def inject_body_images(body: str, body_images, hub: str) -> str:
    """Strip model-written images and inject provided body_images at 4 structural positions.

    Positions (in order, skipped if anchor not found):
      1. Before first ## heading (end of intro)
      2. Before ## How to Choose / ## Buying Guide (end of Top Picks)
      3. Before ## Frequently Asked Questions (end of buying guide)
      4. Before closing JSON-LD script block or end of body (end of FAQ)

    If body_images is None or empty, still strips model-written images and returns.
    """
    # Strip any model-written image markdown
    body = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', body)
    body = re.sub(r'\n{3,}', '\n\n', body)

    if not body_images:
        return body

    images = list(body_images)  # consume in order

    def _img_md(path: str, hub_slug: str) -> str:
        return f'\n\n![{hub_slug} product image]({path})\n'

    def _insert_before(text: str, pattern: str, img_path: str) -> tuple[str, bool]:
        m = re.search(pattern, text, re.MULTILINE)
        if not m:
            return text, False
        pos = m.start()
        block = _img_md(img_path, hub)
        return text[:pos] + block + '\n' + text[pos:], True

    # Position 1: before first ##
    if images:
        body, inserted = _insert_before(body, r'^##\s', images[0])
        if inserted:
            images.pop(0)

    # Position 2: before How to Choose / Buying Guide
    if images:
        body, inserted = _insert_before(body, r'^##\s+(How to Choose|Buying Guide)', images[0])
        if inserted:
            images.pop(0)

    # Position 3: before FAQ
    if images:
        body, inserted = _insert_before(body, r'^##\s+Frequently Asked Questions', images[0])
        if inserted:
            images.pop(0)

    # Position 4: before closing JSON-LD or end
    if images:
        body, inserted = _insert_before(body, r'<script type="application/ld\+json">', images[0])
        if not inserted:
            body = body.rstrip() + _img_md(images[0], hub) + '\n'

    return re.sub(r'\n{3,}', '\n\n', body)
_AI_TELL_PHRASES = [
    "in this article",
    "in this guide",
    "in today's world",
    "when it comes to",
    "look no further",
    "let's dive in",
    "the perfect",
    "game-changer",
    "elevate your",
    "navigate the world of",
    "without further ado",
]

# Sentence boundary pattern — splits on . ? ! followed by whitespace or end of string
_SENTENCE_RE = re.compile(r'(?<=[.?!])\s+')


def _enforce_ai_tell_bans(body: str) -> str:
    """Remove sentences containing banned AI-tell phrases. Logs each removal."""
    # Only scrub prose — leave JSON-LD blocks intact
    json_marker = '<script type="application/ld+json">'
    if json_marker in body:
        prose, _, rest = body.partition(json_marker)
        return _enforce_ai_tell_bans(prose) + json_marker + rest

    lines = body.split("\n")
    cleaned_lines = []
    for line in lines:
        # Skip heading lines, image lines, frontmatter-style lines
        if line.startswith("#") or line.startswith("!") or line.startswith("---"):
            cleaned_lines.append(line)
            continue

        for phrase in _AI_TELL_PHRASES:
            if phrase.lower() in line.lower():
                # Try to remove just the sentence containing the phrase
                sentences = _SENTENCE_RE.split(line)
                kept = [s for s in sentences if phrase.lower() not in s.lower()]
                if kept:
                    print(f"  [AI-TELL] removed sentence containing '{phrase}'")
                    line = " ".join(kept)
                else:
                    # Whole line is the offending sentence — drop it
                    print(f"  [AI-TELL] removed line containing '{phrase}'")
                    line = ""
                break  # one phrase per line pass is enough
        cleaned_lines.append(line)

    # Collapse any double blank lines left by removals
    result = "\n".join(cleaned_lines)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result
