/**
 * Parses ~/affiliate-platform/portfolio.yaml and returns the site registry.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const PLATFORM_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORTFOLIO_PATH = join(PLATFORM_ROOT, 'portfolio.yaml')

/**
 * @typedef {Object} SiteEntry
 * @property {string} slug
 * @property {string} domain
 * @property {string} persona
 * @property {string} tracking_id
 * @property {string} ga4_id
 * @property {string} cloudflare_project
 * @property {string} github_repo
 * @property {string} status
 * @property {string} launched
 * @property {string} [notes]
 */

/**
 * Returns all site entries from portfolio.yaml.
 * @returns {SiteEntry[]}
 */
export function loadPortfolio() {
  let raw
  try {
    raw = readFileSync(PORTFOLIO_PATH, 'utf-8')
  } catch {
    throw new Error(`Cannot read portfolio.yaml at ${PORTFOLIO_PATH}`)
  }
  const doc = yaml.load(raw)
  if (!doc?.sites || !Array.isArray(doc.sites)) {
    throw new Error('portfolio.yaml missing or malformed sites array')
  }
  return doc.sites
}

/**
 * Returns a single site entry by slug, or throws if not found.
 * @param {string} slug
 * @returns {SiteEntry}
 */
export function getSite(slug) {
  const sites = loadPortfolio()
  const site = sites.find(s => s.slug === slug)
  if (!site) throw new Error(`Site "${slug}" not found in portfolio.yaml`)
  return site
}
