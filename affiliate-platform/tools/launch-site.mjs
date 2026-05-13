#!/usr/bin/env node
/**
 * launch-site.mjs — Flip a pre_launch site to live.
 *
 * Runs gate checks (verify-site-shell --strict, deploy-and-verify), submits
 * IndexNow, flips portfolio status to live, commits + pushes. Refuses to
 * proceed if any gate fails. Does not prepare anything — that's the producer's
 * job. This is purely the flip-the-switch command.
 *
 * Usage:
 *   node tools/launch-site.mjs --site <slug>
 *   node tools/launch-site.mjs --site <slug> --dry-run
 *
 * Exit codes:
 *   0 — launched (or dry-run clean)
 *   1 — gate failed; portfolio NOT modified, no IndexNow submission
 *   2 — tool error (auth, missing files, bad state)
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import yaml from 'js-yaml'

import { loadPortfolio } from './lib/portfolio.mjs'

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

const args   = process.argv.slice(2)
const has    = flag => args.includes(flag)
const get    = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const slug   = get('--site')
const dryRun = has('--dry-run')

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORTFOLIO_PATH  = join(PLATFORM_ROOT, 'portfolio.yaml')
const TOOL_SHELL      = join(PLATFORM_ROOT, 'tools', 'verify-site-shell.mjs')
const TOOL_DEPLOY     = join(PLATFORM_ROOT, 'tools', 'deploy-and-verify.mjs')

// ── Helpers ───────────────────────────────────────────────────────────────────

function execCmd(cmd, opts = {}) {
  try {
    return { ok: true, stdout: execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', ...opts }).trim() }
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.trim() ?? '',
      stderr: err.stderr?.trim() ?? err.message,
    }
  }
}

function readPortfolioRaw() {
  try {
    return readFileSync(PORTFOLIO_PATH, 'utf-8')
  } catch (err) {
    console.error(c.red(`Cannot read portfolio.yaml: ${err.message}`))
    process.exit(2)
  }
}

function parsePortfolio(raw) {
  try {
    const doc = yaml.load(raw)
    if (!doc?.sites || !Array.isArray(doc.sites)) throw new Error('missing sites array')
    return doc
  } catch (err) {
    console.error(c.red(`portfolio.yaml parse error: ${err.message}`))
    process.exit(2)
  }
}

function countPublishedArticles(siteDir) {
  const pipelinePath = join(siteDir, 'data', 'pipeline.json')
  if (!existsSync(pipelinePath)) return 0
  try {
    const pipeline = JSON.parse(readFileSync(pipelinePath, 'utf-8'))
    const articles = pipeline.articles ?? []
    return articles.filter(a => a.status === 'published' || a.wp_post_id).length
  } catch {
    return 0
  }
}

// ── Phase 1 — Pre-flight ──────────────────────────────────────────────────────

function phase1(siteDir) {
  console.log(c.bold('\nPhase 1 — Pre-flight'))

  // 1b: site directory
  if (!existsSync(siteDir)) {
    console.error(c.red(`  ✗ Site directory not found: ${siteDir}`))
    console.error(c.dim('    Run initialise-site.mjs first.'))
    process.exit(2)
  }

  // 1a/1c: portfolio entry + already-live check
  const raw = readPortfolioRaw()
  const doc = parsePortfolio(raw)
  const entry = doc.sites.find(s => s.slug === slug)
  if (!entry) {
    console.error(c.red(`  ✗ "${slug}" not found in portfolio.yaml`))
    process.exit(2)
  }

  if (entry.status === 'live') {
    const raw = entry.launched
    const launchedAt = raw instanceof Date ? raw.toISOString().slice(0, 10) : (raw ?? 'unknown date')
    console.error(c.yellow(`  Site ${slug} is already live (launched: ${launchedAt}). Nothing to do.`))
    process.exit(2)
  }

  // 1e: article count gate
  const published = countPublishedArticles(siteDir)
  if (published === 0) {
    console.error(c.red('  ✗ No published articles. Launch requires at least 1 published article.'))
    console.error(c.dim('    Run the producer pipeline first.'))
    process.exit(1)
  }

  // 1d: launch context
  console.log(c.green('  ✓ Site found in portfolio'))
  console.log(c.dim(`\n  Site:             ${slug}`))
  console.log(c.dim(`  Domain:           ${entry.domain}`))
  console.log(c.dim(`  Current status:   ${entry.status}`))
  console.log(c.dim(`  Articles:         ${published} published`))
  if (dryRun) console.log(c.yellow('\n  DRY RUN — gates will run; portfolio + IndexNow will be skipped'))
  console.log(c.dim('\n  About to: verify shell → verify deploy → submit IndexNow → flip portfolio to live'))

  return { entry, doc }
}

// ── Phase 2 — Gate: verify-site-shell ────────────────────────────────────────

function phase2() {
  console.log(c.bold('\nPhase 2 — Gate: verify-site-shell --strict'))

  const result = execCmd(`node ${TOOL_SHELL} --site ${slug} --strict --json`)

  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    console.error(c.red('  ✗ verify-site-shell returned unparseable output'))
    if (result.stderr) console.error(c.dim(`    ${result.stderr}`))
    process.exit(1)
  }

  const siteData = parsed?.sites?.[slug]
  if (!siteData) {
    console.error(c.red(`  ✗ Site "${slug}" not found in verify-site-shell JSON output`))
    process.exit(1)
  }

  const blockerCount = siteData.blockers ?? 0
  if (blockerCount > 0) {
    console.error(c.red(`  ✗ Site shell verification failed — ${blockerCount} blocker(s):`))
    const failedChecks = (siteData.checks ?? []).filter(ch => ch.status === 'fail')
    for (const ch of failedChecks) {
      const detail = ch.detail ? ` — ${ch.detail}` : ''
      console.error(c.red(`      [${ch.id}] ${ch.label}${detail}`))
    }
    console.error(c.dim(`\n    Run: node tools/verify-site-shell.mjs --site ${slug} --strict`))
    console.error(c.dim('    Resolve all blockers before launching.'))
    process.exit(1)
  }

  const warnCount = siteData.warnings ?? 0
  if (warnCount > 0) {
    console.log(c.yellow(`  ⚠ ${warnCount} warning(s) (non-blocking in strict mode)`))
    const warnChecks = (siteData.checks ?? []).filter(ch => ch.status === 'warn')
    for (const ch of warnChecks) console.log(c.yellow(`      [${ch.id}] ${ch.label} — ${ch.detail}`))
  }

  console.log(c.green('  ✓ Site shell verification passed'))
}

// ── Phase 3 — Gate: deploy-and-verify ────────────────────────────────────────

function phase3() {
  console.log(c.bold('\nPhase 3 — Gate: deploy-and-verify'))

  const result = execCmd(`node ${TOOL_DEPLOY} --site ${slug} --skip-push --json`)

  let parsed
  try {
    // deploy-and-verify may emit multiple JSON objects; take the last complete one
    const jsonBlocks = result.stdout.match(/\{[\s\S]*?\n\}/g) ?? [result.stdout]
    parsed = JSON.parse(jsonBlocks[jsonBlocks.length - 1])
  } catch {
    console.error(c.red('  ✗ deploy-and-verify returned unparseable output'))
    if (result.stderr) console.error(c.dim(`    ${result.stderr.slice(0, 200)}`))
    process.exit(1)
  }

  const status = parsed?.overall_status
  if (status === 'fail' || status === 'error') {
    console.error(c.red(`  ✗ Deploy verification failed (overall_status: ${status})`))

    const failedBindings = (parsed.bindings ?? []).filter(b => b.status === 'fail')
    const failedSmoke    = (parsed.smoke_tests ?? []).filter(s => s.status === 'fail')
    const failedContent  = (parsed.content_sanity?.results ?? []).filter(r => r.status === 'fail')

    if (failedBindings.length) {
      console.error(c.red('    Bindings:'))
      for (const b of failedBindings) console.error(c.red(`      [${b.id}] ${b.name} — ${b.details}`))
    }
    if (failedSmoke.length) {
      console.error(c.red('    Smoke tests:'))
      for (const s of failedSmoke) console.error(c.red(`      [${s.id}] ${s.name} — ${s.details}`))
    }
    if (failedContent.length) {
      console.error(c.red('    Content sanity:'))
      for (const r of failedContent) console.error(c.red(`      ${r.url ?? r.slug} — ${r.issue ?? r.detail}`))
    }

    console.error(c.dim(`\n    Run: node tools/deploy-and-verify.mjs --site ${slug} --skip-push`))
    console.error(c.dim('    Resolve all failures before launching.'))
    process.exit(1)
  }

  if (status === 'pass_with_warnings') {
    const warnBindings = (parsed.bindings ?? []).filter(b => b.status === 'warn')
    const warnSmoke    = (parsed.smoke_tests ?? []).filter(s => s.status === 'warn')
    if (warnBindings.length || warnSmoke.length) {
      console.log(c.yellow(`  ⚠ Deploy verification passed with warnings (non-blocking):`))
      for (const b of warnBindings) console.log(c.yellow(`      [${b.id}] ${b.name} — ${b.details}`))
      for (const s of warnSmoke)    console.log(c.yellow(`      [${s.id}] ${s.name} — ${s.details}`))
    }
  }

  console.log(c.green('  ✓ Deploy verification passed'))
}

// ── Phase 4 — IndexNow submission ─────────────────────────────────────────────

function phase4(siteDir, published) {
  console.log(c.bold('\nPhase 4 — IndexNow submission'))

  const script = join(siteDir, 'producer', 'indexnow-submit.py')
  if (!existsSync(script)) {
    console.error(c.red('  ✗ IndexNow script missing — required for launch.'))
    console.error(c.dim(`    Add ${siteDir}/producer/indexnow-submit.py before re-running.`))
    process.exit(1)
  }

  if (dryRun) {
    const result = execCmd(`cd ${siteDir} && python3 producer/indexnow-submit.py --all --dry-run`)
    const urlLine = result.stdout.split('\n').find(l => /\d+.*url/i.test(l)) ?? `~${published} URLs`
    console.log(c.dim(`  (dry-run: would submit — ${urlLine})`))
    console.log(c.green('  ✓ IndexNow dry-run complete'))
    return
  }

  const result = execCmd(`cd ${siteDir} && python3 producer/indexnow-submit.py --all`)
  if (!result.ok) {
    console.log(c.yellow('  ⚠ IndexNow submission returned non-zero. Site is live but search engines were not pinged.'))
    console.log(c.dim(`    Retry: cd ${siteDir} && python3 producer/indexnow-submit.py --all`))
    if (result.stderr) console.log(c.dim(`    Error: ${result.stderr.slice(0, 200)}`))
    return  // non-blocking — proceed to portfolio flip
  }

  const urlLine = result.stdout.split('\n').find(l => /submitted|url/i.test(l)) ?? ''
  console.log(c.green(`  ✓ IndexNow submitted${urlLine ? ' — ' + urlLine : ''}`))
}

// ── Phase 5 — Portfolio flip ──────────────────────────────────────────────────

function phase5(doc) {
  console.log(c.bold('\nPhase 5 — Portfolio flip'))

  if (dryRun) {
    console.log(c.dim('  (dry-run: would update portfolio.yaml — status=live, launched=<now>)'))
    console.log(c.green('  ✓ Phase 5 skipped (dry-run)'))
    return null
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const entry = doc.sites.find(s => s.slug === slug)
  entry.status   = 'live'
  entry.launched = now

  const tmp = PORTFOLIO_PATH + '.tmp'
  try {
    writeFileSync(tmp, yaml.dump(doc, { lineWidth: 120 }), 'utf-8')
    renameSync(tmp, PORTFOLIO_PATH)
  } catch (err) {
    console.error(c.red(`  ✗ Failed to write portfolio.yaml: ${err.message}`))
    process.exit(1)
  }

  // Verify write
  const verify = parsePortfolio(readPortfolioRaw())
  const updated = verify.sites.find(s => s.slug === slug)
  if (updated?.status !== 'live' || !updated?.launched) {
    console.error(c.red('  ✗ Portfolio write verify failed — fields did not update correctly'))
    process.exit(1)
  }

  console.log(c.green(`  ✓ Portfolio updated: status=live, launched=${now}`))
  return now
}

// ── Phase 6 — Commit + push ───────────────────────────────────────────────────

function phase6(entry, launchedAt) {
  console.log(c.bold('\nPhase 6 — Commit + push'))

  if (dryRun) {
    console.log(c.dim(`  (dry-run: would commit "feat(portfolio): launch ${slug} (${entry.domain})")`))
    console.log(c.green('  ✓ Phase 6 skipped (dry-run)'))
    return null
  }

  // Confirm only portfolio.yaml is modified
  const statusResult = execCmd('git status --porcelain', { cwd: PLATFORM_ROOT })
  const modified = (statusResult.stdout ?? '').split('\n').filter(l => l.trim())
  const unexpected = modified.filter(l => !l.includes('portfolio.yaml'))
  if (unexpected.length > 0) {
    console.error(c.red('  ✗ Unexpected staged changes in platform repo — aborting commit:'))
    unexpected.forEach(l => console.error(c.red(`    ${l}`)))
    console.error(c.dim('    Stash or commit unrelated changes first.'))
    process.exit(1)
  }

  // Confirm portfolio.yaml is actually modified
  const diffResult = execCmd('git diff --name-only portfolio.yaml', { cwd: PLATFORM_ROOT })
  if (!diffResult.stdout.includes('portfolio.yaml')) {
    console.error(c.red('  ✗ portfolio.yaml shows no diff — write may have failed silently'))
    process.exit(2)
  }

  execCmd('git add portfolio.yaml', { cwd: PLATFORM_ROOT })
  const msg = [
    `feat(portfolio): launch ${slug} (${entry.domain})`,
    '',
    `Status flipped pre_launch → live.`,
    `Launched: ${launchedAt}`,
  ].join('\n')
  execCmd(`git commit -m ${JSON.stringify(msg)}`, { cwd: PLATFORM_ROOT })
  const sha = execCmd('git rev-parse --short HEAD', { cwd: PLATFORM_ROOT }).stdout
  execCmd('git push origin main', { cwd: PLATFORM_ROOT })

  console.log(c.green(`  ✓ Portfolio commit pushed: ${sha}`))
  return sha
}

// ── Phase 7 — Final summary ───────────────────────────────────────────────────

function phase7(entry, published, launchedAt, commitSha) {
  if (dryRun) {
    const shellLine  = c.green('  ✓ would pass (strict)')
    const deployLine = c.green('  ✓ would pass')
    console.log(c.bold('\n  ┌─ DRY RUN COMPLETE ────────────────────────────────────────────┐'))
    console.log(`  │  Site shell:    ${shellLine}`)
    console.log(`  │  Deploy:        ${deployLine}`)
    console.log(`  │  IndexNow:      (dry-run submitted)`)
    console.log(`  │  Portfolio:     (dry-run: would flip to live)`)
    console.log(`  │  Commit:        (dry-run: "feat(portfolio): launch ${slug}")`)
    console.log(`  │`)
    console.log(`  │  Re-run without --dry-run to actually launch.`)
    console.log(c.bold('  └───────────────────────────────────────────────────────────────┘'))
    return
  }

  console.log(c.bold('\n  ┌─ SITE LAUNCHED ───────────────────────────────────────────────┐'))
  console.log(`  │`)
  console.log(`  │  Site:         ${slug}`)
  console.log(`  │  Domain:       ${c.cyan(`https://${entry.domain}`)}`)
  console.log(`  │  Launched:     ${launchedAt}`)
  console.log(`  │  Articles:     ${published} published`)
  console.log(`  │  Portfolio:    ${commitSha}`)
  console.log(`  │`)
  console.log(`  │  Next checks (run in 5-15 min):`)
  console.log(`  │    1. Verify https://${entry.domain} resolves and renders`)
  console.log(`  │    2. Confirm GA4 events flowing in real-time view`)
  console.log(`  │    3. Test affiliate links — should redirect with ?tag=${entry.tracking_id}`)
  console.log(`  │    4. Submit XML sitemap to Google Search Console if not already`)
  console.log(`  │`)
  console.log(`  │  Monitor:`)
  console.log(`  │    node tools/dashboard.mjs --health --site ${slug}`)
  console.log(c.bold('  └───────────────────────────────────────────────────────────────┘'))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!slug) {
    console.error(c.red('Usage: node tools/launch-site.mjs --site <slug> [--dry-run]'))
    process.exit(2)
  }

  const siteDir = join(homedir(), slug)

  const { entry, doc } = phase1(siteDir)
  const published = countPublishedArticles(siteDir)

  phase2()
  phase3()
  phase4(siteDir, published)

  const launchedAt = phase5(doc)
  const commitSha  = phase6(entry, launchedAt)

  phase7(entry, published, launchedAt, commitSha)
  process.exit(0)
}

main().catch(err => {
  console.error(c.red(`\nFatal: ${err.message}`))
  if (process.env.DEBUG) console.error(err.stack)
  process.exit(1)
})
