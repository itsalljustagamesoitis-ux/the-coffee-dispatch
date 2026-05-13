#!/usr/bin/env python3
"""
migrate-mlt-pipeline.py — Migrate MLT pipeline.json to canonical envelope format.

Writes to pipeline.json.new (does not overwrite original).

Rules:
  Rename:  has_ai_overview → ai_overview, required_products → required_product_count,
           category_label → category (overwrites legacy slug-cased category)
  Drop:    cluster, category (legacy slug-cased — replaced by category_label promotion)
  Add:     hero_image (null), body_images ([])
           category_slug already present; locked_url already present
  Wrap:    flat array → {version, site, generated_at, source_xlsx, articles:[]}
  Keep:    everything else (title, supporting_products, ai_overview_risk, published,
           assignment_notes, hub_label, hub_url, etc.)
"""

import json
from datetime import datetime, timezone
from pathlib import Path

SITE   = "my-little-tablespoon"
SOURCE = Path.home() / SITE / "data" / "pipeline.json"
DEST   = Path.home() / SITE / "data" / "pipeline.json.new"

DROPPED_FIELDS = {"cluster"}

data = json.loads(SOURCE.read_text())
articles_in = data if isinstance(data, list) else data.get("articles", [])

stats = {"renamed": [], "added": [], "dropped": list(DROPPED_FIELDS)}
renamed_seen = set()
added_seen   = set()

articles_out = []
for a in articles_in:
    out = {}

    for k, v in a.items():
        # ── Drop ──────────────────────────────────────────────────────────────
        if k in DROPPED_FIELDS:
            continue

        # ── Rename: category_label → category (canonical is human-readable) ─
        if k == "category_label":
            out["category"] = v
            if "category_label" not in renamed_seen:
                stats["renamed"].append("category_label → category (overwrites)")
                renamed_seen.add("category_label")
            continue

        # ── Drop existing slug-cased category (will be set by category_label) ─
        if k == "category":
            continue

        # ── Rename: has_ai_overview → ai_overview ────────────────────────────
        if k == "has_ai_overview":
            out["ai_overview"] = v
            if "has_ai_overview" not in renamed_seen:
                stats["renamed"].append("has_ai_overview → ai_overview")
                renamed_seen.add("has_ai_overview")
            continue

        # ── Rename: required_products → required_product_count ───────────────
        if k == "required_products":
            out["required_product_count"] = v if isinstance(v, int) else 0
            if "required_products" not in renamed_seen:
                stats["renamed"].append("required_products → required_product_count")
                renamed_seen.add("required_products")
            continue

        # ── Keep everything else ─────────────────────────────────────────────
        out[k] = v

    # ── Add missing canonical fields ─────────────────────────────────────────
    if "hero_image" not in out:
        out["hero_image"] = None
        if "hero_image" not in added_seen:
            stats["added"].append("hero_image (default null)")
            added_seen.add("hero_image")

    if "body_images" not in out:
        out["body_images"] = []
        if "body_images" not in added_seen:
            stats["added"].append("body_images (default [])")
            added_seen.add("body_images")

    # Ensure category_slug present (derive from category if missing)
    if "category_slug" not in out and out.get("category"):
        import re
        out["category_slug"] = re.sub(r"[^a-z0-9]+", "-", out["category"].lower()).strip("-")
        if "category_slug" not in added_seen:
            stats["added"].append("category_slug (derived from category)")
            added_seen.add("category_slug")

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
print("Renamed:")
for r in stats["renamed"]:
    print(f"  {r}")
print()
print("Added:")
for a in stats["added"]:
    print(f"  {a}")
print()
print("Dropped:")
for d in stats["dropped"]:
    print(f"  {d}")
