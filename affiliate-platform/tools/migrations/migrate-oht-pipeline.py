#!/usr/bin/env python3
"""
migrate-oht-pipeline.py — Migrate OHT pipeline.json to canonical envelope format.

Writes to pipeline.json.new (does not overwrite original).

Rules:
  Add:     category ("Home Entertaining"), category_slug ("home-entertaining")
           (category_label and category_slug already exist — canonical 'category' field is new)
  Drop:    cluster, category_label
  Wrap:    flat array → {version, site, generated_at, source_xlsx, articles:[]}
  Keep:    everything else (hub, hub_slug, hub_label, hub_url, locked_url,
           products, published, status, staged, assignment_notes, etc.)
"""

import json
from datetime import datetime, timezone
from pathlib import Path

SITE     = "one-happy-table"
SOURCE   = Path.home() / SITE / "data" / "pipeline.json"
DEST     = Path.home() / SITE / "data" / "pipeline.json.new"

CATEGORY       = "Home Entertaining"
CATEGORY_SLUG  = "home-entertaining"
DROPPED_FIELDS = {"cluster", "category_label"}

data = json.loads(SOURCE.read_text())
articles_in = data if isinstance(data, list) else data.get("articles", [])

stats = {"renamed": [], "added": [], "dropped": list(DROPPED_FIELDS)}
added_seen = set()

articles_out = []
for a in articles_in:
    out = {}

    for k, v in a.items():
        # ── Drop ──────────────────────────────────────────────────────────────
        if k in DROPPED_FIELDS:
            continue
        # ── Keep everything else ─────────────────────────────────────────────
        out[k] = v

    # ── Add canonical category fields ────────────────────────────────────────
    if "category" not in out:
        out["category"] = CATEGORY
        if "category" not in added_seen:
            stats["added"].append(f'category ("{CATEGORY}")')
            added_seen.add("category")

    # category_slug already present in OHT as "home-entertaining"
    # but ensure it's there for completeness
    out.setdefault("category_slug", CATEGORY_SLUG)

    articles_out.append(out)

envelope = {
    "version":      1,
    "site":         SITE,
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "source_xlsx":  None,
    "articles":     articles_out,
}

DEST.write_text(json.dumps(envelope, indent=2))

print(f"Migrated: {len(articles_out)} articles")
print(f"Output:   {DEST}")
print()
print("Renamed:  (none)")
print()
print("Added:")
for a in stats["added"]:
    print(f"  {a}")
print()
print("Dropped:")
for d in stats["dropped"]:
    print(f"  {d}")
