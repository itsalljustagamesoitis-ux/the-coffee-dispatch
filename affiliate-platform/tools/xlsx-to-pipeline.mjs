#!/usr/bin/env node
/**
 * xlsx-to-pipeline.mjs — Convert keyword research xlsx into pipeline.json.
 *
 * Usage:
 *   node tools/xlsx-to-pipeline.mjs --input <path-to-xlsx> --output <path-to-pipeline.json>
 *   node tools/xlsx-to-pipeline.mjs --input <path-to-xlsx> --output <path-to-pipeline.json> --json
 *
 * Point 3 of the launch-site ritual (PIPELINE.md).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { basename, resolve } from 'path'
import { fileURLToPath } from 'url'
import XLSX from 'xlsx'

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
}

const pass = label => console.log(`  ${c.green('[PASS]')} ${label}`)
const fail = label => console.error(`  ${c.red('[FAIL]')} ${label}`)

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const get = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }
const has = flag => args.includes(flag)

const inputPath  = get('--input')
const outputPath = get('--output')
const jsonMode   = has('--json')

if (!inputPath || !outputPath) {
  console.error('Usage: node tools/xlsx-to-pipeline.mjs --input <xlsx> --output <pipeline.json>')
  process.exit(2)
}

const absInput  = resolve(inputPath)
const absOutput = resolve(outputPath)

// ── Required columns ──────────────────────────────────────────────────────────

const REQUIRED_COLS = [
  '#', 'Hub', 'Hub Slug', 'Hub URL', 'Cluster', 'Keyword', 'Slug',
  'Locked URL', 'Article Type', 'Required Product Count', 'Angle',
  'H2 Structure', 'Volume', 'KD', 'CPC', 'Intent', 'Quality',
  'AI Overview', 'Premium Brand', 'Source Seed',
]

const VALID_TYPES = new Set(['buyer_guide', 'roundup', 'comparison', 'review'])

/**
 * Normalizes an Article Type string to the platform's lowercase_underscore form.
 * @param {string} raw
 * @returns {string}
 */
function normalizeType(raw) {
  if (!raw) return raw
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Coerces a cell value to integer or null.
 * @param {any} v
 * @returns {number|null}
 */
function toInt(v) {
  if (v === null || v === undefined || v === '') return null
  const n = parseInt(v, 10)
  return isNaN(n) ? null : n
}

/**
 * Coerces a cell value to float or null.
 * @param {any} v
 * @returns {number|null}
 */
function toFloat(v) {
  if (v === null || v === undefined || v === '') return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

/**
 * Interprets a cell value as boolean.
 * Treats "$", "yes", "true", "1", and any non-empty non-None string as true.
 * Treats null, undefined, "", "none", "no", "false", "0" as false.
 * @param {any} v
 * @returns {boolean}
 */
function toBool(v) {
  if (v === null || v === undefined || v === '') return false
  const s = String(v).trim().toLowerCase()
  return !['none', 'no', 'false', '0', ''].includes(s)
}

/**
 * Derives the site slug from the xlsx filename.
 * e.g. "thecoffeedispatch-launch-300.xlsx" → "thecoffeedispatch"
 * @param {string} filename
 * @returns {string}
 */
function deriveSiteSlug(filename) {
  return basename(filename, '.xlsx').replace(/-launch-\d+$/i, '')
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log()
console.log(c.bold(`Reading: ${basename(absInput)}`))

// Validation 1: file exists
if (!existsSync(absInput)) {
  fail(`Input file not found: ${absInput}`)
  process.exit(2)
}

let wb
try {
  wb = XLSX.readFile(absInput)
} catch (err) {
  fail(`Cannot read xlsx: ${err.message}`)
  process.exit(2)
}

// Validation 2: find Launch-N sheet
const launchSheet = wb.SheetNames.find(n => /^Launch-\d+$/i.test(n))
if (!launchSheet) {
  fail(`No "Launch-N" sheet found. Sheets: ${wb.SheetNames.join(', ')}`)
  process.exit(1)
}

const expectedCount = parseInt(launchSheet.replace(/^Launch-/i, ''), 10)
const ws = wb.Sheets[launchSheet]
const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null })

console.log(`  Found sheet: ${launchSheet} (${rawRows.length} rows)`)
console.log()

let errors = 0

// Validation 3: required columns
const actualCols = new Set(Object.keys(rawRows[0] ?? {}))
const missingCols = REQUIRED_COLS.filter(col => !actualCols.has(col))
if (missingCols.length > 0) {
  fail(`Missing required columns: ${missingCols.join(', ')}`)
  errors++
} else {
  pass('Required columns present')
}

// Validation 4: every row has #, Slug, Hub, Cluster, Article Type
const missingRequired = rawRows
  .map((row, i) => ({ row, i }))
  .filter(({ row }) => !row['#'] || !row['Slug'] || !row['Hub'] || !row['Cluster'] || !row['Article Type'])
  .map(({ i }) => i + 2) // 1-indexed, +1 for header
if (missingRequired.length > 0) {
  fail(`Rows missing required fields (#, Slug, Hub, Cluster, Article Type): rows ${missingRequired.slice(0, 5).join(', ')}${missingRequired.length > 5 ? '...' : ''}`)
  errors++
}

// Validation 5: slugs unique
const slugsSeen = new Map()
const dupSlugs = []
for (const row of rawRows) {
  const slug = row['Slug']
  if (!slug) continue
  if (slugsSeen.has(slug)) dupSlugs.push(slug)
  else slugsSeen.set(slug, true)
}
if (dupSlugs.length > 0) {
  fail(`Duplicate slugs: ${dupSlugs.slice(0, 5).join(', ')}${dupSlugs.length > 5 ? '...' : ''}`)
  errors++
} else {
  pass(`All slugs unique (${rawRows.length} articles)`)
}

// Validation 6: article types valid
const badTypes = rawRows
  .map(row => normalizeType(row['Article Type']))
  .filter(t => t && !VALID_TYPES.has(t))
const uniqueBadTypes = [...new Set(badTypes)]
if (uniqueBadTypes.length > 0) {
  fail(`Invalid Article Type values: ${uniqueBadTypes.join(', ')} — expected: buyer_guide, roundup, comparison, review`)
  errors++
} else {
  pass('Article types valid')
}

// Validation 7: count matches suffix
if (rawRows.length !== expectedCount) {
  fail(`Article count mismatch: sheet is ${launchSheet} but contains ${rawRows.length} rows (expected ${expectedCount})`)
  errors++
} else {
  pass(`Article count matches ${launchSheet}`)
}

if (errors > 0) {
  console.error(`\n${c.red(`${errors} validation error(s). Aborting.`)}`)
  process.exit(1)
}

// ── Build output ──────────────────────────────────────────────────────────────

const articles = rawRows.map(row => ({
  id:                     toInt(row['#']),
  slug:                   String(row['Slug']).trim(),
  category:               String(row['Hub']).trim(),
  hub:                    row['Hub Slug'] ? String(row['Hub Slug']).trim() : String(row['Cluster']).trim(),
  hub_slug:               row['Hub Slug'] ? String(row['Hub Slug']).trim() : null,
  cluster:                String(row['Cluster']).trim(),
  locked_url:             row['Locked URL'] ? String(row['Locked URL']).trim() : null,
  type:                   normalizeType(row['Article Type']),
  keyword:                row['Keyword'] ? String(row['Keyword']).trim() : null,
  angle:                  row['Angle'] ? String(row['Angle']).trim() : null,
  h2_structure:           row['H2 Structure'] ? String(row['H2 Structure']).trim() : null,
  required_product_count: toInt(row['Required Product Count']),
  volume:                 toInt(row['Volume']),
  kd:                     toInt(row['KD']),
  cpc:                    toFloat(row['CPC']),
  intent:                 row['Intent'] ? String(row['Intent']).trim() : null,
  quality_score:          toInt(row['Quality']),
  ai_overview:            toBool(row['AI Overview']),
  premium_brand:          toBool(row['Premium Brand']),
  source_seed:            row['Source Seed'] ? String(row['Source Seed']).trim() : null,
  products:               [],
  hero_image:             null,
  body_images:            [],
}))

const categories = [...new Set(articles.map(a => a.category))].sort()
const hubs       = [...new Set(articles.map(a => a.hub))].sort()

console.log()
console.log(`  Categories: ${categories.length} (${categories.join(', ')})`)
console.log(`  Hubs: ${hubs.length} (${hubs.join(', ')})`)
console.log()

const site = deriveSiteSlug(basename(absInput))

const output = {
  version:      1,
  site,
  generated_at: new Date().toISOString(),
  source_xlsx:  basename(absInput),
  articles,
}

if (jsonMode) {
  // Write structured JSON summary to stdout for --json callers
  const summary = {
    site,
    source_xlsx: basename(absInput),
    article_count: articles.length,
    categories,
    hubs,
    output_path: absOutput,
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
}

try {
  writeFileSync(absOutput, JSON.stringify(output, null, 2), 'utf-8')
} catch (err) {
  fail(`Cannot write output: ${err.message}`)
  process.exit(2)
}

console.log(c.green(`  Wrote ${articles.length} articles to: ${absOutput}`))
console.log()
