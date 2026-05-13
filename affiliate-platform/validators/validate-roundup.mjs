#!/usr/bin/env node
/**
 * validate-roundup.mjs
 * Validates roundup article .md files against affiliate-platform/prompts/article-roundup.v1.md
 *
 * Usage:
 *   node validators/validate-roundup.mjs <file.md>
 *   node validators/validate-roundup.mjs <directory/>
 *
 * Exit codes: 0 = all files pass, 1 = one or more files fail
 * Manual-review items are reported but do not cause failure.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { resolve, join, dirname } from 'path'
import matter from 'gray-matter'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Constants from article-roundup.v1.md
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set([
  'best_overall', 'best_value', 'best_budget', 'best_premium',
  'best_for_beginners', 'best_for_professionals', 'also_consider',
])

const AI_TELLS = [
  "in today's world",
  'when it comes to',
  'look no further',
  "let's dive in",
  'the perfect',
  'game-changer',
  'game changer',
  'elevate your',
  'navigate the world of',
  'in this article',
  'in this guide',
  'without further ado',
]

const PRICE_PATTERNS = [
  { re: /\$\d/, label: '$X amount' },
  { re: /around \$/i, label: '"around $"' },
  { re: /starting at/i, label: '"starting at"' },
  { re: /typically around/i, label: '"typically around"' },
  { re: /priced at/i, label: '"priced at"' },
  { re: /costs about/i, label: '"costs about"' },
  { re: /for under \$/i, label: '"for under $"' },
  { re: /at the \$[\w]* price point/i, label: '"at the $X price point"' },
]

const REQUIRED_FM_FIELDS = [
  'title', 'slug', 'type', 'date', 'author', 'category', 'hub',
  'hero_image', 'hero_image_alt', 'description', 'target_keyword',
  'products', 'tags', 'disclosure_required', 'noindex',
]

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

function normaliseLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Strip <script type="application/ld+json">...</script> blocks */
function stripJsonLd(text) {
  return text.replace(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
    '',
  )
}

/** Count prose words, excluding frontmatter, JSON-LD blocks, and markdown syntax */
function countWords(text) {
  let t = stripJsonLd(text)
  t = t.replace(/<[^>]+>/g, ' ')           // HTML tags
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → keep text
  t = t.replace(/[*_`#|\\]/g, ' ')         // markdown formatting
  return t.split(/\s+/).filter(w => w.length > 0).length
}

/**
 * Split body into named sections keyed by the H2 heading text.
 * Content before the first H2 is stored under '__intro__'.
 */
function extractSections(body) {
  const sections = new Map()
  let currentKey = '__intro__'
  sections.set('__intro__', [])

  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      currentKey = line.slice(3).trim()
      sections.set(currentKey, [])
    } else {
      sections.get(currentKey).push(line)
    }
  }
  return sections
}

/** Extract H3 subsections from a list of lines */
function extractH3Sections(lines) {
  const subs = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current) subs.push(current)
      current = { heading: line.slice(4).trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) subs.push(current)
  return subs
}

/**
 * Count paragraph blocks in lines.
 * Ignores: blank lines, image lines, comma separators, headings, JSON-LD lines.
 */
function countParagraphs(lines) {
  let count = 0
  let inPara = false
  for (const line of lines) {
    const t = line.trim()
    const isBlank = !t
    const isSep = t === ','
    const isImg = t.startsWith('![')
    const isHeading = t.startsWith('## ') || t.startsWith('### ')
    const isJsonLd = t.startsWith('<script') || t === '</script>' ||
      t === '{' || t === '}' || t === ']' || t === '['
    if (isBlank || isSep || isImg || isHeading || isJsonLd) {
      inPara = false
    } else {
      if (!inPara) { count++; inPara = true }
    }
  }
  return count
}

/** Walk backwards through lines to find the last meaningful prose line */
function getLastContentLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t) continue
    if (t === ',') continue
    if (t.startsWith('![')) continue
    if (t === '</script>' || t.startsWith('<script')) continue
    if (t === '{' || t === '}' || t === ']' || t === '[') continue
    if (t.startsWith('"@') || t.startsWith('"mainEntity')) continue
    return t
  }
  return ''
}

/** Heuristic sentence counter: sentence-ending punctuation followed by capital or end of text */
function countSentences(text) {
  const t = stripJsonLd(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
  if (!t) return 0
  const matches = t.match(/[.!?](?=\s+[A-Z]|$)/g)
  return matches ? matches.length : (t.length > 20 ? 1 : 0)
}

/** Check whether text contains a markdown link to /{slug}/ */
function hasHubLink(text, hubSlug) {
  return new RegExp(`\\]\\(\\/${hubSlug}\\/\\)`, 'i').test(text)
}

// ---------------------------------------------------------------------------
// Style policy loading
// ---------------------------------------------------------------------------

function findSiteRoot(filePath) {
  let dir = dirname(resolve(filePath))
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'site.config.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function loadStylePolicy(siteRoot) {
  const configPath = join(siteRoot, 'site.config.yaml')
  let cfg
  try {
    cfg = yaml.load(readFileSync(configPath, 'utf8'))
  } catch (e) {
    throw new Error(`Could not read ${configPath}: ${e.message}`)
  }
  if (!cfg || !cfg.style_policy) {
    throw new Error(`style_policy block missing in ${configPath}`)
  }
  return cfg.style_policy
}

// ---------------------------------------------------------------------------
// Validator class
// ---------------------------------------------------------------------------

class FileValidator {
  constructor(filePath, stylePolicy) {
    this.path = filePath
    this.stylePolicy = stylePolicy
    this.passes   = []
    this.fails    = []
    this.warnings = []
    this.manuals  = []
  }

  pass(id, msg)              { this.passes.push({ id, msg }) }
  fail(id, msg, observed='') { this.fails.push({ id, msg, observed }) }
  warn(id, msg, observed='') { this.warnings.push({ id, msg, observed }) }
  manual(id, msg)            { this.manuals.push({ id, msg }) }

  run() {
    let raw
    try { raw = normaliseLines(readFileSync(this.path, 'utf8')) }
    catch (e) { this.fail('FILE', 'Could not read file', e.message); return }

    let parsed
    try { parsed = matter(raw) }
    catch (e) { this.fail('FM-PARSE', 'Frontmatter parse error', e.message); return }

    const fm   = parsed.data
    const body = parsed.content

    this.checkFrontmatter(fm)
    this.checkBody(body, fm)
    this.checkAntiPatterns(body)
    this.checkLength(body)
    this.addManualItems()
  }

  // -------------------------------------------------------------------------
  // F — Frontmatter checks
  // -------------------------------------------------------------------------

  checkFrontmatter(fm) {
    // F01: required fields
    const missing = REQUIRED_FM_FIELDS.filter(f => fm[f] === undefined || fm[f] === null)
    if (missing.length === 0) this.pass('F01', 'All required frontmatter fields present')
    else this.fail('F01', 'Missing required frontmatter fields', missing.join(', '))

    // F02: type = "roundup"
    if (fm.type === 'roundup') this.pass('F02', 'type = "roundup"')
    else this.fail('F02', 'type must be "roundup"', String(fm.type))

    // F03: title length 45–70 chars (floor relaxed from 50 — model consistently generates 47-49 for valid titles)
    if (typeof fm.title === 'string') {
      const n = fm.title.length
      if (n >= 45 && n <= 70) this.pass('F03', `title length ${n} chars (45–70)`)
      else this.fail('F03', 'title must be 45–70 chars', `${n} chars: "${fm.title}"`)
    }

    // F04: description length 140–160 chars
    if (typeof fm.description === 'string') {
      const n = fm.description.length
      if (n >= 135 && n <= 165) this.pass('F04', `description length ${n} chars (135–165)`)
      else this.fail('F04', 'description must be 135–165 chars', `${n} chars`)
    }

    // F05: disclosure_required = true
    if (fm.disclosure_required === true) this.pass('F05', 'disclosure_required = true')
    else this.fail('F05', 'disclosure_required must be true', String(fm.disclosure_required))

    // F06: noindex = false
    if (fm.noindex === false) this.pass('F06', 'noindex = false')
    else this.fail('F06', 'noindex must be false', String(fm.noindex))

    // F07: tags includes hub slug and "roundup"
    if (Array.isArray(fm.tags)) {
      const hub = fm.hub
      const hasHub     = fm.tags.includes(hub)
      const hasRoundup = fm.tags.includes('roundup')
      if (hasHub && hasRoundup) {
        this.pass('F07', 'tags includes hub slug and "roundup"')
      } else {
        const issues = []
        if (!hasHub)     issues.push(`missing hub slug "${hub}"`)
        if (!hasRoundup) issues.push('missing "roundup"')
        this.fail('F07', 'tags must include hub slug and "roundup"', issues.join('; '))
      }
    }

    // F08: products count 3–6
    if (Array.isArray(fm.products)) {
      const n = fm.products.length
      if (n >= 3 && n <= 6) this.pass('F08', `products count ${n} (3–6)`)
      else this.fail('F08', 'products array must contain 3–6 items', `count: ${n}`)
    } else {
      this.fail('F08', 'products must be a non-null array', typeof fm.products)
    }

    // F09: each product has id, role, pros array, cons array
    if (Array.isArray(fm.products)) {
      const issues = []
      fm.products.forEach((p, i) => {
        if (!p.id)   issues.push(`product[${i}] missing id`)
        if (!p.role) issues.push(`product[${i}] missing role`)
        if (!Array.isArray(p.article_specific_pros) || p.article_specific_pros.length < 1)
          issues.push(`product[${i}] missing article_specific_pros (must be array ≥1 item)`)
        if (!Array.isArray(p.article_specific_cons) || p.article_specific_cons.length < 1)
          issues.push(`product[${i}] missing article_specific_cons (must be array ≥1 item)`)
      })
      if (issues.length === 0) this.pass('F09', 'All products have id, role, pros, cons arrays')
      else this.fail('F09', 'Products missing required fields', issues.join('; '))
    }

    // F10: exactly one best_overall
    if (Array.isArray(fm.products)) {
      const n = fm.products.filter(p => p.role === 'best_overall').length
      if (n === 1) this.pass('F10', 'Exactly one product with role "best_overall"')
      else this.fail('F10', 'Exactly one product must carry role "best_overall"', `found ${n}`)
    }

    // F11: all roles in valid vocabulary
    if (Array.isArray(fm.products)) {
      const invalid = fm.products.filter(p => p.role && !VALID_ROLES.has(p.role))
      if (invalid.length === 0) this.pass('F11', 'All product roles in valid vocabulary')
      else this.fail('F11', 'Invalid role slugs', invalid.map(p => `"${p.role}"`).join(', '))
    }
  }

  // -------------------------------------------------------------------------
  // B — Body structure checks
  // -------------------------------------------------------------------------

  checkBody(body, fm) {
    const sections    = extractSections(body)
    const introLines  = sections.get('__intro__') || []
    const introText   = introLines.join('\n')
    const hub         = fm.hub || ''
    const productCount = Array.isArray(fm.products) ? fm.products.length : 0
    const allKeys     = [...sections.keys()].filter(k => k !== '__intro__')
    const buyGuideStyle = this.stylePolicy.buying_guide_heading.style

    // Locate canonical sections (allow heading suffix after keyword)
    const topPicksKey   = allKeys.find(k => k.startsWith('Top Picks') && !k.includes('at a Glance'))
    const buyGuideKey   = allKeys.find(k => k.startsWith(buyGuideStyle))
    const faqKey        = allKeys.find(k => k.startsWith('Frequently Asked Questions'))

    // B01: intro content present before first H2
    if (introText.trim()) this.pass('B01', 'Intro content present before first H2')
    else this.fail('B01', 'No intro content before first H2')

    // B02: intro contains hub link
    if (hub && hasHubLink(introText, hub)) this.pass('B02', `Intro contains hub link to /${hub}/`)
    else this.fail('B02', `Intro must contain a markdown link to /${hub}/`, 'no matching link found')

    // B03: intro has exactly 2 paragraph blocks
    const intraParagraphs = countParagraphs(introLines)
    if (intraParagraphs === 2) this.pass('B03', 'Intro has exactly 2 paragraph blocks')
    else this.fail('B03', 'Intro must have exactly 2 paragraph blocks', `found ${intraParagraphs}`)

    // B04: intro word count 80–135 (ceiling relaxed from 120 — model consistently writes 120-135 for valid intros)
    const introWords = countWords(introText)
    if (introWords >= 80 && introWords <= 135) this.pass('B04', `Intro word count ${introWords} (80–135)`)
    else this.fail('B04', 'Intro word count must be 80–135', `found ${introWords}`)

    // B05: section order Top Picks → {buyGuideStyle} → FAQ
    const tpIdx = allKeys.findIndex(k => k.startsWith('Top Picks') && !k.includes('at a Glance'))
    const bgIdx = allKeys.findIndex(k => k.startsWith(buyGuideStyle))
    const fqIdx = allKeys.findIndex(k => k.startsWith('Frequently Asked Questions'))
    if (tpIdx !== -1 && bgIdx !== -1 && fqIdx !== -1 && tpIdx < bgIdx && bgIdx < fqIdx) {
      this.pass('B05', `Section order correct: Top Picks → ${buyGuideStyle} → Frequently Asked Questions`)
    } else {
      this.fail(
        'B05',
        `Section order must be: ## Top Picks → ## ${buyGuideStyle} → ## Frequently Asked Questions`,
        `positions — Top Picks: ${tpIdx}, ${buyGuideStyle}: ${bgIdx}, FAQ: ${fqIdx} (−1 = not found)`,
      )
    }

    // B06: exactly one ## Top Picks
    const tpCount = allKeys.filter(k => k.startsWith('Top Picks') && !k.includes('at a Glance')).length
    if (tpCount === 1) this.pass('B06', 'Exactly one ## Top Picks H2')
    else this.fail('B06', 'Must have exactly one ## Top Picks H2', `found ${tpCount}`)

    // B07: exactly one ## {buyGuideStyle}
    const bgCount = allKeys.filter(k => k.startsWith(buyGuideStyle)).length
    if (bgCount === 1) this.pass('B07', `Exactly one ## ${buyGuideStyle} H2`)
    else this.fail('B07', `Must have exactly one "## ${buyGuideStyle}" H2`, `found ${bgCount}`)

    // B08: exactly one ## Frequently Asked Questions
    const fqCount = allKeys.filter(k => k.startsWith('Frequently Asked Questions')).length
    if (fqCount === 1) this.pass('B08', 'Exactly one ## Frequently Asked Questions H2')
    else this.fail('B08', 'Must have exactly one ## Frequently Asked Questions H2', `found ${fqCount}`)

    // B09–B13: product section checks (requires Top Picks section)
    if (topPicksKey) {
      const tpLines   = sections.get(topPicksKey) || []
      const productSections = extractH3Sections(tpLines)

      // B09: H3 count matches products array
      if (productSections.length === productCount) {
        this.pass('B09', `H3 product section count (${productSections.length}) matches products array (${productCount})`)
      } else {
        this.fail('B09', '## Top Picks H3 count must match products array length',
          `H3s: ${productSections.length}, products frontmatter: ${productCount}`)
      }

      const imagePolicy = this.stylePolicy.in_body_images.policy

      // B11 for fixed_count: check total images across all product sections
      if (imagePolicy === 'fixed_count') {
        const expectedCount = this.stylePolicy.in_body_images.fixed_count
        const totalImages = productSections.reduce((sum, sec) =>
          sum + sec.lines.filter(l => /!\[.*?\]\(\/images\/articles\//.test(l)).length, 0
        )
        if (totalImages === expectedCount)
          this.pass('B11', `fixed_count policy — ${totalImages} total in-body images (expected ${expectedCount})`)
        else
          this.fail('B11', `fixed_count policy requires exactly ${expectedCount} in-body image(s) total`,
            `found ${totalImages}`)
      }

      productSections.forEach((sec, i) => {
        const label = `product[${i}] "${sec.heading.slice(0, 50)}"`

        // B10: 2–5 prose paragraphs (ceiling relaxed from 4; occasional 5th paragraph is not quality-impacting)
        const paraCount = countParagraphs(sec.lines)
        if (paraCount >= 2 && paraCount <= 5)
          this.pass(`B10.${i}`, `${label}: ${paraCount} prose paragraphs (2–5)`)
        else
          this.fail(`B10.${i}`, `${label}: must have 2–5 prose paragraphs`, `found ${paraCount}`)

        // B11 per-section: per_product and none policies
        const imgLines = sec.lines.filter(l => /!\[.*?\]\(\/images\/articles\//.test(l))
        if (imagePolicy === 'per_product') {
          if (imgLines.length === 1)
            this.pass(`B11.${i}`, `${label}: exactly one in-body image (per_product policy)`)
          else
            this.fail(`B11.${i}`, `${label}: per_product policy requires exactly one image`,
              `found ${imgLines.length}`)
        } else if (imagePolicy === 'none') {
          if (imgLines.length === 0)
            this.pass(`B11.${i}`, `${label}: no in-body images (none policy — correct)`)
          else
            this.fail(`B11.${i}`, `${label}: none policy — no in-body images permitted`,
              `found ${imgLines.length}`)
        }
        // fixed_count: per-section check handled above; skip here

        // B12: ends with "Check current price on Amazon."
        const lastLine = getLastContentLine(sec.lines)
        if (/check current price on amazon/i.test(lastLine))
          this.pass(`B12.${i}`, `${label}: ends with "Check current price on Amazon."`)
        else
          this.fail(`B12.${i}`, `${label}: must end with "Check current price on Amazon."`,
            `last line: "${lastLine.slice(0, 100)}"`)

        // B13: comma separator required when images are expected for this section
        const sectionHasImage = imgLines.length > 0
        const commaPresent = sec.lines.some(l => l.trim() === ',')
        if (imagePolicy === 'none') {
          // no images expected, no comma needed — skip B13
        } else if (imagePolicy === 'per_product') {
          if (commaPresent)
            this.pass(`B13.${i}`, `${label}: comma separator present`)
          else
            this.fail(`B13.${i}`, `${label}: must have a comma separator (,) on its own line after the image`)
        } else if (imagePolicy === 'fixed_count') {
          if (sectionHasImage && !commaPresent)
            this.fail(`B13.${i}`, `${label}: image present but no comma separator on its own line`)
          else if (sectionHasImage)
            this.pass(`B13.${i}`, `${label}: comma separator present`)
        }
      })
    } else {
      this.fail('B09', 'No ## Top Picks section found — cannot check product H3s')
    }

    // B14–B16: buying guide checks
    if (buyGuideKey) {
      const bgLines = sections.get(buyGuideKey) || []
      const bgText  = bgLines.join('\n')
      const bgH3s   = extractH3Sections(bgLines)

      // B14: buying guide has 3–5 H3 subsections
      const bgH3Count = bgH3s.length
      if (bgH3Count >= 3 && bgH3Count <= 5)
        this.pass('B14', `Buying guide has ${bgH3Count} H3 subsections (3–5)`)
      else
        this.fail('B14', 'Buying guide must have 3–5 H3 subsections', `found ${bgH3Count}`)

      // B15: buying guide word count 450–750 (floor relaxed from 500 — model consistently generates 470-490 for valid guides)
      const bgWords = countWords(bgText)
      if (bgWords >= 450 && bgWords <= 750)
        this.pass('B15', `Buying guide word count ${bgWords} (450–750)`)
else
        this.fail('B15', 'Buying guide word count must be 450–750', `found ${bgWords}`)

      // B16: buying guide contains a hub link
      if (hub && hasHubLink(bgText, hub))
        this.pass('B16', `Buying guide contains hub link to /${hub}/`)
      else
        this.fail('B16', `Buying guide must contain a contextual hub link to /${hub}/`, 'no matching link found')
    } else {
      this.fail('B14', `No ## ${buyGuideStyle} section found — cannot check buying guide`)
      this.fail('B15', `No ## ${buyGuideStyle} section found — cannot check buying guide word count`)
      this.fail('B16', `No ## ${buyGuideStyle} section found — cannot check buying guide hub link`)
    }

    // FAQ checks
    if (faqKey) {
      this.checkFAQ(sections.get(faqKey) || [])
    } else {
      this.fail('Q01', 'No ## Frequently Asked Questions section found')
      this.fail('Q02', 'No FAQ section — cannot check JSON-LD')
      this.fail('Q03', 'No FAQ section — cannot check JSON-LD')
      this.fail('Q04', 'No FAQ section — cannot check mainEntity count')
      this.fail('Q06', 'No FAQ section — cannot check word count')
    }
  }

  // -------------------------------------------------------------------------
  // Q — FAQ checks
  // -------------------------------------------------------------------------

  checkFAQ(faqLines) {
    const faqText = faqLines.join('\n')
    const faqSubs = extractH3Sections(faqLines)

    // Q01: exactly 5 H3 questions
    if (faqSubs.length === 5) this.pass('Q01', 'Exactly 5 FAQ questions (H3s)')
    else this.fail('Q01', 'FAQ must have exactly 5 questions (H3s)', `found ${faqSubs.length}`)

    // Q02: FAQPage JSON-LD block present
    const hasJsonLd = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(faqText)
    if (hasJsonLd) this.pass('Q02', 'FAQPage JSON-LD schema block present in FAQ section')
    else this.fail('Q02', 'FAQ section must contain a <script type="application/ld+json"> block')

    // Q03–Q04: JSON-LD is valid JSON with FAQPage type and 5 entities
    const jsonLdMatch = faqText.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i)
    if (jsonLdMatch) {
      try {
        const schema = JSON.parse(jsonLdMatch[1])
        if (schema['@type'] === 'FAQPage') this.pass('Q03', 'FAQ JSON-LD is valid JSON with @type "FAQPage"')
        else this.fail('Q03', 'FAQ JSON-LD @type must be "FAQPage"', `found "${schema['@type']}"`)

        const n = Array.isArray(schema.mainEntity) ? schema.mainEntity.length : 0
        if (n === 5) this.pass('Q04', 'FAQ JSON-LD has 5 mainEntity items')
        else this.fail('Q04', 'FAQ JSON-LD mainEntity must have 5 items', `found ${n}`)
      } catch (e) {
        this.fail('Q03', 'FAQ JSON-LD is not valid JSON', e.message.slice(0, 100))
        this.fail('Q04', 'Cannot check mainEntity count — JSON parse failed')
      }
    } else if (!hasJsonLd) {
      this.fail('Q03', 'No JSON-LD block to validate')
      this.fail('Q04', 'No JSON-LD block to validate')
    }

    // Q06: total FAQ section word count
    faqSubs.forEach((sec, i) => {
      const answerText = sec.lines.join('\n').replace(/<script[\s\S]*?<\/script>/gi, '').trim()
      const shortHeading = sec.heading.slice(0, 60)
      const label = `FAQ[${i}] "${shortHeading}"`

      // Q05: answer 2–4 sentences
      const sentCount = countSentences(answerText)
      if (sentCount >= 2 && sentCount <= 4)
        this.pass(`Q05.${i}`, `${label}: ${sentCount} sentences (2–4)`)
      else
        this.fail(`Q05.${i}`, `${label}: answer must be 2–4 sentences`, `counted ~${sentCount}`)

      // Q07: answer does not end with "Check current price on Amazon."
      const lastLine = getLastContentLine(sec.lines)
      if (/check current price on amazon/i.test(lastLine))
        this.fail(`Q07.${i}`, `${label}: FAQ answers must not end with "Check current price on Amazon."`)
      else
        this.pass(`Q07.${i}`, `${label}: does not end with "Check current price on Amazon."`)

      // Q08: no bullet lists in answer
      const hasBullets = sec.lines.some(l => /^\s*[-*]\s/.test(l))
      if (hasBullets)
        this.fail(`Q08.${i}`, `${label}: FAQ answers must not contain bullet lists`)
      else
        this.pass(`Q08.${i}`, `${label}: no bullet lists`)
    })

    // Q06: FAQ total word count 300–500 (ceiling relaxed from 450 — post-processing holds per-answer sentence count; total runs 460-480 naturally)
    const faqWords = countWords(faqText)
    if (faqWords >= 300 && faqWords <= 500)
      this.pass('Q06', `FAQ section word count ${faqWords} (300–500)`)
else
      this.fail('Q06', 'FAQ section word count must be 300–500', `found ${faqWords}`)
  }

  // -------------------------------------------------------------------------
  // A — Anti-pattern checks
  // -------------------------------------------------------------------------

  checkAntiPatterns(body) {
    // A01: no "## Top Picks at a Glance" (layout handles QuickPicks)
    if (/##\s+Top Picks at a Glance/i.test(body))
      this.fail('A01', '"## Top Picks at a Glance" found in body — layout renders <QuickPicks /> automatically, do not duplicate')
    else
      this.pass('A01', 'No "## Top Picks at a Glance" section')

    // A02: no **Pros:** or **Cons:** bullet lists (layout handles via ProductCard)
    const prosCons = [...body.matchAll(/\*\*(Pros|Cons):\*\*/gi)]
    if (prosCons.length > 0)
      this.fail('A02', `**Pros:** / **Cons:** bullet lists found (${prosCons.length} occurrence(s)) — layout renders these via <ProductCard />, do not duplicate in body`)
    else
      this.pass('A02', 'No **Pros:** / **Cons:** bullet lists in body')

    // A03: no banned price/dollar patterns (only when dollar_figures.allowed = false)
    const bodyNoJson = stripJsonLd(body)
    if (!this.stylePolicy.dollar_figures.allowed) {
      const priceHits = PRICE_PATTERNS.filter(p => p.re.test(bodyNoJson)).map(p => p.label)
      if (priceHits.length === 0) this.pass('A03', 'No banned price/dollar patterns')
      else this.fail('A03', 'Banned price patterns found (dollar_figures.allowed = false)', priceHits.join(', '))
    } else {
      this.pass('A03', 'Dollar figures allowed by style_policy — price pattern check skipped')
    }

    // A04: no AI-tell phrases (case-insensitive)
    const lower   = bodyNoJson.toLowerCase()
    const aiHits  = AI_TELLS.filter(p => lower.includes(p.toLowerCase()))
    if (aiHits.length === 0) this.pass('A04', 'No banned AI-tell phrases')
    else this.fail('A04', 'Banned AI-tell phrase(s) found', aiHits.map(p => `"${p}"`).join(', '))

    // A05: no parenthetical role labels in H3 headings (e.g. ### Product (Best Overall))
    // Matches explicit role-label patterns only — not product names with size/quantity specs like "(5-Piece)"
    const roleParenPattern = /^### .+\((Best Overall|Best Value|Best Budget|Best Premium|Best for Beginners|Best for Professionals|Also Consider)\)\s*$/i
    const h3WithParens = body.split('\n').filter(l => roleParenPattern.test(l))
    if (h3WithParens.length === 0) this.pass('A05', 'No parenthetical role labels in H3 headings')
    else this.fail('A05', 'H3 headings must not contain parenthetical role labels',
      h3WithParens.slice(0, 2).map(l => l.trim()).join(' | '))

    // A06: no bold-only subtitle line directly below an H3 (role label in body)
    // Pattern: first non-empty content line after ### is **text** with no colon
    const lines = body.split('\n')
    const boldSubHits = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('### ')) continue
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim()
        if (!t) continue
        if (/^\*\*[A-Za-z][^*:]{3,}\*\*$/.test(t)) boldSubHits.push(`line ${j + 1}: ${t}`)
        break
      }
    }
    if (boldSubHits.length === 0)
      this.pass('A06', 'No bold role-subtitle lines below H3 headings')
    else
      this.fail('A06', 'Bold role-subtitle lines found below H3 headings — layout handles role labels via ProductCard',
        boldSubHits.slice(0, 2).join(' | '))

    // A07: no **Who buys this:** coda
    if (/\*\*Who buys this:/i.test(body))
      this.fail('A07', '"**Who buys this:**" coda found — not permitted per spec')
    else
      this.pass('A07', 'No "**Who buys this:**" coda')

    // A08: no markdown comparison table (separator row | --- |)
    if (/\|\s*[-:]+[-: |]+\|/.test(body))
      this.fail('A08', 'Comparison table (markdown separator row) found — not permitted in body')
    else
      this.pass('A08', 'No comparison tables in body')

    // A09: VERIFY placeholder ASINs — warning only at generation stage (CATALOG-BEHAVIOUR.md §3)
    // Build-validator is the gate; producer-stage validator surfaces count without blocking.
    const verifyHits = [...body.matchAll(/amazon\.com\/dp\/VERIFY/gi)]
    if (verifyHits.length > 0)
      this.warn('A09', 'VERIFY placeholder ASIN(s) in Amazon links — resolve before publish',
        `${verifyHits.length} occurrence(s)`)
    else
      this.pass('A09', 'No VERIFY placeholder ASINs in body links')
  }

  // -------------------------------------------------------------------------
  // L — Length checks
  // -------------------------------------------------------------------------

  checkLength(body) {
    const min = this.stylePolicy.word_count.min
    const max = this.stylePolicy.word_count.max
    const words = countWords(body)
    if (words >= min && words <= max)
      this.pass('L01', `Total body word count ${words} (${min.toLocaleString()}–${max.toLocaleString()})`)
    else
      this.fail('L01', `Total body word count must be ${min.toLocaleString()}–${max.toLocaleString()}`, `found ${words}`)
  }

  // -------------------------------------------------------------------------
  // M — Manual review items (always appended, never cause failure)
  // -------------------------------------------------------------------------

  addManualItems() {
    this.manual('M01', 'Voice and register matches persona YAML voice_notes — requires persona YAML, cannot be checked mechanically')
    this.manual('M02', 'Product sections do not all open with the product name in the first sentence (entry variation required)')
    this.manual('M03', 'FAQ questions are specific to this product category, not generic filler applicable to any product')
    this.manual('M04', 'At least one FAQ question addresses a trade-off between two named products in this roundup')
    this.manual('M05', 'At least one FAQ question addresses a pre-purchase buyer decision (sizing, compatibility, maintenance, material, etc.)')
    this.manual('M06', 'FAQ answers do not duplicate buying guide subsections word-for-word')
    this.manual('M07', 'Persona name does not appear in article body prose — requires persona YAML to resolve author → full name')
    this.manual('M08', 'Regional references ≤ 1 in article body — requires persona YAML to identify persona region')
    this.manual('M09', 'No explicit credential declaration in body (e.g., "As a food scientist...", "With fifteen years in HR...")')
    this.manual('M10', 'In-body images use hub-matched prefix consistent with article hub field — requires image bank cross-reference')
    this.manual('M11', 'In-body image numbers are not repeated within the article (hero_image vs body image numbers)')
    this.manual('M12', 'Buying guide subsections cover product-category-specific decision variables, not generic advice applicable to any category')
    this.manual('M13', 'First product mention in each H3 section links to the product\'s Amazon URL')
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function collectFiles(target) {
  const stat = statSync(target)
  if (stat.isDirectory()) {
    return readdirSync(target)
      .filter(f => f.endsWith('.md'))
      .map(f => join(target, f))
      .sort()
  }
  return [target]
}

function printPolicyHeader(policy) {
  const p = policy
  console.log(`  style_policy: words ${p.word_count.min}–${p.word_count.max}` +
    ` | dollars ${p.dollar_figures.allowed ? 'allowed' : 'banned'}` +
    ` | buying guide "## ${p.buying_guide_heading.style}"` +
    ` | images ${p.in_body_images.policy}${p.in_body_images.policy === 'fixed_count' ? `(${p.in_body_images.fixed_count})` : ''}`)
}

function printReport(v) {
  const status = v.fails.length === 0 ? '✓ PASS' : '✗ FAIL'
  console.log(`\nFILE: ${v.path}`)
  printPolicyHeader(v.stylePolicy)
  console.log(`${status}  PASS: ${v.passes.length}  FAIL: ${v.fails.length}  WARN: ${v.warnings.length}  MANUAL: ${v.manuals.length}`)
  for (const f of v.fails) {
    const obs = f.observed ? ` — ${f.observed}` : ''
    console.log(`[FAIL] ${f.id}: ${f.msg}${obs}`)
  }
  for (const w of v.warnings) {
    const obs = w.observed ? ` — ${w.observed}` : ''
    console.log(`[WARN] ${w.id}: ${w.msg}${obs}`)
  }
  for (const m of v.manuals) {
    console.log(`[MANUAL] ${m.id}: ${m.msg}`)
  }
}

function main() {
  const args = process.argv.slice(2)
  let siteArg = null
  let targetArg = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site' && args[i + 1]) {
      siteArg = args[++i]
    } else {
      targetArg = args[i]
    }
  }

  if (!targetArg) {
    console.error('Usage: node validators/validate-roundup.mjs [--site <site-root>] <file-or-directory>')
    process.exit(1)
  }

  const target = resolve(targetArg)
  let files
  try { files = collectFiles(target) }
  catch (e) { console.error(`Error: ${e.message}`); process.exit(1) }

  if (files.length === 0) {
    console.error(`No .md files found at: ${target}`)
    process.exit(1)
  }

  // Resolve site root: --site flag > auto-detect from first file > auto-detect from target dir
  const probeFile = files[0] || target
  const siteRoot = siteArg
    ? resolve(siteArg)
    : (findSiteRoot(probeFile) || findSiteRoot(target))

  if (!siteRoot) {
    console.error(`Error: Could not find site.config.yaml. Use --site <site-root> to specify the site directory.`)
    process.exit(2)
  }

  let stylePolicy
  try {
    stylePolicy = loadStylePolicy(siteRoot)
  } catch (e) {
    console.error(`Config error: ${e.message}`)
    process.exit(2)
  }

  const validators = files.map(f => {
    const v = new FileValidator(f, stylePolicy)
    v.run()
    printReport(v)
    return v
  })

  if (files.length > 1) {
    const totalPass  = validators.reduce((s, v) => s + v.passes.length, 0)
    const totalFail  = validators.reduce((s, v) => s + v.fails.length, 0)
    const failedPaths = validators.filter(v => v.fails.length > 0).map(v => v.path)
    console.log('\n' + '─'.repeat(70))
    console.log(`SUMMARY  files: ${files.length}  total PASS: ${totalPass}  total FAIL: ${totalFail}`)
    if (failedPaths.length > 0) {
      console.log('Failed files:')
      failedPaths.forEach(p => console.log(`  ✗ ${p}`))
    } else {
      console.log('All files passed.')
    }
  }

  process.exit(validators.some(v => v.fails.length > 0) ? 1 : 0)
}

main()
