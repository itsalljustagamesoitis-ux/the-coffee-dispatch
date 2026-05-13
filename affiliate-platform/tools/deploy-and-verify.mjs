#!/usr/bin/env node
/**
 * deploy-and-verify.mjs — git push + Cloudflare deploy poll + post-deploy verification.
 *
 * Usage:
 *   node tools/deploy-and-verify.mjs --site <slug>
 *   node tools/deploy-and-verify.mjs --site <slug> --dry-run
 *   node tools/deploy-and-verify.mjs --site <slug> --skip-push
 *   node tools/deploy-and-verify.mjs --site <slug> --json
 *
 * Exit: 0 = deploy succeeded AND all verification passed
 *       1 = deploy failed OR any verification check failed
 *       2 = tool error (auth, network, dirty tree, etc.)
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

import { getCloudflareToken } from './lib/auth.mjs'
import { loadPortfolio, getSite } from './lib/portfolio.mjs'
import { runChecks } from './lib/binding-checks.mjs'

// ── ANSI ──────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
const esc   = isTTY ? (s, code) => `\x1b[${code}m${s}\x1b[0m` : s => s
const c = {
  green:  s => esc(s, '32'),
  red:    s => esc(s, '31'),
  yellow: s => esc(s, '33'),
  bold:   s => esc(s, '1'),
  dim:    s => esc(s, '2'),
  cyan:   s => esc(s, '36'),
}

// ── Args ──────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2)
const has      = flag => args.includes(flag)
const get      = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const slug     = get('--site')
const dryRun   = has('--dry-run')
const skipPush = has('--skip-push')
const jsonMode = has('--json')

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID       = 'fedb496b1addc0743cb2a84fa5a7ba67'
const CF_BASE          = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS  = 10 * 60 * 1_000  // 10 minutes per PIPELINE.md §1.13
const DEPLOY_LAG_WAIT  = 30_000           // up to 30s for fresh deploy to appear

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

function log(...a)    { if (!jsonMode) console.log(...a) }
function logErr(...a) { if (!jsonMode) console.error(...a) }

function symbol(s) {
  if (s === 'pass') return c.green('✓')
  if (s === 'fail') return c.red('✗')
  if (s === 'warn') return c.yellow('⚠')
  return c.dim('—')
}

// Deterministic seeded RNG (LCG) — same seed = same article sample all day
function seededRng(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

function todaySeed() {
  const d = new Date()
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

// ── Cloudflare Deployments API ────────────────────────────────────────────────

async function cfGet(token, path) {
  let res
  try {
    res = await fetch(`${CF_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(`Network error: ${err.message}`)
  }
  const body = await res.json()
  if (res.status === 429) throw Object.assign(new Error('Cloudflare API rate limit'), { isRateLimit: true })
  if (!body.success) {
    const msg = body.errors?.map(e => `${e.code}: ${e.message}`).join(', ') ?? 'unknown error'
    throw new Error(`CF API error on ${path}: ${msg}`)
  }
  return body.result
}

const listDeployments  = (token, proj)     => cfGet(token, `/pages/projects/${proj}/deployments`)
const getDeployment    = (token, proj, id) => cfGet(token, `/pages/projects/${proj}/deployments/${id}`)

// ── Result accumulator ────────────────────────────────────────────────────────

const result = {
  site: slug,
  deploy: { triggered: false, deployment_id: null, duration_seconds: null, status: 'skipped', error_message: null },
  bindings: [],
  smoke_tests: [],
  content_sanity: { sampled: [], results: [] },
  overall_status: null,
  exit_code: null,
}

function exitWith(code, msg) {
  if (msg) logErr(code >= 2 ? c.red(`\nError: ${msg}`) : c.red(`\n${msg}`))
  result.exit_code = code
  if (jsonMode) console.log(JSON.stringify(result, null, 2))
  process.exit(code)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!slug) exitWith(2, '--site <slug> is required')

  // ── Phase 1: Pre-flight ─────────────────────────────────────────────────────

  log()
  log(c.bold(`Deploy & Verify — ${slug}`))
  log(c.dim('─'.repeat(50)))

  // 1a. Resolve site
  let site, allSites
  try { allSites = loadPortfolio(); site = getSite(slug) }
  catch (err) { exitWith(2, err.message) }

  // 1b. Git checkout
  const siteDir = join(homedir(), slug)
  if (!existsSync(join(siteDir, '.git'))) exitWith(2, `~/${slug}/ is not a git repository`)

  const git = (cmd, opts = {}) =>
    execSync(cmd, { cwd: siteDir, encoding: 'utf-8', stdio: 'pipe', ...opts }).trim()

  if (!skipPush) {
    // 1c. Clean working tree
    const porcelain = git('git status --porcelain')
    if (porcelain) {
      const lines = porcelain.split('\n').slice(0, 10).join('\n  ')
      exitWith(2,
        `working tree must be clean before deploy.\nDirty files (untracked ?? lines also count):\n  ${lines}\n` +
        `Stash, .gitignore, or commit before retrying.`
      )
    }

    // 1d. Branch must be main
    const branch = git('git rev-parse --abbrev-ref HEAD')
    if (branch !== 'main') exitWith(2, `current branch is "${branch}" — must be on main to deploy`)
  }

  // 1e. Sync state (skip if skipPush)
  let syncState = 'skip-push'
  if (!skipPush) {
    try { git('git fetch origin main') } catch (err) { exitWith(2, `git fetch failed: ${err.message}`) }

    const local  = git('git rev-parse main')
    const remote = git('git rev-parse origin/main')
    const base   = git('git merge-base main origin/main')

    if (local === remote) {
      syncState = 'up-to-date'
      log(c.yellow('  Nothing to push — local main == origin/main. Verifying current live state.'))
    } else if (local === base) {
      exitWith(2, 'local main is behind origin/main — run git pull first')
    } else if (remote === base) {
      syncState = 'ahead'
    } else {
      exitWith(2, 'local main has diverged from origin/main — resolve before deploying')
    }
  }

  // 1f. Cloudflare token
  let token
  try { token = getCloudflareToken() } catch (err) { exitWith(2, err.message) }

  log(c.green('  ✓ Pre-flight checks passed'))

  // ── Phase 2: Trigger deploy ─────────────────────────────────────────────────

  const willPush = !skipPush && syncState === 'ahead'

  if (willPush) {
    const commits = git('git log --oneline origin/main..main')
    const n = commits ? commits.split('\n').length : 0
    log()
    log(c.bold(`  About to push ${n} commit(s) to origin/main, triggering Cloudflare Pages deploy:`))
    for (const l of commits.split('\n')) log(c.dim(`    ${l}`))

    if (dryRun) {
      log()
      log(c.cyan('  Dry run — stopping here. No push performed.'))
      result.deploy.status = 'skipped'
      result.overall_status = 'pass'
      result.exit_code = 0
      if (jsonMode) console.log(JSON.stringify(result, null, 2))
      process.exit(0)
    }

    log()
    log('  Pushing...')
    try {
      git('git push origin main')
      result.deploy.triggered = true
      log(c.green('  ✓ Push succeeded'))
    } catch (err) {
      exitWith(2, `git push failed: ${err.stderr ?? err.message}`)
    }
  }

  // ── Phase 3: Poll deploy state ──────────────────────────────────────────────

  let deployDurationSeconds = null

  if (willPush) {
    log()
    log('  Waiting for Cloudflare to pick up deployment...')

    // Wait up to 30s for a fresh deployment (<60s old) to appear
    const lagDeadline = Date.now() + DEPLOY_LAG_WAIT
    let freshDeploy = null
    while (Date.now() < lagDeadline) {
      try {
        const deploys = await listDeployments(token, site.cloudflare_project)
        const recent = (deploys ?? []).find(d => Date.now() - new Date(d.created_on).getTime() < 60_000)
        if (recent) { freshDeploy = recent; break }
      } catch (err) {
        if (err.isRateLimit) exitWith(2, 'Cloudflare API rate limit — try again later')
      }
      await sleep(POLL_INTERVAL_MS)
    }

    if (!freshDeploy) {
      exitWith(1, 'deploy not triggered — push may not have been picked up by Cloudflare. Check the Pages dashboard.')
    }

    const deploymentId = freshDeploy.id
    result.deploy.deployment_id = deploymentId
    log(c.green(`  ✓ Deployment ${deploymentId} detected`))
    log()

    const pollDeadline = Date.now() + POLL_TIMEOUT_MS
    const deployStarted = Date.now()
    let lastStatus = null

    while (Date.now() < pollDeadline) {
      let dep
      try { dep = await getDeployment(token, site.cloudflare_project, deploymentId) }
      catch (err) {
        if (err.isRateLimit) exitWith(2, 'Cloudflare API rate limit during poll')
        await sleep(POLL_INTERVAL_MS); continue
      }

      const stageName = dep.latest_stage?.name ?? 'unknown'
      const status    = dep.latest_stage?.status ?? 'unknown'

      if (isTTY) {
        process.stdout.write(`\r  ${c.dim(`[${stageName}]`)} ${status}...   `)
      } else if (status !== lastStatus) {
        log(`  [${stageName}] ${status}`)
      }
      lastStatus = status

      if (status === 'success') {
        deployDurationSeconds = Math.round((Date.now() - deployStarted) / 1000)
        if (isTTY) process.stdout.write('\n')
        log(c.green(`  ✓ Deploy succeeded in ${deployDurationSeconds}s`))
        result.deploy.status = 'success'
        result.deploy.duration_seconds = deployDurationSeconds
        break
      }
      if (status === 'failure' || status === 'failed') {
        if (isTTY) process.stdout.write('\n')
        const errMsg = `failed at stage: ${stageName}`
        result.deploy.status = 'failure'; result.deploy.error_message = errMsg
        exitWith(1, `Deploy failed — ${errMsg}. Check Cloudflare Pages dashboard.`)
      }
      if (status === 'canceled') {
        if (isTTY) process.stdout.write('\n')
        result.deploy.status = 'failure'; result.deploy.error_message = 'deployment was canceled'
        exitWith(1, 'Deploy was canceled.')
      }
      await sleep(POLL_INTERVAL_MS)
    }

    if (result.deploy.status !== 'success') {
      exitWith(1, 'deploy timeout exceeded 10-minute hard fail per PIPELINE.md §1.13')
    }
  } else if (!skipPush && syncState === 'up-to-date') {
    result.deploy.status = 'skipped'
  } else {
    log()
    log(c.dim('  (skip-push — verifying current live state)'))
    result.deploy.status = 'skipped'
  }

  // ── Phase 4: Verification ───────────────────────────────────────────────────

  log()
  log(c.bold('  Running verification...'))

  // 4a. Bindings (8 checks)
  log()
  log(c.bold('  Bindings'))
  const allGa4Ids = allSites.map(s => s.ga4_id).filter(Boolean)
  let bindingResults
  try { bindingResults = await runChecks(site, allGa4Ids, token) }
  catch (err) { exitWith(2, `Bindings check error: ${err.message}`) }
  result.bindings = bindingResults
  for (const chk of bindingResults) {
    const det = chk.details ? c.dim(` — ${chk.details}`) : ''
    log(`  ${String(chk.id).padStart(2)}. ${symbol(chk.status)} ${chk.name.padEnd(42)}${det}`)
  }

  // 4b. Smoke tests
  log()
  log(c.bold('  Smoke Tests'))
  const domain = site.domain
  const smokeResults = []

  const tryFetch = async (url, timeout = 15_000) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeout) })
      return { ok: r.ok, status: r.status, text: await r.text() }
    } catch (err) {
      return { ok: false, status: 0, text: '', error: err.message }
    }
  }

  // Test 9: Homepage 200 + body > 1KB
  {
    const r = await tryFetch(`https://${domain}/`)
    let status = 'fail', details = ''
    if (r.error) {
      details = r.error
      if (/dns|getaddrinfo/i.test(r.error)) details += ' — DNS may not have propagated yet; try again in a few minutes'
    } else if (r.status === 200 && r.text.length > 1000) {
      status = 'pass'; details = `${r.status} — ${r.text.length} bytes`
    } else {
      details = `${r.status} — ${r.text.length} bytes`
    }
    smokeResults.push({ id: 9, name: 'Homepage 200 + body > 1KB', status, details })
    log(`   9. ${symbol(status)} ${'Homepage 200 + body > 1KB'.padEnd(42)}${details ? c.dim(` — ${details}`) : ''}`)
  }

  // Test 10: Sitemap XML reachable
  {
    let status = 'fail', details = ''
    const idx = await tryFetch(`https://${domain}/sitemap-index.xml`, 10_000)
    if (idx.ok && /<sitemapindex/i.test(idx.text)) {
      status = 'pass'; details = 'sitemap-index.xml — valid sitemapindex'
    } else {
      const sm = await tryFetch(`https://${domain}/sitemap.xml`, 10_000)
      if (sm.ok && (/<urlset/i.test(sm.text) || /<sitemapindex/i.test(sm.text))) {
        status = 'pass'; details = 'sitemap.xml — valid urlset/sitemapindex'
      } else {
        details = 'neither /sitemap-index.xml nor /sitemap.xml returned valid XML'
      }
    }
    smokeResults.push({ id: 10, name: 'Sitemap XML reachable', status, details })
    log(`  10. ${symbol(status)} ${'Sitemap XML reachable'.padEnd(42)}${details ? c.dim(` — ${details}`) : ''}`)
  }

  // Test 11: robots.txt has Sitemap directive
  {
    const r = await tryFetch(`https://${domain}/robots.txt`, 10_000)
    let status = 'fail', details = ''
    if (r.error)           { details = r.error }
    else if (!r.ok)        { details = `status ${r.status}` }
    else if (!r.text.includes('Sitemap:')) { details = 'robots.txt exists but no Sitemap: directive' }
    else                   { status = 'pass'; details = `${r.status} — Sitemap directive present` }
    smokeResults.push({ id: 11, name: 'robots.txt has Sitemap directive', status, details })
    log(`  11. ${symbol(status)} ${'robots.txt has Sitemap directive'.padEnd(42)}${details ? c.dim(` — ${details}`) : ''}`)
  }
  result.smoke_tests = smokeResults

  // 4c. Content sanity
  log()
  log(c.bold('  Content Sanity'))

  const pipelinePath = join(siteDir, 'data', 'pipeline.json')
  let csStatus = 'pass', csDetail = ''

  const printCs = (s, d) => log(`  12. ${symbol(s)} ${'Article content sanity (5 samples)'.padEnd(42)}${d ? c.dim(` — ${d}`) : ''}`)

  if (!existsSync(pipelinePath)) {
    csStatus = 'skip'; csDetail = 'pipeline.json not found'; printCs('skip', csDetail)
  } else {
    let pipeline = null
    try {
      const raw = JSON.parse(readFileSync(pipelinePath, 'utf-8'))
      pipeline = Array.isArray(raw) ? raw : (raw.articles ?? [])
    } catch (err) {
      csStatus = 'skip'; csDetail = `cannot parse pipeline.json: ${err.message}`; printCs('skip', csDetail)
    }

    if (pipeline !== null) {
      const published = pipeline.filter(a => a.status === 'published')
      if (published.length === 0) {
        csStatus = 'skip'; csDetail = 'no published articles to sample'; printCs('skip', csDetail)
      } else {
        const rng = seededRng(todaySeed())
        const sample = [...published].sort(() => rng() - 0.5).slice(0, 5)
        const trackingId = site.tracking_id
        const sampleResults = []

        for (const article of sample) {
          const url = `https://${domain}/${article.slug}/`
          const failures = []
          const r = await tryFetch(url)
          if (r.error) {
            failures.push(`fetch error: ${r.error}`)
          } else if (r.status !== 200) {
            failures.push(`HTTP ${r.status}`)
          } else {
            if (r.text.includes('{{'))
              failures.push('placeholder leak: {{ found in body')
            if (article.products?.length > 0 && !r.text.includes(`tag=${trackingId}`))
              failures.push(`affiliate tag not found (expected ?tag=${trackingId})`)
            const ldMatch = r.text.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i)
            if (!ldMatch) {
              failures.push('no <script type="application/ld+json"> found')
            } else {
              try { JSON.parse(ldMatch[1]) } catch { failures.push('JSON-LD block is invalid JSON') }
            }
          }
          sampleResults.push({ slug: article.slug, status: failures.length === 0 ? 'pass' : 'fail', failures })
        }

        result.content_sanity = { sampled: sample.map(a => a.slug), results: sampleResults }

        const failed = sampleResults.filter(r => r.status === 'fail')
        if (failed.length > 0) {
          csStatus = 'fail'
          csDetail = `${failed.length}/${sample.length} articles failed: ${failed.map(r => r.slug).join(', ')}`
        } else {
          csDetail = `${sample.length} articles checked`
        }
        printCs(csStatus, csDetail)
        for (const f of failed) log(c.dim(`       ${f.slug}: ${f.failures.join('; ')}`))
      }
    }
  }

  // ── Phase 5: Summary ────────────────────────────────────────────────────────

  log()
  log(c.bold('  Summary'))
  log(c.dim('  ' + '─'.repeat(48)))

  const bPass = bindingResults.filter(r => r.status === 'pass').length
  const bWarn = bindingResults.filter(r => r.status === 'warn').length
  const bFail = bindingResults.filter(r => r.status === 'fail').length
  const sPass = smokeResults.filter(r => r.status === 'pass').length
  const sFail = smokeResults.filter(r => r.status === 'fail').length

  if (deployDurationSeconds !== null) log(`  Deploy duration:   ${deployDurationSeconds}s`)
  log(`  Bindings:          ${bPass}/${bindingResults.length} passed${bWarn > 0 ? ` (${bWarn} warning${bWarn > 1 ? 's' : ''})` : ''}`)
  log(`  Smoke tests:       ${sPass}/${smokeResults.length} passed`)
  const csSummary = csStatus === 'skip' ? 'skipped' : csStatus === 'pass' ? `pass — ${csDetail}` : `fail — ${csDetail}`
  log(`  Content sanity:    ${csSummary}`)

  const anyFail = bFail > 0 || sFail > 0 || csStatus === 'fail'
  const anyWarn = bWarn > 0

  const overall = anyFail ? 'fail' : anyWarn ? 'pass_with_warnings' : 'pass'
  result.overall_status = overall
  result.exit_code = anyFail ? 1 : 0

  log()
  if (overall === 'fail')              log(c.red('  ✗ FAIL'))
  else if (overall === 'pass_with_warnings') log(c.yellow('  ⚠ PASS WITH WARNINGS'))
  else                                 log(c.green('  ✓ PASS'))
  log()

  if (jsonMode) console.log(JSON.stringify(result, null, 2))
  process.exit(anyFail ? 1 : 0)
}

main().catch(err => {
  logErr(c.red(`\nUnexpected error: ${err.message}`))
  if (err.stack && !jsonMode) logErr(c.dim(err.stack))
  result.exit_code = 2
  if (jsonMode) console.log(JSON.stringify(result, null, 2))
  process.exit(2)
})
