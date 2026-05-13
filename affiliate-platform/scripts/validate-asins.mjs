/**
 * ASIN validator — verifies every Amazon product link in products.yaml resolves
 * to a real product page, not a 404 or hallucinated ASIN.
 *
 * Run before cloning: node scripts/validate-asins.mjs
 * Options:
 *   --concurrency=N   parallel requests (default 3 — be gentle with Amazon)
 *   --timeout=N       ms per request (default 8000)
 *   --fail-on-unknown exit 1 if requests are blocked/ambiguous (default: warn only)
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { load } = require('js-yaml')

// Resolve paths relative to site CWD, not this script's location in node_modules
const SITE_ROOT = process.cwd()

// ── Config ────────────────────────────────────────────────────────────────
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '3')
const TIMEOUT_MS  = parseInt(process.argv.find(a => a.startsWith('--timeout='))?.split('=')[1] ?? '8000')
const FAIL_UNKNOWN = process.argv.includes('--fail-on-unknown')

const ASIN_RE = /^[A-Z0-9]{10}$/

// Realistic browser UA to reduce bot-blocking
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ── Load products ─────────────────────────────────────────────────────────
const productsPath = resolve(SITE_ROOT, 'content/products/products.yaml')
const products = load(readFileSync(productsPath, 'utf8'))

const entries = Object.entries(products)
  .filter(([, p]) => p.amazon_asin && p.amazon_asin !== 'NOT_ON_AMAZON')
  .map(([id, p]) => ({ id, asin: p.amazon_asin, name: `${p.brand} ${p.name}` }))

console.log(`\nValidating ${entries.length} ASINs (concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms)\n`)

// ── Validation ────────────────────────────────────────────────────────────
const results = { ok: [], bad_format: [], not_found: [], blocked: [], error: [] }

async function checkAsin({ id, asin, name }) {
  // 1. Format check
  if (!ASIN_RE.test(asin)) {
    results.bad_format.push({ id, asin, name, reason: `Invalid format (not 10 uppercase alphanumeric)` })
    return
  }

  const url = `https://www.amazon.com/dp/${asin}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)

    const body = await res.text()
    const finalUrl = res.url

    if (res.status === 404) {
      results.not_found.push({ id, asin, name, reason: `HTTP 404` })
      return
    }

    // Amazon sometimes redirects to /s? (search) or homepage for invalid ASINs
    if (finalUrl.includes('/s?') || finalUrl === 'https://www.amazon.com/' || finalUrl.includes('/gp/product/glance')) {
      results.not_found.push({ id, asin, name, reason: `Redirected to non-product URL: ${finalUrl}` })
      return
    }

    // Bot-block signals
    if (res.status === 503 || body.includes('Robot Check') || body.includes('api-services-support@amazon.com')) {
      results.blocked.push({ id, asin, name, reason: `Bot-blocked (status ${res.status})` })
      return
    }

    // Must see product indicators in the page
    const isProduct = body.includes('productTitle') || body.includes('add-to-cart') || body.includes('"product"') || body.includes('asin')
    if (!isProduct) {
      results.blocked.push({ id, asin, name, reason: `Ambiguous response — no product indicators (status ${res.status})` })
      return
    }

    results.ok.push({ id, asin })

  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      results.error.push({ id, asin, name, reason: `Timed out after ${TIMEOUT_MS}ms` })
    } else {
      results.error.push({ id, asin, name, reason: err.message })
    }
  }
}

// ── Run with concurrency limit ────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
  const queue = [...tasks]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift()
      process.stdout.write('.')
      await checkAsin(task)
    }
  })
  await Promise.all(workers)
}

await runWithConcurrency(entries, CONCURRENCY)
console.log('\n')

// ── Report ────────────────────────────────────────────────────────────────
const failures = [...results.bad_format, ...results.not_found]
const unknowns  = [...results.blocked, ...results.error]

console.log(`Results:`)
console.log(`  ✓ Valid:        ${results.ok.length}`)
console.log(`  ✗ Bad format:   ${results.bad_format.length}`)
console.log(`  ✗ Not found:    ${results.not_found.length}`)
console.log(`  ? Blocked/err:  ${unknowns.length} (Amazon rate-limiting — rerun to confirm)`)
console.log()

if (failures.length) {
  console.error('CONFIRMED BAD ASINs — fix before shipping:\n')
  for (const f of failures) {
    console.error(`  [${f.id}]  ASIN: ${f.asin}`)
    console.error(`           Product: ${f.name}`)
    console.error(`           Reason: ${f.reason}\n`)
  }
}

if (unknowns.length) {
  console.warn('AMBIGUOUS (rerun to confirm — may be bot-blocked):\n')
  for (const u of unknowns) {
    console.warn(`  [${u.id}]  ASIN: ${u.asin}  — ${u.reason}`)
  }
  console.warn()
}

const exitCode = failures.length > 0 || (FAIL_UNKNOWN && unknowns.length > 0) ? 1 : 0
if (exitCode === 0 && failures.length === 0) {
  console.log(unknowns.length
    ? `⚠ No confirmed bad ASINs. ${unknowns.length} ambiguous — rerun to confirm.`
    : `✓ All ${results.ok.length} ASINs validated successfully.`)
}

process.exit(exitCode)
