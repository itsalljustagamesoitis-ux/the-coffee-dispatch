/**
 * amazon-search.mjs — Provider-agnostic Amazon product search via web scraping.
 *
 * Exports:
 *   searchAmazon(query, options) → Promise<ProductResult[]>
 *   getProduct(asin)             → Promise<ProductResult>
 *
 * Rate-limit strategy: sequential with 1.5-3s jitter, single retry on 503/captcha.
 * RateLimitError is thrown for caller to decide whether to abort the run.
 */

import { load } from 'cheerio'

// ── User-Agent rotation ───────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

let uaIndex = Math.floor(Math.random() * USER_AGENTS.length)
const nextUA = () => { uaIndex = (uaIndex + 1) % USER_AGENTS.length; return USER_AGENTS[uaIndex] }

// ── Error types ───────────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(msg) { super(msg); this.name = 'RateLimitError' }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))
const jitter = (min, max) => min + Math.random() * (max - min)

function baseHeaders() {
  return {
    'User-Agent': nextUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
  }
}

function detectBlock(html) {
  if (!html || html.length < 500) return true
  const lower = html.toLowerCase()
  // Meta-refresh redirect: Amazon's soft rate-limit response (~2KB, no real content)
  if (html.length < 10_000 && lower.includes('http-equiv="refresh"')) return true
  return lower.includes('robot check') ||
    lower.includes('enter the characters you see below') ||
    lower.includes('captcha') ||
    lower.includes('api.solvemedia.com') ||
    lower.includes('automated access')
}

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const wait = jitter(30_000, 60_000)
      await sleep(wait)
    }

    let res
    try {
      res = await fetch(url, {
        headers: baseHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      if (attempt === 0) continue
      throw new Error(`Fetch error: ${err.message}`)
    }

    if (res.status === 503 || res.status === 429) {
      if (attempt === 0) continue
      throw new RateLimitError(`Amazon returned ${res.status} after retry — cooling off required`)
    }

    const html = await res.text()

    if (detectBlock(html)) {
      if (attempt === 0) continue
      throw new RateLimitError('Amazon CAPTCHA/bot-detection page encountered — cooling off required')
    }

    return html
  }
  throw new Error('fetchWithRetry: exhausted attempts')
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parsePrice(text) {
  if (!text) return null
  const m = text.match(/\$[\d,]+\.?\d{0,2}/)
  return m ? m[0] : null
}

function parseRating(text) {
  if (!text) return null
  const m = text.match(/([\d.]+)\s*out of\s*5/)
  return m ? parseFloat(m[1]) : null
}

function parseReviewCount(text) {
  if (!text) return null
  const m = text.replace(/,/g, '').match(/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

function asinFromUrl(url) {
  if (!url) return null
  const m = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)
  return m ? m[1] : null
}

// ── Search result parser ──────────────────────────────────────────────────────

function parseSearchResults(html, maxResults) {
  const $ = load(html)
  const results = []
  const seen = new Set()

  $('[data-component-type="s-search-result"]').each((_, el) => {
    if (results.length >= maxResults) return false

    const $el  = $(el)
    const asin = $el.attr('data-asin')
    if (!asin || asin.length !== 10 || seen.has(asin)) return
    seen.add(asin)

    const titleEl = $el.find('h2 a span, h2 span').first()
    const title   = titleEl.text().trim()
    if (!title) return

    // Always build productUrl from ASIN — href scraping is fragile
    const productUrl = `https://www.amazon.com/dp/${asin}`

    const priceWhole = $el.find('.a-price-whole').first().text().replace(/[^0-9]/g, '')
    const priceFrac  = $el.find('.a-price-fraction').first().text().replace(/[^0-9]/g, '')
    const price      = priceWhole ? `$${priceWhole}${priceFrac ? `.${priceFrac}` : ''}` : null

    const ratingText  = $el.find('.a-icon-alt').first().text()
    const rating      = parseRating(ratingText)

    const reviewText  = $el.find('[aria-label*="ratings"]').first().attr('aria-label') ??
                        $el.find('.a-size-base.s-underline-text').first().text()
    const reviewCount = parseReviewCount(reviewText)

    const imageUrl = $el.find('img.s-image').first().attr('src') ?? null

    // Brand is in a dedicated byline span, distinct from title — skip if it looks like title
    const brandRaw = $el.find('.a-size-base-plus.a-color-base').first().text().trim()
    const brand    = brandRaw && brandRaw !== title && brandRaw.split(' ').length <= 5 &&
                     !/amazon'?s choice|overall pick|best seller/i.test(brandRaw) ? brandRaw : null

    const isPrime   = $el.find('[aria-label="Amazon Prime"]').length > 0
    const sponsored = $el.find('.s-sponsored-label-info-icon, [data-component-type="sp-sponsored-result"]').length > 0

    results.push({ asin, title, brand, price, rating, reviewCount, imageUrl, productUrl, isPrime, sponsored })
  })

  return results
}

// ── Product detail parser ─────────────────────────────────────────────────────

function parseProductPage(html, asin) {
  const $ = load(html)

  const title = $('#productTitle').text().trim() || null

  const priceText = $('#priceblock_ourprice, #priceblock_dealprice, .a-price .a-offscreen, #price_inside_buybox')
    .first().text().trim()
  const price = parsePrice(priceText)

  const ratingText = $('#acrPopover').attr('title') ?? $('[data-hook="average-star-rating"] span').first().text()
  const rating = parseRating(ratingText)

  const reviewText = $('#acrCustomerReviewText').text()
  const reviewCount = parseReviewCount(reviewText)

  const imageUrl = $('#landingImage, #imgBlkFront').attr('src') ?? null

  const brand = $('#bylineInfo, #brand').first().text().replace(/^(Visit the |Brand: )/i, '').trim() || null

  const isPrime = $('[aria-label="Amazon Prime"]').length > 0

  const description = $('#productDescription p, #feature-div .a-list-item').first().text().trim() || null

  const features = []
  $('#feature-bullets .a-list-item').each((_, el) => {
    const t = $(el).text().trim()
    if (t) features.push(t)
  })

  const productUrl = `https://www.amazon.com/dp/${asin}`

  return {
    asin,
    title,
    brand,
    price,
    rating,
    reviewCount,
    imageUrl,
    productUrl,
    isPrime,
    sponsored: false,
    description: description || null,
    features: features.length ? features.slice(0, 6) : [],
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search Amazon for products matching a query.
 *
 * @param {string} query
 * @param {{maxResults?: number, sortBy?: 'relevance'|'rating'}} [options]
 * @returns {Promise<Array<{asin,title,brand,price,rating,reviewCount,imageUrl,productUrl,isPrime,sponsored}>>}
 */
export async function searchAmazon(query, options = {}) {
  const { maxResults = 10, sortBy = 'relevance' } = options
  const sort = sortBy === 'rating' ? '&s=review-rank' : ''
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&ref=nb_sb_noss${sort}`

  const html = await fetchWithRetry(url)
  const results = parseSearchResults(html, maxResults)

  // Polite inter-request delay
  await sleep(jitter(1_500, 3_000))

  return results
}

/**
 * Fetch product details for a known ASIN.
 *
 * @param {string} asin
 * @returns {Promise<{asin,title,brand,price,rating,reviewCount,imageUrl,productUrl,isPrime,sponsored,description?,features?}>}
 */
export async function getProduct(asin) {
  const url = `https://www.amazon.com/dp/${asin}`
  const html = await fetchWithRetry(url)
  const result = parseProductPage(html, asin)
  await sleep(jitter(1_500, 3_000))
  return result
}
