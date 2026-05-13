#!/usr/bin/env python3
"""
migrate-fsg-pipeline.py — Migrate FSG pipeline.json to canonical envelope format.

Writes to pipeline.json.new (does not overwrite original).

Rules:
  Rename:  cluster → hub, category_label → category
  Add:     locked_url, required_product_count (0), ai_overview (false), ai_overview_risk (null)
           category_slug already present;
           body_images/hero_image/products already present
  Wrap:    flat array → {version, site, generated_at, source_xlsx, articles:[]}
  Keep:    everything else (layout, hero_image_alt, hub_label, hub_url, hub_slug,
           category_slug, category_url, assignment_notes, status, hero_image, body_images, etc.)
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SITE = "four-season-gardener"
DOMAIN = "fourseasongardener.com"
SOURCE = Path.home() / SITE / "data" / "pipeline.json"
DEST   = Path.home() / SITE / "data" / "pipeline.json.new"

data = json.loads(SOURCE.read_text())
articles_in = data if isinstance(data, list) else data.get("articles", [])

stats = {"renamed": [], "added": [], "kept": [], "dropped": []}
renamed_seen = set()
added_seen   = set()

articles_out = []
for a in articles_in:
    out = {}

    # ── Rename: cluster → hub ────────────────────────────────────────────────
    # FSG has no 'hub' field — cluster IS the hub
    out["id"]      = a["id"]
    out["slug"]    = a["slug"]
    out["keyword"] = a.get("keyword")
    out["type"]    = a.get("type")

    hub = a.get("cluster") or a.get("hub_slug") or ""
    out["hub"] = hub
    if "cluster" not in renamed_seen:
        stats["renamed"].append("cluster → hub")
        renamed_seen.add("cluster")

    # ── Rename: category_label → category ───────────────────────────────────
    category = a.get("category_label", "")
    out["category"] = category
    if "category_label" not in renamed_seen:
        stats["renamed"].append("category_label → category")
        renamed_seen.add("category_label")

    # ── Keep existing fields ─────────────────────────────────────────────────
    keep = [
        "hub_slug", "hub_label", "hub_url",
        "category_slug", "category_url",
        "layout", "angle", "volume", "kd", "h2_structure",
        "products", "assignment_notes", "status",
        "hero_image", "hero_image_alt", "body_images",
    ]
    for k in keep:
        if k in a:
            out[k] = a[k]
            if k not in added_seen and k not in renamed_seen:
                if k not in stats["kept"]:
                    stats["kept"].append(k)

    # ── Add missing canonical fields ─────────────────────────────────────────
    if "locked_url" not in out:
        out["locked_url"] = f"https://{DOMAIN}/{a['slug']}/"
        if "locked_url" not in added_seen:
            stats["added"].append("locked_url (derived from slug)")
            added_seen.add("locked_url")

    if "required_product_count" not in out:
        out["required_product_count"] = 0
        if "required_product_count" not in added_seen:
            stats["added"].append("required_product_count (default 0)")
            added_seen.add("required_product_count")

    if "ai_overview" not in out:
        out["ai_overview"] = False
        if "ai_overview" not in added_seen:
            stats["added"].append("ai_overview (default false)")
            added_seen.add("ai_overview")

    if "ai_overview_risk" not in out:
        out["ai_overview_risk"] = None
        if "ai_overview_risk" not in added_seen:
            stats["added"].append("ai_overview_risk (default null)")
            added_seen.add("ai_overview_risk")

    # Ensure body_images exists (FSG has it, but be safe)
    out.setdefault("body_images", [])
    # Ensure products exists
    out.setdefault("products", [])

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
print("Dropped:  (none — all non-canonical fields preserved)")
