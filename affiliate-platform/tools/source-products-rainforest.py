#!/usr/bin/env python3
"""
Bulk product sourcing via Rainforest API.

For each article in pipeline.json with an empty products[] field, searches
Rainforest for the article keyword, picks the top results, adds them to
products.yaml, and assigns product keys back to pipeline.json.

Usage:
  python3 tools/source-products-rainforest.py --site <slug>
  python3 tools/source-products-rainforest.py --site <slug> --limit 10
  python3 tools/source-products-rainforest.py --site <slug> --resume
  python3 tools/source-products-rainforest.py --site <slug> --dry-run

Cost:
  ~$0.005-0.01 per Rainforest API call (1 call per article keyword).
  A 300-article site costs approximately $1.50-3.00 total.

Prerequisites:
  RAINFOREST_KEY in <site_root>/config/credentials.env or RAINFOREST_KEY env var.

Exit:
  0 = complete
  1 = interrupted (state preserved for --resume)
  2 = tool error (missing credentials, files, etc.)
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
import yaml

MIN_RESULTS = 5
MAX_RESULTS = 7
MIN_REVIEWS = 50
CHECKPOINT_EVERY = 25
NOW = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ── Credentials ───────────────────────────────────────────────────────────────

def load_rainforest_key(site_root: Path) -> str:
    key = os.environ.get("RAINFOREST_KEY")
    if not key:
        creds = site_root / "config/credentials.env"
        if creds.exists():
            for line in creds.read_text().splitlines():
                if line.startswith("RAINFOREST_KEY="):
                    key = line.split("=", 1)[1].strip()
    if not key:
        creds_path = site_root / "config/credentials.env"
        print(
            f"ERROR: RAINFOREST_KEY not set.\n"
            f"  Add it to {creds_path}\n"
            f"  or set the RAINFOREST_KEY environment variable.",
            file=sys.stderr,
        )
        sys.exit(2)
    return key


# ── Helpers ───────────────────────────────────────────────────────────────────

def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[''']", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def make_product_key(brand: str, title: str, used_keys: set) -> str:
    brand_s = slugify(brand or "")
    title_s = slugify(title or "")
    if brand_s and title_s.startswith(brand_s + "-"):
        title_s = title_s[len(brand_s) + 1:]
    parts = title_s.split("-")[:5]
    descriptor = "-".join(p for p in parts if p)
    base = f"{brand_s}-{descriptor}" if brand_s else descriptor
    base = base[:60].rstrip("-")
    key = base
    n = 2
    while key in used_keys:
        key = f"{base[:56]}-{n}"
        n += 1
    return key


# ── API ───────────────────────────────────────────────────────────────────────

def search(keyword: str, api_key: str, dry_run: bool) -> list:
    if dry_run:
        return []
    try:
        resp = requests.get(
            "https://api.rainforestapi.com/request",
            params={
                "api_key": api_key,
                "type": "search",
                "amazon_domain": "amazon.com",
                "search_term": keyword,
            },
            timeout=30,
        )
        resp.raise_for_status()
        results = resp.json().get("search_results", [])
        qualified = [r for r in results if r.get("ratings_total", 0) >= MIN_REVIEWS]
        pool = qualified if len(qualified) >= MIN_RESULTS else results
        return pool[:MAX_RESULTS]
    except Exception as e:
        print(f"    API error: {e}")
        return []


# ── I/O (atomic) ──────────────────────────────────────────────────────────────

def load_pipeline(pipeline_path: Path) -> dict:
    with open(pipeline_path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {"articles": data}
    return data


def save_pipeline(data: dict, pipeline_path: Path) -> None:
    tmp = pipeline_path.with_suffix(".json.tmp")
    bak = pipeline_path.with_suffix(".json.bak")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    if pipeline_path.exists():
        shutil.copy2(pipeline_path, bak)
    os.replace(tmp, pipeline_path)


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


# ── State (resume) ────────────────────────────────────────────────────────────

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
        description="Bulk product sourcing via Rainforest API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--site", required=True, metavar="SLUG",
                        help="Site slug (site root is ~/SLUG)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most N articles (test mode)")
    parser.add_argument("--resume", action="store_true",
                        help="Skip articles already sourced in a prior run")
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip API calls; show what would be sourced")
    parser.add_argument("--reset-state", action="store_true",
                        help="Clear resume state file and start fresh")
    args = parser.parse_args()

    site_root = Path.home() / args.site
    pipeline_path = site_root / "data/pipeline.json"
    products_path = site_root / "content/products/products.yaml"
    state_file = Path(f"/tmp/source-products-rainforest-{args.site}-state.json")

    if not site_root.exists():
        print(f"ERROR: site root not found: {site_root}", file=sys.stderr)
        sys.exit(2)
    if not pipeline_path.exists():
        print(f"ERROR: pipeline.json not found: {pipeline_path}", file=sys.stderr)
        sys.exit(2)
    if not products_path.exists():
        print(f"ERROR: products.yaml not found: {products_path}", file=sys.stderr)
        sys.exit(2)

    api_key = load_rainforest_key(site_root)

    if args.reset_state and state_file.exists():
        state_file.unlink()
        print("State file cleared.")

    done = load_state(state_file) if args.resume else set()

    print(f"Site:       {args.site}")
    print(f"Site root:  {site_root}")
    if args.dry_run:
        print("Mode:       DRY RUN — no API calls")
    if args.resume:
        print(f"Resume:     {len(done)} articles already sourced")
    print()

    pipeline_data = load_pipeline(pipeline_path)
    products = load_products(products_path)
    articles = pipeline_data.get("articles", [])

    candidates = [a for a in articles if not a.get("products") and a["slug"] not in done]
    if args.limit:
        candidates = candidates[:args.limit]

    total_empty = len([a for a in articles if not a.get("products")])
    print(f"Articles in pipeline: {len(articles)}")
    print(f"Need products:        {total_empty}")
    print(f"Already done (state): {len(done)}")
    print(f"To process this run:  {len(candidates)}")
    if args.limit:
        print(f"Limit:                {args.limit} (test mode)")
    print()

    if not candidates:
        print("Nothing to do.")
        return

    # Build ASIN → existing key map to avoid duplicates
    asin_to_key = {
        v["asin"]: k for k, v in products.items()
        if isinstance(v, dict) and v.get("asin")
        and v["asin"] not in ("VERIFY", "NOT_FOUND", "NOT_ON_AMAZON")
    }
    used_keys = set(products.keys())

    sourced = new_total = 0

    for i, article in enumerate(candidates, 1):
        slug = article["slug"]
        keyword = article.get("keyword") or slug.replace("-", " ")
        hub = article.get("hub", "")
        prefix = f"[{i}/{len(candidates)}]"

        print(f"{prefix} {slug}")
        print(f"         keyword: {keyword}")

        if args.dry_run:
            print(f"         [dry-run] would search Rainforest for: {keyword}")
            done.add(slug)
            continue

        results = search(keyword, api_key, args.dry_run)
        time.sleep(0.4)

        if not results:
            print(f"         → no results, skipping")
            continue

        assigned_keys = []
        new_count = 0

        for r in results:
            asin = r.get("asin", "")
            if not asin:
                continue
            if asin in asin_to_key:
                assigned_keys.append(asin_to_key[asin])
                continue

            title = r.get("title", "")
            brand = r.get("brand") or r.get("manufacturer") or ""
            link = r.get("link") or f"https://www.amazon.com/dp/{asin}"

            key = make_product_key(brand, title, used_keys)
            used_keys.add(key)
            asin_to_key[asin] = key
            products[key] = {
                "title": title,
                "asin": asin,
                "brand": brand or None,
                "hub": hub,
                "source_url": link,
                "sourced_at": NOW,
                "confidence": 0.75,
            }
            assigned_keys.append(key)
            new_count += 1

        article["products"] = assigned_keys
        done.add(slug)
        sourced += 1
        new_total += new_count
        reused = len(assigned_keys) - new_count
        print(f"         → {len(assigned_keys)} products ({new_count} new, {reused} reused)")

        if i % CHECKPOINT_EVERY == 0:
            print(f"\n  [checkpoint] saving at article {i}...\n")
            save_products(products, products_path)
            save_pipeline(pipeline_data, pipeline_path)
            save_state(done, state_file)

    print("\nFinal save...")
    save_products(products, products_path)
    save_pipeline(pipeline_data, pipeline_path)
    save_state(done, state_file)

    remaining = len([a for a in articles if not a.get("products")])
    print(f"\nDone.")
    print(f"  Articles sourced:     {sourced}/{len(candidates)}")
    print(f"  New products:         {new_total}")
    print(f"  Total in catalog:     {len(products)}")
    print(f"  Articles still empty: {remaining}")
    print(f"  State file:           {state_file}")


if __name__ == "__main__":
    main()
