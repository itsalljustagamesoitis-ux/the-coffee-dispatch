#!/usr/bin/env node
/**
 * dashboard.mjs — Operational visibility CLI for the affiliate platform.
 *
 * Modes:
 *   A (default)   — status snapshot table
 *   B --readiness — launch readiness per site
 *   C --health    — health check with blockers/warnings
 *   --all         — A + B + C in order
 *
 * Modifiers: --site <slug>  --full (live HTML Amazon check)  --json
 *
 * Exit: 0 = no blockers, 1 = at least one blocker, 2 = tool error
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join }   from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import { loadPortfolio, getSite }  from './lib/portfolio.mjs'
import { getCloudflareToken }      from './lib/auth.mjs'
import { runChecks }               from './lib/binding-checks.mjs'
import { getProject }              from './lib/cloudflare-api.mjs'

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
const args = process.argv.slice(2)
const has  = flag => args.includes(flag)
const get  = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const jsonMode    = has('--json')
const fullMode    = has('--full')
const siteSlug    = get('--site')
const allMode     = has('--all')
const doReadiness = has('--readiness') || allMode
const doHealth    = has('--health')    || allMode
const doSnapshot  = (!has('--readiness') && !has('--health')) || allMode

// ── Shared utilities ──────────────────────────────────────────────────────────

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Right-pad string to visual width n, ignoring ANSI codes */
function pad(s, n) {
  return s + ' '.repeat(Math.max(0, n - stripAnsi(s).length))
}

/** Relative time: "2d ago", "3h ago", "14m ago", or "—" */
function relTime(dateStr) {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Map Cloudflare deployment status to concise coloured label */
function deployLabel(project) {
  const status = project?.latest_deployment?.latest_stage?.status
  if (!status) return c.dim('—')
  const map = {
    success:  c.green('live'),
    failure:  c.red('failed'),
    active:   c.cyan('building'),
    canceled: c.dim('canceled'),
    skipped:  c.dim('skipped'),
  }
  return map[status] ?? status
}

/** Count *.md files in <siteRoot>/content/articles/ */
function countMd(siteRoot) {
  const dir = join(siteRoot, 'content', 'articles')
  if (!existsSync(dir)) return null
  try { return readdirSync(dir).filter(f => f.endsWith('.md')).length } catch { return null }
}

/** Parse pipeline.json — returns articles array, { error } object, or null if missing */
function readPipeline(siteRoot) {
  const p = join(siteRoot, 'data', 'pipeline.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    const arts = raw.articles ?? (Array.isArray(raw) ? raw : null)
    return arts ?? { error: 'no articles array found in envelope' }
  } catch (e) { return { error: e.message } }
}

/** Read products.yaml from content/products/ or data/ */
function readProducts(siteRoot) {
  for (const rel of ['content/products/products.yaml', 'data/products.yaml']) {
    const p = join(siteRoot, rel)
    if (!existsSync(p)) continue
    try { return { data: yaml.load(readFileSync(p, 'utf-8')) } }
    catch (e) { return { error: e.message } }
  }
  return null
}

/** True if public/images/articles/ exists and contains at least one image */
function hasImages(siteRoot) {
  const dir = join(siteRoot, 'public', 'images', 'articles')
  if (!existsSync(dir)) return false
  try { return readdirSync(dir).some(f => /\.(jpg|jpeg|png|webp)$/i.test(f)) } catch { return false }
}

const ga4Valid = id => typeof id === 'string' && /^G-[A-Z0-9]{6,}$/.test(id)

/** Find a check by numeric id in a runChecks results array */
const getChk = (checks, id) => checks.find(r => r.id === id) ?? null

/** Render a check result as a compact status icon */
function statusIcon(r) {
  if (!r) return c.dim('—')
  if (r.status === 'pass') return c.green('✓')
  if (r.status === 'warn') return c.yellow('⚠')
  if (r.status === 'skip') return c.dim('[run --full]')
  return c.red('✗')
}

// ── Data gathering (once per site, shared across all active modes) ─────────────

/**
 * Gather Cloudflare checks, project object, GitHub reachability, and filesystem
 * state for one site. Called once per site regardless of active modes.
 * @param {import('./lib/portfolio.mjs').SiteEntry} site
 * @param {string[]} allGa4Ids
 * @param {string} token
 */
async function gatherSite(site, allGa4Ids, token) {
  const siteRoot    = join(homedir(), site.slug)
  const localExists = existsSync(siteRoot)

  // CF checks — skip live HTML Amazon scrape unless --full
  let cfChecks = []
  try {
    cfChecks = await runChecks(site, allGa4Ids, token, { skipLiveHtml: !fullMode })
  } catch (e) {
    cfChecks = [{ id: 0, name: 'Cloudflare API reachable', status: 'fail', details: e.message }]
  }

  // getProject separately for deploy_state / last_deploy (runChecks doesn't expose the object)
  let project = null
  if (getChk(cfChecks, 0)?.status !== 'fail') {
    try { project = await getProject(token, site.cloudflare_project) } catch {}
  }

  return {
    site,
    siteRoot,
    localExists,
    cfChecks,
    project,
    pipeline:    localExists ? readPipeline(siteRoot) : null,
    mdCount:     localExists ? countMd(siteRoot) : null,
    products:    localExists ? readProducts(siteRoot) : null,
    imagesExist: localExists ? hasImages(siteRoot) : false,
  }
}

// ── Mode A: Status Snapshot ───────────────────────────────────────────────────

function buildSnapshotRow(d) {
  const check4 = getChk(d.cfChecks, 4)
  const check7 = getChk(d.cfChecks, 7)
  return {
    slug:         d.site.slug,
    domain:       d.site.domain,
    deploy_state: deployLabel(d.project),
    articles:     d.mdCount != null ? String(d.mdCount) : c.dim('—'),
    last_deploy:  relTime(d.project?.latest_deployment?.created_on),
    ga4:          ga4Valid(d.site.ga4_id) ? c.green('✓') : c.red('✗'),
    amazon_tag:   fullMode ? statusIcon(check4) : c.dim('[run --full]'),
    indexnow:     statusIcon(check7),
  }
}

function printSnapshot(rows) {
  const cols = [
    { key: 'slug',         label: 'Site',        w: 22 },
    { key: 'domain',       label: 'Domain',       w: 24 },
    { key: 'deploy_state', label: 'Deploy',       w: 10 },
    { key: 'articles',     label: 'Articles',     w: 10 },
    { key: 'last_deploy',  label: 'Last Deploy',  w: 13 },
    { key: 'ga4',          label: 'GA4',          w: 6  },
    { key: 'amazon_tag',   label: 'Amazon',       w: 16 },
    { key: 'indexnow',     label: 'IndexNow',     w: 10 },
  ]
  const totalW = cols.reduce((a, col) => a + col.w, 0)
  console.log(c.bold('\nStatus Snapshot'))
  console.log(c.dim(cols.map(col => pad(col.label, col.w)).join('')))
  console.log(c.dim('─'.repeat(totalW)))
  for (const row of rows) console.log(cols.map(col => pad(row[col.key], col.w)).join(''))
  console.log()
}

// ── Mode B: Launch Readiness ──────────────────────────────────────────────────

/**
 * Run the 10 launch readiness checks for one site from pre-gathered data.
 * @returns {{ checks: Array, anyFail: boolean }}
 */
function buildReadinessChecks(d) {
  const checks = []
  let anyFail = false
  const pass = (n, name, detail = '') => checks.push({ n, name, status: 'pass', detail })
  const fail = (n, name, detail = '') => { checks.push({ n, name, status: 'fail', detail }); anyFail = true }
  const skip = (n, name, detail = '') => checks.push({ n, name, status: 'skip', detail })

  // 1. Portfolio entry (always passes — we got this far)
  pass(1, 'Portfolio entry')

  // 2. Cloudflare project
  getChk(d.cfChecks, 0)?.status === 'fail'
    ? fail(2, 'Cloudflare project', getChk(d.cfChecks, 0).details)
    : pass(2, 'Cloudflare project')

  // 3. Custom domain
  const cf3 = getChk(d.cfChecks, 3)
  if (!cf3)                     skip(3, 'Custom domain', 'CF checks did not complete')
  else if (cf3.status === 'pass') pass(3, 'Custom domain', d.site.domain)
  else                           fail(3, 'Custom domain', cf3.details)

  // 4. DNS to Cloudflare
  const cf8 = getChk(d.cfChecks, 8)
  if (!cf8)                                              skip(4, 'DNS to Cloudflare', 'CF checks did not complete')
  else if (cf8.status === 'pass' || cf8.status === 'warn') pass(4, 'DNS to Cloudflare', cf8.details)
  else                                                   fail(4, 'DNS to Cloudflare', cf8.details)

  if (!d.localExists) {
    for (const [n, name] of [
      [5, 'Pipeline populated'], [6, 'Products sourced'],
      [7, 'Images sourced'],     [8, 'Images assigned'], [9, 'Articles generated'],
    ]) skip(n, name, 'no local checkout')
  } else {
    const pipe = d.pipeline

    // 5. Pipeline populated
    if (!pipe)              fail(5, 'Pipeline populated', 'pipeline.json missing')
    else if (pipe.error)    fail(5, 'Pipeline populated', pipe.error)
    else if (!pipe.length)  fail(5, 'Pipeline populated', 'articles array is empty')
    else                    pass(5, 'Pipeline populated', `${pipe.length} articles`)

    // 6. Products sourced (all articles have non-empty products)
    if (!pipe || pipe.error) {
      skip(6, 'Products sourced', 'pipeline unavailable')
    } else {
      const n = pipe.filter(a => !a.products?.length).length
      n === 0 ? pass(6, 'Products sourced') : fail(6, 'Products sourced', `${n} articles have empty products`)
    }

    // 7. Images sourced
    d.imagesExist
      ? pass(7, 'Images sourced')
      : fail(7, 'Images sourced', 'no images in public/images/articles/')

    // 8. Images assigned (hero_image set on all pipeline articles)
    if (!pipe || pipe.error) {
      skip(8, 'Images assigned', 'pipeline unavailable')
    } else {
      const n = pipe.filter(a => !a.hero_image).length
      n === 0 ? pass(8, 'Images assigned') : fail(8, 'Images assigned', `${n} articles missing hero_image`)
    }

    // 9. Articles generated (.md count >= published count)
    if (!pipe || pipe.error) {
      skip(9, 'Articles generated', 'pipeline unavailable')
    } else {
      const published = pipe.filter(a => a.status === 'published').length
      const md = d.mdCount ?? 0
      md >= published
        ? pass(9, 'Articles generated', `${md} .md files, ${published} published in pipeline`)
        : fail(9, 'Articles generated', `${md} generated, ${published} marked published in pipeline`)
    }
  }

  // 10. First deploy
  d.project?.latest_deployment
    ? pass(10, 'First deploy', relTime(d.project.latest_deployment.created_on))
    : fail(10, 'First deploy', 'no deployment found')

  return { checks, anyFail }
}

function printReadiness(readinessData) {
  console.log(c.bold('\nLaunch Readiness'))
  for (const { site, checks, anyFail } of readinessData) {
    const passed  = checks.filter(r => r.status === 'pass').length
    const failed  = checks.filter(r => r.status === 'fail')
    const skipped = checks.filter(r => r.status === 'skip')
    if (!anyFail) {
      console.log(`  [${site.slug}] ${c.green(`${passed}/${checks.length} ✓ launch complete`)}`)
    } else {
      const pendingStr = failed.map(r => `${r.n} (${r.detail})`).join(', ')
      console.log(`  ${c.bold(`[${site.slug}]`)} ${passed}/${checks.length} — pending: ${pendingStr}`)
      if (skipped.length) console.log(c.dim(`    skipped: ${skipped.map(r => r.n).join(', ')}`))
    }
  }
  console.log()
}

// ── Mode C: Health Check ──────────────────────────────────────────────────────

/**
 * Derive blocker/warning lists for one site from pre-gathered data.
 * @returns {{ blockers: string[], warnings: string[] }}
 */
function buildHealthItems(d) {
  const blockers = [], warnings = []
  const block = msg => blockers.push(msg)
  const warn  = msg => warnings.push(msg)
  const preLaunch = d.site.pre_launch === true

  // 1. Binding health
  const cf0 = getChk(d.cfChecks, 0)
  if (cf0?.status === 'fail') {
    block(`bindings: CF API unreachable — ${cf0.details}`)
  } else {
    for (const r of d.cfChecks) {
      if (r.id === 0) continue
      if (r.id === 4 && !fullMode) continue   // live HTML check only with --full
      if (r.status === 'fail') block(`binding ${r.id} (${r.name}): ${r.details}`)
      else if (r.status === 'warn') warn(`binding ${r.id} (${r.name}): ${r.details}`)
    }
  }

  if (!d.localExists) {
    warn('filesystem: no local checkout — pipeline, products, and content checks skipped')
    return { blockers, warnings }
  }

  // 2. Pipeline integrity
  const pipe = d.pipeline
  if (!pipe) {
    warn('pipeline: pipeline.json missing')
  } else if (pipe.error) {
    block(`pipeline: malformed — ${pipe.error}`)
  } else {
    for (const field of ['id', 'slug', 'keyword', 'type', 'hub']) {
      const n = pipe.filter(a => !a[field]).length
      if (n > 0) block(`pipeline: ${n} articles missing required field "${field}"`)
    }
    const pubNoProds  = pipe.filter(a => a.status === 'published' && !a.products?.length).length
    const pendNoProds = pipe.filter(a => a.status !== 'published' && !a.products?.length).length
    if (pubNoProds  > 0) block(`pipeline: ${pubNoProds} published articles have empty products`)
    if (pendNoProds > 0)  warn(`pipeline: ${pendNoProds} unpublished articles have empty products`)

    const pubNoHero  = pipe.filter(a => a.status === 'published' && !a.hero_image).length
    const pendNoHero = pipe.filter(a => a.status !== 'published' && !a.hero_image).length
    if (pubNoHero  > 0) block(`pipeline: ${pubNoHero} published articles missing hero_image`)
    if (pendNoHero > 0)  warn(`pipeline: ${pendNoHero} unpublished articles missing hero_image`)
  }

  // 3. Products catalog
  if (d.products?.error) {
    warn(`products: read error — ${d.products.error}`)
  } else if (d.products?.data) {
    const entries    = Object.values(d.products.data)
    const verifyN    = entries.filter(p => p?.amazon_asin === 'VERIFY').length
    const notAmazonN = entries.filter(p => p?.amazon_asin === 'NOT_ON_AMAZON').length
    if (verifyN    > 0) warn(`products: ${verifyN} VERIFY entries unresolved`)
    if (notAmazonN > 0) warn(`products: ${notAmazonN} NOT_ON_AMAZON entries (informational)`)
  }

  // 4. Deploy state
  if (!d.project?.latest_deployment) {
    if (!preLaunch) block('deploy: no deployment found and site is marked as launched')
    // pre-launch: expected, suppress entirely
  } else {
    const status = d.project.latest_deployment.latest_stage?.status
    if (status === 'failure') block('deploy: latest deployment failed')
    const age = Date.now() - new Date(d.project.latest_deployment.created_on).getTime()
    if (age > 14 * 24 * 60 * 60 * 1000) {
      warn(`deploy: last deploy was ${relTime(d.project.latest_deployment.created_on)} — stale`)
    }
  }

  // 5. Content drift
  if (pipe && !pipe.error && d.mdCount != null) {
    const publishedCount = pipe.filter(a => a.status === 'published').length
    if (d.mdCount !== publishedCount) {
      warn(`drift: pipeline says ${publishedCount} published, ${d.mdCount} .md files in content/`)
    }
    // Published in pipeline but no corresponding .md file → blocker
    const artDir = join(d.siteRoot, 'content', 'articles')
    if (existsSync(artDir)) {
      const mdSlugs = new Set(
        readdirSync(artDir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
      )
      const missing = pipe.filter(a => a.status === 'published' && !mdSlugs.has(a.slug)).slice(0, 5)
      for (const a of missing) block(`drift: published in pipeline but missing from content/ — ${a.slug}`)
    }
  }

  return { blockers, warnings }
}

function printHealth(healthData) {
  console.log(c.bold('\nHealth Check'))
  let totalBlockers = 0, totalWarnings = 0, sitesWithBlockers = 0

  for (const { site, blockers, warnings } of healthData) {
    const preLaunch = site.pre_launch === true
    console.log(`  ${c.bold(`[${site.slug}]`)}${preLaunch ? c.dim(' pre-launch') : ''}`)
    if (blockers.length === 0 && warnings.length === 0) {
      console.log(c.green('    ✓ all checks passing'))
    } else {
      for (const b of blockers) console.log(c.red(`    ✗ ${b}`))
      for (const w of warnings) console.log(c.yellow(`    ⚠ ${w}`))
    }
    totalBlockers  += blockers.length
    totalWarnings  += warnings.length
    if (blockers.length > 0) sitesWithBlockers++
  }

  console.log()
  const s = n => n !== 1 ? 's' : ''
  console.log(c.bold(
    `  Summary: ${totalBlockers} blocker${s(totalBlockers)} across ` +
    `${sitesWithBlockers} site${s(sitesWithBlockers)}, ${totalWarnings} warning${s(totalWarnings)}`
  ))
  console.log()
  return totalBlockers
}

// ── Main ──────────────────────────────────────────────────────────────────────

let sites
try {
  sites = siteSlug ? [getSite(siteSlug)] : loadPortfolio()
} catch (e) {
  console.error(`Tool error: ${e.message}`)
  process.exit(2)
}

const allGa4Ids = loadPortfolio().map(s => s.ga4_id)

let token
try {
  token = getCloudflareToken()
} catch (e) {
  console.error(`Tool error: ${e.message}`)
  process.exit(2)
}

// Gather all site data once, sequentially (respects CF rate limits)
const gathered = []
for (const site of sites) gathered.push(await gatherSite(site, allGa4Ids, token))

let anyBlocker = false
const jsonOut  = {}

if (doSnapshot) {
  const rows = gathered.map(buildSnapshotRow)
  if (jsonMode) {
    jsonOut.snapshot = {
      mode: 'snapshot',
      sites: rows.map(r => ({
        slug: r.slug, domain: r.domain,
        deploy_state: stripAnsi(r.deploy_state),
        articles:     stripAnsi(r.articles),
        last_deploy:  r.last_deploy,
        ga4:          stripAnsi(r.ga4) === '✓',
        amazon_tag:   stripAnsi(r.amazon_tag),
        indexnow:     stripAnsi(r.indexnow),
      }))
    }
  } else {
    printSnapshot(rows)
  }
}

if (doReadiness) {
  const readinessData = gathered.map(d => {
    const { checks, anyFail } = buildReadinessChecks(d)
    if (anyFail) anyBlocker = true
    return { site: d.site, checks, anyFail }
  })
  if (jsonMode) {
    jsonOut.readiness = {
      mode: 'readiness',
      sites: readinessData.map(({ site, checks }) => ({
        slug:   site.slug,
        total:  checks.length,
        passed: checks.filter(r => r.status === 'pass').length,
        checks,
      }))
    }
  } else {
    printReadiness(readinessData)
  }
}

if (doHealth) {
  const healthData    = gathered.map(d => ({ site: d.site, ...buildHealthItems(d) }))
  const totalBlockers = healthData.reduce((a, d) => a + d.blockers.length, 0)
  if (totalBlockers > 0) anyBlocker = true
  if (jsonMode) {
    jsonOut.health = {
      mode:   'health',
      sites:  healthData.map(({ site, blockers, warnings }) => ({ slug: site.slug, blockers, warnings })),
      totals: {
        blockers: totalBlockers,
        warnings: healthData.reduce((a, d) => a + d.warnings.length, 0),
      }
    }
  } else {
    printHealth(healthData)
  }
}

if (jsonMode) console.log(JSON.stringify(jsonOut, null, 2))

process.exit(anyBlocker ? 1 : 0)
