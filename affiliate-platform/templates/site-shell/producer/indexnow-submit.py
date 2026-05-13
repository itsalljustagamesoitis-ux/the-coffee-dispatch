"""
Submit article URLs to IndexNow after publishing.

Usage:
  # Submit all published articles:
  python3 producer/indexnow-submit.py --all

  # Submit specific slugs:
  python3 producer/indexnow-submit.py --slugs best-product-review another-slug

  # Dry run (print URLs without submitting):
  python3 producer/indexnow-submit.py --all --dry-run

IndexNow key file must be at: public/{key}.txt
The key is the filename without .txt extension.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "producer"))


def load_credentials():
    creds = {}
    cred_path = ROOT / "config/credentials.env"
    if cred_path.exists():
        for line in cred_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                creds[k.strip()] = v.strip()
    return creds


def get_indexnow_key() -> str:
    """Read key from env var, then fall back to the key file in public/."""
    key = os.environ.get("INDEXNOW_KEY") or load_credentials().get("INDEXNOW_KEY")
    if key:
        return key
    # Derive from the key file in public/
    key_files = list((ROOT / "public").glob("????????????????????????????????.txt"))
    if key_files:
        return key_files[0].stem
    raise RuntimeError(
        "No IndexNow key found. Add INDEXNOW_KEY=<key> to config/credentials.env "
        "or ensure public/{key}.txt exists."
    )


def get_site_domain() -> str:
    import yaml
    cfg = yaml.safe_load((ROOT / "site.config.yaml").read_text())
    return cfg["site"]["domain"]


def get_all_slugs() -> list[str]:
    """Return slugs of all published articles from content/articles/."""
    slugs = []
    article_dir = ROOT / "content/articles"
    if not article_dir.exists():
        return slugs
    for md_file in sorted(article_dir.glob("*.md")):
        text = md_file.read_text()
        if not text.startswith("---"):
            continue
        parts = text.split("---", 2)
        if len(parts) < 3:
            continue
        try:
            import yaml
            data = yaml.safe_load(parts[1])
            slug = data.get("slug") or md_file.stem
            if slug and not data.get("noindex"):
                slugs.append(slug)
        except Exception:
            pass
    return slugs


def submit_batch(urls: list[str], key: str, host: str, dry_run: bool) -> bool:
    """Submit up to 10,000 URLs in one IndexNow request."""
    if not urls:
        print("No URLs to submit.")
        return True

    payload = {
        "host": host,
        "key": key,
        "keyLocation": f"https://{host}/{key}.txt",
        "urlList": urls,
    }

    if dry_run:
        print(f"[DRY RUN] Would submit {len(urls)} URLs to IndexNow:")
        for url in urls[:10]:
            print(f"  {url}")
        if len(urls) > 10:
            print(f"  ... and {len(urls) - 10} more")
        return True

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.indexnow.org/indexnow",
        data=body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "{{SITE_SLUG}}-IndexNow/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            if status == 200:
                print(f"✓ IndexNow: submitted {len(urls)} URLs (200 OK)")
                return True
            elif status == 202:
                print(f"✓ IndexNow: {len(urls)} URLs accepted for crawl (202)")
                return True
            else:
                print(f"⚠ IndexNow: unexpected status {status}")
                return False
    except urllib.error.HTTPError as e:
        print(f"✗ IndexNow HTTP error: {e.code} {e.reason}")
        if e.code == 422:
            print("  → Key mismatch: verify key file is deployed at the correct URL")
        return False
    except Exception as e:
        print(f"✗ IndexNow error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Submit article URLs to IndexNow")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--all", action="store_true", help="Submit all published articles")
    group.add_argument("--slugs", nargs="+", metavar="SLUG", help="Submit specific slugs")
    parser.add_argument("--dry-run", action="store_true", help="Print URLs without submitting")
    args = parser.parse_args()

    key = get_indexnow_key()
    domain = get_site_domain()

    if args.all:
        slugs = get_all_slugs()
    else:
        slugs = args.slugs

    if not slugs:
        print("No slugs found.")
        sys.exit(0)

    urls = [f"https://{domain}/{slug}/" for slug in slugs]
    print(f"Site: {domain}")
    print(f"Key:  {key[:8]}...")
    print(f"URLs: {len(urls)}")

    # IndexNow allows up to 10,000 URLs per request; batch if needed
    batch_size = 10_000
    for i in range(0, len(urls), batch_size):
        batch = urls[i : i + batch_size]
        ok = submit_batch(batch, key, domain, args.dry_run)
        if not ok:
            sys.exit(1)
        if i + batch_size < len(urls):
            time.sleep(1)

    if not args.dry_run:
        print("\nDone. IndexNow submitted to Bing, Google, Yandex, and others via api.indexnow.org")


if __name__ == "__main__":
    main()
