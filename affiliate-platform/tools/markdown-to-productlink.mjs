#!/usr/bin/env node
/**
 * markdown-to-productlink.mjs
 *
 * Migrates article bodies from hardcoded Amazon affiliate URLs to
 * <ProductLink slug="..."> component references.
 *
 * For each .md file in content/articles/:
 *   - Finds [anchor](amazon.com/dp/ASIN?tag=...) patterns
 *   - Reverse-looks up ASIN → product slug in products.yaml
 *   - Rewrites to <ProductLink slug="slug">anchor</ProductLink>
 *   - Renames .md → .mdx so Astro processes JSX syntax
 *
 * CLI: node tools/markdown-to-productlink.mjs --site <path> [--dry-run] [--verbose]
 */

import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { resolve, join, basename } from 'path'

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--site') args.site = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
    else if (argv[i] === '--verbose') args.verbose = true
  }
  return args
}

// ── YAML dict parser (line-level, no external deps) ──────────────────────────

function parseProductsYaml(text) {
  const lines = text.split('\n')
  const products = new Map() // slug → { amazon_asin }
  let currentSlug = null
  let currentAsin = null

  function flush() {
    if (currentSlug && currentAsin) products.set(currentSlug, { amazon_asin: currentAsin })
    currentSlug = null; currentAsin = null
  }

  for (const line of lines) {
    if (line.startsWith('#')) { flush(); continue }

    const keyMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9_./-]*):\s*$/)
    if (keyMatch) { flush(); currentSlug = keyMatch[1]; continue }

    const asinMatch = line.match(/^\s+amazon_asin:\s*(.+)$/)
    if (asinMatch && currentSlug) currentAsin = asinMatch[1].trim()
  }
  flush()
  return products
}

// ── ASIN → slug reverse map ───────────────────────────────────────────────────

const VALID_ASIN = /^(?:B0[A-Z0-9]{8}|[0-9]{10})$/

function buildReverseMap(products) {
  const map = new Map()
  for (const [slug, data] of products) {
    const asin = data.amazon_asin
    if (!asin || asin === 'NOT_ON_AMAZON' || !VALID_ASIN.test(asin)) continue
    if (map.has(asin)) {
      console.warn(`  ⚠ Duplicate ASIN ${asin}: slugs "${map.get(asin)}" and "${slug}" — using first`)
    } else {
      map.set(asin, slug)
    }
  }
  return map
}

// ── Amazon link regex ─────────────────────────────────────────────────────────
// Excludes newlines in anchor text to avoid matching across JSON-LD blocks

const AMAZON_LINK_RE = /\[([^\]\n]+)\]\(https?:\/\/(?:www\.)?amazon\.com\/dp\/([A-Z0-9]{10})[^)]*\)/g

// ── Process one file ──────────────────────────────────────────────────────────

function processFile(filePath, reverseMap, verbose) {
  const content = readFileSync(filePath, 'utf8')
  const resolved = []
  const unresolved = []

  const rewritten = content.replace(AMAZON_LINK_RE, (fullMatch, anchor, asin) => {
    const slug = reverseMap.get(asin)
    if (!slug) {
      unresolved.push({ asin, anchor })
      return fullMatch
    }
    resolved.push({ asin, slug, anchor })
    if (verbose) console.log(`    ${asin} → ${slug} | "${anchor}"`)
    return `[${anchor}](product:${slug})`
  })

  return { content, rewritten, resolved, unresolved }
}

// ── Walk articles directory ───────────────────────────────────────────────────

function walkArticles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkArticles(full))
    else if (entry.name.endsWith('.md')) files.push(full)
  }
  return files
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv)

  if (!args.site) {
    console.error('Usage: node tools/markdown-to-productlink.mjs --site <site-path> [--dry-run] [--verbose]')
    process.exit(1)
  }

  const sitePath = resolve(args.site)
  const articlesDir = join(sitePath, 'content', 'articles')
  const productsYamlPath = join(sitePath, 'content', 'products', 'products.yaml')

  const productsYaml = readFileSync(productsYamlPath, 'utf8')
  const products = parseProductsYaml(productsYaml)
  const reverseMap = buildReverseMap(products)

  console.log('\n── markdown-to-productlink ──────────────────────────────────────────────────')
  console.log(`Site:               ${sitePath}`)
  console.log(`Products loaded:    ${products.size} (${reverseMap.size} with resolvable ASINs)`)
  console.log(`Mode:               ${args.dryRun ? 'DRY RUN — no files written' : 'LIVE'}`)
  console.log()

  const files = walkArticles(articlesDir)
  console.log(`Found ${files.length} .md files to process\n`)

  let totalResolved = 0
  let totalUnresolved = 0
  const renamedFiles = []
  const unresolvedAll = []

  for (const filePath of files) {
    const { rewritten, resolved, unresolved } = processFile(filePath, reverseMap, args.verbose)

    if (unresolved.length > 0) {
      unresolvedAll.push({ file: basename(filePath), items: unresolved })
      totalUnresolved += unresolved.length
    }

    if (resolved.length > 0) {
      totalResolved += resolved.length
      const mdxPath = filePath.replace(/\.md$/, '.mdx')
      renamedFiles.push(basename(filePath))

      if (!args.dryRun) {
        writeFileSync(filePath, rewritten, 'utf8')
      }

      console.log(`  ✓ ${basename(filePath)}  (${resolved.length} link${resolved.length !== 1 ? 's' : ''} rewritten)`)
    } else if (args.verbose) {
      console.log(`  – ${basename(filePath)}  (no resolvable Amazon links)`)
    }
  }

  console.log('\n── Summary ──────────────────────────────────────────────────────────────────')
  console.log(`Files processed:          ${files.length}`)
  console.log(`Files rewritten:          ${renamedFiles.length}`)
  console.log(`Amazon links resolved:    ${totalResolved}`)
  console.log(`Amazon links unresolved:  ${totalUnresolved}`)

  if (unresolvedAll.length > 0) {
    console.log('\nUnresolved (ASIN not found in products.yaml — left unchanged):')
    for (const { file, items } of unresolvedAll) {
      console.log(`  ${file}:`)
      for (const { asin, anchor } of items) {
        console.log(`    ASIN ${asin} | anchor: "${anchor}"`)
      }
    }
  }

  if (args.dryRun) {
    console.log('\n[dry-run] No files written. Re-run without --dry-run to apply changes.')
  }

  console.log()
  process.exit(totalUnresolved > 0 ? 1 : 0)
}

main()
