#!/usr/bin/env node
/**
 * assign-article-images.mjs — Populate hero_image + body_images in pipeline.json.
 *
 * Usage:
 *   node tools/assign-article-images.mjs --site <slug>
 *   node tools/assign-article-images.mjs --site <slug> --reassign
 *   node tools/assign-article-images.mjs --site <slug> --dry-run
 *   node tools/assign-article-images.mjs --site <slug> --json
 *   node tools/assign-article-images.mjs --all
 *
 * Point 9.6 of the launch-site ritual (PIPELINE.md).
 *
 * Reads pipeline.json, assigns hero_image + body_images from the site's
 * image bank (public/images/articles/). Idempotent by default — only writes
 * where hero_image is missing or null. Hero selection rotates through hub
 * images for uniqueness; body images are seeded-random per article.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadPortfolio, getSite } from './lib/portfolio.mjs'

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

const args    = process.argv.slice(2)
const get     = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }
const has     = flag => args.includes(flag)

const siteSlug = get('--site')
const allSites = has('--all')
const reassign = has('--reassign')
const dryRun   = has('--dry-run')
const jsonMode = has('--json')

if (!siteSlug && !allSites) {
  console.error('Usage: node tools/assign-article-images.mjs --site <slug> [--reassign] [--dry-run] [--json]')
  console.error('       node tools/assign-article-images.mjs --all [--reassign] [--dry-run] [--json]')
  process.exit(2)
}

// ── RNG: mulberry32 seeded with djb2 hash of slug ─────────────────────────────

/**
 * djb2 hash of a string → unsigned 32-bit integer.
 * @param {string} s
 * @returns {number}
 */
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
  }
  return h
}

/**
 * Returns a seeded PRNG function (mulberry32).
 * Each call to the returned function produces the next float in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) >>> 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Returns a seeded PRNG for a given article slug.
 * @param {string} slug
 * @returns {() => number}
 */
function seededRand(slug) {
  return mulberry32(hashStr(slug))
}

// ── Image bank loading ────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/**
 * Reads public/images/articles/ and returns a map of hub → sorted filename array.
 * Filenames must match <hub>-<N>.<ext>.
 * @param {string} imagesDir  absolute path to the images directory
 * @returns {Map<string, string[]>}
 */
function loadImageBank(imagesDir) {
  const bank = new Map()
  for (const fname of readdirSync(imagesDir)) {
    const dotIdx = fname.lastIndexOf('.')
    if (dotIdx === -1) continue
    const ext = fname.slice(dotIdx).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) continue
    const match = fname.match(/^(.+)-\d+\.[a-z]+$/i)
    if (!match) continue
    const hub = match[1]
    if (!bank.has(hub)) bank.set(hub, [])
    bank.get(hub).push(fname)
  }
  for (const [hub, files] of bank) {
    bank.set(hub, files.sort())
  }
  return bank
}

// ── Core assignment logic ─────────────────────────────────────────────────────

/**
 * Assigns hero_image and body_images for all articles in one site.
 * Returns a result object; does not exit.
 *
 * @param {string} slug  site slug from portfolio.yaml
 * @param {{ reassign: boolean, dryRun: boolean, jsonMode: boolean }} opts
 * @returns {{ exitCode: number, site: string, populated: number, skipped: number, warnings: string[], hubs: object[] }}
 */
function assignSite(slug, opts) {
  const { reassign, dryRun, jsonMode } = opts

  let site
  try {
    site = getSite(slug)
  } catch (e) {
    if (!jsonMode) console.error(`${c.red('[ERROR]')} ${e.message}`)
    return { exitCode: 2, site: slug, populated: 0, skipped: 0, warnings: [e.message], hubs: [] }
  }

  const siteDir    = join(homedir(), slug)
  const pipelinePath = join(siteDir, 'data', 'pipeline.json')
  const imagesDir  = join(siteDir, 'public', 'images', 'articles')

  // Validate paths
  if (!existsSync(pipelinePath)) {
    const msg = `No pipeline.json at ${pipelinePath}`
    if (!jsonMode) console.error(`${c.red('[ERROR]')} ${msg}`)
    return { exitCode: 2, site: slug, populated: 0, skipped: 0, warnings: [msg], hubs: [] }
  }
  if (!existsSync(imagesDir)) {
    const msg = `Image bank directory not found: ${imagesDir}`
    if (!jsonMode) console.error(`${c.red('[ERROR]')} ${msg}`)
    return { exitCode: 2, site: slug, populated: 0, skipped: 0, warnings: [msg], hubs: [] }
  }

  // Load pipeline
  let envelope
  try {
    envelope = JSON.parse(readFileSync(pipelinePath, 'utf-8'))
  } catch (e) {
    const msg = `Failed to parse pipeline.json: ${e.message}`
    if (!jsonMode) console.error(`${c.red('[ERROR]')} ${msg}`)
    return { exitCode: 2, site: slug, populated: 0, skipped: 0, warnings: [msg], hubs: [] }
  }
  if (!envelope.articles || !Array.isArray(envelope.articles)) {
    const msg = `pipeline.json missing articles array`
    if (!jsonMode) console.error(`${c.red('[ERROR]')} ${msg}`)
    return { exitCode: 2, site: slug, populated: 0, skipped: 0, warnings: [msg], hubs: [] }
  }

  const bank = loadImageBank(imagesDir)

  if (!jsonMode) {
    console.log()
    console.log(`${c.bold('Site:')} ${slug}`)
    console.log(`${c.bold('Pipeline:')} ${pipelinePath}`)
    console.log(`${c.bold('Image bank:')} ${imagesDir}`)
    console.log(`${c.bold('Articles:')} ${envelope.articles.length}`)
    if (dryRun)   console.log(c.yellow('  DRY RUN — pipeline.json will not be written'))
    if (reassign) console.log(c.yellow('  --reassign — overwriting existing assignments'))
    console.log()
  }

  // Sort articles: hub then id (deterministic processing order for hero rotation)
  const sorted = [...envelope.articles].sort((a, b) => {
    const ha = a.hub || '', hb = b.hub || ''
    if (ha < hb) return -1
    if (ha > hb) return 1
    return (a.id || 0) - (b.id || 0)
  })

  // Per-hub state
  const heroUsed    = {}  // hub → Set of filenames already used as hero
  const hubArticles = {}  // hub → array of articles (for stats)
  const hubAssigned = {}  // hub → count assigned this run

  for (const article of sorted) {
    const hub = article.hub || ''
    if (!hubArticles[hub]) hubArticles[hub] = []
    hubArticles[hub].push(article)
  }

  let populated = 0
  let skipped   = 0
  const warnings = []
  const hubStats  = []

  for (const hub of Object.keys(hubArticles).sort()) {
    const articles = hubArticles[hub]
    const images   = bank.get(hub) || []

    // No hub field
    if (!hub) {
      for (const article of articles) {
        const msg = `Article id=${article.id} slug=${article.slug} has no hub field`
        warnings.push(msg)
        if (!jsonMode) console.log(`  ${c.yellow('[WARN]')} ${msg}`)
      }
      hubStats.push({ hub: '(none)', images_in_bank: 0, articles: articles.length, hero_unique_count: 0 })
      continue
    }

    // No images for this hub
    if (images.length === 0) {
      if (!jsonMode) console.log(`${c.cyan('[HUB]')} ${hub}`)
      if (!jsonMode) console.log(`  ${c.yellow('[SKIP]')} hub has no images in bank`)
      const msg = `Hub "${hub}" has no images in bank (${articles.length} articles unassigned)`
      warnings.push(msg)
      hubStats.push({ hub, images_in_bank: 0, articles: articles.length, hero_unique_count: 0 })
      continue
    }

    if (!heroUsed[hub]) heroUsed[hub] = new Set()
    const usedHeroes = heroUsed[hub]
    let assignedCount = 0

    for (const article of articles) {
      // Idempotent skip
      if (article.hero_image && !reassign) {
        skipped++
        continue
      }

      // Seeded RNG for this article
      const rand = seededRand(article.slug || String(article.id))

      // Hero: pick from unused images if any remain, else seeded random from all
      let heroFile
      const unused = images.filter(f => !usedHeroes.has(f))
      if (unused.length > 0) {
        heroFile = unused[Math.floor(rand() * unused.length)]
      } else {
        heroFile = images[Math.floor(rand() * images.length)]
      }
      usedHeroes.add(heroFile)

      // Body: 4 images, seeded random (may repeat, may overlap hero)
      const bodyImages = []
      for (let i = 0; i < 4; i++) {
        const f = images[Math.floor(rand() * images.length)]
        bodyImages.push({ alt: article.keyword || '', path: `articles/${f}` })
      }

      if (!dryRun) {
        article.hero_image  = `articles/${heroFile}`
        article.body_images = bodyImages
      }

      populated++
      assignedCount++
    }

    // Hub output
    const heroUniqueCount = usedHeroes.size
    const articleCount    = articles.length
    const skippedCount    = articleCount - assignedCount
    const ratio           = images.length > 0 ? articleCount / images.length : Infinity
    const poolUndersized  = ratio > 3

    if (poolUndersized) {
      const ratioStr  = ratio === Infinity ? '∞' : ratio.toFixed(1)
      const repeatLow = Math.floor(ratio)
      const repeatHi  = Math.ceil(ratio)
      const msg = `Hub "${hub}": hero pool undersized: ${articleCount} articles / ${images.length} images = ${ratioStr}×`
      warnings.push(msg)
      if (!jsonMode) {
        console.log(`${c.cyan('[HUB]')} ${hub} ${c.dim(`(${images.length} images, ${articleCount} articles)`)}`)
        console.log(`  ${c.yellow('[WARN]')} hero pool undersized: ${articleCount} articles / ${images.length} images = ${ratioStr}× (heroes will repeat ${repeatLow}–${repeatHi} times each)`)
      }
    } else if (!jsonMode) {
      console.log(`${c.cyan('[HUB]')} ${hub} ${c.dim(`(${images.length} images, ${articleCount} articles)`)}`)
    }

    if (!jsonMode) {
      if (assignedCount > 0 && !poolUndersized) {
        console.log(`  ${c.green('[PASS]')} ${assignedCount} articles assigned, hero rotation uses ${heroUniqueCount}/${images.length} images`)
      }
      if (skippedCount > 0) {
        console.log(`  ${c.dim('[SKIP]')} ${skippedCount} already populated (use --reassign to overwrite)`)
      }
    }

    hubStats.push({ hub, images_in_bank: images.length, articles: articleCount, hero_unique_count: heroUniqueCount })
  }

  // Write pipeline.json
  if (!dryRun && populated > 0) {
    envelope.articles.sort((a, b) => (a.id || 0) - (b.id || 0))
    writeFileSync(pipelinePath, JSON.stringify(envelope, null, 2))
  }

  // Exit code: 1 if any hub had no images and articles were left unassigned
  const hasFailure = warnings.some(w => w.includes('no images in bank'))
  const exitCode = hasFailure ? 1 : 0

  if (!jsonMode) {
    console.log()
    const mode = dryRun ? ' (dry run)' : ''
    console.log(`Summary${mode}: ${c.green(`${populated} articles populated`)}, ${c.dim(`${skipped} skipped (already populated)`)}, ${warnings.length > 0 ? c.yellow(`${warnings.length} warning(s)`) : '0 warnings'}`)
    console.log()
  }

  return { exitCode, site: slug, populated, skipped, warnings, hubs: hubStats }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const opts = { reassign, dryRun, jsonMode }
const results = []

if (allSites) {
  let sites
  try {
    sites = loadPortfolio()
  } catch (e) {
    console.error(`${c.red('[ERROR]')} Cannot load portfolio.yaml: ${e.message}`)
    process.exit(2)
  }
  for (const site of sites) {
    results.push(assignSite(site.slug, opts))
  }
} else {
  results.push(assignSite(siteSlug, opts))
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(
    results.length === 1 ? results[0] : results,
    null, 2
  ) + '\n')
}

const exitCode = results.reduce((max, r) => Math.max(max, r.exitCode), 0)
process.exit(exitCode)
