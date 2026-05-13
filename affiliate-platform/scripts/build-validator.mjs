/**
 * Post-build validator — fails the build if critical issues are found in dist/.
 * Checks: empty pages, untagged Amazon affiliate links, hardcoded prices, doubled brand names in H3s.
 * Run via: node scripts/build-validator.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, relative, resolve } from 'path'
import yaml from 'js-yaml'

// All paths resolve relative to the site CWD (where `npm run build` is invoked),
// not relative to this script file — the script lives in node_modules/@platform/core/scripts/
const SITE_ROOT = process.cwd()
const DIST = resolve(SITE_ROOT, 'dist')
const MIN_HTML_BYTES = 500

// Resolve the configured Amazon tag so we can verify it's actually in affiliate URLs
const _cfg = yaml.load(readFileSync(resolve(SITE_ROOT, 'site.config.yaml'), 'utf8'))
const CONFIGURED_TAG = process.env.AMAZON_TAG ?? _cfg?.affiliate?.amazon_tracking_id ?? ''

let failures = 0
const errors = []
const warnings = []

function fail(check, file, msg) {
  errors.push(`  FAIL [${check}] ${file}\n       ${msg}`)
  failures++
}

function checkFile(fullPath) {
  const rel = relative(DIST, fullPath)
  const raw = readFileSync(fullPath, 'utf8')
  const size = Buffer.byteLength(raw, 'utf8')

  // ── 1. Empty page ────────────────────────────────────────────────────────
  // Skip intentional Astro redirect pages (they're tiny but valid)
  if (raw.includes('http-equiv="refresh"')) return

  if (size < MIN_HTML_BYTES) {
    fail('empty-page', rel, `${size} bytes — minimum is ${MIN_HTML_BYTES}`)
    return // Nothing else to check on a near-empty file
  }

  // ── 2. Missing local images ──────────────────────────────────────────────
  // Catch hero images referenced in HTML that weren't committed to the repo.
  const imgRe = /<img[^>]+src="(\/images\/[^"]+)"[^>]*>/gi
  let imgMatch
  while ((imgMatch = imgRe.exec(raw)) !== null) {
    const imgPath = imgMatch[1]
    // join() with an absolute path replaces the base — use string concat instead
    const diskPath = DIST + imgPath
    if (!existsSync(diskPath)) {
      fail('missing-image', rel, `Image not found on disk: ${imgPath}`)
    }
  }

  // ── 3. Untagged Amazon affiliate links ───────────────────────────────────
  // Match <a ...> tags that contain amazon.com in href
  const anchorRe = /<a\s[^>]*href="([^"]*amazon\.com[^"]*)"[^>]*>/gi
  let m
  while ((m = anchorRe.exec(raw)) !== null) {
    const tag = m[0]
    const href = m[1]
    if (!/rel="[^"]*sponsored[^"]*"/.test(tag)) {
      const snippet = tag.replace(/\s+/g, ' ').slice(0, 120)
      fail('untagged-affiliate', rel, `Amazon link missing rel="sponsored": ${snippet}`)
    }
    // Verify the configured affiliate tag is present — catches revenue leaks from wrong/missing tag
    if (CONFIGURED_TAG && !/[?&]tag=/.test(href)) {
      fail('missing-tag', rel, `Amazon link has no tag= parameter: ${href.slice(0, 120)}`)
    } else if (CONFIGURED_TAG && !href.includes(`tag=${CONFIGURED_TAG}`)) {
      fail('wrong-tag', rel, `Amazon link has wrong affiliate tag (expected ${CONFIGURED_TAG}): ${href.slice(0, 120)}`)
    }
  }

  // ── 4. Hardcoded prices (Amazon Associates ToS) ──────────────────────────
  // Dollar amounts in editorial prose go stale and violate Associates program terms.
  // Only check article pages (not hub/category/static pages). Only check the
  // article-page__content div (prose body), not product card or comparison table
  // component output — those prices come from products.yaml and are not editorial.
  if (raw.includes('article-page__content')) {
    const proseRe = /class="article-page__content"[^>]*>([\s\S]*?)<\/div>/i
    const proseMatch = proseRe.exec(raw)
    if (proseMatch) {
      // Strip JSON-LD and inline script blocks
      const proseText = proseMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '')
      // Match dollar sign followed by digits (e.g. $45, $120, $1,299, $45-$80)
      const priceRe = /\$\s*\d[\d,]*(?:\s*[-–]\s*\$?\s*\d[\d,]*)?/g
      const priceMatches = proseText.match(priceRe)
      // Threshold of 3+ to reduce noise from incidental price mentions in comparisons
      if (priceMatches && priceMatches.length >= 3) {
        warnings.push(`  WARN [hardcoded-price] ${rel}\n       ${priceMatches.length} dollar amount(s) in prose: ${[...new Set(priceMatches)].slice(0, 5).join(', ')}`)
      }
    }
  }

  // ── 5. Sentinel Amazon image hashes ─────────────────────────────────────
  // Catch placeholder image hashes (71Q8Q8Q8Q8L pattern) that 404 on Amazon CDN.
  const sentinelImgRe = /m\.media-amazon\.com\/images\/I\/(7[01]Q[0-9Q]{6,}L)[^"']*/g
  let siMatch
  while ((siMatch = sentinelImgRe.exec(raw)) !== null) {
    fail('sentinel-image', rel, `Placeholder Amazon image hash detected: ${siMatch[1]}`)
  }

  // ── 6. Placeholder ASINs ─────────────────────────────────────────────────
  // Catch VERIFY-, TODO-, PLACEHOLDER- ASINs that slipped through.
  const placeholderAsinRe = /VERIFY-|TODO-|PLACEHOLDER-/g
  if (placeholderAsinRe.test(raw)) {
    fail('placeholder-asin', rel, `Placeholder ASIN value found in rendered HTML`)
  }

  // ── 7. Duplicate consecutive breadcrumb hrefs ────────────────────────────
  // Catches category/hub slug collisions rendering identical back-to-back crumbs.
  const breadcrumbRe = /<nav[^>]*breadcrumb[^>]*>([\s\S]*?)<\/nav>/i
  const bcMatch = breadcrumbRe.exec(raw)
  if (bcMatch) {
    const hrefs = [...bcMatch[1].matchAll(/href="([^"]+)"/g)].map(m => m[1])
    for (let i = 1; i < hrefs.length; i++) {
      if (hrefs[i] === hrefs[i - 1]) {
        fail('duplicate-breadcrumb', rel, `Duplicate consecutive breadcrumb href: "${hrefs[i]}"`)
      }
    }
  }

  // ── 8. Doubled brand names in H3 ─────────────────────────────────────────
  // Catches "Perky-Pet Perky-Pet …", "EGO Power+ EGO POWER+ …" etc.
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi
  while ((m = h3Re.exec(raw)) !== null) {
    // Strip inner HTML tags to get visible text
    const text = m[1].replace(/<[^>]+>/g, '').trim()
    // A word (or hyphenated word) repeated immediately after itself, case-insensitive
    if (/(\b[\w-]+\b)\s+\1\b/i.test(text)) {
      fail('doubled-brand', rel, `H3 contains repeated word: "${text.slice(0, 100)}"`)
    }
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.html')) checkFile(full)
  }
}

// ── Pre-flight: IndexNow key file check ───────────────────────────────────
const INDEXNOW_KEY = process.env.INDEXNOW_KEY
const isCloudflareProduction =
  process.env.CF_PAGES === '1' && process.env.CF_PAGES_BRANCH === 'main'

if (INDEXNOW_KEY) {
  const keyFilePath = join(DIST, `${INDEXNOW_KEY}.txt`)
  if (!existsSync(keyFilePath)) {
    fail('indexnow-key-missing', `dist/${INDEXNOW_KEY}.txt`, 'Key file not found in dist — ensure public/<key>.txt is committed to the repo')
  } else {
    const keyFileContents = readFileSync(keyFilePath, 'utf8').replace(/\n$/, '')
    if (keyFileContents !== INDEXNOW_KEY) {
      fail('indexnow-key-mismatch', `dist/${INDEXNOW_KEY}.txt`, `Key file contents "${keyFileContents}" do not match INDEXNOW_KEY env var`)
    }
  }
} else if (isCloudflareProduction) {
  warnings.push('  WARN [indexnow-key] INDEXNOW_KEY not set — IndexNow submissions disabled for this clone.\n       Set INDEXNOW_KEY in Cloudflare Pages → Settings → Environment Variables.')
}

// ── Pre-flight: source file checks (before scanning dist/) ────────────────
const PRODUCTS_YAML = resolve(SITE_ROOT, 'content/products/products.yaml')
if (existsSync(PRODUCTS_YAML)) {
  const productsRaw = readFileSync(PRODUCTS_YAML, 'utf8')
  if (/VERIFY-|TODO-|PLACEHOLDER-/.test(productsRaw)) {
    fail('placeholder-asin-source', 'content/products/products.yaml', 'Placeholder ASIN (VERIFY-/TODO-/PLACEHOLDER-) found in source — fix before building')
  }
  if (/7[01]Q[0-9Q]{6,}[A-Z0-9]L/.test(productsRaw)) {
    fail('sentinel-image-source', 'content/products/products.yaml', 'Sentinel Amazon image hash found in source — fix before building')
  }
}

// ── Pre-flight: article source checks — no hardcoded ASINs or affiliate tags ─
// After Phase 3 migration, article bodies must use <ProductLink> not raw Amazon URLs.
// Any hardcoded amazon.com/dp/ URL or ?tag= in markdown is a regression.
const ARTICLES_DIR = resolve(SITE_ROOT, 'content/articles')
if (existsSync(ARTICLES_DIR)) {
  function walkArticleSource(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkArticleSource(full)
      else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
        const src = readFileSync(full, 'utf8')
        const rel = 'content/articles/' + entry.name
        // Strip frontmatter before checking body
        const body = src.replace(/^---[\s\S]*?---\n/, '')
        if (/https?:\/\/(?:www\.)?amazon\.com\/dp\/[A-Z0-9]{10}/.test(body)) {
          fail('hardcoded-asin-source', rel, 'Hardcoded Amazon ASIN URL found in article body — use <ProductLink slug="..."> instead')
        }
        if (/\?tag=[a-z0-9-]+-\d{2}/.test(body)) {
          fail('hardcoded-affiliate-tag-source', rel, 'Hardcoded affiliate tag (?tag=...) found in article body — use <ProductLink> which injects the correct tag at build time')
        }
      }
    }
  }
  walkArticleSource(ARTICLES_DIR)
}

// ── Run ───────────────────────────────────────────────────────────────────
console.log(`\nValidating build output in ${DIST} …\n`)
walk(DIST)

if (warnings.length > 0) {
  console.warn(`⚠ ${warnings.length} warning(s) — these are non-blocking but should be fixed:\n`)
  for (const w of warnings) console.warn(w)
  console.warn()
}

if (failures === 0) {
  console.log(warnings.length
    ? `✓ Build validation passed with warnings (see above).\n`
    : `✓ Build validation passed — no issues found.\n`)
  process.exit(0)
} else {
  console.error(`✗ Build validation failed — ${failures} issue(s):\n`)
  for (const e of errors) console.error(e)
  console.error(`\nFix the issues above and rebuild.\n`)
  process.exit(1)
}
