#!/usr/bin/env python3
"""
Generate real default_pros / default_cons for products in products.yaml
via Claude Haiku. Idempotent, resumable, incremental.

Usage:
  python3 tools/generate-product-pros-cons.py --site <slug>
  python3 tools/generate-product-pros-cons.py --site <slug> --limit 10
  python3 tools/generate-product-pros-cons.py --site <slug> --hub grinders
  python3 tools/generate-product-pros-cons.py --site <slug> --reset-state

Cost:
  Claude Haiku: $0.80/$4.00 per million tokens (input/output).
  Typical: ~$0.80-1.00 for 1,000-1,500 products (~$0.0007/product).

Prerequisites:
  ANTHROPIC_API_KEY in <site_root>/config/credentials.env or env var.

Exit:
  0 = complete
  2 = tool error (missing credentials, files, etc.)
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

import anthropic
import yaml

CHECKPOINT_EVERY = 10


# ── Credentials ───────────────────────────────────────────────────────────────

def load_anthropic_key(site_root: Path) -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        creds = site_root / "config/credentials.env"
        if creds.exists():
            for line in creds.read_text().splitlines():
                if line.startswith("ANTHROPIC_API_KEY="):
                    key = line.split("=", 1)[1].strip()
    if not key:
        creds_path = site_root / "config/credentials.env"
        print(
            f"ERROR: ANTHROPIC_API_KEY not set.\n"
            f"  Add it to {creds_path}\n"
            f"  or set the ANTHROPIC_API_KEY environment variable.",
            file=sys.stderr,
        )
        sys.exit(2)
    return key


# ── Idempotency ───────────────────────────────────────────────────────────────

_PLACEHOLDER_PATTERNS = re.compile(
    r"^(Well-reviewed|From |Strong customer ratings|Verify specifications)",
    re.IGNORECASE,
)


def _is_placeholder(pros: list) -> bool:
    if not pros:
        return True
    return any(_PLACEHOLDER_PATTERNS.match(str(p)) for p in pros)


def needs_generation(product: dict) -> bool:
    return _is_placeholder(product.get("default_pros", []))


def is_skippable(product: dict) -> bool:
    asin = str(product.get("asin") or product.get("amazon_asin") or "")
    return asin in ("", "NOT_ON_AMAZON", "NOT_FOUND", "VERIFY")


# ── Prompt ────────────────────────────────────────────────────────────────────

def build_prompt(key: str, product: dict) -> str:
    title = product.get("title") or product.get("name") or key
    if len(title) > 120:
        title = title[:117].rsplit(" ", 1)[0] + "..."
    brand = product.get("brand") or "Unknown"
    hub = product.get("hub") or "product"
    hub_label = hub.replace("-", " ")
    asin = product.get("asin") or product.get("amazon_asin") or "unknown"

    return f"""Generate honest pros and cons for this product, based only on what is inferable from its title, brand, and category. Do not invent specific defects or features that the title does not suggest.

Product: {title}
Brand: {brand}
Category: {hub_label}
ASIN: {asin}

Return JSON ONLY (no markdown, no explanation):
{{
  "pros": ["...", "..."],
  "cons": ["..."]
}}

Guidelines:
- Pros: 2-3 items, each 6-12 words. Focus on features named in the title (specific mechanism, capacity, build material), brand reputation in this category, or price-tier value implied by the listing.
- Cons: 1-2 items, each 6-12 words. Use honest class-level or price-tier tradeoffs. Examples of acceptable cons: "Manual lever requires technique to dial in", "Single boiler limits simultaneous brewing and steaming", "Blade grinder produces uneven particle size".
- Bad cons (DO NOT WRITE): specific defects, reliability claims, "breaks after X months", customer complaint language. These are claims you cannot verify from the title alone.
- If the title contains a model name or spec (e.g. "20 Bar", "burr grinder", "double-walled"), reference it directly in a pro.
- Keep all items factual and usable as product card bullet points on a review site."""


# ── API ───────────────────────────────────────────────────────────────────────

def generate_pros_cons(client: anthropic.Anthropic, key: str, product: dict) -> dict:
    prompt = build_prompt(key, product)
    for attempt in range(3):
        try:
            msg = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=256,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = msg.content[0].text.strip()
            raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
            data = json.loads(raw)
            pros = [str(p).strip() for p in data.get("pros", []) if str(p).strip()][:3]
            cons = [str(c).strip() for c in data.get("cons", []) if str(c).strip()][:2]
            if not pros:
                raise ValueError("No pros returned")
            return {
                "pros": pros,
                "cons": cons,
                "input_tokens": msg.usage.input_tokens,
                "output_tokens": msg.usage.output_tokens,
            }
        except (json.JSONDecodeError, ValueError, anthropic.APIError) as e:
            if attempt == 2:
                raise
            print(f"    Retry {attempt + 1}/3 — {e}")
            time.sleep(2 ** attempt)


# ── I/O (atomic) ──────────────────────────────────────────────────────────────

def load_products(products_path: Path) -> dict:
    with open(products_path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_products(products: dict, products_path: Path) -> None:
    tmp = products_path.with_suffix(".yaml.tmp")
    bak = products_path.with_suffix(".yaml.bak")
    with open(tmp, "w", encoding="utf-8") as f:
        yaml.dump(products, f, allow_unicode=True, default_flow_style=False,
                  sort_keys=False, width=120)
    if products_path.exists():
        shutil.copy2(products_path, bak)
    os.replace(tmp, products_path)


# ── State ─────────────────────────────────────────────────────────────────────

def load_state(state_file: Path) -> set:
    if state_file.exists():
        try:
            return set(json.loads(state_file.read_text()))
        except Exception:
            pass
    return set()


def save_state(done: set, state_file: Path) -> None:
    state_file.write_text(json.dumps(sorted(done)))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate default_pros/cons for products via Claude Haiku",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--site", required=True, metavar="SLUG",
                        help="Site slug (site root is ~/SLUG)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most N products (test mode)")
    parser.add_argument("--hub", default=None,
                        help="Only process products from this hub slug")
    parser.add_argument("--reset-state", action="store_true",
                        help="Clear state file and start fresh")
    args = parser.parse_args()

    site_root = Path.home() / args.site
    products_path = site_root / "content/products/products.yaml"
    state_file = Path(f"/tmp/generate-product-pros-cons-{args.site}-state.json")

    if not site_root.exists():
        print(f"ERROR: site root not found: {site_root}", file=sys.stderr)
        sys.exit(2)
    if not products_path.exists():
        print(f"ERROR: products.yaml not found: {products_path}", file=sys.stderr)
        sys.exit(2)

    if args.reset_state and state_file.exists():
        state_file.unlink()
        print("State file cleared.")

    api_key = load_anthropic_key(site_root)
    client = anthropic.Anthropic(api_key=api_key)
    products = load_products(products_path)
    done = load_state(state_file)

    candidates = [
        (k, v) for k, v in products.items()
        if isinstance(v, dict)
        and not is_skippable(v)
        and needs_generation(v)
        and k not in done
        and (args.hub is None or v.get("hub") == args.hub)
    ]

    total_eligible = len([
        k for k, v in products.items()
        if isinstance(v, dict) and not is_skippable(v) and needs_generation(v)
    ])

    print(f"Site:                   {args.site}")
    print(f"Products in catalog:    {len(products)}")
    print(f"Need generation:        {total_eligible}")
    print(f"Already done (state):   {len(done)}")
    print(f"To process this run:    {min(len(candidates), args.limit or len(candidates))}")
    if args.limit:
        print(f"Limit:                  {args.limit} (test mode)")
    print()

    if not candidates:
        print("Nothing to do. All products already have real pros/cons.")
        return

    if args.limit:
        candidates = candidates[:args.limit]

    total_input = total_output = 0
    processed = skipped_errors = 0

    for i, (key, product) in enumerate(candidates, 1):
        title_short = (product.get("title") or product.get("name") or key)[:60]
        hub = product.get("hub", "?")
        print(f"[{i:4d}/{len(candidates)}] {hub:16s}  {title_short}")

        try:
            result = generate_pros_cons(client, key, product)
        except Exception as e:
            print(f"    ERROR: {e} — skipping")
            skipped_errors += 1
            continue

        product["default_pros"] = result["pros"]
        product["default_cons"] = result["cons"]
        done.add(key)
        total_input += result["input_tokens"]
        total_output += result["output_tokens"]
        processed += 1

        print(f"    pros: {result['pros']}")
        print(f"    cons: {result['cons']}")
        print(f"    tokens: {result['input_tokens']}in / {result['output_tokens']}out")

        if processed % CHECKPOINT_EVERY == 0:
            print(f"\n  [checkpoint] saving after {processed} products...\n")
            save_products(products, products_path)
            save_state(done, state_file)

        time.sleep(0.15)

    print(f"\nFinal save...")
    save_products(products, products_path)
    save_state(done, state_file)

    cost_in  = total_input  / 1_000_000 * 0.80
    cost_out = total_output / 1_000_000 * 4.00
    total_cost = cost_in + cost_out

    print(f"\n=== Run complete ===")
    print(f"  Processed:     {processed}")
    print(f"  Errors/skip:   {skipped_errors}")
    print(f"  Input tokens:  {total_input:,}")
    print(f"  Output tokens: {total_output:,}")
    print(f"  Est. cost:     ${total_cost:.4f}")
    print(f"  State file:    {state_file}")


if __name__ == "__main__":
    main()
