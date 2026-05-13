#!/usr/bin/env python3
"""
Secondary pass for VERIFY-prefixed product entries in products.yaml.

Searches Rainforest API by product title for any entry where asin is
"VERIFY" or "NOT_FOUND". Resolves to a real ASIN or marks as NOT_ON_AMAZON.

Run after source-products-rainforest.py when VERIFY entries remain.

Usage:
  python3 tools/resolve-verify-asins.py --site <slug>
  python3 tools/resolve-verify-asins.py --site <slug> --dry-run
  python3 tools/resolve-verify-asins.py --site <slug> --resume

Cost:
  ~$0.005-0.01 per Rainforest API call.
  Typical: a few dollars for a 300-article site's VERIFY backlog.

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
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
import yaml
from typing import Optional

CHECKPOINT_EVERY = 20
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


# ── API ───────────────────────────────────────────────────────────────────────

def search_amazon(query: str, api_key: str) -> Optional[dict]:
    try:
        resp = requests.get(
            "https://api.rainforestapi.com/request",
            params={
                "api_key": api_key,
                "type": "search",
                "amazon_domain": "amazon.com",
                "search_term": query,
            },
            timeout=30,
        )
        resp.raise_for_status()
        results = resp.json().get("search_results", [])
        qualified = [r for r in results if r.get("ratings_total", 0) >= 50]
        pool = qualified or results
        return pool[0] if pool else None
    except Exception as e:
        print(f"    API error: {e}")
        return None


def result_to_resolution(r: dict) -> dict:
    asin = r.get("asin", "")
    return {
        "asin": asin,
        "title": r.get("title", ""),
        "brand": r.get("brand") or r.get("manufacturer") or "",
        "source_url": r.get("link") or f"https://www.amazon.com/dp/{asin}",
    }


# ── Resolution ────────────────────────────────────────────────────────────────

def apply_resolution(entry: dict, res: dict) -> None:
    if res.get("not_on_amazon"):
        entry["asin"] = "NOT_ON_AMAZON"
        entry.pop("rationale", None)
        return
    entry["title"] = res["title"]
    entry["asin"] = res["asin"]
    entry["brand"] = res.get("brand")
    entry["source_url"] = res.get("source_url") or f"https://www.amazon.com/dp/{res['asin']}"
    entry["sourced_at"] = NOW
    entry["confidence"] = 0.75
    entry.pop("rationale", None)


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
        description="Resolve VERIFY-prefixed ASINs via Rainforest API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--site", required=True, metavar="SLUG",
                        help="Site slug (site root is ~/SLUG)")
    parser.add_argument("--resume", action="store_true",
                        help="Skip keys already resolved in a prior run")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be resolved without making API calls")
    parser.add_argument("--reset-state", action="store_true",
                        help="Clear state file and start fresh")
    args = parser.parse_args()

    site_root = Path.home() / args.site
    products_path = site_root / "content/products/products.yaml"
    state_file = Path(f"/tmp/resolve-verify-asins-{args.site}-state.json")

    if not site_root.exists():
        print(f"ERROR: site root not found: {site_root}", file=sys.stderr)
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
    print()

    products = load_products(products_path)
    verify_keys = [
        k for k, v in products.items()
        if isinstance(v, dict) and v.get("asin") in ("VERIFY", "NOT_FOUND")
        and k not in done
    ]

    print(f"Products in catalog: {len(products)}")
    print(f"VERIFY/NOT_FOUND:    {len(verify_keys) + len(done)}")
    print(f"Already done:        {len(done)}")
    print(f"To resolve:          {len(verify_keys)}")
    print()

    if not verify_keys:
        print("Nothing to resolve.")
        return

    resolved = not_found = api_calls = 0

    for i, key in enumerate(verify_keys, 1):
        entry = products[key]
        prefix = f"[{i}/{len(verify_keys)}]"

        title = entry.get("title", "")
        search_term = title.replace("VERIFY:", "").replace("VERIFY: ", "").strip()
        if not search_term:
            search_term = key.replace("VERIFY-", "").replace("-", " ")

        print(f"{prefix} {key}")
        print(f"         search: {search_term[:80]}")

        if args.dry_run:
            print(f"         [dry-run] would search Rainforest for: {search_term[:60]}")
            done.add(key)
            continue

        result = search_amazon(search_term, api_key)
        api_calls += 1

        if result and result.get("asin"):
            res = result_to_resolution(result)
            apply_resolution(entry, res)
            reviews = result.get("ratings_total", "?")
            print(f"         → {res['asin']} ({reviews} reviews): {res['title'][:60]}")
            resolved += 1
        else:
            entry["asin"] = "NOT_FOUND"
            entry.pop("rationale", None)
            print(f"         → no result")
            not_found += 1

        done.add(key)

        if api_calls % CHECKPOINT_EVERY == 0:
            print(f"\n  [checkpoint] saving after {api_calls} API calls...\n")
            save_products(products, products_path)
            save_state(done, state_file)

        time.sleep(0.4)

    print(f"\nFinal save...")
    save_products(products, products_path)
    save_state(done, state_file)

    remaining = len([
        k for k, v in products.items()
        if isinstance(v, dict) and v.get("asin") == "VERIFY"
    ])
    print(f"\nDone.")
    print(f"  Resolved:        {resolved}")
    print(f"  Not found:       {not_found}")
    print(f"  API calls:       {api_calls}")
    print(f"  VERIFY remaining:{remaining}")
    print(f"  State file:      {state_file}")


if __name__ == "__main__":
    main()
