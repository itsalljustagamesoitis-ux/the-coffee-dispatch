#!/usr/bin/env node
/**
 * source-images-pexels.mjs — Download topical images from Pexels, organised by hub.
 *
 * Downloads jpg images from Pexels and converts to webp (quality 85) during
 * the download step. Output files are named <hub>-N.webp.
 *
 * Usage:
 *   node tools/source-images-pexels.mjs --site <slug>
 *   node tools/source-images-pexels.mjs --site <slug> --per-hub 20
 *   node tools/source-images-pexels.mjs --site <slug> --dry-run
 *   node tools/source-images-pexels.mjs --site <slug> --json
 *
 * Point 11 of the launch-site ritual (PIPELINE.md).
 *
 * Reads PEXELS_API_KEY from environment (or <site>/config/credentials.env as fallback).
 */

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import sharp from 'sharp'
import { loadPortfolio } from './lib/portfolio.mjs'

const WEBP_QUALITY = 85

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args   = process.argv.slice(2)
const get    = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }
const has    = flag => args.includes(flag)

const siteSlug = get('--site')
const perHub   = parseInt(get('--per-hub') ?? '19', 10)
const dryRun   = has('--dry-run')
const jsonMode = has('--json')

if (!siteSlug) {
  console.error('Usage: node tools/source-images-pexels.mjs --site <slug> [--per-hub N] [--dry-run] [--json]')
  process.exit(2)
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Returns the Pexels API key from environment or site credentials.env fallback.
 * @param {string} siteDir
 * @returns {string}
 */
function getPexelsKey(siteDir) {
  if (process.env.PEXELS_API_KEY) return process.env.PEXELS_API_KEY

  const credPath = join(siteDir, 'config', 'credentials.env')
  if (existsSync(credPath)) {
    const raw = readFileSync(credPath, 'utf-8')
    const match = raw.match(/^PEXELS_API_KEY=(.+)$/m)
    if (match) return match[1].trim()
  }

  console.error(`${c.red('[ERROR]')} PEXELS_API_KEY not set (checked env + ${credPath})`)
  process.exit(2)
}

// ── Site + pipeline loading ───────────────────────────────────────────────────

let sites
try {
  sites = loadPortfolio()
} catch (err) {
  console.error(`${c.red('[ERROR]')} Cannot load portfolio.yaml: ${err.message}`)
  process.exit(2)
}

if (!sites.find(s => s.slug === siteSlug)) {
  console.error(`${c.red('[ERROR]')} Site "${siteSlug}" not found in portfolio.yaml`)
  process.exit(2)
}

const siteDir    = join(homedir(), siteSlug)
const pipelinePath = join(siteDir, 'data', 'pipeline.json')
const imagesDir  = join(siteDir, 'public', 'images', 'articles')

if (!existsSync(siteDir)) {
  console.error(`${c.red('[ERROR]')} Site directory not found: ${siteDir}`)
  console.error(`         Create the site shell first (initialise-site.mjs) before sourcing images.`)
  process.exit(2)
}

if (!existsSync(pipelinePath)) {
  console.error(`${c.red('[ERROR]')} No pipeline.json at ${pipelinePath}`)
  console.error(`         Run tools/xlsx-to-pipeline.mjs to generate it, then place it at this path.`)
  process.exit(2)
}

/**
 * Loads pipeline.json and returns a normalised array of articles.
 * @param {string} path
 * @returns {Array<{ hub: string, category: string }>}
 */
function loadPipeline(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  if (!raw.articles || !Array.isArray(raw.articles)) {
    throw new Error('Invalid pipeline.json — expected envelope format { version, articles: [...] }')
  }
  return raw.articles.map(a => ({
    hub:      a.hub ?? '',
    category: a.category ?? '',
  }))
}

const articles = loadPipeline(pipelinePath)

// ── Hub extraction + query building ──────────────────────────────────────────

/**
 * Derives a niche context keyword from the site's category names.
 * Looks for a shared food/hobby domain word across categories.
 * Falls back to the site slug.
 * @param {string[]} categories
 * @param {string} slug
 * @returns {string}
 */
function deriveNicheKeyword(categories, slug) {
  const joined = categories.join(' ').toLowerCase()
  const candidates = [
    { word: 'coffee',    test: /coffee|espresso|brew|roast|grind|cappuccino|latte/i },
    { word: 'cooking',  test: /cooking|kitchen|recipe|food|meal|chef|baking/i },
    { word: 'garden',   test: /garden|plant|grow|soil|lawn|outdoor|flower/i },
    { word: 'pet',      test: /pet|dog|cat|animal|paw|veterinary/i },
    { word: 'home',     test: /home|decor|furniture|interior|living/i },
  ]
  for (const { word, test } of candidates) {
    if (test.test(joined)) return word
  }
  // Fallback: first word of slug
  return slug.split('-')[0]
}

/**
 * Converts a hub slug to a Pexels search query string.
 * Appends niche keyword if not already present.
 * @param {string} hubSlug
 * @param {string} nicheKeyword
 * @returns {string}
 */
function buildQuery(hubSlug, nicheKeyword) {
  const base = hubSlug.replace(/-/g, ' ')
  if (base.includes(nicheKeyword)) return base
  return `${base} ${nicheKeyword}`
}

// Collect unique hubs (preserving first-seen order)
const seen = new Set()
const hubs = []
for (const a of articles) {
  if (a.hub && !seen.has(a.hub)) {
    seen.add(a.hub)
    hubs.push(a.hub)
  }
}

const categories = [...new Set(articles.map(a => a.category).filter(Boolean))]
const nicheKeyword = deriveNicheKeyword(categories, siteSlug)

const pexelsKey = getPexelsKey(siteDir)

// ── Print plan ────────────────────────────────────────────────────────────────

if (!jsonMode) {
  console.log()
  console.log(`${c.bold('Site:')} ${siteSlug}`)
  console.log(`${c.bold('Pipeline:')} ${pipelinePath}`)
  console.log(`${c.bold('Hubs:')} ${hubs.length} (${hubs.join(', ')})`)
  console.log(`${c.bold('Per hub:')} ${perHub}`)
  console.log(`${c.bold('Total target:')} ${hubs.length * perHub} images`)
  console.log(`${c.bold('Niche context:')} "${nicheKeyword}"`)
  if (dryRun) console.log(c.yellow('  DRY RUN — no images will be downloaded'))
  console.log()
}

if (dryRun) {
  for (const hub of hubs) {
    const query = buildQuery(hub, nicheKeyword)
    if (!jsonMode) {
      console.log(`  ${c.cyan('[HUB]')} ${hub} (query: "${query}")`)
      for (let i = 1; i <= perHub; i++) {
        console.log(`    ${c.dim(`→ ${hub}-${i}.webp`)}`)
      }
    }
  }
  if (!jsonMode) console.log()
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      site: siteSlug, dry_run: true, hubs: hubs.length,
      per_hub: perHub, total_target: hubs.length * perHub,
      hub_queries: hubs.map(h => ({ hub: h, query: buildQuery(h, nicheKeyword) })),
    }, null, 2) + '\n')
  }
  process.exit(0)
}

// ── Pexels API + download ─────────────────────────────────────────────────────

if (!existsSync(imagesDir)) {
  mkdirSync(imagesDir, { recursive: true })
}

/**
 * Queries Pexels for landscape photos.
 * @param {string} query
 * @param {number} count
 * @returns {Promise<Array<{ url: string, width: number, height: number }>>}
 */
async function searchPexels(query, count) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape&size=large`
  const res = await fetch(url, { headers: { Authorization: pexelsKey } })
  if (!res.ok) throw new Error(`Pexels API ${res.status}: ${res.statusText}`)
  const body = await res.json()
  return (body.photos ?? []).map(p => ({
    url:    p.src.large,
    width:  p.width,
    height: p.height,
  }))
}

/**
 * Downloads a single image, converts to webp, and writes to destPath.
 * Retries once on failure.
 * @param {string} url
 * @param {string} destPath  — must end in .webp
 * @returns {Promise<boolean>} true on success
 */
async function downloadImage(url, destPath) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const arrayBuf = await res.arrayBuffer()
      const webpBuf = await sharp(Buffer.from(arrayBuf)).webp({ quality: WEBP_QUALITY }).toBuffer()
      await writeFile(destPath, webpBuf)
      return true
    } catch (err) {
      if (attempt === 2) return false
    }
  }
  return false
}

// ── Main download loop ────────────────────────────────────────────────────────

const totals = { downloaded: 0, skipped: 0, failed: 0 }
const jsonResults = []

for (const hub of hubs) {
  const query = buildQuery(hub, nicheKeyword)
  if (!jsonMode) console.log(`  ${c.cyan('[HUB]')} ${hub} (query: "${query}")`)

  let photos
  try {
    photos = await searchPexels(query, perHub)
  } catch (err) {
    if (!jsonMode) console.log(`    ${c.red('[ERROR]')} Pexels search failed: ${err.message}`)
    totals.failed += perHub
    continue
  }

  if (photos.length < perHub && !jsonMode) {
    console.log(`    ${c.yellow('[WARN]')} Pexels returned ${photos.length} of ${perHub} requested`)
  }

  const hubResult = { hub, query, downloaded: 0, skipped: 0, failed: 0 }

  for (let i = 0; i < photos.length; i++) {
    const { url, width, height } = photos[i]
    const filename = `${hub}-${i + 1}.webp`
    const destPath = join(imagesDir, filename)

    // Skip if too small (must be at least 1200x630)
    if (width < 1200 || height < 630) {
      if (!jsonMode) console.log(`    ${c.yellow('[SKIP]')}     ${filename} ${c.dim(`(${width}x${height} — below 1200x630)`)}`)
      hubResult.skipped++
      totals.skipped++
      continue
    }

    if (existsSync(destPath)) {
      if (!jsonMode) console.log(`    ${c.dim('[SKIP]')}     ${filename} ${c.dim('(already exists)')}`)
      hubResult.skipped++
      totals.skipped++
      continue
    }

    const ok = await downloadImage(url, destPath)
    if (ok) {
      if (!jsonMode) console.log(`    ${c.green('[DOWNLOAD]')} ${filename} ${c.dim(`(${width}x${height})`)}`)
      hubResult.downloaded++
      totals.downloaded++
    } else {
      if (!jsonMode) console.log(`    ${c.red('[FAIL]')}     ${filename} ${c.dim('(download failed after 2 attempts)')}`)
      hubResult.failed++
      totals.failed++
    }
  }

  jsonResults.push(hubResult)
}

// ── Summary ───────────────────────────────────────────────────────────────────

if (!jsonMode) {
  console.log()
  console.log(`Summary: ${totals.downloaded} downloaded, ${totals.skipped} skipped (existed/small), ${totals.failed} failed`)
  console.log()
}

if (jsonMode) {
  process.stdout.write(JSON.stringify({
    site: siteSlug, dry_run: false,
    downloaded: totals.downloaded,
    skipped: totals.skipped,
    failed: totals.failed,
    hubs: jsonResults,
  }, null, 2) + '\n')
}

process.exit(totals.failed > 0 ? 1 : 0)
