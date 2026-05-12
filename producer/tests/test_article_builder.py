"""
Tests for article_builder.py — build_frontmatter, hero_image cycling.
Persona-agnostic: works for any site's persona configured at config/personas/<slug>.yaml.
"""

import yaml
import pytest
from pathlib import Path
from data_loader import enrich_article, get_hub_products, load_navigation

ROOT = Path(__file__).parent.parent.parent
IMAGE_DIR = ROOT / "public/images/articles"


def make_article(article_id, hub, article_type="review"):
    nav = load_navigation(ROOT)
    a = {
        "id": article_id,
        "slug": f"test-article-{article_id}",
        "keyword": "test keyword",
        "type": article_type,
        "hub": hub,
        "products": [],
        "angle": "test angle",
    }
    enrich_article(a, nav)
    return a


class TestHeroImageCycling:
    def test_uses_hub_prefix_not_slug(self, products):
        from article_builder import build_frontmatter
        first_product = list(products.values())[0]
        hub_slug = first_product.get("hub") or first_product.get("category")
        article = make_article(1, hub_slug)
        hub = article["hub"]
        fm = build_frontmatter(article, products, "Test Title", "Test description here today.")
        data = yaml.safe_load(fm.strip("---\n").split("---")[0])
        assert data["hero_image"].startswith(f"articles/{hub}-"), \
            f"hero_image should start with 'articles/{hub}-', got: {data['hero_image']}"

    def test_does_not_use_slug_pattern(self, products):
        from article_builder import build_frontmatter
        first_product = list(products.values())[0]
        hub = first_product.get("hub") or first_product.get("category")
        article = make_article(5, hub)
        fm = build_frontmatter(article, products, "Title", "Description for this article.")
        assert article["slug"] not in fm.split("hero_image:")[1].split("\n")[0], \
            "hero_image should not contain the article slug"

    def test_hero_image_n_between_1_and_8(self, products, all_hub_slugs):
        from article_builder import build_frontmatter
        for hub_slug in list(all_hub_slugs)[:3]:
            for i in range(1, 9):
                article = make_article(i, hub_slug)
                fm = build_frontmatter(article, products, "T", "D" * 20)
                data = yaml.safe_load(fm.strip().lstrip("-").split("---")[0])
                img = data["hero_image"]
                n = int(img.split("-")[-1].replace(".jpg", ""))
                assert 1 <= n <= 8, f"Image number {n} out of range for hub {hub_slug}"

    def test_image_file_exists_for_all_hubs(self, products, all_hub_slugs):
        from article_builder import build_frontmatter
        for hub_slug in all_hub_slugs:
            article = make_article(1, hub_slug)
            fm = build_frontmatter(article, products, "T", "D" * 20)
            data = yaml.safe_load(fm.strip().lstrip("-").split("---")[0])
            img_path = IMAGE_DIR / data["hero_image"].replace("articles/", "")
            assert img_path.exists(), \
                f"Hero image missing: {img_path} (hub: {hub_slug})"

    def test_wraps_after_8(self, products):
        from article_builder import build_frontmatter
        first_product = list(products.values())[0]
        hub = first_product.get("hub") or first_product.get("category")
        article = make_article(9, hub)
        fm = build_frontmatter(article, products, "T", "D" * 20)
        data = yaml.safe_load(fm.strip().lstrip("-").split("---")[0])
        assert data["hero_image"].endswith("-1.jpg"), \
            f"Article id 9 should wrap to image 1, got: {data['hero_image']}"


class TestFrontmatterFields:
    def test_category_label_populated(self, products, all_hub_slugs):
        from article_builder import build_frontmatter
        hub = list(all_hub_slugs)[0]
        article = make_article(1, hub)
        fm = build_frontmatter(article, products, "Title", "Description text here now.")
        data = yaml.safe_load(fm.strip().lstrip("-").split("---")[0])
        assert data["category"], f"category field is empty for hub '{hub}'"

    def test_hub_populated(self, products, all_hub_slugs):
        from article_builder import build_frontmatter
        hub = list(all_hub_slugs)[0]
        article = make_article(1, hub)
        fm = build_frontmatter(article, products, "Title", "Description text here now.")
        data = yaml.safe_load(fm.strip().lstrip("-").split("---")[0])
        assert data["hub"] == hub

    def test_required_fields_present(self, products, all_hub_slugs):
        from article_builder import build_frontmatter
        hub = list(all_hub_slugs)[0]
        article = make_article(1, hub)
        fm = build_frontmatter(article, products, "My Title", "My description for test.")
        data = yaml.safe_load(fm.strip().lstrip("-").split("---")[0])
        required = ["title", "slug", "type", "date", "author", "category",
                    "hub", "hero_image", "description", "target_keyword"]
        missing = [f for f in required if not data.get(f)]
        assert not missing, f"Required frontmatter fields are empty: {missing}"

    def test_no_em_dashes_in_frontmatter(self, products, all_hub_slugs):
        from article_builder import build_frontmatter
        hub = list(all_hub_slugs)[0]
        article = make_article(1, hub)
        fm = build_frontmatter(article, products, "Title With, Comma", "Desc.")
        assert "\u2014" not in fm, "Em dash found in frontmatter"
        assert "\u2013" not in fm, "En dash found in frontmatter"


class TestGeneratedArticles:
    def _load_articles(self, root):
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
        bad = [f"{a['_file']}: {a.get('hero_image')}" for a in articles if "-hero.jpg" in a.get("hero_image", "")]
        assert not bad, f"Articles still using slug-based hero images: {bad}"

    def test_hero_images_exist_on_disk(self, root):
        articles = self._load_articles(root)
        image_dir = root / "public/images/articles"
        bad = []
        for a in articles:
            img = a.get("hero_image", "").replace("articles/", "")
            if img and not (image_dir / img).exists():
                bad.append(f"{a['_file']}: {img}")
        assert not bad, f"Hero image files missing:\n" + "\n".join(bad)
