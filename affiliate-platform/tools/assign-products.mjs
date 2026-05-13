#!/usr/bin/env node
/**
 * assign-products.mjs
 * Assigns products from site catalog to pipeline articles based on hub match + keyword relevance.
 * Reads data/pipeline.json and content/products/products.yaml. Writes only pipeline.json.
 *
 * Usage:
 *   node affiliate-platform/tools/assign-products.mjs --site <site-root>
 *   node affiliate-platform/tools/assign-products.mjs --site <site-root> --force
 *   node affiliate-platform/tools/assign-products.mjs --site <site-root> --dry-run
 *   node affiliate-platform/tools/assign-products.mjs --site <site-root> --skip-threshold-check
 *
 * Flags:
 *   --site                  Path to site root (required, must contain site.config.yaml)
 *   --force                 Re-assign articles that already have products (default: skip)
 *   --dry-run               Print plan without writing pipeline.json
 *   --skip-threshold-check  Bypass catalog sizing threshold check (exit 2 suppressed)
 *
 * Exit codes: 0 = success, 1 = gap/no-hub warnings, 2 = config/file error
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Per-type product count targets (minimum from prompt spec)
// ---------------------------------------------------------------------------

const TYPE_TARGETS = {
  buyer_guide: 3,
  roundup: 6,
  comparison: 2,
  review: 1,
}

const DEFAULT_TARGET = 3

// ---------------------------------------------------------------------------
// Tokenisation helpers
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'for', 'and', 'with', 'set', 'pair', 'from', 'that', 'this',
  'are', 'not', 'but', 'can', 'all', 'any', 'its', 'has', 'been',
])

/** Tokenise a string into lowercase alphanum words of length ≥ 3 */
function tokenize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
}

/**
 * Score how well a product matches an article.
 * Each article token that prefix-matches a product token contributes +10.
 * Exact match contributes +15 (bonus +5).
 */
function scoreMatch(artTokens, prodTokens) {
  let score = 0
  for (const at of artTokens) {
    for (const pt of prodTokens) {
      if (at === pt) { score += 15; break }
      if (pt.startsWith(at) || at.startsWith(pt)) { score += 10; break }
    }
  }
  return score
}

// ---------------------------------------------------------------------------
// Product selection
// ---------------------------------------------------------------------------

/**
 * Select up to `target` products from `hubProds` for `article`.
 * Uses keyword relevance scoring + reuse-count penalty to balance assignments.
 *
 * @param {Object} article   - pipeline article record
 * @param {Map}    hubProds  - Map<slug, data> of catalog products in this hub
 * @param {number} target    - number of products to assign
 * @param {Map}    useCounts - Map<slug, count> tracking how many times each product is used
 * @returns {{ products: string[], notes: string, gap: boolean }}
 */
function selectProducts(article, hubProds, target, useCounts) {
  if (hubProds.size === 0) {
    return {
      products: [],
      notes: `No products found in hub "${article.hub_slug || article.hub}".`,
      gap: true,
    }
  }

  const artTokens = tokenize(`${article.slug} ${article.keyword || ''}`)

  const candidates = []
  for (const [slug, data] of hubProds) {
    const prodTokens = tokenize(`${slug} ${data.name || ''}`)
    const matchScore = scoreMatch(artTokens, prodTokens)
    const reusePenalty = (useCounts.get(slug) || 0) * 0.5
    candidates.push({ slug, data, matchScore, final: matchScore - reusePenalty })
  }

  // Sort: combined score descending; raw reuse-count ascending as tiebreaker
  candidates.sort((a, b) => {
    if (b.final !== a.final) return b.final - a.final
    return (useCounts.get(a.slug) || 0) - (useCounts.get(b.slug) || 0)
  })

  // Greedy selection: primary match first, then fill with price-band diversity
  const selected = []
  const usedBands = new Set()

  selected.push(candidates[0].slug)
  usedBands.add(candidates[0].data.price_band)

  const rest = candidates.slice(1)

  // Pass 1: prefer products introducing a new price band
  for (const c of rest) {
    if (selected.length >= target) break
    if (!usedBands.has(c.data.price_band)) {
      selected.push(c.slug)
      usedBands.add(c.data.price_band)
    }
  }

  // Pass 2: fill any remaining slots with next-best candidates
  for (const c of rest) {
    if (selected.length >= target) break
    if (!selected.includes(c.slug)) selected.push(c.slug)
  }

  const gap = selected.length < target
  const topScore = candidates[0].matchScore
  const bandSummary = [...new Set(selected.map(s => hubProds.get(s)?.price_band).filter(Boolean))].join(', ')

  let notes
  if (topScore > 0) {
    notes = `Primary keyword match: ${selected[0]} (score ${topScore}). Complementary: ${selected.slice(1).join(', ')}. Price bands: ${bandSummary}.`
  } else {
    notes = `No direct keyword match in hub — assigned by reuse balance. Price bands: ${bandSummary}. Consider adding a catalog entry for "${article.keyword}".`
  }
  if (gap) {
    notes += ` GAP: only ${selected.length}/${target} required products available in this hub.`
  }

  return { products: selected, notes, gap }
}

// ---------------------------------------------------------------------------
// Catalog grouping field auto-detection
// ---------------------------------------------------------------------------

/**
 * Return 'hub' if any catalog entry has a hub field, else 'category'.
 * FSG uses category; MLT and OHT use hub.
 */
function detectGroupingField(rawProducts) {
  for (const data of Object.values(rawProducts)) {
    if ('hub' in data) return 'hub'
  }
  return 'category'
}

// ---------------------------------------------------------------------------
// Catalog sizing threshold check (Section 6 of CATALOG-BEHAVIOUR.md)
// ---------------------------------------------------------------------------

/**
 * Evaluate catalog health against floor and target thresholds.
 * @param {Map}    byHub       - Map<hub, Map<slug, data>> of catalog products
 * @param {Object} artByHub    - { [hub]: count } of pipeline articles per hub
 * @returns {{ belowFloor: string[], belowTarget: string[] }}
 */
function checkThresholds(byHub, artByHub) {
  const belowFloor = []
  const belowTarget = []

  const allHubs = new Set([...byHub.keys(), ...Object.keys(artByHub)])
  for (const hub of allHubs) {
    const prodCount = byHub.has(hub) ? byHub.get(hub).size : 0
    const artCount = artByHub[hub] || 0
    if (artCount === 0) continue

    const floor = Math.ceil(artCount / 4)
    const target = Math.ceil(artCount / 2)

    if (prodCount < floor) {
      belowFloor.push({ hub, artCount, prodCount, floor, target })
    } else if (prodCount < target) {
      belowTarget.push({ hub, artCount, prodCount, floor, target })
    }
  }

  return { belowFloor, belowTarget }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  let siteArg = null
  let force = false
  let dryRun = false
  let skipThresholdCheck = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site' && args[i + 1]) siteArg = args[++i]
    else if (args[i] === '--force') force = true
    else if (args[i] === '--dry-run') dryRun = true
    else if (args[i] === '--skip-threshold-check') skipThresholdCheck = true
  }

  if (!siteArg) {
    console.error('Usage: node affiliate-platform/tools/assign-products.mjs --site <site-root> [--force] [--dry-run] [--skip-threshold-check]')
    process.exit(1)
  }

  const siteRoot = resolve(siteArg)

  if (!existsSync(join(siteRoot, 'site.config.yaml'))) {
    console.error(`Error: No site.config.yaml at ${siteRoot}`)
    process.exit(2)
  }

  const pipelinePath = join(siteRoot, 'data', 'pipeline.json')
  const productsPath = join(siteRoot, 'content', 'products', 'products.yaml')

  for (const p of [pipelinePath, productsPath]) {
    if (!existsSync(p)) {
      console.error(`Error: File not found: ${p}`)
      process.exit(2)
    }
  }

  let pipeline, rawProducts
  try {
    pipeline = JSON.parse(readFileSync(pipelinePath, 'utf8'))
    rawProducts = yaml.load(readFileSync(productsPath, 'utf8'))
  } catch (e) {
    console.error(`Parse error: ${e.message}`)
    process.exit(2)
  }

  // Auto-detect grouping field (hub vs category — FSG uses category, MLT/OHT use hub)
  const groupingField = detectGroupingField(rawProducts)
  if (groupingField === 'category') {
    console.warn(`  [NOTICE] Catalog uses "category" as grouping field (not "hub"). FSG-style schema detected.`)
  }

  // Index products by hub → Map<hub, Map<slug, data>>
  const byHub = new Map()
  for (const [slug, data] of Object.entries(rawProducts)) {
    const hub = data[groupingField]
    if (!hub) continue
    if (!byHub.has(hub)) byHub.set(hub, new Map())
    byHub.get(hub).set(slug, data)
  }

  // Build article counts per hub (needed for threshold check)
  const artByHub = {}
  for (const article of pipeline) {
    const h = article.hub_slug || article.hub || article.category || 'UNKNOWN'
    artByHub[h] = (artByHub[h] || 0) + 1
  }

  // ---------------------------------------------------------------------------
  // Threshold check (Section 6, CATALOG-BEHAVIOUR.md)
  // ---------------------------------------------------------------------------

  if (skipThresholdCheck) {
    console.warn('  [WARNING] --skip-threshold-check active: catalog sizing thresholds bypassed.')
  } else {
    const { belowFloor, belowTarget } = checkThresholds(byHub, artByHub)

    if (belowFloor.length > 0) {
      console.error('\nCATALOG THRESHOLD FAILURE — below floor (ceil(articles/4)):')
      for (const h of belowFloor) {
        const ratio = (h.artCount / h.prodCount).toFixed(2)
        console.error(`  [FLOOR FAIL] ${h.hub}: ${h.prodCount} products / ${h.artCount} articles — need ${h.floor}, ratio ${ratio}`)
      }
      console.error('\nGrow the catalog before running assignments. Use --skip-threshold-check to override.')
      process.exit(2)
    }

    if (belowTarget.length > 0) {
      console.warn('\n[THRESHOLD WARNING] Below target (ceil(articles/2)) — concentration risk:')
      for (const h of belowTarget) {
        const ratio = (h.artCount / h.prodCount).toFixed(2)
        console.warn(`  ${h.hub}: ${h.prodCount} products / ${h.artCount} articles — target ${h.target}, ratio ${ratio}`)
      }
      console.warn('')
    }
  }

  // Pre-populate reuse counts from articles that already have products
  const useCounts = new Map()
  for (const article of pipeline) {
    if (Array.isArray(article.products)) {
      for (const slug of article.products) {
        useCounts.set(slug, (useCounts.get(slug) || 0) + 1)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Assignment pass — operates on a working copy for dry-run
  // ---------------------------------------------------------------------------

  const workingPipeline = dryRun
    ? pipeline.map(a => ({ ...a, products: [...(a.products || [])], assignment_notes: a.assignment_notes }))
    : pipeline

  let assigned = 0
  let skipped = 0
  let gapCount = 0
  let noHubCount = 0
  const gapArticles = []
  const noHubArticles = []
  const hubStats = new Map()
  // For histogram: hub -> Map<slug, assignedCount>
  const hubProductCounts = new Map()
  // For samples: hub -> [{slug, products, keyword}]
  const hubSamples = new Map()

  for (const article of workingPipeline) {
    const hub = article.hub_slug || article.hub || 'UNKNOWN'
    if (!hubStats.has(hub)) hubStats.set(hub, { total: 0, assigned: 0, gaps: 0 })
    hubStats.get(hub).total++

    const alreadyAssigned = Array.isArray(article.products) && article.products.length > 0
    if (alreadyAssigned && !force) {
      skipped++
      continue
    }

    const rawType = (article.type || 'buyer_guide').toLowerCase().replace(/\s+/g, '_')
    const target = TYPE_TARGETS[rawType] ?? DEFAULT_TARGET

    const hubProds = byHub.get(hub)
    if (!hubProds) {
      article.products = []
      article.assignment_notes =
        `No products catalog for hub "${hub}". Add products to products.yaml before generating.`
      noHubCount++
      noHubArticles.push(article.slug)
      continue
    }

    const { products, notes, gap } = selectProducts(article, hubProds, target, useCounts)

    article.products = products
    article.assignment_notes = notes

    for (const slug of products) {
      useCounts.set(slug, (useCounts.get(slug) || 0) + 1)
      if (!hubProductCounts.has(hub)) hubProductCounts.set(hub, new Map())
      const hpc = hubProductCounts.get(hub)
      hpc.set(slug, (hpc.get(slug) || 0) + 1)
    }

    assigned++
    hubStats.get(hub).assigned++

    if (gap) {
      gapCount++
      hubStats.get(hub).gaps++
      gapArticles.push({ slug: article.slug, hub, needed: target, got: products.length })
    }

    // Collect up to 5 samples per hub
    if (!hubSamples.has(hub)) hubSamples.set(hub, [])
    if (hubSamples.get(hub).length < 5) {
      hubSamples.get(hub).push({
        slug: article.slug,
        keyword: article.keyword || '',
        products,
        topScore: (() => {
          const artT = tokenize(`${article.slug} ${article.keyword || ''}`)
          let best = 0
          for (const [s, d] of hubProds) {
            const sc = scoreMatch(artT, tokenize(`${s} ${d.name || ''}`))
            if (sc > best) best = sc
          }
          return best
        })(),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  const sep = '─'.repeat(72)
  console.log('\n' + sep)
  console.log('assign-products')
  console.log(`  Site:     ${siteRoot}`)
  console.log(`  Mode:     ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}${force ? ' + --force' : ''}`)
  console.log(`  Pipeline: ${pipeline.length} articles`)
  console.log(`  Catalog:  ${Object.keys(rawProducts).length} products / ${byHub.size} hub(s)  [grouped by: ${groupingField}]`)

  // Per-hub summary table
  console.log('\nPer-hub summary:')
  for (const [hub, s] of [...hubStats.entries()].sort()) {
    const prods = byHub.get(hub)?.size ?? 0
    const gapFlag = s.gaps > 0 ? '  *** GAP' : ''
    console.log(
      `  ${hub.padEnd(12)}  total:${String(s.total).padStart(3)}  assigned:${String(s.assigned).padStart(3)}  gaps:${String(s.gaps).padStart(2)}  catalog:${String(prods).padStart(2)}${gapFlag}`
    )
  }

  console.log('\nResults:')
  console.log(`  Assigned:  ${assigned}`)
  console.log(`  Skipped:   ${skipped}  (already assigned — use --force to re-run)`)
  if (noHubCount > 0) {
    console.log(`  No-hub:    ${noHubCount}`)
    for (const s of noHubArticles) console.log(`    [NO-HUB] ${s}`)
  }
  if (gapCount > 0) {
    console.log(`  Gaps:      ${gapCount}`)
    for (const g of gapArticles) console.log(`    [GAP] ${g.slug}  hub:${g.hub}  needed:${g.needed}  got:${g.got}`)
  } else {
    console.log(`  Gaps:      0`)
  }

  // ---------------------------------------------------------------------------
  // Per-hub product assignment histogram
  // ---------------------------------------------------------------------------

  console.log('\nProduct assignment histogram (per hub):')
  for (const [hub, hpc] of [...hubProductCounts.entries()].sort()) {
    const hubProds = byHub.get(hub)
    const allSlugs = hubProds ? [...hubProds.keys()] : []

    // Include products that got 0 assignments
    const counts = allSlugs.map(slug => ({ slug, n: hpc.get(slug) || 0 }))
    counts.sort((a, b) => b.n - a.n)

    const buckets = { 0: 0, '1-2': 0, '3-5': 0, '6-10': 0, '11-20': 0, '21+': 0 }
    for (const { n } of counts) {
      if (n === 0) buckets['0']++
      else if (n <= 2) buckets['1-2']++
      else if (n <= 5) buckets['3-5']++
      else if (n <= 10) buckets['6-10']++
      else if (n <= 20) buckets['11-20']++
      else buckets['21+']++
    }

    console.log(`\n  ${hub} (${allSlugs.length} products):`)
    for (const [bucket, n] of Object.entries(buckets)) {
      if (n > 0) console.log(`    [${bucket.padStart(5)} articles]  ${n} product(s)`)
    }
    // Show top 3 most-assigned and any with 0
    const top3 = counts.slice(0, 3)
    const zero = counts.filter(c => c.n === 0)
    if (top3.length) {
      console.log(`    Most assigned: ${top3.map(c => `${c.slug}(${c.n})`).join(', ')}`)
    }
    if (zero.length) {
      console.log(`    Zero assigned: ${zero.map(c => c.slug).join(', ')}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Per-hub sample assignments (5 per hub for eyeball check)
  // ---------------------------------------------------------------------------

  console.log('\nSample assignments — 5 per hub (keyword → products):')
  for (const [hub, samples] of [...hubSamples.entries()].sort()) {
    console.log(`\n  ${hub}:`)
    for (const s of samples) {
      const scoreLabel = s.topScore > 0 ? ` [score ${s.topScore}]` : ' [no match]'
      console.log(`    "${s.keyword}"${scoreLabel}`)
      for (const p of s.products) {
        const pd = byHub.get(hub)?.get(p)
        const name = pd ? pd.name : '?'
        console.log(`      → ${p}  (${name})`)
      }
    }
  }

  console.log('\n' + sep)

  if (dryRun) {
    console.log('DRY RUN — pipeline.json not written.')
    process.exit(gapCount > 0 || noHubCount > 0 ? 1 : 0)
  }

  // ---------------------------------------------------------------------------
  // Atomic write: tmp → backup original → write final
  // ---------------------------------------------------------------------------

  const tmpPath = pipelinePath + '.tmp'
  const bakPath = pipelinePath + '.bak'

  writeFileSync(tmpPath, JSON.stringify(pipeline, null, 2) + '\n', 'utf8')
  if (existsSync(pipelinePath)) copyFileSync(pipelinePath, bakPath)
  writeFileSync(pipelinePath, readFileSync(tmpPath, 'utf8'), 'utf8')
  try { unlinkSync(tmpPath) } catch {}

  console.log(`Written: ${pipelinePath}`)
  console.log(`Backup:  ${bakPath}`)

  process.exit(gapCount > 0 || noHubCount > 0 ? 1 : 0)
}

main()
