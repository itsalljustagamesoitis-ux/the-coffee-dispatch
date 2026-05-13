#!/usr/bin/env node
/**
 * source-products-per-article.mjs — Automated product sourcing with VERIFY fallback.
 *
 * For each pending article: LLM proposes concepts → scrape Amazon → LLM ranks
 * candidates → write high-confidence matches to products.yaml + pipeline.json,
 * flag everything else as VERIFY.
 *
 * Usage:
 *   node tools/source-products-per-article.mjs --site <slug>
 *   node tools/source-products-per-article.mjs --site <slug> --dry-run
 *   node tools/source-products-per-article.mjs --site <slug> --article <slug>
 *   node tools/source-products-per-article.mjs --site <slug> --limit N
 *   node tools/source-products-per-article.mjs --site <slug> --resume
 *
 * Exit: 0 = finished (VERIFY entries are normal)
 *       1 = interrupted (RateLimitError or fatal mid-run; state preserved for --resume)
 *       2 = tool error (auth, missing files, etc.)
 */

/**
 * DEPRECATED — May 2026
 *
 * This tool uses Amazon scraping which rate-limits at scale (TCD's
 * 300-article bulk run hit blocks within ~30 articles). Use the
 * Rainforest-based tool for production:
 *   python3 tools/source-products-rainforest.py --site <slug>
 *
 * This tool remains functional for small jobs (< 30 articles) and
 * smoke testing. It will be removed in a future cleanup unless
 * usage justifies keeping it.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import yaml from 'js-yaml'

import { loadPortfolio, getSite } from './lib/portfolio.mjs'
import { searchAmazon, RateLimitError } from './lib/amazon-search.mjs'

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

const args        = process.argv.slice(2)
const has         = flag => args.includes(flag)
const get         = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const slug        = get('--site')
const articleSlug = get('--article')
const limitArg    = get('--limit')
const limit       = limitArg ? parseInt(limitArg, 10) : null
const dryRun      = has('--dry-run')
const resume      = has('--resume')

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_ROOT    = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIDENCE_GATE  = 0.8
const DEFAULT_MODEL    = 'claude-haiku-4-5-20251001'

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function resolveAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const envLocal = join(PLATFORM_ROOT, '.env.local')
  if (existsSync(envLocal)) {
    const m = readFileSync(envLocal, 'utf-8').match(/^ANTHROPIC_API_KEY=(.+)$/m)
    if (m) return m[1].trim()
  }
  return null
}

function atomicWriteJson(path, data) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, path)
}

function atomicWriteYaml(path, data) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, yaml.dump(data, { lineWidth: 120, noRefs: true }), 'utf-8')
  renameSync(tmp, path)
}

function extractJson(text) {
  // Try direct parse first
  try { return JSON.parse(text) } catch {}
  // Extract from markdown fences or prose
  const m = text.match(/```(?:json)?\s*([\s\S]+?)```/) ?? text.match(/(\{[\s\S]+\})/)
  if (m) { try { return JSON.parse(m[1]) } catch {} }
  return null
}

function exitWith(code, msg) {
  if (msg) console.error(c.red(`\nError: ${msg}`))
  process.exit(code)
}

// ── LLM calls ─────────────────────────────────────────────────────────────────

async function proposeConceptsLlm(client, model, article) {
  const userMsg = `Article details:
- Title: ${article.title}
- Keyword: ${article.keyword}
- Type: ${article.type}
- Angle: ${article.angle ?? 'general'}
- Hub: ${article.hub_label ?? article.hub}
- Notes: ${article.assignment_notes ?? 'none'}

Propose 5-8 specific product concepts for this article.`

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: `You source Amazon products for affiliate review articles. Propose 5-8 specific product concepts that should appear in this article. Each concept should be (a) relevant to the article's keyword and angle, (b) varied enough to give real range — different price points, brands, or specs.

CRITICAL for search_query: use category + key spec style (e.g., "7 inch santoku knife japanese steel", "budget santoku knife stainless", "professional santoku knife forged"). DO NOT use brand+model style queries like "Shun Classic 7 inch santoku" — those return zero Amazon results. The label can mention specific brands (e.g., "Shun Classic — premium Japanese santoku") but search_query must be broad enough to return 10+ search results.

Concept scope: For buyer_guide articles, at least 60% of concepts should be the core product type (different brands, sizes, price points of the keyword). Adjacent products (accessories, alternatives, complementary tools) may comprise the remaining 40% if they meaningfully serve the article's angle. Do NOT include complementary products at the expense of core product range — readers came for the keyword. For other article types (single_product, comparison, etc.), use judgment about scope.

Output JSON only: {"concepts": [{"label": "...", "search_query": "...", "rationale": "..."}]}`,
    messages: [{ role: 'user', content: userMsg }],
  })

  const text = response.content[0]?.text ?? ''
  const tokens = { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }
  const parsed = extractJson(text)

  if (!parsed?.concepts || !Array.isArray(parsed.concepts) || parsed.concepts.length < 2) {
    return { concepts: null, tokens, rawText: text }
  }

  // Clamp to 5-8
  const concepts = parsed.concepts.slice(0, 8)
  return { concepts, tokens, rawText: null }
}

async function rankCandidatesLlm(client, model, article, concepts, candidates) {
  const conceptsList = concepts.map((c, i) => `${i + 1}. ${c.label} (search: "${c.search_query}")`).join('\n')

  const candidatesList = candidates.map(p =>
    `ASIN: ${p.asin} | Title: ${p.title} | Brand: ${p.brand ?? 'n/a'} | Price: ${p.price ?? 'n/a'} | Rating: ${p.rating ?? 'n/a'} (${p.reviewCount ?? 0} reviews)`
  ).join('\n')

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: `You rank Amazon search results against product concepts for affiliate articles. For each concept, choose the single best matching ASIN from the candidates (or null if none fit well).

Output JSON only:
{"rankings": [{"concept": "<label>", "best_match_asin": "<ASIN or null>", "confidence": <0.0-1.0>, "reasoning": "<brief>"}]}

Confidence rubric:
- 0.9-1.0: clear match, exact brand+model+attributes align
- 0.7-0.89: good match, minor uncertainty (size/color variation OK if category right)
- 0.5-0.69: plausible but uncertain
- 0.0-0.49: poor match or wrong category
- null asin: no candidate fits — mark for manual sourcing`,
    messages: [{
      role: 'user',
      content: `Article: ${article.title} (${article.keyword})
Hub: ${article.hub_label ?? article.hub}

Concepts to match:
${conceptsList}

Available candidates:
${candidatesList}

Rank each concept against the candidates.`,
    }],
  })

  const text = response.content[0]?.text ?? ''
  const tokens = { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }
  const parsed = extractJson(text)

  if (!parsed?.rankings || !Array.isArray(parsed.rankings)) {
    return { rankings: null, tokens, rawText: text }
  }
  return { rankings: parsed.rankings, tokens, rawText: null }
}

// ── Core per-article processor ────────────────────────────────────────────────

async function processArticle(article, { client, model, siteDir, site, products, pipeline, dryRun, verbose }) {
  const result = {
    slug: article.slug,
    autoWrites: [],
    verifyEntries: [],
    emptyConceptsCount: 0,
    tokensInput: 0,
    tokensOutput: 0,
    error: null,
  }

  if (verbose) {
    console.log()
    console.log(c.bold(`  ▸ ${article.slug}`))
    console.log(c.dim(`    ${article.title} · ${article.type} · ${article.hub_label ?? article.hub}`))
  }

  // Step 3a: Concept proposal
  const { concepts, tokens: t1, rawText: badConcepts } = await proposeConceptsLlm(client, model, article)
  result.tokensInput  += t1.input
  result.tokensOutput += t1.output

  if (verbose) console.log(c.dim(`    Concepts: ${concepts ? concepts.length : '⚠ parse failure'} (${t1.input}+${t1.output} tokens)`))

  if (!concepts) {
    result.verifyEntries.push({
      key: `VERIFY-${slugify(article.slug)}-all`,
      entry: { title: `VERIFY: all concepts (LLM parse failure)`, asin: 'VERIFY', brand: null, hub: article.hub },
    })
    if (verbose) console.log(c.yellow('    ⚠ Concept parse failure — marking whole article as VERIFY'))
    return result
  }

  if (verbose) {
    for (const con of concepts) {
      console.log(c.dim(`      • ${con.label}: "${con.search_query}"`))
    }
  }

  // Step 3b: Amazon search per concept
  const allCandidates = []
  const seenAsins = new Set()

  for (const concept of concepts) {
    let results
    try {
      results = await searchAmazon(concept.search_query, { maxResults: 10 })
    } catch (err) {
      if (err instanceof RateLimitError) throw err  // propagate to abort run
      if (verbose) console.log(c.yellow(`    ⚠ Search failed for "${concept.search_query}": ${err.message}`))
      result.emptyConceptsCount++
      continue
    }

    const fresh = results.filter(r => !seenAsins.has(r.asin))
    for (const r of fresh) seenAsins.add(r.asin)
    allCandidates.push(...fresh)

    if (results.length === 0) {
      result.emptyConceptsCount++
      if (verbose) console.log(c.dim(`      └ "${concept.search_query}" → 0 results`))
    } else {
      if (verbose) console.log(c.dim(`      └ "${concept.search_query}" → ${results.length} results (${fresh.length} new, ${results.length - fresh.length} dupe)`))
    }
  }

  if (allCandidates.length === 0) {
    result.verifyEntries.push({
      key: `VERIFY-${slugify(article.slug)}-all`,
      entry: { title: `VERIFY: all concepts (no Amazon candidates found)`, asin: 'VERIFY', brand: null, hub: article.hub },
    })
    if (verbose) console.log(c.yellow('    ⚠ No candidates from any search — marking whole article as VERIFY'))
    return result
  }

  if (verbose) console.log(c.dim(`    Candidates: ${allCandidates.length} unique ASINs across ${concepts.length} concepts`))

  // Step 3c: Ranking
  const { rankings, tokens: t2, rawText: badRankings } = await rankCandidatesLlm(client, model, article, concepts, allCandidates)
  result.tokensInput  += t2.input
  result.tokensOutput += t2.output

  if (verbose) console.log(c.dim(`    Rankings: ${rankings ? rankings.length : '⚠ parse failure'} (${t2.input}+${t2.output} tokens)`))

  if (!rankings) {
    result.verifyEntries.push({
      key: `VERIFY-${slugify(article.slug)}-all`,
      entry: { title: `VERIFY: all rankings (LLM parse failure)`, asin: 'VERIFY', brand: null, hub: article.hub },
    })
    return result
  }

  // Step 3d: Classify
  for (const ranking of rankings) {
    const conceptSlug = slugify(ranking.concept)
    const candidate   = allCandidates.find(c => c.asin === ranking.best_match_asin)

    if (verbose) {
      const conf   = ranking.confidence?.toFixed(2) ?? '?'
      const result = ranking.best_match_asin ?? 'null'
      const sym    = (ranking.confidence ?? 0) >= CONFIDENCE_GATE ? c.green('✓') : c.yellow('⚠')
      console.log(`      ${sym} [${conf}] ${ranking.concept} → ${result}`)
      if (ranking.reasoning) console.log(c.dim(`           ${ranking.reasoning}`))
    }

    if (ranking.best_match_asin && candidate && (ranking.confidence ?? 0) >= CONFIDENCE_GATE) {
      const entryKey = slugify(`${candidate.brand ?? ''}-${candidate.title}`.slice(0, 48)).replace(/^-/, '') ||
                       `product-${candidate.asin.toLowerCase()}`
      result.autoWrites.push({
        key: entryKey,
        asin: candidate.asin,
        entry: {
          title:      candidate.title,
          asin:       candidate.asin,
          brand:      candidate.brand ?? null,
          hub:        article.hub,
          source_url: candidate.productUrl,
          sourced_at: new Date().toISOString(),
          confidence: ranking.confidence,
        },
      })
    } else {
      result.verifyEntries.push({
        key: `VERIFY-${conceptSlug}`,
        entry: {
          title:     `VERIFY: ${ranking.concept}`,
          asin:      'VERIFY',
          brand:     null,
          hub:       article.hub,
          rationale: ranking.reasoning ?? null,
        },
      })
    }
  }

  // Write to products.yaml + pipeline.json (unless dry-run)
  if (!dryRun) {
    const allNewKeys = [...result.autoWrites, ...result.verifyEntries].map(e => e.key)

    for (const w of [...result.autoWrites, ...result.verifyEntries]) {
      products[w.key] = w.entry
    }

    // Update pipeline article products list
    const pipelineArticle = pipeline.find(a => a.slug === article.slug)
    if (pipelineArticle) {
      const autoKeys   = result.autoWrites.map(w => w.key)
      const verifyKeys = result.verifyEntries.map(w => w.key)
      pipelineArticle.products = [...(pipelineArticle.products ?? []), ...autoKeys, ...verifyKeys]
    }
  } else if (verbose && (result.autoWrites.length || result.verifyEntries.length)) {
    console.log(c.dim(`    [dry-run] Would write ${result.autoWrites.length} product(s) + ${result.verifyEntries.length} VERIFY entries`))
    for (const w of result.autoWrites) {
      console.log(c.dim(`      AUTO  ${w.key} (ASIN ${w.asin})`))
    }
    for (const w of result.verifyEntries) {
      console.log(c.dim(`      VERIFY ${w.key}`))
    }
  }

  return result
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.warn('\x1b[33m⚠ DEPRECATED: source-products-per-article uses Amazon scraping which rate-limits at scale. Use tools/source-products-rainforest.py for production.\x1b[0m')

  if (!slug) exitWith(2, '--site <slug> is required')

  // Pre-flight 1a: Resolve site
  let site
  try { site = getSite(slug) } catch (err) { exitWith(2, err.message) }

  const siteDir = join(homedir(), slug)

  // Pre-flight 1b: Pipeline
  const pipelinePath = join(siteDir, 'data', 'pipeline.json')
  if (!existsSync(pipelinePath)) exitWith(2, `pipeline.json not found at ${pipelinePath}`)
  let pipelineEnvelope, pipeline
  try {
    pipelineEnvelope = JSON.parse(readFileSync(pipelinePath, 'utf-8'))
    pipeline = Array.isArray(pipelineEnvelope) ? pipelineEnvelope : (pipelineEnvelope.articles ?? [])
  } catch (err) { exitWith(2, `Cannot parse pipeline.json: ${err.message}`) }

  // Pre-flight 1c: products.yaml
  const productsPath = join(siteDir, 'content', 'products', 'products.yaml')
  let products = {}
  if (existsSync(productsPath)) {
    try { products = yaml.load(readFileSync(productsPath, 'utf-8')) ?? {} }
    catch (err) { exitWith(2, `Cannot parse products.yaml: ${err.message}`) }
  }

  // Pre-flight 1d: site.config.yaml
  const siteConfigPath = join(siteDir, 'site.config.yaml')
  let siteConfig = {}
  if (existsSync(siteConfigPath)) {
    try { siteConfig = yaml.load(readFileSync(siteConfigPath, 'utf-8')) ?? {} }
    catch { /* optional */ }
  }

  // Pre-flight 1e: Anthropic key
  const apiKey = resolveAnthropicKey()
  if (!apiKey) exitWith(2, 'ANTHROPIC_API_KEY not found in env or .env.local')

  const model = process.env.CLAUDE_MODEL ?? DEFAULT_MODEL

  // Pre-flight 1f: State file
  const stateFile = `/tmp/source-products-${slug}-state.json`
  let processedSlugs = new Set()
  let state = { processedSlugs: [], startedAt: new Date().toISOString(), articleCount: 0, processed: 0 }

  if (resume) {
    if (existsSync(stateFile)) {
      try {
        const s = JSON.parse(readFileSync(stateFile, 'utf-8'))
        processedSlugs = new Set(s.processedSlugs ?? [])
        state = s
        console.log(c.yellow(`  Resuming — ${processedSlugs.size} articles already processed`))
      } catch { console.log(c.yellow('  State file unreadable — starting fresh')) }
    } else {
      console.log(c.yellow('  No state file found — starting fresh'))
    }
  } else if (existsSync(stateFile) && !articleSlug) {
    exitWith(2, `State file exists at ${stateFile}. Use --resume to continue, or delete it to start fresh.`)
  }

  // Phase 2: Article selection
  let articles = pipeline.filter(a => {
    // Eligible: status pending OR products empty/missing
    const isPending = a.status === 'pending' || a.published === false
    const noProducts = !a.products || a.products.length === 0
    return isPending || noProducts
  })

  if (articleSlug) {
    const found = pipeline.find(a => a.slug === articleSlug)
    if (!found) exitWith(2, `Article "${articleSlug}" not found in pipeline.json`)
    articles = [found]
    // --article is the force flag — skip the "already has products" guard
  } else {
    // Skip articles that already have products (not force mode)
    articles = articles.filter(a => {
      if (a.products?.length > 0 && !processedSlugs.has(a.slug)) {
        // Already has products — skip unless forced
        return false
      }
      return true
    })
  }

  // Skip already processed (resume mode)
  if (!articleSlug) articles = articles.filter(a => !processedSlugs.has(a.slug))

  if (limit) articles = articles.slice(0, limit)

  if (articles.length === 0) {
    console.log(c.green('\nNo pending articles to process. All done.'))
    process.exit(0)
  }

  console.log()
  console.log(c.bold(`Source Products — ${slug}`))
  console.log(c.dim('─'.repeat(50)))
  console.log(`  Articles to process: ${c.bold(String(articles.length))}`)
  console.log(`  Model: ${c.dim(model)}`)
  if (dryRun) console.log(c.cyan('  DRY RUN — no writes will be made'))
  console.log(`  Estimated runtime: ~2-3 minutes per article`)
  console.log()

  const client = new Anthropic({ apiKey })

  // Phase 3: Per-article loop
  let totalAuto = 0, totalVerify = 0, totalEmpty = 0, totalTokensIn = 0, totalTokensOut = 0, totalErrors = 0
  const runStarted = Date.now()

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i]
    console.log(c.dim(`  [${i + 1}/${articles.length}]`))

    // Skip if already has products and we're not in article-specific mode
    if (!articleSlug && article.products?.length > 0) {
      console.log(c.dim(`  → ${article.slug}: already sourced — skipping`))
      processedSlugs.add(article.slug)
      continue
    }

    let result
    try {
      result = await processArticle(article, {
        client, model, siteDir, site, products, pipeline, dryRun, verbose: true,
      })
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.error(c.red(`\n  ✗ Rate limit hit: ${err.message}`))
        console.error(c.yellow('  Wait 5-15 minutes then re-run with --resume'))
        // Save state before aborting
        state.processedSlugs = [...processedSlugs]
        state.processed = processedSlugs.size
        atomicWriteJson(stateFile, state)
        if (!dryRun) {
          atomicWriteYaml(productsPath, products)
          if (Array.isArray(pipelineEnvelope)) {
            atomicWriteJson(pipelinePath, pipeline)
          } else {
            atomicWriteJson(pipelinePath, { ...pipelineEnvelope, articles: pipeline })
          }
        }
        process.exit(1)
      }
      console.error(c.yellow(`  ⚠ Error on ${article.slug}: ${err.message}`))
      totalErrors++
      processedSlugs.add(article.slug)
      continue
    }

    totalAuto   += result.autoWrites.length
    totalVerify += result.verifyEntries.length
    totalEmpty  += result.emptyConceptsCount
    totalTokensIn  += result.tokensInput
    totalTokensOut += result.tokensOutput

    processedSlugs.add(article.slug)

    // Checkpoint after each article (3e)
    state.processedSlugs = [...processedSlugs]
    state.processed = processedSlugs.size
    atomicWriteJson(stateFile, state)

    if (!dryRun) {
      atomicWriteYaml(productsPath, products)
      if (Array.isArray(pipelineEnvelope)) {
        atomicWriteJson(pipelinePath, pipeline)
      } else {
        atomicWriteJson(pipelinePath, { ...pipelineEnvelope, articles: pipeline })
      }
    }
  }

  // Phase 4: Summary
  const elapsed = Math.round((Date.now() - runStarted) / 1000)
  const llmCalls    = articles.length * 2
  // Rough cost: Haiku input $0.80/M, output $4.00/M (as of 2025)
  const costEstimate = ((totalTokensIn / 1_000_000) * 0.80 + (totalTokensOut / 1_000_000) * 4.00).toFixed(4)

  console.log()
  console.log(c.bold('  Summary'))
  console.log(c.dim('  ' + '─'.repeat(48)))
  console.log(`  Total articles processed:  ${articles.length}`)
  console.log(`  Auto-resolved products:    ${c.green(String(totalAuto))} (confidence ≥ ${CONFIDENCE_GATE})`)
  console.log(`  VERIFY entries:            ${totalVerify > 0 ? c.yellow(String(totalVerify)) : '0'} (need human review)`)
  console.log(`  Empty concept searches:    ${totalEmpty}`)
  console.log(`  Errors / skipped:          ${totalErrors}`)
  console.log()
  console.log(`  Total LLM calls:           ~${llmCalls} (2 per article)`)
  console.log(`  Total tokens:              ${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out`)
  console.log(`  Estimated LLM cost:        ~$${costEstimate}`)
  console.log(`  Elapsed:                   ${elapsed}s`)
  console.log()
  if (!dryRun) {
    console.log(`  products.yaml updated:     ${productsPath}`)
    console.log(`  pipeline.json updated:     ${pipelinePath}`)
  } else {
    console.log(c.cyan('  DRY RUN — no files were modified'))
  }
  console.log(`  State file:                ${stateFile}`)

  if (totalVerify > 0) {
    console.log()
    console.log(c.yellow(`  ${totalVerify} VERIFY entries need human review.`))
    console.log(c.dim('  Run: node tools/dashboard.mjs --health to see VERIFY count.'))
  }

  console.log()

  process.exit(0)
}

main().catch(err => {
  console.error(c.red(`\nUnexpected error: ${err.message}`))
  if (err.stack) console.error(c.dim(err.stack))
  process.exit(2)
})
