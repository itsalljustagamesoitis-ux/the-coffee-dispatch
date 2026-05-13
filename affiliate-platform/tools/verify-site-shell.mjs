#!/usr/bin/env node
/**
 * verify-site-shell.mjs — Site shell conformance checker.
 *
 * Validates site structure, configs, and files against PIPELINE.md Point 7.
 *
 * Usage:
 *   node tools/verify-site-shell.mjs                    # all sites, matrix
 *   node tools/verify-site-shell.mjs --site <slug>      # one site, narrative
 *   node tools/verify-site-shell.mjs --strict           # warnings → blockers
 *   node tools/verify-site-shell.mjs --json             # machine-readable
 *
 * Exit: 0 = no blockers, 1 = at least one blocker, 2 = tool error
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, basename, extname } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import yaml from 'js-yaml'
import { loadPortfolio } from './lib/portfolio.mjs'

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
const esc   = isTTY ? (s, c) => `\x1b[${c}m${s}\x1b[0m` : (s) => s

const c = {
  green:  s => esc(s, '32'),
  red:    s => esc(s, '31'),
  yellow: s => esc(s, '33'),
  bold:   s => esc(s, '1'),
  dim:    s => esc(s, '2'),
  cyan:   s => esc(s, '36'),
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args     = process.argv.slice(2)
const has      = flag => args.includes(flag)
const get      = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const siteArg  = get('--site')
const strict   = has('--strict')
const jsonMode = has('--json')

// ── Platform root ─────────────────────────────────────────────────────────────

const PLATFORM_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── Portfolio ─────────────────────────────────────────────────────────────────

let allSites
try {
  allSites = loadPortfolio()
} catch (err) {
  console.error(`[ERROR] Cannot load portfolio.yaml: ${err.message}`)
  process.exit(2)
}

const sites = siteArg
  ? (() => {
      const s = allSites.find(s => s.slug === siteArg)
      if (!s) { console.error(`[ERROR] Site "${siteArg}" not in portfolio.yaml`); process.exit(2) }
      return [s]
    })()
  : allSites

// ── Known cross-site identifiers (for template contamination checks) ──────────

const SITE_IDENTIFIERS = {
  'four-season-gardener': {
    domains: ['fourseasongardener.com'],
    brands:  ['Four Season Gardener', 'four season gardener'],
    personas: ['wendy'],
  },
  'my-little-tablespoon': {
    domains: ['mylittletablespoon.com'],
    brands:  ['My Little Tablespoon', 'my little tablespoon'],
    personas: ['emily'],
  },
  'one-happy-table': {
    domains: ['onehappytable.com'],
    brands:  ['One Happy Table', 'one happy table'],
    personas: ['sarah'],
  },
}

function foreignIdentifiers(slug) {
  const all = []
  for (const [s, ids] of Object.entries(SITE_IDENTIFIERS)) {
    if (s === slug) continue
    all.push(...ids.domains, ...ids.brands, ...ids.personas)
  }
  return all
}

// ── Check result constructors ─────────────────────────────────────────────────

/** @typedef {{ status: 'pass'|'fail'|'warn'|'skip', detail: string }} CheckResult */

const pass  = (detail = '') => ({ status: 'pass', detail })
const fail  = (detail = '') => ({ status: 'fail', detail })
const warn  = (detail = '') => ({ status: 'warn', detail })
const skip  = (detail = '') => ({ status: 'skip', detail })

// ── Check helpers ─────────────────────────────────────────────────────────────

function fileExists(path) { return existsSync(path) }

function readYaml(path) {
  try { return yaml.load(readFileSync(path, 'utf-8')) }
  catch { return null }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')) }
  catch { return null }
}

function readText(path) {
  try { return readFileSync(path, 'utf-8') }
  catch { return null }
}

function lsDir(path) {
  try { return readdirSync(path) }
  catch { return null }
}

function isPlaceholder(val) {
  if (!val) return true
  const s = String(val)
  return s === '' || /\{\{/.test(s) || /REPLACE_ME/i.test(s) || /\bTOKEN\b/i.test(s) || /\bTBD\b/i.test(s)
}

// ── Platform HEAD SHA ─────────────────────────────────────────────────────────

let platformHead = null
try {
  platformHead = execSync('git rev-parse HEAD', {
    cwd: PLATFORM_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
} catch { /* offline or not a git repo — skip */ }

// ── Per-site checks ───────────────────────────────────────────────────────────

/**
 * Run all checks for one site. Returns array of {id, label, group, ...CheckResult}.
 * @param {import('./lib/portfolio.mjs').SiteEntry} site
 * @returns {Array<{id:number, label:string, group:string} & CheckResult>}
 */
function runSiteChecks(site) {
  const { slug } = site
  const siteDir  = join(homedir(), slug)
  const results  = []

  // Cached reads — loaded once, used by multiple checks
  let siteConfig   = null
  let navConfig    = null
  let pipelineData = null
  let wranglerText = null
  let personaSlug  = null

  if (fileExists(join(siteDir, 'site.config.yaml'))) {
    siteConfig = readYaml(join(siteDir, 'site.config.yaml'))
  }
  if (fileExists(join(siteDir, 'config', 'navigation.yaml'))) {
    navConfig = readYaml(join(siteDir, 'config', 'navigation.yaml'))
  }
  if (fileExists(join(siteDir, 'data', 'pipeline.json'))) {
    pipelineData = readJson(join(siteDir, 'data', 'pipeline.json'))
  }
  if (fileExists(join(siteDir, 'wrangler.toml'))) {
    wranglerText = readText(join(siteDir, 'wrangler.toml'))
  }

  if (siteConfig?.persona?.config_path) {
    const cp = siteConfig.persona.config_path
    personaSlug = basename(cp, extname(cp))
  }

  function add(id, group, label, result) {
    results.push({ id, group, label, ...result })
  }

  // ── GROUP 1: Required files ──────────────────────────────────────────────

  add(1,  'G1', 'site.config.yaml at root',
    fileExists(join(siteDir, 'site.config.yaml'))
      ? pass() : fail('missing'))

  add(2,  'G1', 'wrangler.toml exists',
    fileExists(join(siteDir, 'wrangler.toml'))
      ? pass() : fail('missing'))

  add(3,  'G1', 'config/navigation.yaml exists',
    fileExists(join(siteDir, 'config', 'navigation.yaml'))
      ? pass() : fail('missing'))

  add(4,  'G1', 'persona config file exists', (() => {
    if (!siteConfig) return fail('cannot check — site.config.yaml missing/unreadable')
    if (!personaSlug) return fail('persona.config_path not set in site.config.yaml')
    return fileExists(join(siteDir, 'config', 'personas', `${personaSlug}.yaml`))
      ? pass(`${personaSlug}.yaml`) : fail(`config/personas/${personaSlug}.yaml not found`)
  })())

  add(5,  'G1', 'producer *-producer-v2.py exists', (() => {
    const files = lsDir(join(siteDir, 'producer')) ?? []
    const match = files.find(f => f.endsWith('-producer-v2.py'))
    return match ? pass(match) : fail('no *-producer-v2.py in producer/')
  })())

  add(6,  'G1', 'producer/indexnow-submit.py exists',
    fileExists(join(siteDir, 'producer', 'indexnow-submit.py'))
      ? pass() : fail('missing'))

  add(7,  'G1', 'producer/tests/ with conftest.py', (() => {
    const testsDir = join(siteDir, 'producer', 'tests')
    if (!fileExists(testsDir)) return fail('producer/tests/ directory missing')
    if (!fileExists(join(testsDir, 'conftest.py'))) return fail('conftest.py missing from tests/')
    const files = lsDir(testsDir) ?? []
    const testFiles = files.filter(f => f.startsWith('test_'))
    if (testFiles.length === 0) return warn('conftest.py present but no test_*.py files')
    return pass(`${testFiles.length} test file(s)`)
  })())

  add(8,  'G1', 'IndexNow key file (32-char hex)', (() => {
    const pubDir = join(siteDir, 'public')
    const files  = lsDir(pubDir) ?? []
    const matches = files.filter(f => /^[a-f0-9]{32}\.txt$/.test(f))
    if (matches.length === 0) return fail('no <32-char-hex>.txt in public/')
    if (matches.length > 1)   return fail(`multiple IndexNow key files: ${matches.join(', ')}`)
    const keyFile = matches[0]
    const stem    = keyFile.replace('.txt', '')
    const content = (readText(join(pubDir, keyFile)) ?? '').trim()
    if (content !== stem) return fail(`content "${content}" ≠ filename stem "${stem}"`)
    return pass(keyFile)
  })())

  add(9,  'G1', 'logo-header.svg (canonical name)',
    fileExists(join(siteDir, 'public', 'images', 'brand', 'logo-header.svg'))
      ? pass() : fail('public/images/brand/logo-header.svg missing'))

  add(10, 'G1', 'logo-footer.svg (canonical name)',
    fileExists(join(siteDir, 'public', 'images', 'brand', 'logo-footer.svg'))
      ? pass() : fail('public/images/brand/logo-footer.svg missing'))

  add(11, 'G1', 'favicon.ico or favicon.svg', (() => {
    const hasIco = fileExists(join(siteDir, 'public', 'favicon.ico'))
    const hasSvg = fileExists(join(siteDir, 'public', 'favicon.svg'))
    return (hasIco || hasSvg) ? pass() : fail('no favicon.ico or favicon.svg in public/')
  })())

  add(12, 'G1', 'pipeline.json envelope schema', (() => {
    if (!fileExists(join(siteDir, 'data', 'pipeline.json')))
      return fail('data/pipeline.json missing')
    if (!pipelineData) return fail('data/pipeline.json parse error')
    if (Array.isArray(pipelineData)) return fail('legacy flat-array format — migrate to envelope')
    if (!pipelineData.articles || !Array.isArray(pipelineData.articles))
      return fail('missing articles array in envelope')
    if (pipelineData.articles.length === 0) return fail('articles array is empty')
    return pass(`${pipelineData.articles.length} articles`)
  })())

  add(13, 'G1', 'content/products/products.yaml exists',
    fileExists(join(siteDir, 'content', 'products', 'products.yaml'))
      ? pass() : fail('missing'))

  add(14, 'G1', 'affiliate-platform submodule present', (() => {
    const subDir = join(siteDir, 'affiliate-platform')
    if (!fileExists(subDir)) return fail('affiliate-platform/ directory missing')
    const hasGitDir  = fileExists(join(subDir, '.git'))
    const hasGitFile = fileExists(join(subDir, '.git')) // covers both dir and file
    return hasGitDir ? pass() : fail('affiliate-platform/.git missing — not a proper submodule')
  })())

  // ── GROUP 2: Config values ───────────────────────────────────────────────

  add(15, 'G2', 'wrangler.toml name = site slug', (() => {
    if (!wranglerText) return fail('wrangler.toml missing/unreadable')
    const match = wranglerText.match(/^name\s*=\s*"([^"]+)"/m)
    if (!match) return fail('name field not found in wrangler.toml')
    return match[1] === slug ? pass() : fail(`name="${match[1]}" ≠ slug "${slug}"`)
  })())

  add(16, 'G2', 'wrangler.toml [vars] NODE_VERSION = "22"', (() => {
    if (!wranglerText) return fail('wrangler.toml missing/unreadable')
    const hasVars = /^\[vars\]/m.test(wranglerText)
    if (!hasVars) return fail('[vars] section missing')
    const match = wranglerText.match(/^NODE_VERSION\s*=\s*"([^"]+)"/m)
    if (!match) return fail('NODE_VERSION not set in [vars]')
    return match[1] === '22' ? pass() : fail(`NODE_VERSION="${match[1]}" (expected "22")`)
  })())

  add(17, 'G2', 'visual: 5 slots populated', (() => {
    if (!siteConfig) return fail('site.config.yaml missing/unreadable')
    const v = siteConfig.visual ?? {}
    const slots = ['primary_color', 'accent_color', 'background_color', 'font_headings', 'font_body']
    const bad = slots.filter(k => isPlaceholder(v[k]))
    return bad.length === 0 ? pass() : fail(`placeholder/empty: ${bad.join(', ')}`)
  })())

  add(18, 'G2', 'affiliate.amazon_tracking_id well-formed', (() => {
    if (!siteConfig) return fail('site.config.yaml missing/unreadable')
    const id = siteConfig?.affiliate?.amazon_tracking_id
    if (!id) return fail('affiliate.amazon_tracking_id missing')
    if (isPlaceholder(id)) return fail(`placeholder value: "${id}"`)
    if (!String(id).endsWith('-20')) return fail(`should end in -20, got "${id}"`)
    return pass(id)
  })())

  add(19, 'G2', 'analytics.ga4_measurement_id well-formed', (() => {
    if (!siteConfig) return fail('site.config.yaml missing/unreadable')
    const id = siteConfig?.analytics?.ga4_measurement_id
    if (!id) return fail('analytics.ga4_measurement_id missing')
    if (isPlaceholder(id)) return fail(`placeholder value: "${id}"`)
    if (!/^G-[A-Z0-9]+$/.test(String(id))) return fail(`unexpected format: "${id}"`)
    return pass(id)
  })())

  add(20, 'G2', 'site.domain present and well-formed', (() => {
    if (!siteConfig) return fail('site.config.yaml missing/unreadable')
    const domain = siteConfig?.site?.domain
    if (!domain) return fail('site.domain missing')
    if (isPlaceholder(domain)) return fail(`placeholder: "${domain}"`)
    if (!domain.includes('.')) return fail(`no TLD in "${domain}"`)
    return pass(domain)
  })())

  add(21, 'G2', 'persona config_path resolves', (() => {
    if (!siteConfig) return skip('site.config.yaml missing — see check 1')
    if (!personaSlug) return fail('persona.config_path not set')
    const personaPath = join(siteDir, 'config', 'personas', `${personaSlug}.yaml`)
    // If check 4 already caught this, just confirm
    return fileExists(personaPath) ? pass(`${personaSlug}.yaml`) : skip('covered by check 4')
  })())

  add(22, 'G2', 'portfolio.yaml entry exists', (() => {
    const entry = allSites.find(s => s.slug === slug)
    return entry ? pass() : fail('not in portfolio.yaml')
  })())

  add(23, 'G2', 'portfolio.yaml entry has 9 required fields', (() => {
    const entry = allSites.find(s => s.slug === slug)
    if (!entry) return skip('no portfolio.yaml entry — see check 22')
    const required = ['slug', 'domain', 'persona', 'tracking_id', 'ga4_id',
                      'cloudflare_project', 'github_repo', 'status', 'launched']
    const missing = required.filter(k => !entry[k])
    return missing.length === 0 ? pass() : fail(`missing: ${missing.join(', ')}`)
  })())

  // ── GROUP 3: Template inheritance ────────────────────────────────────────

  add(24, 'G3', 'No foreign identifiers in src/pages/', (() => {
    const pagesDir = join(siteDir, 'src', 'pages')
    if (!fileExists(pagesDir)) return skip('src/pages/ not present')
    const foreign = foreignIdentifiers(slug)
    const files   = lsDir(pagesDir) ?? []
    const astroFiles = files.filter(f => f.endsWith('.astro'))
    const hits = []
    for (const f of astroFiles) {
      const text = readText(join(pagesDir, f)) ?? ''
      const found = foreign.filter(id => text.includes(id))
      if (found.length) hits.push(`${f} (${found.join(', ')})`)
    }
    return hits.length === 0 ? pass() : fail(hits.join(' | '))
  })())

  add(25, 'G3', 'No foreign identifiers in producer/', (() => {
    const producerDir = join(siteDir, 'producer')
    if (!fileExists(producerDir)) return skip('producer/ not present')
    const foreign = foreignIdentifiers(slug)
    const files   = lsDir(producerDir) ?? []
    const pyFiles = files.filter(f => f.endsWith('.py') && f !== '.legacy')
    const hits    = []
    for (const f of pyFiles) {
      const text = readText(join(producerDir, f)) ?? ''
      const found = foreign.filter(id => text.includes(id))
      if (found.length) hits.push(`${f} (${found.join(', ')})`)
    }
    return hits.length === 0 ? pass() : fail(hits.join(' | '))
  })())

  add(26, 'G3', 'conftest.py docstring matches site', (() => {
    const cfPath = join(siteDir, 'producer', 'tests', 'conftest.py')
    if (!fileExists(cfPath)) return skip('conftest.py missing — see check 7')
    const text  = readText(cfPath) ?? ''
    const match = text.match(/^"""([^"]+)"""/)
    if (!match) return warn('no leading docstring found')
    const doc   = match[1].toLowerCase()
    const abbr  = slug.replace('four-season-gardener', 'fsg')
                       .replace('my-little-tablespoon', 'mlt')
                       .replace('one-happy-table', 'oht')
    const siteWords = [abbr, slug, ...slug.split('-')]
    const matchesSelf   = siteWords.some(w => doc.includes(w.toLowerCase()))
    const otherSlugs    = allSites.filter(s => s.slug !== slug).map(s => s.slug)
    const otherAbbrevs  = ['fsg', 'mlt', 'oht'].filter(a =>
      !slug.includes(a.split('')[0]) &&
      !(slug === 'four-season-gardener' && a === 'fsg') &&
      !(slug === 'my-little-tablespoon' && a === 'mlt') &&
      !(slug === 'one-happy-table' && a === 'oht')
    )
    const matchesOther  = [...otherSlugs, ...otherAbbrevs].some(s => doc.includes(s.toLowerCase()))
    if (matchesOther) return fail(`docstring references another site: "${match[1].trim()}"`)
    if (!matchesSelf) return warn(`docstring may not reference this site: "${match[1].trim()}"`)
    return pass()
  })())

  add(27, 'G3', 'Only one persona file in config/personas/', (() => {
    const personasDir = join(siteDir, 'config', 'personas')
    if (!fileExists(personasDir)) return fail('config/personas/ directory missing')
    const files = (lsDir(personasDir) ?? []).filter(f => f.endsWith('.yaml'))
    if (files.length === 0) return fail('no .yaml files in config/personas/')
    if (files.length > 1)   return fail(`multiple personas: ${files.join(', ')}`)
    return pass(files[0])
  })())

  add(28, 'G3', 'No leftover persona images in brand/', (() => {
    const brandDir = join(siteDir, 'public', 'images', 'brand')
    if (!fileExists(brandDir)) return skip('public/images/brand/ not present')
    const files = lsDir(brandDir) ?? []
    // Get other sites' persona slugs
    const otherPersonas = allSites
      .filter(s => s.slug !== slug)
      .map(s => s.persona)
      .filter(Boolean)
    const leaks = files.filter(f =>
      otherPersonas.some(p => f.startsWith(p + '-') || f.startsWith(p + '.'))
    )
    return leaks.length === 0 ? pass() : fail(`foreign persona images: ${leaks.join(', ')}`)
  })())

  // ── GROUP 4: Structure / consistency ─────────────────────────────────────

  add(29, 'G4', 'Hub structure: 3-level (cat→hub→article)', (() => {
    if (!navConfig) return fail('config/navigation.yaml missing/unreadable')
    const cats = navConfig.categories ?? []
    if (cats.length === 0) return fail('no categories in navigation.yaml')
    const flat = cats.filter(cat => !cat.hubs || cat.hubs.length === 0)
    if (flat.length === cats.length) return warn(`all ${cats.length} categories have empty hubs (flat structure)`)
    if (flat.length > 0) return warn(`${flat.length}/${cats.length} categories have empty hubs`)
    return pass(`${cats.length} categories, all with hubs`)
  })())

  add(30, 'G4', 'Submodule pin is current', (() => {
    const subDir = join(siteDir, 'affiliate-platform')
    if (!fileExists(subDir)) return skip('affiliate-platform/ missing — see check 14')
    let pinnedSha
    try {
      pinnedSha = execSync(`git submodule status ${subDir}`, {
        cwd: siteDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().replace(/^[+\- ]/, '').split(' ')[0]
    } catch { return skip('cannot read submodule SHA') }
    if (!platformHead) return skip('platform HEAD not available (offline?)')
    const pinShort  = pinnedSha.slice(0, 7)
    const headShort = platformHead.slice(0, 7)
    if (pinnedSha.startsWith(platformHead) || platformHead.startsWith(pinnedSha)) return pass(pinShort)
    return warn(`pinned ${pinShort} ≠ platform HEAD ${headShort}`)
  })())

  add(31, 'G4', 'Article images are .webp', (() => {
    const imgDir = join(siteDir, 'public', 'images', 'articles')
    if (!fileExists(imgDir)) return skip('public/images/articles/ not present')
    const files = lsDir(imgDir) ?? []
    if (files.length === 0) return skip('no files in public/images/articles/')
    const nonWebp = files.filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f))
    if (nonWebp.length === 0) return pass(`${files.length} image(s) all .webp`)
    return warn(`${nonWebp.length}/${files.length} image(s) are not .webp`)
  })())

  add(32, 'G4', 'No {{PLACEHOLDER}} tokens in tracked files', (() => {
    let gitFiles
    try {
      gitFiles = execSync('git ls-files', {
        cwd: siteDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n').filter(f =>
        f && !f.startsWith('.legacy/') && !f.startsWith('node_modules/')
      )
    } catch { return skip('cannot run git ls-files') }
    const hits = []
    for (const rel of gitFiles) {
      const full = join(siteDir, rel)
      try {
        const text = readFileSync(full, 'utf-8')
        if (/\{\{[A-Z_][A-Z0-9_]*\}\}/.test(text)) hits.push(rel)
      } catch { /* binary or unreadable — skip */ }
    }
    return hits.length === 0 ? pass() : fail(`placeholder tokens in: ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` (+${hits.length - 3} more)` : ''}`)
  })())

  // ── GROUP 5: Producer tests ───────────────────────────────────────────────

  add(33, 'G5', 'conftest.py: no hardcoded hub slugs', (() => {
    const cfPath = join(siteDir, 'producer', 'tests', 'conftest.py')
    if (!fileExists(cfPath)) return skip('conftest.py missing — see check 7')
    if (!navConfig) return skip('navigation.yaml missing — cannot verify hubs')
    const text = readText(cfPath) ?? ''
    // Collect all hub slugs from navigation
    const cats = navConfig.categories ?? []
    const allHubs = cats.flatMap(cat => (cat.hubs ?? []).map(h => h.slug))
    if (allHubs.length === 0) return skip('no hubs in navigation.yaml (flat site)')
    // Look for hub slug strings in conftest — quoted literals
    const hardcoded = allHubs.filter(h => new RegExp(`["']${h}["']`).test(text))
    return hardcoded.length === 0
      ? pass()
      : warn(`hardcoded hub slugs: ${hardcoded.slice(0, 3).join(', ')}${hardcoded.length > 3 ? ` (+${hardcoded.length - 3} more)` : ''}`)
  })())

  return results
}

// ── Severity resolution (strict mode) ────────────────────────────────────────

const STRICT_ELEVATE = new Set([7, 29, 30, 31, 33])

function resolvedStatus(check) {
  if (strict && check.status === 'warn' && STRICT_ELEVATE.has(check.id)) return 'fail'
  return check.status
}

// ── Symbol helpers ────────────────────────────────────────────────────────────

function symbol(status) {
  switch (status) {
    case 'pass': return c.green('✓')
    case 'fail': return c.red('✗')
    case 'warn': return c.yellow('⚠')
    case 'skip': return c.dim('—')
    default:     return ' '
  }
}

// ── Output: narrative (--site) ────────────────────────────────────────────────

function printNarrative(site, checks) {
  const siteDir = join(homedir(), site.slug)
  const hasCheckout = fileExists(siteDir)
  if (!hasCheckout) {
    console.log(`\n${c.bold(site.slug)} — ${c.dim('(no local checkout)')}\n`)
    return
  }
  console.log()
  console.log(c.bold(`Site: ${site.slug}`))
  console.log(c.dim(`Dir:  ${siteDir}`))
  if (strict) console.log(c.yellow('  [strict mode — warnings are blockers]'))
  console.log()

  let prevGroup = null
  for (const chk of checks) {
    if (chk.group !== prevGroup) {
      const labels = { G1: 'Required Files', G2: 'Config Values', G3: 'Template Inheritance', G4: 'Structure / Consistency', G5: 'Producer Tests' }
      console.log(c.bold(`  ${labels[chk.group] ?? chk.group}`))
      prevGroup = chk.group
    }
    const s = resolvedStatus(chk)
    const sym = symbol(s)
    const id  = String(chk.id).padStart(2, ' ')
    const lbl = chk.label.padEnd(44)
    const det = chk.detail ? c.dim(` — ${chk.detail}`) : ''
    console.log(`  ${id}. ${sym} ${lbl}${det}`)
  }

  const blockers = checks.filter(chk => resolvedStatus(chk) === 'fail').length
  const warnings = checks.filter(chk => resolvedStatus(chk) === 'warn').length
  console.log()
  const summary = blockers > 0
    ? c.red(`  ${blockers} blocker(s), ${warnings} warning(s)`)
    : warnings > 0
    ? c.yellow(`  0 blockers, ${warnings} warning(s)`)
    : c.green(`  All checks passed`)
  console.log(summary)
  console.log()
}

// ── Output: matrix (default) ──────────────────────────────────────────────────

function printMatrix(siteResults) {
  const slugs   = siteResults.map(r => r.site.slug)
  const colW    = Math.max(8, ...slugs.map(s => s.length)) + 2
  const labelW  = 46

  // Header
  console.log()
  const headerCells = slugs.map(s => s.slice(0, colW - 1).padEnd(colW))
  console.log(c.bold(' '.repeat(labelW + 4) + headerCells.join('')))
  console.log(c.dim('─'.repeat(labelW + 4 + colW * slugs.length)))

  // Rows
  const checkCount = siteResults[0].checks.length
  for (let i = 0; i < checkCount; i++) {
    const chk  = siteResults[0].checks[i]
    const id   = String(chk.id).padStart(2, ' ')
    const lbl  = `${id}. ${chk.label}`.padEnd(labelW)
    const cells = siteResults.map(sr => {
      const c_ = sr.checks[i]
      if (!c_) return ' '.repeat(colW)
      const s  = sr.hasCheckout ? resolvedStatus(c_) : 'skip'
      const sym = symbol(s)
      const det = (sr.hasCheckout && c_.detail) ? c.dim(` ${c_.detail.slice(0, colW - 4)}`) : ''
      return (sym + det).padEnd(colW)
    })
    // Group separator
    if (i > 0 && chk.group !== siteResults[0].checks[i - 1].group) {
      console.log(c.dim('─'.repeat(labelW + 4 + colW * slugs.length)))
    }
    console.log(`  ${lbl}  ${cells.join('')}`)
  }

  // Footer
  console.log(c.dim('─'.repeat(labelW + 4 + colW * slugs.length)))
  console.log()
  for (const sr of siteResults) {
    if (!sr.hasCheckout) {
      console.log(`  ${c.bold(sr.site.slug)}: ${c.dim('no local checkout')}`)
      continue
    }
    const blockers = sr.checks.filter(chk => resolvedStatus(chk) === 'fail').length
    const warnings = sr.checks.filter(chk => resolvedStatus(chk) === 'warn').length
    const line = blockers > 0
      ? c.red(`  ${c.bold(sr.site.slug)}: ${blockers} blocker(s), ${warnings} warning(s)`)
      : warnings > 0
      ? c.yellow(`  ${c.bold(sr.site.slug)}: 0 blockers, ${warnings} warning(s)`)
      : c.green(`  ${c.bold(sr.site.slug)}: all checks passed`)
    console.log(line)
  }
  console.log()
}

// ── Output: JSON ──────────────────────────────────────────────────────────────

function printJson(siteResults) {
  const out = { sites: {} }
  for (const sr of siteResults) {
    const checks = sr.hasCheckout
      ? sr.checks.map(chk => ({
          id: chk.id, group: chk.group, label: chk.label,
          status: resolvedStatus(chk), detail: chk.detail,
        }))
      : []
    out.sites[sr.site.slug] = {
      has_checkout: sr.hasCheckout,
      checks,
      blockers: checks.filter(c => c.status === 'fail').length,
      warnings: checks.filter(c => c.status === 'warn').length,
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

// ── Main ──────────────────────────────────────────────────────────────────────

const siteResults = []
for (const site of sites) {
  const siteDir    = join(homedir(), site.slug)
  const hasCheckout = fileExists(siteDir)
  const checks     = hasCheckout ? runSiteChecks(site) : []
  siteResults.push({ site, hasCheckout, checks })
}

if (jsonMode) {
  printJson(siteResults)
} else if (siteArg) {
  printNarrative(siteResults[0].site, siteResults[0].checks)
} else {
  printMatrix(siteResults)
}

// ── Exit code ─────────────────────────────────────────────────────────────────

const anyBlocker = siteResults.some(sr =>
  sr.checks.some(chk => resolvedStatus(chk) === 'fail')
)
process.exit(anyBlocker ? 1 : 0)
