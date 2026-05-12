"""Shared test fixtures for the site producer."""

import sys
import json
import yaml
import pytest
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT / "producer"))


@pytest.fixture(scope="session")
def root():
    return ROOT


@pytest.fixture(scope="session")
def site_config():
    with open(ROOT / "site.config.yaml") as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="session")
def navigation():
    with open(ROOT / "config/navigation.yaml") as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="session")
def pipeline():
    with open(ROOT / "data/pipeline.json") as f:
        data = json.load(f)
    return data.get("articles", data) if isinstance(data, dict) else data


@pytest.fixture(scope="session")
def products():
    from data_loader import load_products
    return load_products(ROOT)


@pytest.fixture(scope="session")
def all_hub_slugs(navigation):
    slugs = set()
    for cat in navigation.get("categories", []):
        for hub in cat.get("hubs", []):
            slugs.add(hub["slug"])
    return slugs


@pytest.fixture(scope="session")
def image_dir(root):
    return root / "public/images/articles"
