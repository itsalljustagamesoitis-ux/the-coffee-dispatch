#!/usr/bin/env node
/**
 * initialise-site.mjs — Bootstrap a new affiliate site from a YAML spec.
 *
 * Phases:
 *   0: Pre-flight (spec validation, auth checks)
 *   1: Local scaffolding (clone template, token replacement, config gen)
 *   2: Git initialization (init, submodule, initial commit)
 *   [GATE — stop here unless --proceed or --dry-run]
 *   3: Cloud resource creation (GitHub repo, CF Pages project, env vars)
 *   4: Wiring (push, first deploy, DNS instructions)
 *   5: Portfolio registration
 *   6: Final verification (auto after phase 5)
 *
 * Usage:
 *   node tools/initialise-site.mjs --spec <path>             # phases 0-2, then gate
 *   node tools/initialise-site.mjs --spec <path> --proceed   # phases 3-5 (1-2 must be done)
 *   node tools/initialise-site.mjs --spec <path> --dry-run   # all phases simulated
 *   node tools/initialise-site.mjs --spec <path> --resume-from=N
 *
 * Exit codes:
 *   0 — finished cleanly (gated stop after phase 2 = 0)
 *   1 — phase failed, state preserved for retry
 *   2 — tool error (spec invalid, auth missing, etc.)
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  cpSync, readdirSync, renameSync, copyFileSync,
} from 'fs'
import { join, dirname, extname, relative } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'

import { loadPortfolio } from './lib/portfolio.mjs'
import { getCloudflareToken } from './lib/auth.mjs'

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

const args      = process.argv.slice(2)
const has       = flag => args.includes(flag)
const get       = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }
const getParam  = prefix => { const a = args.find(x => x.startsWith(prefix + '=')); return a ? a.slice(prefix.length + 1) : null }

const specPath  = get('--spec')
const dryRun    = has('--dry-run')
const proceed   = has('--proceed')
const resumeFrom = getParam('--resume-from') !== null ? parseInt(getParam('--resume-from'), 10) : null

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITES_DIR      = join(PLATFORM_ROOT, 'sites')
const TEMPLATE_DIR   = join(PLATFORM_ROOT, 'templates', 'site-shell')
const ACCOUNT_ID     = 'fedb496b1addc0743cb2a84fa5a7ba67'
const CF_BASE        = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
const GITHUB_DEFAULT = 'itsalljustagamesoitis-ux'
const POLL_INTERVAL  = 5_000
const POLL_TIMEOUT   = 600_000
const DEPLOY_LAG     = 30_000

const BINARY_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.wav',
])

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

function execCmd(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', ...opts }).trim()
  } catch (err) {
    const msg = err.stderr?.trim() || err.stdout?.trim() || err.message
    throw new Error(`Command failed: ${cmd}\n${msg}`)
  }
}

function atomicWriteYaml(filePath, data) {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, yaml.dump(data, { lineWidth: 120 }), 'utf-8')
  renameSync(tmp, filePath)
}

function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, filePath)
}

function statePath(slug) {
  return dryRun
    ? join('/tmp', `initialise-site-dryrun-${slug}.state.json`)
    : join(SITES_DIR, `${slug}.state.json`)
}

function readState(slug) {
  if (dryRun) return null  // dry-runs always start fresh; no resumption from prior dry-run state
  const p = statePath(slug)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}

function writeState(slug, state) {
  if (!dryRun) mkdirSync(SITES_DIR, { recursive: true })
  atomicWriteJson(statePath(slug), state)
}

function isBinary(filePath) {
  return BINARY_EXTS.has(extname(filePath).toLowerCase())
}

function walkFiles(dir) {
  const results = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        walk(full)
      } else {
        results.push(full)
      }
    }
  }
  walk(dir)
  return results
}

function siteDir(slug) {
  return dryRun ? join('/tmp', `initialise-site-dryrun-${slug}`) : join(homedir(), slug)
}

// ── Spec validation ───────────────────────────────────────────────────────────

function validateSpec(raw) {
  const errors = []

  const check = (path, test, msg) => {
    const parts = path.split('.')
    let val = raw
    for (const p of parts) val = val?.[p]
    if (!test(val)) errors.push(`  ${path}: ${msg}`)
  }

  check('slug',                      v => v && /^[a-z][a-z0-9-]+$/.test(v),             'required, must match /^[a-z][a-z0-9-]+$/')
  check('domain',                    v => v && !v.includes('://') && v.includes('.'),    'required, no protocol prefix, must have TLD')
  check('brand_name',                v => typeof v === 'string' && v.length > 0,         'required string')
  check('tagline',                   v => typeof v === 'string' && v.length > 0,         'required string')
  check('niche',                     v => typeof v === 'string' && v.length > 0,         'required string')
  check('amazon_associates_id',      v => typeof v === 'string' && v.endsWith('-20'),    'required, must end in -20')
  check('ga4_measurement_id',        v => typeof v === 'string' && v.startsWith('G-'),   'required, must start with G-')
  check('persona.slug',              v => v && /^[a-z][a-z0-9-]*$/.test(v),             'required, lowercase kebab')
  check('persona.display_name',      v => typeof v === 'string' && v.length > 0,         'required string')
  check('persona.bio',               v => typeof v === 'string' && v.length > 0,         'required string')
  check('persona.location',          v => typeof v === 'string' && v.length > 0,         'required string')
  check('persona.voice_notes',       v => typeof v === 'string' && v.length > 0,         'required string')
  check('persona.photo_source',      v => v && existsSync(v),                            'required, file must exist at path')
  check('persona.about_photo_source', v => v && existsSync(v),                           'required, file must exist at path')

  for (const f of ['visual.primary_color', 'visual.accent_color', 'visual.background_color']) {
    check(f, v => v && /^#[0-9A-Fa-f]{6}$/.test(v), 'required, must be #RRGGBB hex')
  }
  check('visual.font_headings', v => typeof v === 'string' && v.length > 0, 'required')
  check('visual.font_body',     v => typeof v === 'string' && v.length > 0, 'required')

  if (!Array.isArray(raw?.categories) || raw.categories.length === 0) {
    errors.push('  categories: required non-empty array')
  } else {
    for (const [i, cat] of raw.categories.entries()) {
      if (!cat.slug)  errors.push(`  categories[${i}].slug: required`)
      if (!cat.label) errors.push(`  categories[${i}].label: required`)
      if (!Array.isArray(cat.hubs) || cat.hubs.length === 0) {
        errors.push(`  categories[${i}].hubs: required non-empty array`)
      } else {
        for (const [j, hub] of cat.hubs.entries()) {
          if (!hub.slug)  errors.push(`  categories[${i}].hubs[${j}].slug: required`)
          if (!hub.label) errors.push(`  categories[${i}].hubs[${j}].label: required`)
        }
      }
    }
  }

  return errors
}

// ── CF permission probe ───────────────────────────────────────────────────────

async function cfHasPagesEdit(token) {
  try {
    const res = await fetch(`${CF_BASE}/pages/projects`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 403) return false
    const body = await res.json().catch(() => ({}))
    // CF auth error code 10000 = permission denied even on non-403 responses
    if (!body.success && body.errors?.some(e => e.code === 10000)) return false
    return true  // 400/422 = permission present, input rejected (expected)
  } catch {
    return false
  }
}

// ── CF API fetch wrappers ─────────────────────────────────────────────────────

async function cfReq(method, token, path, body) {
  const url = `${CF_BASE}${path}`
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  const data = await res.json()
  return { status: res.status, ...data }
}

// ── Config generators ─────────────────────────────────────────────────────────

function buildSiteConfig(spec) {
  return {
    site: {
      slug:        spec.slug,
      domain:      spec.domain,
      brand_name:  spec.brand_name,
      tagline:     spec.tagline,
      description: spec.description ?? spec.niche,
      niche:       spec.niche,
    },
    affiliate: { amazon_tracking_id: spec.amazon_associates_id },
    analytics: { ga4_measurement_id: spec.ga4_measurement_id },
    persona:   { config_path: `config/personas/${spec.persona.slug}.yaml` },
    visual: {
      primary_color:    spec.visual.primary_color,
      accent_color:     spec.visual.accent_color,
      background_color: spec.visual.background_color,
      font_headings:    spec.visual.font_headings,
      font_body:        spec.visual.font_body,
      slots: 5,
    },
    images: { base_url: '/images' },
    style_policy: {
      word_count:            { min: 2000, max: 3500 },
      dollar_figures:        { allowed: true },
      buying_guide_heading:  { style: 'Buying Guide' },
      in_body_images:        { policy: 'none', fixed_count: null },
    },
  }
}

function buildNavigationYaml(spec) {
  return {
    categories: spec.categories.map(cat => ({
      slug:  cat.slug,
      label: cat.label,
      hubs:  cat.hubs.map(hub => ({ slug: hub.slug, label: hub.label, articles: [] })),
    })),
  }
}

function buildPersonaYaml(spec) {
  const firstName = spec.persona.display_name.split(' ')[0]
  return {
    slug:            spec.persona.slug,
    name_formal:     spec.persona.display_name,
    name_used:       firstName,
    display_name:    spec.persona.display_name,
    bio:             spec.persona.bio,
    bio_short:       spec.persona.bio,
    bio_full:        spec.persona.bio_full ?? spec.persona.bio,
    location:        spec.persona.location,
    location_detail: spec.persona.location_detail ?? spec.persona.location,
    background:      spec.persona.background ?? '',
    voice_notes:     spec.persona.voice_notes,
    photo_byline:    `/images/brand/${spec.persona.slug}-byline.jpg`,
    photo_about:     `/images/brand/${spec.persona.slug}-about.jpg`,
    photos: {
      byline: `${spec.persona.slug}-byline.jpg`,
      about:  `${spec.persona.slug}-about.jpg`,
    },
  }
}

// ── Phase 0 — Pre-flight ──────────────────────────────────────────────────────

async function phase0(spec, slug, state) {
  console.log(c.bold('\nPhase 0 — Pre-flight'))

  // P0.2: site collision check (skip when resuming)
  if (resumeFrom === null) {
    const dir = siteDir(slug)
    if (!dryRun && existsSync(dir) && readdirSync(dir).length > 0) {
      console.error(c.red(`  ✗ Directory ${dir} already exists and is non-empty`))
      console.error(c.dim(`    Use --resume-from=N if this is an intentional resume`))
      process.exit(2)
    }
    try {
      const portfolio = loadPortfolio()
      if (portfolio.some(s => s.slug === slug)) {
        console.error(c.red(`  ✗ Slug "${slug}" already registered in portfolio.yaml`))
        console.error(c.dim(`    Use --resume-from=N to continue a partial initialisation`))
        process.exit(2)
      }
    } catch { /* portfolio.yaml may not exist — fine on first site */ }
  }
  console.log(c.green('  ✓ Slug available'))

  // P0.3: auth — only needed for cloud phases
  const needsCloud = proceed || dryRun
  if (!needsCloud) {
    console.log(c.dim('  ✓ Cloud auth not needed for phases 1-2'))
    console.log(c.green('  ✓ Pre-flight complete'))
    return
  }

  // GitHub
  try {
    execCmd('gh auth status')
    console.log(c.green('  ✓ GitHub CLI authenticated'))
  } catch {
    if (dryRun) {
      console.log(c.yellow('  ⚠ GitHub CLI not authenticated (dry-run: would fail in phase 3)'))
    } else {
      console.error(c.red('  ✗ GitHub CLI not authenticated. Run: gh auth login'))
      process.exit(2)
    }
  }

  // Cloudflare
  let cfToken
  try {
    cfToken = getCloudflareToken()
  } catch {
    if (dryRun) {
      console.log(c.yellow('  ⚠ CF token not found (dry-run: would fail in phase 3)'))
      cfToken = null
    } else {
      console.error(c.red('  ✗ Cloudflare API token not found in .env.local'))
      process.exit(2)
    }
  }

  if (cfToken && !dryRun) {
    const hasEdit = await cfHasPagesEdit(cfToken)
    if (!hasEdit) {
      console.error(c.red('  ✗ CF token lacks Pages:Edit permission'))
      console.error(c.dim('    Add Pages:Edit scope at:'))
      console.error(c.cyan('    https://dash.cloudflare.com/profile/api-tokens'))
      console.error(c.dim('    Then update CLOUDFLARE_API_TOKEN in ~/affiliate-platform/.env.local'))
      process.exit(2)
    }
    console.log(c.green('  ✓ Cloudflare token has Pages:Edit'))
  } else if (dryRun) {
    console.log(c.dim('  ✓ CF permission check skipped (dry-run)'))
  }

  console.log(c.green('  ✓ Pre-flight complete'))
}

// ── Phase 1 — Local scaffolding ───────────────────────────────────────────────

async function phase1(spec, slug, state) {
  console.log(c.bold('\nPhase 1 — Local scaffolding'))

  const dir = siteDir(slug)

  // P1.1: template check
  if (!existsSync(TEMPLATE_DIR)) {
    console.error(c.red(`  ✗ Template missing at ${TEMPLATE_DIR}`))
    console.error(c.dim('    Create ~/affiliate-platform/templates/site-shell/ from FSG/MLT shape'))
    console.error(c.dim('    before initialising new sites. This is a known prerequisite — see backlog.'))
    process.exit(1)
  }

  // Copy template
  mkdirSync(dir, { recursive: true })
  cpSync(TEMPLATE_DIR, dir, {
    recursive: true,
    filter: src => !src.includes('/.git/') && !src.endsWith('/.git'),
  })
  console.log(c.green(`  ✓ Template copied → ${dir}`))

  // P1.2: token replacement
  const TOKENS = {
    '{{SITE_SLUG}}':             spec.slug,
    '{{SITE_DOMAIN}}':           spec.domain,
    '{{SITE_DESCRIPTION}}':      spec.description ?? spec.niche,
    '{{SITE_NICHE}}':            spec.niche,
    '{{AMAZON_ASSOCIATES_ID}}':  spec.amazon_associates_id,
    '{{GA4_MEASUREMENT_ID}}':    spec.ga4_measurement_id,
    '{{PERSONA_SLUG}}':          spec.persona.slug,
    '{{PERSONA_DISPLAY_NAME}}':  spec.persona.display_name,
    '{{PERSONA_BIO}}':           spec.persona.bio,
    '{{PERSONA_LOCATION}}':      spec.persona.location,
    '{{PRIMARY_COLOR}}':         spec.visual.primary_color,
    '{{ACCENT_COLOR}}':          spec.visual.accent_color,
    '{{BACKGROUND_COLOR}}':      spec.visual.background_color,
    '{{FONT_HEADINGS}}':         spec.visual.font_headings,
    '{{FONT_BODY}}':             spec.visual.font_body,
    '{{GITHUB_OWNER}}':          spec.github?.owner ?? GITHUB_DEFAULT,
    '{{NODE_VERSION}}':          '22',
  }

  // P1.2a: replace tokens in file contents
  let replacedFiles = 0
  for (const filePath of walkFiles(dir)) {
    if (isBinary(filePath)) continue
    let content
    try { content = readFileSync(filePath, 'utf-8') } catch { continue }
    let updated = content
    for (const [token, value] of Object.entries(TOKENS)) updated = updated.replaceAll(token, value)
    if (updated !== content) { writeFileSync(filePath, updated, 'utf-8'); replacedFiles++ }
  }

  // P1.2b: rename files whose names contain token patterns
  let renamedFiles = 0
  for (const filePath of walkFiles(dir)) {
    const base = filePath.split('/').pop()
    let newBase = base
    for (const [token, value] of Object.entries(TOKENS)) newBase = newBase.replaceAll(token, value)
    if (newBase !== base) {
      const dir_ = filePath.slice(0, filePath.lastIndexOf('/'))
      renameSync(filePath, `${dir_}/${newBase}`)
      renamedFiles++
    }
  }

  // Scan for leftover tokens
  const TOKEN_RE = /\{\{[A-Z_][A-Z0-9_]*\}\}/g
  const leftover = []
  for (const filePath of walkFiles(dir)) {
    if (isBinary(filePath)) continue
    try {
      const matches = readFileSync(filePath, 'utf-8').match(TOKEN_RE)
      if (matches) leftover.push(`    ${relative(dir, filePath)}: ${[...new Set(matches)].join(', ')}`)
    } catch { /* skip */ }
  }
  if (leftover.length > 0) {
    console.error(c.red('  ✗ Unreplaced tokens found — spec is missing values:'))
    leftover.forEach(l => console.error(c.red(l)))
    process.exit(1)
  }
  console.log(c.green(`  ✓ Token replacement (${replacedFiles} files updated, ${renamedFiles} files renamed)`))

  // P1.3: generate dynamic config files
  const configDir = join(dir, 'config')
  const personasDir = join(configDir, 'personas')
  mkdirSync(personasDir, { recursive: true })

  atomicWriteYaml(join(dir, 'site.config.yaml'), buildSiteConfig(spec))
  console.log(c.green('  ✓ site.config.yaml'))

  atomicWriteYaml(join(configDir, 'navigation.yaml'), buildNavigationYaml(spec))
  console.log(c.green('  ✓ config/navigation.yaml'))

  atomicWriteYaml(join(personasDir, `${spec.persona.slug}.yaml`), buildPersonaYaml(spec))
  console.log(c.green(`  ✓ config/personas/${spec.persona.slug}.yaml`))

  // P1.3b: credentials stub (gitignored in new site — must be written explicitly, not via template copy)
  const credentialsContent = [
    '# API keys for content sourcing — fill these before running source-products',
    '# or producer. This file is gitignored — never commit real keys.',
    '#',
    '# Where to get keys:',
    '#   PEXELS_API_KEY:    https://www.pexels.com/api/',
    '#   RAINFOREST_KEY:    https://www.rainforestapi.com/ (if using Rainforest for product sourcing)',
    '#   ANTHROPIC_API_KEY: https://console.anthropic.com/',
    '',
    'PEXELS_API_KEY=',
    'RAINFOREST_KEY=',
    'ANTHROPIC_API_KEY=',
  ].join('\n') + '\n'
  writeFileSync(join(configDir, 'credentials.env'), credentialsContent, 'utf-8')

  // P1.4: persona photos
  const brandDir = join(dir, 'public', 'images', 'brand')
  mkdirSync(brandDir, { recursive: true })
  copyFileSync(spec.persona.photo_source, join(brandDir, `${spec.persona.slug}-byline.jpg`))
  copyFileSync(spec.persona.about_photo_source, join(brandDir, `${spec.persona.slug}-about.jpg`))
  console.log(c.green('  ✓ Persona photos copied'))

  // P1.5: IndexNow key
  const indexNowKey = randomBytes(16).toString('hex')
  mkdirSync(join(dir, 'public'), { recursive: true })
  writeFileSync(join(dir, 'public', `${indexNowKey}.txt`), indexNowKey, 'utf-8')
  console.log(c.green(`  ✓ IndexNow key: ${indexNowKey}`))

  // P1.6: pipeline, products, content dirs
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })

  if (spec.keyword_source?.xlsx_path) {
    console.log(c.dim('  Running xlsx-to-pipeline.mjs…'))
    try {
      const tool = join(PLATFORM_ROOT, 'tools', 'xlsx-to-pipeline.mjs')
      execCmd(`node ${tool} --input ${spec.keyword_source.xlsx_path} --output ${join(dataDir, 'pipeline.json')}`)
      console.log(c.green('  ✓ Pipeline populated from xlsx'))
    } catch (err) {
      console.log(c.yellow(`  ⚠ xlsx-to-pipeline failed: ${err.message}`))
      console.log(c.dim('    Writing empty pipeline.json'))
      atomicWriteJson(join(dataDir, 'pipeline.json'), { version: 1, articles: [] })
    }
  } else {
    atomicWriteJson(join(dataDir, 'pipeline.json'), { version: 1, articles: [] })
    console.log(c.green('  ✓ pipeline.json (empty — populate later)'))
  }

  // P1.3c: eeat-vault stub for persona authority signals
  const eeatStub = {
    persona:          spec.persona.slug,
    last_updated:     new Date().toISOString().slice(0, 10),
    background_details: {
      experience_years:  '',
      current_setup:     '',
      relevant_history:  '',
    },
    product_experiences: [],
    failures:            [],
    strong_opinions:     [],
    voice_samples:       [],
  }
  writeFileSync(
    join(dataDir, 'eeat-vault.json'),
    JSON.stringify(eeatStub, null, 2),
    'utf-8'
  )

  const articlesDir = join(dir, 'content', 'articles')
  const productsDir = join(dir, 'content', 'products')
  mkdirSync(articlesDir, { recursive: true })
  mkdirSync(productsDir, { recursive: true })
  writeFileSync(join(articlesDir, '.gitkeep'), '', 'utf-8')
  writeFileSync(join(productsDir, 'products.yaml'), '{}\n', 'utf-8')

  const stagingDir = join(dir, 'staging')
  mkdirSync(stagingDir, { recursive: true })
  writeFileSync(join(stagingDir, '.gitkeep'), '', 'utf-8')

  const fileCount = walkFiles(dir).length
  console.log(c.dim(`\n  Site root: ${dir} (${fileCount} files)`))

  state.siteDir     = dir
  state.indexNowKey = indexNowKey
  state.completedPhases = [...new Set([...(state.completedPhases ?? []), 1])]
  writeState(slug, state)
  console.log(c.yellow('  ⚠ Fill config/credentials.env with RAINFOREST_KEY, ANTHROPIC_API_KEY, PEXELS_API_KEY before running source-products or producer'))
  console.log(c.yellow('  ⚠ Fill data/eeat-vault.json with persona authority signals (experiences, failures, opinions) before running producer'))
  console.log(c.green('  ✓ Phase 1 complete'))
}

// ── Phase 2 — Git initialization ─────────────────────────────────────────────

async function phase2(spec, slug, state) {
  console.log(c.bold('\nPhase 2 — Git initialization'))

  const dir = state.siteDir ?? siteDir(slug)
  const owner = spec.github?.owner ?? GITHUB_DEFAULT

  if (dryRun) {
    console.log(c.dim('  [dry-run] git init -b main'))
    console.log(c.dim(`  [dry-run] git submodule add https://github.com/${owner}/affiliate-platform.git`))
    console.log(c.dim('  [dry-run] git add . && git commit -m "feat: initial site scaffold…"'))
    state.completedPhases = [...new Set([...(state.completedPhases ?? []), 2])]
    writeState(slug, state)
    console.log(c.green('  ✓ Phase 2 complete (dry-run)'))
    return
  }

  execCmd('git init -b main', { cwd: dir })
  console.log(c.green('  ✓ git init -b main'))

  const platformSha = execCmd('git rev-parse HEAD', { cwd: PLATFORM_ROOT })
  const subUrl = `https://github.com/${owner}/affiliate-platform.git`
  execCmd(`git submodule add ${subUrl} affiliate-platform`, { cwd: dir })
  execCmd('git submodule update --init', { cwd: dir })
  console.log(c.green(`  ✓ Submodule pinned at ${platformSha.slice(0, 7)}`))

  execCmd('git add .', { cwd: dir })
  const msg = [
    'feat: initial site scaffold from initialise-site.mjs',
    '',
    `Site:          ${slug}`,
    `Domain:        ${spec.domain}`,
    `Niche:         ${spec.niche}`,
    `Persona:       ${spec.persona.display_name}`,
    `Submodule pin: ${platformSha}`,
  ].join('\n')
  execCmd(`git commit -m ${JSON.stringify(msg)}`, { cwd: dir })
  const sha = execCmd('git rev-parse --short HEAD', { cwd: dir })
  console.log(c.green(`  ✓ Initial commit: ${sha}`))

  state.initialSha  = sha
  state.platformSha = platformSha.slice(0, 7)
  state.completedPhases = [...new Set([...(state.completedPhases ?? []), 2])]
  writeState(slug, state)
  console.log(c.green('  ✓ Phase 2 complete'))
}

// ── Gate ──────────────────────────────────────────────────────────────────────

function printGate(spec, slug, state) {
  const dir = state.siteDir ?? siteDir(slug)
  const sha = state.initialSha ?? '(dry-run)'
  const pin = state.platformSha ?? '(dry-run)'
  console.log(c.bold('\n  ┌─ Gate: Phases 1-2 complete ──────────────────────────────────┐'))
  console.log(`  │  ✓ Phase 1: Local scaffolding`)
  console.log(`  │  ✓ Phase 2: Git initialized — commit ${sha}`)
  console.log(`  │`)
  console.log(`  │  Site root:     ${dir}`)
  console.log(`  │  Submodule pin: ${pin}`)
  console.log(`  │`)
  console.log(`  │  Next steps:`)
  console.log(`  │    1. node tools/verify-site-shell.mjs --site ${slug}`)
  console.log(`  │    2. Inspect configs: ls ~/${slug}`)
  console.log(`  │    3. Rerun with --proceed to create cloud resources`)
  console.log(`  │       (GitHub repo, Cloudflare Pages project, custom domain)`)
  console.log(`  │`)
  console.log(`  │  ⚠ --proceed creates real cloud resources. Cancel if uncertain.`)
  console.log(c.bold('  └───────────────────────────────────────────────────────────────┘'))
}

// ── Phase 3 — Cloud resource creation ────────────────────────────────────────

async function phase3(spec, slug, state) {
  console.log(c.bold('\nPhase 3 — Cloud resource creation'))

  const owner  = spec.github?.owner ?? GITHUB_DEFAULT
  const vis    = spec.github?.visibility ?? 'public'
  const dir    = state.siteDir ?? siteDir(slug)

  if (dryRun) {
    const cfBody = {
      name: slug, production_branch: 'main',
      source: { type: 'github', config: { owner, repo_name: slug, production_branch: 'main', deployments_enabled: true } },
    }
    const envBody = {
      build_config: { build_command: 'npm run build', destination_dir: 'dist' },
      deployment_configs: {
        production: { env_vars: {
          AMAZON_TAG:            { type: 'secret_text', value: spec.amazon_associates_id },
          BING_SITE_VERIFICATION: { type: 'secret_text', value: 'PLACEHOLDER_REPLACE_BEFORE_LAUNCH' },
        }},
        preview: { env_vars: {
          AMAZON_TAG:            { type: 'secret_text', value: spec.amazon_associates_id },
          BING_SITE_VERIFICATION: { type: 'secret_text', value: 'PLACEHOLDER_REPLACE_BEFORE_LAUNCH' },
        }},
      },
    }
    console.log(c.dim(`  [dry-run] gh repo create ${owner}/${slug} --${vis} --source=${dir} --remote=origin`))
    console.log(c.dim('  [dry-run] CF POST /pages/projects:'))
    JSON.stringify(cfBody, null, 2).split('\n').forEach(l => console.log(c.dim('    ' + l)))
    console.log(c.dim('  [dry-run] CF PATCH /pages/projects/<slug>:'))
    JSON.stringify(envBody, null, 2).split('\n').forEach(l => console.log(c.dim('    ' + l)))
    state.phase3 = { githubRepoUrl: `https://github.com/${owner}/${slug}`, cfProjectName: slug }
    state.completedPhases = [...new Set([...(state.completedPhases ?? []), 3])]
    writeState(slug, state)
    console.log(c.green('  ✓ Phase 3 complete (dry-run)'))
    return
  }

  const cfToken = getCloudflareToken()

  // P3.1: GitHub repo
  let repoUrl = `https://github.com/${owner}/${slug}`
  try {
    execCmd(`gh repo create ${owner}/${slug} --${vis} --source=${dir} --remote=origin`)
    console.log(c.green(`  ✓ GitHub repo created: ${repoUrl}`))
  } catch (err) {
    if (err.message.includes('already exists') || err.message.includes('Name already exists')) {
      console.log(c.yellow(`  ⚠ Repo already exists — continuing: ${repoUrl}`))
      try { execCmd(`git remote add origin ${repoUrl}`, { cwd: dir }) } catch { /* remote exists */ }
    } else {
      throw err
    }
  }
  execCmd(`gh repo view ${owner}/${slug}`)

  // P3.2: CF Pages project
  const cfCreateRes = await cfReq('POST', cfToken, '/pages/projects', {
    name: slug,
    production_branch: 'main',
    source: {
      type: 'github',
      config: { owner, repo_name: slug, production_branch: 'main', deployments_enabled: true },
    },
  })
  if (cfCreateRes.status === 409 || cfCreateRes.errors?.some(e => e.message?.includes('already exists'))) {
    console.log(c.yellow(`  ⚠ CF Pages project already exists — continuing`))
  } else if (!cfCreateRes.success) {
    throw new Error(`CF project creation failed: ${JSON.stringify(cfCreateRes.errors)}`)
  } else {
    console.log(c.green(`  ✓ CF Pages project created: ${slug}`))
  }

  // P3.3: Attach custom domain
  const domainRes = await cfReq('POST', cfToken, `/pages/projects/${slug}/domains`, { name: spec.domain })
  if (domainRes.status === 409) {
    console.log(c.yellow(`  ⚠ Custom domain already attached: ${spec.domain}`))
  } else if (!domainRes.success) {
    console.log(c.yellow(`  ⚠ Domain attachment failed: ${JSON.stringify(domainRes.errors)}`))
    console.log(c.dim('    Add domain manually: CF Dashboard → Pages → your project → Custom domains'))
  } else {
    console.log(c.green(`  ✓ Custom domain attached: ${spec.domain}`))
  }

  // P3.4: Set build_config + AMAZON_TAG on production + preview
  const envRes = await cfReq('PATCH', cfToken, `/pages/projects/${slug}`, {
    build_config: {
      build_command:   'npm run build',
      destination_dir: 'dist',
    },
    deployment_configs: {
      production: { env_vars: {
        AMAZON_TAG:            { type: 'secret_text', value: spec.amazon_associates_id },
        BING_SITE_VERIFICATION: { type: 'secret_text', value: 'PLACEHOLDER_REPLACE_BEFORE_LAUNCH' },
      }},
      preview: { env_vars: {
        AMAZON_TAG:            { type: 'secret_text', value: spec.amazon_associates_id },
        BING_SITE_VERIFICATION: { type: 'secret_text', value: 'PLACEHOLDER_REPLACE_BEFORE_LAUNCH' },
      }},
    },
  })
  if (!envRes.success) {
    console.log(c.yellow(`  ⚠ Project config failed: ${JSON.stringify(envRes.errors)}`))
  } else {
    console.log(c.green(`  ✓ Build config + AMAZON_TAG + BING_SITE_VERIFICATION set for production + preview`))
  }

  state.phase3 = { githubRepoUrl: repoUrl, cfProjectName: slug }
  state.completedPhases = [...new Set([...(state.completedPhases ?? []), 3])]
  writeState(slug, state)
  console.log(c.green('  ✓ Phase 3 complete'))
}

// ── Phase 4 — Wiring ──────────────────────────────────────────────────────────

async function phase4(spec, slug, state) {
  console.log(c.bold('\nPhase 4 — Wiring'))

  const dir           = state.siteDir ?? siteDir(slug)
  const cfProjectName = state.phase3?.cfProjectName ?? slug

  if (dryRun) {
    console.log(c.dim('  [dry-run] git push -u origin main'))
    console.log(c.dim('  [dry-run] Poll CF for deployment (up to 10 min)'))
    printDnsBlock(spec, cfProjectName)
    state.completedPhases = [...new Set([...(state.completedPhases ?? []), 4])]
    writeState(slug, state)
    console.log(c.green('  ✓ Phase 4 complete (dry-run)'))
    return
  }

  // P4.1: push
  execCmd('git push -u origin main', { cwd: dir })
  console.log(c.green('  ✓ Pushed to GitHub — CF auto-deploy triggered'))

  // P4.2: poll for deployment
  const cfToken = getCloudflareToken()
  console.log(c.dim('  Waiting for CF deployment to appear…'))
  await sleep(DEPLOY_LAG)

  let deploymentId = null
  const start = Date.now()
  let lastStatus = ''

  while (Date.now() - start < POLL_TIMEOUT) {
    const res = await cfReq('GET', cfToken, `/pages/projects/${cfProjectName}/deployments?per_page=5`)
    const deploys = res.result ?? []
    const latest  = deploys[0]
    if (latest) {
      const stages  = latest.stages ?? []
      const current = stages.findLast(s => s.status !== 'idle')
      const status  = current ? `${current.name}:${current.status}` : 'pending'
      if (status !== lastStatus) {
        process.stdout.write(c.dim(`\r  Deploy ${latest.id?.slice(0, 8)} — ${status}    `))
        lastStatus = status
      }
      if (stages.length > 0 && stages.every(s => s.status === 'success')) {
        deploymentId = latest.id
        process.stdout.write('\n')
        console.log(c.green(`  ✓ Deployment succeeded: ${deploymentId?.slice(0, 8)}`))
        break
      }
      if (stages.some(s => s.status === 'failure')) {
        process.stdout.write('\n')
        console.error(c.yellow('  ⚠ Deployment failed — check CF dashboard for logs'))
        break
      }
    }
    await sleep(POLL_INTERVAL)
  }
  if (!deploymentId) {
    process.stdout.write('\n')
    console.log(c.yellow('  ⚠ Deployment not confirmed within timeout — may still be building'))
  }

  // P4.3: DNS block
  printDnsBlock(spec, cfProjectName)

  state.phase4 = { deploymentId }
  state.completedPhases = [...new Set([...(state.completedPhases ?? []), 4])]
  writeState(slug, state)
  console.log(c.green('  ✓ Phase 4 complete'))
}

function printDnsBlock(spec, cfProjectName) {
  const provider = spec.dns_provider ?? 'unknown'
  console.log(c.bold('\n  DNS Configuration:'))
  if (provider === 'cloudflare') {
    console.log(`  ${spec.domain} is on Cloudflare. Custom domain should auto-resolve.`)
    console.log(`  Check at: ${c.cyan(`https://dash.cloudflare.com/${ACCOUNT_ID}/${cfProjectName}/custom-domains`)}`)
  } else {
    if (provider === 'unknown') console.log('  Unknown registrar — apply whichever block fits:\n')
    console.log(`  Domain: ${spec.domain}`)
    console.log('  Add these records at your DNS registrar:\n')
    console.log('    Type    Name    Value')
    console.log(`    CNAME   @       ${cfProjectName}.pages.dev`)
    console.log(`    CNAME   www     ${cfProjectName}.pages.dev\n`)
    console.log('  Or update nameservers to Cloudflare (check your CF dashboard for NS values).')
    console.log(`  Verify propagation: dig ${spec.domain} +short`)
  }
}

// ── Phase 5 — Portfolio registration ─────────────────────────────────────────

async function phase5(spec, slug, state) {
  console.log(c.bold('\nPhase 5 — Portfolio registration'))

  const owner = spec.github?.owner ?? GITHUB_DEFAULT
  const entry = {
    slug,
    domain:             spec.domain,
    persona:            spec.persona.slug,
    tracking_id:        spec.amazon_associates_id,
    ga4_id:             spec.ga4_measurement_id,
    cloudflare_project: slug,
    github_repo:        `${owner}/${slug}`,
    status:             spec.pre_launch === false ? 'live' : 'pre_launch',
    launched:           null,
  }

  if (dryRun) {
    console.log(c.dim('  [dry-run] Would append to portfolio.yaml:'))
    yaml.dump(entry, { lineWidth: 80 }).trimEnd().split('\n').forEach(l => console.log(c.dim('    ' + l)))
    console.log(c.dim('  [dry-run] Would commit + push affiliate-platform'))
    state.completedPhases = [...new Set([...(state.completedPhases ?? []), 5])]
    writeState(slug, state)
    console.log(c.green('  ✓ Phase 5 complete (dry-run)'))
    return
  }

  // P5.1: atomic portfolio update
  const portfolioPath = join(PLATFORM_ROOT, 'portfolio.yaml')
  const raw = readFileSync(portfolioPath, 'utf-8')
  const doc = yaml.load(raw)
  doc.sites = doc.sites ?? []

  if (doc.sites.some(s => s.slug === slug)) {
    console.log(c.yellow(`  ⚠ ${slug} already in portfolio.yaml — skipping`))
  } else {
    doc.sites.push(entry)
    const tmp = portfolioPath + '.tmp'
    writeFileSync(tmp, yaml.dump(doc, { lineWidth: 120 }), 'utf-8')
    renameSync(tmp, portfolioPath)
    console.log(c.green(`  ✓ ${slug} appended to portfolio.yaml`))
  }

  // P5.2: commit + push platform repo
  execCmd('git add portfolio.yaml', { cwd: PLATFORM_ROOT })
  execCmd(`git commit -m ${JSON.stringify(`feat(portfolio): register ${slug} (${spec.domain})`)}`, { cwd: PLATFORM_ROOT })
  const sha = execCmd('git rev-parse --short HEAD', { cwd: PLATFORM_ROOT })
  execCmd('git push origin main', { cwd: PLATFORM_ROOT })
  console.log(c.green(`  ✓ Platform repo updated: ${sha}`))

  state.phase5 = { portfolioCommit: sha }
  state.completedPhases = [...new Set([...(state.completedPhases ?? []), 5])]
  writeState(slug, state)
  console.log(c.green('  ✓ Phase 5 complete'))
}

// ── Phase 6 — Final verification ─────────────────────────────────────────────

async function phase6(spec, slug, state) {
  console.log(c.bold('\nPhase 6 — Final verification'))

  const owner         = spec.github?.owner ?? GITHUB_DEFAULT
  const cfProjectName = state.phase3?.cfProjectName ?? slug
  const shellTool     = join(PLATFORM_ROOT, 'tools', 'verify-site-shell.mjs')
  const deployTool    = join(PLATFORM_ROOT, 'tools', 'deploy-and-verify.mjs')

  // P6.1: verify-site-shell
  if (existsSync(shellTool)) {
    console.log(c.dim('  Running verify-site-shell.mjs…'))
    try {
      const out = execCmd(`node ${shellTool} --site ${slug}`)
      out.split('\n').forEach(l => console.log('  ' + l))
    } catch (err) {
      const out = err.message.split('\n').slice(1).join('\n')
      if (out) out.split('\n').forEach(l => console.log('  ' + l))
      console.log(c.yellow('  ⚠ verify-site-shell reported issues'))
    }
  }

  // P6.2: deploy-and-verify (skip-push)
  if (existsSync(deployTool)) {
    console.log(c.dim('  Running deploy-and-verify.mjs --skip-push…'))
    try {
      const out = execCmd(`node ${deployTool} --site ${slug} --skip-push`)
      out.split('\n').forEach(l => console.log('  ' + l))
    } catch {
      console.log(c.yellow('  ⚠ deploy-and-verify reported issues (DNS may still be propagating)'))
    }
  }

  // P6.3: final summary
  console.log(c.bold('\n  ┌─ Site initialised ────────────────────────────────────────────┐'))
  console.log(`  │  ✓ Site:    ${slug}`)
  console.log(`  │  ✓ GitHub:  https://github.com/${owner}/${slug}`)
  console.log(`  │  ✓ Pages:   https://${cfProjectName}.pages.dev`)
  console.log(`  │  ✓ Domain:  https://${spec.domain} (DNS may still be propagating)`)
  console.log(`  │`)
  console.log(`  │  Next steps:`)
  console.log(`  │    1. Verify https://${spec.domain} loads (wait up to 60min for DNS)`)
  console.log(`  │    2. Populate pipeline (node tools/xlsx-to-pipeline.mjs if needed)`)
  console.log(`  │    3. node tools/source-images-pexels.mjs --site ${slug}`)
  console.log(`  │    4. node tools/source-products-per-article.mjs --site ${slug}`)
  console.log(`  │    5. node tools/launch-site.mjs --site ${slug}`)
  console.log(c.bold('  └───────────────────────────────────────────────────────────────┘'))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!specPath) {
    console.error(c.red('Usage: node tools/initialise-site.mjs --spec <path> [--dry-run] [--proceed] [--resume-from=N]'))
    process.exit(2)
  }

  if (!existsSync(specPath)) {
    console.error(c.red(`Spec file not found: ${specPath}`))
    process.exit(2)
  }

  let spec
  try {
    spec = yaml.load(readFileSync(specPath, 'utf-8'))
  } catch (err) {
    console.error(c.red(`Spec YAML parse error: ${err.message}`))
    process.exit(2)
  }

  const errors = validateSpec(spec)
  if (errors.length > 0) {
    console.error(c.red('Spec validation failed:'))
    errors.forEach(e => console.error(c.red(e)))
    process.exit(2)
  }

  const { slug } = spec
  mkdirSync(SITES_DIR, { recursive: true })

  let state = readState(slug) ?? {
    slug,
    spec: specPath,
    startedAt: new Date().toISOString(),
    completedPhases: [],
  }

  const completed = new Set(state.completedPhases ?? [])
  const skip = phase => (resumeFrom !== null && phase < resumeFrom) || (completed.has(phase) && resumeFrom === null)

  console.log(c.bold(`\nInitialise Site — ${slug}`))
  console.log('─'.repeat(52))
  if (dryRun)   console.log(c.yellow('  DRY RUN — no side effects'))
  if (proceed)  console.log(c.dim('  --proceed: cloud phases 3-5'))
  if (resumeFrom !== null) console.log(c.dim(`  --resume-from: starting at phase ${resumeFrom}`))

  await phase0(spec, slug, state)

  if (dryRun) {
    if (!skip(1)) await phase1(spec, slug, state)
    if (!skip(2)) await phase2(spec, slug, state)
    printGate(spec, slug, state)
    if (!skip(3)) await phase3(spec, slug, state)
    if (!skip(4)) await phase4(spec, slug, state)
    if (!skip(5)) await phase5(spec, slug, state)
    console.log(c.green('\nDry run complete.'))
    process.exit(0)
  }

  if (!proceed) {
    // Local-only: phases 1-2, then gate
    if (!skip(1)) await phase1(spec, slug, state)
    if (!skip(2)) await phase2(spec, slug, state)
    printGate(spec, slug, state)
    process.exit(0)
  }

  // --proceed: phases 3-5 (phases 1-2 must already be done)
  if (!completed.has(1) || !completed.has(2)) {
    if (resumeFrom === null) {
      console.error(c.red('--proceed requires phases 1-2 to be complete. Run without --proceed first.'))
      process.exit(2)
    }
  }
  if (!skip(3)) await phase3(spec, slug, state)
  if (!skip(4)) await phase4(spec, slug, state)
  if (!skip(5)) await phase5(spec, slug, state)
  await phase6(spec, slug, state)

  process.exit(0)
}

main().catch(err => {
  console.error(c.red(`\nFatal: ${err.message}`))
  if (process.env.DEBUG) console.error(err.stack)
  process.exit(1)
})
