"""
Loads platform prompt files and renders them with site-specific values.

Replaces script-level placeholders before passing to the model:
  {{PRODUCT_COUNT.min/max}}            — platform-defined per article type
  {{PERSONA_YAML}}                     — full persona YAML block
  {{STYLE_POLICY}}                     — full style_policy YAML block
  {STYLE_POLICY.buying_guide_heading.style} — resolved heading text
"""

import sys
import yaml
from pathlib import Path

PLATFORM_ROOT = Path(__file__).parent.parent
PROMPTS_DIR = PLATFORM_ROOT / "prompts"

# Map normalised article_type → prompt filename
_PROMPT_MAP = {
    "roundup":     "article-roundup.v1.md",
    "buyer_guide": "article-buyer-guide.v1.md",
    "comparison":  "article-buyer-guide.v1.md",
    "review":      "article-buyer-guide.v1.md",
}

# Platform-level product_count limits (not site-overridable per CATALOG-BEHAVIOUR.md)
_PRODUCT_COUNT = {
    "roundup":     {"min": 6, "max": 8},
    "buyer_guide": {"min": 3, "max": 5},
    "comparison":  {"min": 2, "max": 5},
    "review":      {"min": 1, "max": 3},
}

_BUYING_GUIDE_REMINDER = (
    "\n\n**WORD COUNT CHECK — BUYING GUIDE SECTION:** "
    "Before finalizing, count the words in your ## Buying Guide section. "
    "It must total 500–700 words across all H3 subsections. "
    "If it falls below 500, add one additional specific, decision-relevant sentence "
    "to the thinnest subsection — a genuine point, not padding."
)


def _normalise_type(article_type: str) -> str:
    """Map raw pipeline type strings to prompt keys."""
    mapping = {
        "roundup":    "roundup",
        "Roundup":    "roundup",
        "buyer_guide":"buyer_guide",
        "Buyer Guide":"buyer_guide",
        "buyer guide":"buyer_guide",
        "comparison": "comparison",
        "Comparison": "comparison",
        "review":     "review",
        "Review":     "review",
    }
    return mapping.get(article_type, article_type.lower().replace(" ", "_"))


def _validate_style_policy(sp: dict) -> list[str]:
    """Returns list of missing field paths. Empty = valid."""
    errors = []
    if "word_count" not in sp:
        errors.append("style_policy.word_count")
    else:
        for k in ("min", "max"):
            if k not in sp["word_count"]:
                errors.append(f"style_policy.word_count.{k}")
    if "dollar_figures" not in sp or "allowed" not in sp.get("dollar_figures", {}):
        errors.append("style_policy.dollar_figures.allowed")
    if "buying_guide_heading" not in sp or "style" not in sp.get("buying_guide_heading", {}):
        errors.append("style_policy.buying_guide_heading.style")
    return errors


def load_prompt(article_type: str, site_config: dict, persona: dict) -> tuple:
    """
    Returns (rendered_system_text, metadata_dict).

    rendered_system_text: platform prompt with all script-level placeholders resolved.
      Returns None for article types without a platform prompt (fallback to per-site SYSTEM).

    metadata_dict keys:
      product_count: {"min": int, "max": int}
      word_count: {"min": int, "max": int}
      prompt_file: str
      article_type: str (normalised)
      buying_guide_heading: str
      dollar_figures_allowed: bool

    Exits with code 2 if style_policy is absent or malformed.
    """
    norm_type = _normalise_type(article_type)
    prompt_file = _PROMPT_MAP.get(norm_type)

    sp = site_config.get("style_policy", {})

    # style_policy must be present and complete for ALL article types (not just prompted ones)
    errors = _validate_style_policy(sp)
    if errors:
        print(f"ERROR: site.config.yaml style_policy is absent or malformed.", file=sys.stderr)
        print(f"  Missing fields: {', '.join(errors)}", file=sys.stderr)
        print("  Cannot proceed without a complete style_policy block. Exiting.", file=sys.stderr)
        sys.exit(2)

    if not prompt_file:
        return None, {}

    prompt_path = PROMPTS_DIR / prompt_file
    if not prompt_path.exists():
        raise FileNotFoundError(f"Platform prompt not found: {prompt_path}")

    text = prompt_path.read_text(encoding="utf-8")

    pc = _PRODUCT_COUNT[norm_type]
    wc = sp["word_count"]
    bgh = sp["buying_guide_heading"]["style"]
    dollar_allowed = sp["dollar_figures"]["allowed"]

    # Build the {{STYLE_POLICY}} replacement block
    style_policy_block = (
        f"word_count:\n"
        f"  min: {wc['min']}\n"
        f"  max: {wc['max']}\n"
        f"dollar_figures:\n"
        f"  allowed: {'true' if dollar_allowed else 'false'}\n"
        f"buying_guide_heading:\n"
        f"  style: \"{bgh}\""
    )

    # Build persona YAML block
    persona_yaml = yaml.dump(persona, default_flow_style=False, allow_unicode=True).strip()

    # Replace script-level placeholders
    text = text.replace("{{PRODUCT_COUNT.min}}", str(pc["min"]))
    text = text.replace("{{PRODUCT_COUNT.max}}", str(pc["max"]))
    text = text.replace("{{PERSONA_YAML}}", persona_yaml)
    text = text.replace("{{STYLE_POLICY}}", style_policy_block)
    # Single-brace heading style used in body component order sections
    text = text.replace("{STYLE_POLICY.buying_guide_heading.style}", bgh)

    if norm_type == "buyer_guide":
        text += _BUYING_GUIDE_REMINDER

    metadata = {
        "product_count": pc,
        "word_count": wc,
        "prompt_file": prompt_file,
        "article_type": norm_type,
        "buying_guide_heading": bgh,
        "dollar_figures_allowed": dollar_allowed,
    }

    return text, metadata
