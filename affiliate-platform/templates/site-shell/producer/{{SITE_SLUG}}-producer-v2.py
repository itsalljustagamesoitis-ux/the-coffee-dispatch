#!/usr/bin/env python3
"""
{{SITE_SLUG}} producer — thin shell over affiliate-platform producer.

All logic lives in affiliate-platform/producer/producer_main.py.

Usage:
  python3 producer/{{SITE_SLUG}}-producer-v2.py --id 3
  python3 producer/{{SITE_SLUG}}-producer-v2.py --count 10
  python3 producer/{{SITE_SLUG}}-producer-v2.py --count 5 --type Roundup
  python3 producer/{{SITE_SLUG}}-producer-v2.py --slug my-article-slug
  python3 producer/{{SITE_SLUG}}-producer-v2.py --dry-run --count 5
"""

import sys
from pathlib import Path

SITE_ROOT = Path(__file__).parent.parent
SITE_PRODUCER = SITE_ROOT / "producer"
PLATFORM_PRODUCER = SITE_ROOT / "affiliate-platform/producer"

if not PLATFORM_PRODUCER.exists():
    print(
        f"ERROR: affiliate-platform submodule not found at {PLATFORM_PRODUCER}.\n"
        f"Run: git submodule update --init",
        file=sys.stderr,
    )
    sys.exit(1)

# Pre-import site data_loader so Python caches it before producer_main loads.
sys.path.insert(0, str(SITE_PRODUCER))
import data_loader   # noqa: F401

sys.path.insert(0, str(PLATFORM_PRODUCER))

from producer_main import main

if __name__ == "__main__":
    if "--site" not in sys.argv:
        sys.argv.extend(["--site", str(SITE_ROOT)])
    main()
