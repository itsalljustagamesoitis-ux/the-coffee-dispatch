"""
Tests for pipeline.json structural integrity.
These run against the actual pipeline file and catch data problems before article generation.
"""

import pytest
from collections import Counter


VALID_TYPES = {
    "roundup", "review", "comparison", "informational", "buyer_guide",
    "Roundup", "Review", "Comparison", "Informational", "Buyer Guide",
}


class TestPipelineStructure:
    def test_pipeline_is_non_empty(self, pipeline):
        assert len(pipeline) > 0, "pipeline.json is empty"

    def test_all_articles_have_required_fields(self, pipeline):
        required = ["id", "slug", "keyword", "type", "hub"]
        bad = []
        for a in pipeline:
            missing = [f for f in required if not a.get(f)]
            if missing:
                bad.append(f"id={a.get('id','?')}: missing {missing}")
        assert not bad, f"{len(bad)} articles missing required fields:\n" + "\n".join(bad[:10])

    def test_no_duplicate_ids(self, pipeline):
        ids = [a["id"] for a in pipeline]
        dupes = [id_ for id_, count in Counter(ids).items() if count > 1]
        assert not dupes, f"Duplicate article IDs: {dupes}"

    def test_no_duplicate_slugs(self, pipeline):
        slugs = [a["slug"] for a in pipeline]
        dupes = [s for s, count in Counter(slugs).items() if count > 1]
        assert not dupes, f"Duplicate slugs: {dupes}"

    def test_all_types_are_valid(self, pipeline):
        bad = []
        for a in pipeline:
            if a.get("type") not in VALID_TYPES:
                bad.append(f"id={a['id']} slug={a['slug']}: type='{a.get('type')}'")
        assert not bad, f"Invalid article types:\n" + "\n".join(bad[:10])

    def test_all_hubs_exist_in_navigation(self, pipeline, all_hub_slugs):
        bad = []
        for a in pipeline:
            hub = a.get("hub_slug") or a.get("hub", "")
            if hub not in all_hub_slugs:
                bad.append(f"id={a['id']} slug={a['slug']}: hub='{hub}'")
        assert not bad, f"{len(bad)} articles reference hubs not in navigation.yaml:\n" + "\n".join(bad[:10])


class TestProductAssignment:
    def test_all_articles_have_been_through_assignment(self, pipeline):
        """Every article must have the 'products' key (even if empty list with gap note)."""
        unassigned = [
            a for a in pipeline
            if "products" not in a
        ]
        assert not unassigned, (
            f"{len(unassigned)} articles have never been through product assignment "
            f"(run: python3 data/assign-products.py --all). "
            f"First few: {[a['slug'] for a in unassigned[:5]]}"
        )

    def test_no_articles_have_empty_products_without_gap_note(self, pipeline):
        """An article with products=[] must have assignment_notes explaining why."""
        bad = []
        for a in pipeline:
            if a.get("products") == [] and not a.get("assignment_notes"):
                bad.append(f"id={a['id']} slug={a['slug']}")
        assert not bad, (
            f"{len(bad)} articles have products=[] with no assignment_notes:\n"
            + "\n".join(bad[:10])
        )

    def test_all_assigned_product_keys_exist_in_catalog(self, pipeline, products):
        bad = []
        for a in pipeline:
            for key in a.get("products", []):
                if key not in products:
                    bad.append(f"id={a['id']} slug={a['slug']}: product key '{key}' not in products.yaml")
        assert not bad, f"{len(bad)} references to missing products:\n" + "\n".join(bad[:10])

    def test_review_articles_have_at_least_one_product(self, pipeline):
        bad = [
            a for a in pipeline
            if a.get("type", "").lower() == "review" and not a.get("products")
        ]
        assert not bad, (
            f"{len(bad)} Review articles have no products assigned: "
            + str([a['slug'] for a in bad[:5]])
        )

    def test_comparison_articles_have_at_least_two_products(self, pipeline):
        bad = [
            a for a in pipeline
            if a.get("type", "").lower() == "comparison" and len(a.get("products", [])) < 2
        ]
        assert not bad, (
            f"{len(bad)} Comparison articles have fewer than 2 products: "
            + str([a['slug'] for a in bad[:5]])
        )


class TestProductsCatalog:
    def test_all_products_have_required_fields(self, products):
        required = ["name", "brand", "price_band", "default_pros", "default_cons"]
        bad = []
        for key, p in products.items():
            missing = [f for f in required if not p.get(f)]
            # amazon_asin may be null for direct-to-consumer brands — check it's present as a key
            if "amazon_asin" not in p:
                missing.append("amazon_asin (key missing entirely)")
            if missing:
                bad.append(f"'{key}': missing {missing}")
        assert not bad, f"{len(bad)} products missing required fields:\n" + "\n".join(bad[:10])

    def test_all_products_have_category_or_hub(self, products, all_hub_slugs):
        """Products must reference a valid hub via 'category' or 'hub' field."""
        bad = []
        for key, p in products.items():
            hub_val = p.get("hub") or p.get("category")
            if hub_val not in all_hub_slugs:
                bad.append(f"'{key}': category/hub='{hub_val}'")
        assert not bad, f"Products reference hubs not in navigation.yaml:\n" + "\n".join(bad)

    def test_amazon_asins_are_10_chars(self, products):
        bad = []
        for key, p in products.items():
            asin = p.get("amazon_asin")
            if asin and asin not in ("VERIFY",) and len(asin) != 10:
                bad.append(f"'{key}': ASIN='{asin}' (length {len(asin)}, expected 10)")
        assert not bad, f"Malformed ASINs:\n" + "\n".join(bad)

    def test_price_bands_are_valid(self, products):
        valid_bands = {"budget", "mid", "premium"}
        bad = []
        for key, p in products.items():
            band = p.get("price_band", "")
            if band not in valid_bands:
                bad.append(f"'{key}': price_band='{band}'")
        assert not bad, f"Invalid price_band values:\n" + "\n".join(bad)


class TestGeneratedArticles:
    """Validate frontmatter of already-generated .md files in content/articles/."""

    def _load_articles(self, root):
        import yaml
        articles = []
        for md_file in (root / "content/articles").glob("*.md"):
            text = md_file.read_text()
            if not text.startswith("---"):
                continue
            parts = text.split("---", 2)
            if len(parts) < 3:
                continue
            try:
                data = yaml.safe_load(parts[1])
                data["_file"] = md_file.name
                articles.append(data)
            except Exception:
                pass
        return articles

    def test_no_empty_category_in_generated_articles(self, root):
        articles = self._load_articles(root)
        bad = [a["_file"] for a in articles if not a.get("category")]
        assert not bad, f"Generated articles with empty category: {bad}"

    def test_no_slug_based_hero_images(self, root):
        articles = self._load_articles(root)
        bad = []
        for a in articles:
            img = a.get("hero_image", "")
            # Slug-based pattern: articles/{slug}-hero.jpg
            if img and not img.startswith("articles/") or "-hero.jpg" in img:
                if "-hero.jpg" in img:
                    bad.append(f"{a['_file']}: {img}")
        assert not bad, f"Articles still using slug-based hero images: {bad}"

    def test_hero_images_exist_on_disk(self, root):
        articles = self._load_articles(root)
        image_dir = root / "public/images/articles"
        bad = []
        for a in articles:
            img = a.get("hero_image", "").replace("articles/", "")
            if img and not (image_dir / img).exists():
                bad.append(f"{a['_file']}: {img}")
        assert not bad, f"Hero image files missing on disk:\n" + "\n".join(bad)

    def test_author_field_is_set_in_generated_articles(self, root):
        articles = self._load_articles(root)
        bad = [a["_file"] for a in articles if not a.get("author")]
        assert not bad, f"Articles with missing author field: {bad}"
