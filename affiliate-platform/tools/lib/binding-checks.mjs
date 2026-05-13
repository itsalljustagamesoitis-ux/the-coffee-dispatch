/**
 * binding-checks.mjs — Core Cloudflare Pages binding verification logic.
 *
 * Exports resolveArticleUrls, verifyTagInLiveHtml, and runChecks.
 * All functions return structured data — no terminal output.
 */

import { resolve } from 'dns/promises'
import { getProject, getCustomDomains, getEnvVars } from './cloudflare-api.mjs'

/**
 * @typedef {{ id: number, name: string, status: 'pass'|'fail'|'warn'|'skip', details: string }} CheckResult
 */

/**
 * Resolves up to `limit` candidate article URLs for a domain.
 * Strategy (in order):
 *   1. sitemap-articles.xml
 *   2. sitemap-index.xml → first child sitemap (prefer one named "article")
 *   3. sitemap-0.xml (Astro default)
 *   4. Homepage scrape filtered to slugs with ≥3 hyphens (article-shaped)
 *
 * @param {string} domain
 * @param {number} [limit=5]
 * @returns {Promise<string[]>}
 */
export async function resolveArticleUrls(domain, limit = 5) {
  const SKIP = /\/(about|contact|privacy|cookie|terms|search|sitemap|affiliate|affiliate-disclosure|category|tag|feed)\/?$/
  const base = `https://${domain}`

  const parseLocs = (xml) =>
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(m => m[1].trim())
      .filter(u => !SKIP.test(u) && u !== `${base}/`)

  const tryFetch = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
      return r.ok ? r.text() : null
    } catch { return null }
  }

  // 1. sitemap-articles.xml
  let xml = await tryFetch(`${base}/sitemap-articles.xml`)
  if (xml) {
    const locs = parseLocs(xml)
    if (locs.length) return locs.slice(0, limit)
  }

  // 2. sitemap-index.xml → child sitemap
  xml = await tryFetch(`${base}/sitemap-index.xml`)
  if (xml) {
    const childUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim())
    const preferred = childUrls.find(u => u.includes('article')) ?? childUrls[0]
    if (preferred) {
      const childXml = await tryFetch(preferred)
      if (childXml) {
        const locs = parseLocs(childXml)
        if (locs.length) return locs.slice(0, limit)
      }
    }
  }

  // 3. sitemap-0.xml (Astro default)
  xml = await tryFetch(`${base}/sitemap-0.xml`)
  if (xml) {
    const locs = parseLocs(xml)
    if (locs.length) return locs.slice(0, limit)
  }

  // 4. Fallback: homepage scrape, ≥3 hyphens = article-shaped slug
  const homeHtml = await tryFetch(`${base}/`)
  if (homeHtml) {
    const links = [...homeHtml.matchAll(/href="(\/[a-z0-9][a-z0-9-]+\/)"/g)]
      .map(m => m[1])
      .filter(p => !SKIP.test(p) && (p.match(/-/g) ?? []).length >= 3)
    if (links.length) return links.slice(0, limit).map(p => `${base}${p}`)
  }

  return []
}

/**
 * Walks up to 5 candidate article URLs until one has Amazon affiliate links,
 * then checks whether the expected tracking tag is present.
 *
 * @param {string} domain
 * @param {string} expectedTag
 * @returns {Promise<{found: boolean, foundOther: string|null, url: string|null, sampled: number}>}
 */
export async function verifyTagInLiveHtml(domain, expectedTag) {
  try {
    const candidates = await resolveArticleUrls(domain, 5)
    if (!candidates.length) return { found: false, foundOther: null, url: null, sampled: 0 }

    for (const articleUrl of candidates) {
      let html
      try {
        const res = await fetch(articleUrl, { signal: AbortSignal.timeout(10000) })
        html = await res.text()
      } catch { continue }

      const tagMatches = [...html.matchAll(/amazon\.com[^"']*[?&]tag=([a-z0-9-]+)/gi)]
        .map(m => m[1])

      if (!tagMatches.length) continue  // no Amazon links — try next

      if (tagMatches.includes(expectedTag)) {
        return { found: true, foundOther: null, url: articleUrl, sampled: candidates.indexOf(articleUrl) + 1 }
      }
      const unique = [...new Set(tagMatches)]
      return { found: false, foundOther: unique[0], url: articleUrl, sampled: candidates.indexOf(articleUrl) + 1 }
    }

    // Walked all candidates — none had Amazon links
    return { found: false, foundOther: null, url: candidates[0], sampled: candidates.length }
  } catch {
    return { found: false, foundOther: null, url: null, sampled: 0 }
  }
}

/**
 * Runs all 8 binding checks for one site.
 *
 * @param {import('./portfolio.mjs').SiteEntry} site
 * @param {string[]} allGa4Ids  — all GA4 IDs across portfolio (for uniqueness check)
 * @param {string} token
 * @returns {Promise<CheckResult[]>}
 */
export async function runChecks(site, allGa4Ids, token, opts = {}) {
  const { skipLiveHtml = false } = opts
  const results = []

  const check = (id, name, status, details) => results.push({ id, name, status, details })

  // Fetch project data upfront — if this fails, emit tool error and return
  let project, domains, envVars
  try {
    ;[project, domains, envVars] = await Promise.all([
      getProject(token, site.cloudflare_project),
      getCustomDomains(token, site.cloudflare_project),
      getEnvVars(token, site.cloudflare_project),
    ])
  } catch (err) {
    check(0, 'Cloudflare API reachable', 'fail', err.message)
    return results
  }

  // 1. Project name matches slug
  if (project.name === site.slug) {
    check(1, 'Project name matches slug', 'pass', project.name)
  } else {
    check(1, 'Project name matches slug', 'fail',
      `expected ${site.slug}, got ${project.name}`)
  }

  // 2. GitHub repo matches (skip if direct_upload)
  const sourceType = project.source?.type
  if (!sourceType || sourceType === 'direct_upload') {
    check(2, 'GitHub repo matches', 'warn',
      `project source type is "${sourceType ?? 'none'}" — cannot verify repo (Direct Upload project)`)
  } else {
    const cfg = project.source?.config ?? {}
    const actual = `${cfg.owner}/${cfg.repo_name}`
    if (actual === site.github_repo) {
      check(2, 'GitHub repo matches', 'pass', actual)
    } else {
      check(2, 'GitHub repo matches', 'fail',
        `expected ${site.github_repo}, got ${actual}`)
    }
  }

  // 3. Custom domain matches
  const domainNames = (domains ?? []).map(d => d.name)
  if (domainNames.includes(site.domain)) {
    check(3, 'Custom domain matches', 'pass', site.domain)
  } else {
    check(3, 'Custom domain matches', 'fail',
      `expected ${site.domain}, configured: [${domainNames.join(', ') || 'none'}]`)
  }

  // 4. AMAZON_TAG production — secrets have type "secret_text" and empty value
  const prodBinding = envVars.production.AMAZON_TAG
  if (skipLiveHtml) {
    check(4, 'AMAZON_TAG Production', 'skip', 'live HTML check skipped (run with --full)')
  } else if (!prodBinding) {
    // Not configured as env var — may fall back to site.config.yaml. Verify via live HTML.
    const liveResult = await verifyTagInLiveHtml(site.domain, site.tracking_id)
    if (liveResult.found) {
      check(4, 'AMAZON_TAG Production', 'pass',
        `AMAZON_TAG not set in CF env — verified correct tag via site.config.yaml fallback (${liveResult.url})`)
    } else if (liveResult.foundOther) {
      check(4, 'AMAZON_TAG Production', 'fail',
        `AMAZON_TAG not set in CF env — live site rendering wrong tag: expected ${site.tracking_id}, found ${liveResult.foundOther} (${liveResult.url})`)
    } else {
      check(4, 'AMAZON_TAG Production', 'warn',
        `AMAZON_TAG not configured in CF env; live HTML check inconclusive — no Amazon links in ${liveResult.sampled} sampled article(s) (${liveResult.url ?? 'fetch failed'})`)
    }
  } else if (prodBinding.type === 'secret_text') {
    // Value is encrypted — verify via live rendered HTML
    const liveResult = await verifyTagInLiveHtml(site.domain, site.tracking_id)
    if (liveResult.found) {
      check(4, 'AMAZON_TAG Production', 'pass',
        `AMAZON_TAG verified via rendered HTML — sampled ${liveResult.sampled} article(s), found tag at ${liveResult.url}`)
    } else if (liveResult.foundOther) {
      check(4, 'AMAZON_TAG Production', 'fail',
        `AMAZON_TAG configured but live site rendering different tag — expected ${site.tracking_id}, found ${liveResult.foundOther} at ${liveResult.url}`)
    } else {
      check(4, 'AMAZON_TAG Production', 'warn',
        `AMAZON_TAG configured as secret; live HTML check inconclusive — no Amazon links in ${liveResult.sampled} sampled article(s) (${liveResult.url ?? 'fetch failed'})`)
    }
  } else {
    // Plain text var — compare value directly
    if (prodBinding.value === site.tracking_id) {
      check(4, 'AMAZON_TAG Production', 'pass', prodBinding.value)
    } else {
      check(4, 'AMAZON_TAG Production', 'fail',
        `expected ${site.tracking_id}, got ${prodBinding.value}`)
    }
  }

  // 5. AMAZON_TAG preview — presence check only (preview deploys not fetched)
  const previewBinding = envVars.preview.AMAZON_TAG
  if (!previewBinding) {
    check(5, 'AMAZON_TAG Preview', 'fail',
      'AMAZON_TAG secret not configured on Preview')
  } else if (previewBinding.type === 'secret_text') {
    check(5, 'AMAZON_TAG Preview', 'pass',
      'AMAZON_TAG configured on Preview (value not verifiable — encrypted secret)')
  } else {
    if (previewBinding.value === site.tracking_id) {
      check(5, 'AMAZON_TAG Preview', 'pass', previewBinding.value)
    } else {
      check(5, 'AMAZON_TAG Preview', 'fail',
        `expected ${site.tracking_id}, got ${previewBinding.value}`)
    }
  }

  // 6. GA4 ID unique across portfolio
  const duplicates = allGa4Ids.filter(id => id === site.ga4_id)
  if (duplicates.length <= 1) {
    check(6, 'GA4 ID unique across portfolio', 'pass', site.ga4_id)
  } else {
    check(6, 'GA4 ID unique across portfolio', 'fail',
      `${site.ga4_id} appears ${duplicates.length} times in portfolio.yaml`)
  }

  // 7. IndexNow key reachable
  const indexNowBinding = envVars.production.INDEXNOW_KEY
  // Secret bindings have value "" — the actual key is not retrievable; skip reachability
  const indexNowKey = indexNowBinding?.type === 'plain_text' ? indexNowBinding.value : null
  const indexNowConfigured = !!indexNowBinding
  if (!indexNowConfigured) {
    check(7, 'IndexNow key reachable', 'warn',
      'INDEXNOW_KEY not configured in Cloudflare env — skipping reachability check')
  } else if (!indexNowKey) {
    // Configured as encrypted secret — key value not retrievable, skip URL test
    check(7, 'IndexNow key reachable', 'warn',
      'INDEXNOW_KEY configured as encrypted secret — key value not retrievable, skipping reachability check')
  } else {
    const keyUrl = `https://${site.domain}/${indexNowKey}.txt`
    try {
      const res = await fetch(keyUrl, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        check(7, 'IndexNow key reachable', 'pass', `${keyUrl} → ${res.status}`)
      } else {
        check(7, 'IndexNow key reachable', 'fail',
          `${keyUrl} → ${res.status}`)
      }
    } catch (err) {
      check(7, 'IndexNow key reachable', 'fail', `${keyUrl} — ${err.message}`)
    }
  }

  // 8. DNS resolves to Cloudflare Pages target
  try {
    const records = await resolve(site.domain, 'CNAME').catch(() => [])
    const aRecords = await resolve(site.domain, 'A').catch(() => [])
    const allRecords = [...records, ...aRecords]
    const cfTarget = records.some(r => r.includes('pages.dev') || r.includes('cloudflare'))
    // Cloudflare proxied A records land on known CF IP ranges (198.41.x, 104.x, etc.)
    const cfIpLike = aRecords.some(ip => ip.startsWith('198.41.') || ip.startsWith('104.') || ip.startsWith('172.'))
    if (cfTarget || cfIpLike) {
      check(8, 'DNS resolves to Cloudflare', 'pass',
        allRecords.slice(0, 2).join(', '))
    } else if (allRecords.length > 0) {
      check(8, 'DNS resolves to Cloudflare', 'warn',
        `resolves but target not clearly Cloudflare: ${allRecords.slice(0, 2).join(', ')}`)
    } else {
      check(8, 'DNS resolves to Cloudflare', 'fail', 'no DNS records found')
    }
  } catch (err) {
    check(8, 'DNS resolves to Cloudflare', 'fail', `DNS lookup error: ${err.message}`)
  }

  return results
}
