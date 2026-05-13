#!/usr/bin/env node
/**
 * verify-bindings.mjs — Verify Cloudflare Pages project bindings match portfolio.yaml.
 *
 * Usage:
 *   node tools/verify-bindings.mjs --site <slug>
 *   node tools/verify-bindings.mjs --all
 *   node tools/verify-bindings.mjs --site <slug> --json
 */

import { getCloudflareToken } from './lib/auth.mjs'
import { loadPortfolio, getSite } from './lib/portfolio.mjs'
import { runChecks } from './lib/binding-checks.mjs'

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  reset:  s => `\x1b[0m${s}`,
}

// ── Output formatter ──────────────────────────────────────────────────────────

function printSiteResults(site, results) {
  console.log(c.bold(`\nSite: ${site.slug}`))
  for (const r of results) {
    const label = r.id === 0 ? r.name : `${r.id}. ${r.name}`
    if (r.status === 'pass') {
      console.log(`  ${c.green('[PASS]')} ${label}`)
    } else if (r.status === 'fail') {
      console.log(`  ${c.red('[FAIL]')} ${label}: ${r.details}`)
    } else if (r.status === 'warn') {
      console.log(`  ${c.yellow('[WARN]')} ${label}: ${r.details}`)
    } else {
      console.log(`  [SKIP] ${label}: ${r.details}`)
    }
  }
  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  const warned = results.filter(r => r.status === 'warn').length
  const parts = [`${passed} passed`, `${failed} failed`]
  if (warned) parts.push(`${warned} warned`)
  console.log(`\n  Summary: ${parts.join(', ')}`)
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const allMode = args.includes('--all')
const siteIdx = args.indexOf('--site')
const siteSlug = siteIdx !== -1 ? args[siteIdx + 1] : null

if (!allMode && !siteSlug) {
  console.error('Usage: verify-bindings.mjs --site <slug> | --all [--json]')
  process.exit(2)
}

let token
try {
  token = getCloudflareToken()
} catch (err) {
  console.error(`Tool error: ${err.message}`)
  process.exit(2)
}

let sites
try {
  sites = allMode ? loadPortfolio() : [getSite(siteSlug)]
} catch (err) {
  console.error(`Tool error: ${err.message}`)
  process.exit(2)
}

const allGa4Ids = loadPortfolio().map(s => s.ga4_id)

let anyFail = false
const jsonOutput = []

for (const site of sites) {
  const results = await runChecks(site, allGa4Ids, token)
  const failed = results.some(r => r.status === 'fail')
  if (failed) anyFail = true

  if (jsonMode) {
    jsonOutput.push({
      site: site.slug,
      passed: results.filter(r => r.status === 'pass').length,
      failed: results.filter(r => r.status === 'fail').length,
      warned: results.filter(r => r.status === 'warn').length,
      checks: results.map(r => ({ id: r.id, name: r.name, status: r.status, details: r.details })),
    })
  } else {
    printSiteResults(site, results)
  }
}

if (jsonMode) {
  console.log(JSON.stringify(jsonOutput, null, 2))
}

process.exit(anyFail ? 1 : 0)
