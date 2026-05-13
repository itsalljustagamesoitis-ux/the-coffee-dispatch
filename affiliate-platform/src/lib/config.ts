import { readFileSync } from 'fs'
import { resolve } from 'path'
import yaml from 'js-yaml'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StylePolicy {
  word_count: {
    min: number
    max: number
  }
  dollar_figures: {
    allowed: boolean
  }
  buying_guide_heading: {
    style: 'How to Choose' | 'Buying Guide'
  }
  in_body_images: {
    policy: 'per_product' | 'fixed_count' | 'none'
    fixed_count: number | null
  }
}

export interface SiteConfig {
  site: {
    brand_name: string
    domain: string
    tagline: string
  }
  visual: {
    primary_color: string
    accent_color: string
    background_color: string
    font_headings: string
    font_body: string
    logo_paths: {
      favicon: string
      header_svg: string
      header_png: string
      footer_svg: string
      social_square: string
      open_graph_default: string
    }
  }
  persona: {
    config_path: string
  }
  affiliate: {
    amazon_tracking_id: string
    awin_publisher_id: string
    awin_clickref_pattern: string
  }
  analytics: {
    ga4_measurement_id: string | null
    bing_uet_tag: string | null
  }
  images: {
    base_url: string
  }
  deployment: {
    cloudflare_pages_project: string
  }
  style_policy: StylePolicy
}

export interface PersonaConfig {
  name_formal: string
  name_used: string
  photo_byline: string
  photo_about: string
  location: string
  background: string
  bio_short: string
  bio_full: string
  voice_notes: string
  social?: {
    pinterest?: string | null
    instagram?: string | null
  }
}

export interface ProductRecord {
  name?: string | null
  title?: string | null
  brand?: string | null
  asin?: string | null
  amazon_asin?: string | null
  awin_advertiser_id?: number | null
  awin_product_url?: string | null
  default_image: string
  category: string
  price_band: 'budget' | 'mid' | 'premium'
  default_pros: string[]
  default_cons: string[]
  notes_for_writers?: string
  last_verified?: string
  current_price?: string | null
}

export type ProductDatabase = Record<string, ProductRecord>

export interface NavHub {
  label: string
  slug: string
  description?: string
}

export interface NavCategory {
  label: string
  slug: string
  hubs: NavHub[]
}

export interface NavConfig {
  categories: NavCategory[]
}

// ── Loaders (run at build time) ───────────────────────────────────────────────

function loadYaml<T>(relativePath: string): T {
  const abs = resolve(process.cwd(), relativePath)
  return yaml.load(readFileSync(abs, 'utf8')) as T
}

let _siteConfig: SiteConfig | null = null
let _persona: PersonaConfig | null = null
let _products: ProductDatabase | null = null
let _nav: NavConfig | null = null

export function getSiteConfig(): SiteConfig {
  if (!_siteConfig) {
    _siteConfig = loadYaml<SiteConfig>('site.config.yaml')
    if (!_siteConfig.style_policy) {
      throw new Error('style_policy block missing in site.config.yaml')
    }
  }
  return _siteConfig
}

export function getPersona(): PersonaConfig {
  if (!_persona) {
    const cfg = getSiteConfig()
    _persona = loadYaml<PersonaConfig>(cfg.persona.config_path)
  }
  return _persona
}

export function getProducts(): ProductDatabase {
  if (!_products) _products = loadYaml<ProductDatabase>('content/products/products.yaml')
  return _products
}

export function getNav(): NavConfig {
  if (!_nav) _nav = loadYaml<NavConfig>('config/navigation.yaml')
  return _nav
}

export function getHubLabel(hubSlug: string): string {
  const nav = getNav()
  for (const cat of nav.categories) {
    if (cat.slug === hubSlug) return cat.label
    const hub = cat.hubs?.find(h => h.slug === hubSlug)
    if (hub) return hub.label
  }
  return hubSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function getCategoryLabel(categorySlug: string): string {
  const nav = getNav()
  const cat = nav.categories.find(c =>
    c.slug === categorySlug ||
    c.slug === categorySlug.toLowerCase().replace(/\s+/g, '-')
  )
  return cat?.label ?? categorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function getCategorySlug(categoryLabel: string): string {
  const nav = getNav()
  const cat = nav.categories.find(c =>
    c.label === categoryLabel ||
    c.label.toLowerCase() === categoryLabel.toLowerCase()
  )
  return cat?.slug ?? categoryLabel.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

// ── Affiliate URL generation (build-time only) ────────────────────────────────

export function buildAffiliateUrl(
  productId: string,
  articleSlug: string,
): string | null {
  const db = getProducts()
  const cfg = getSiteConfig()
  const product = db[productId]
  if (!product) return null

  const { awin_advertiser_id, awin_product_url } = product
  const amazon_asin = product.amazon_asin ?? product.asin ?? null
  const { awin_publisher_id, awin_clickref_pattern } = cfg.affiliate
  // AMAZON_TAG env var overrides site.config.yaml — set per-clone in Cloudflare Pages
  const amazon_tracking_id = import.meta.env.AMAZON_TAG ?? cfg.affiliate.amazon_tracking_id

  if (awin_advertiser_id && awin_product_url) {
    const clickref = `${awin_clickref_pattern}-${articleSlug}`
    const url = new URL(awin_product_url)
    url.searchParams.set('awc', `${awin_advertiser_id}_${Date.now()}`)
    return `https://www.awin1.com/cread.php?awinmid=${awin_advertiser_id}&awinaffid=${awin_publisher_id}&clickref=${encodeURIComponent(clickref)}&ued=${encodeURIComponent(awin_product_url)}`
  }

  if (amazon_asin && amazon_asin !== 'NOT_ON_AMAZON' && amazon_asin !== 'NOT_FOUND' && amazon_asin !== 'VERIFY') {
    return `https://www.amazon.com/dp/${amazon_asin}?tag=${amazon_tracking_id}`
  }

  return null
}

// ── Resolve product for an article product ref ────────────────────────────────

export interface ResolvedProduct {
  id: string
  name: string
  brand: string
  image: string | null
  price_band: string
  pros: string[]
  cons: string[]
  affiliate_url: string | null
  role?: string
}

export function resolveProduct(
  ref: { id: string; role?: string; article_specific_pros?: string[]; article_specific_cons?: string[] },
  articleSlug: string,
): ResolvedProduct | null {
  const db = getProducts()
  const product = db[ref.id]
  if (!product) {
    console.warn(`[products] Unknown product ID: ${ref.id}`)
    return null
  }

  const name = product.name ?? product.title ?? ref.id
  const brand = product.brand ?? null
  const asin = product.amazon_asin ?? product.asin ?? null
  return {
    id: ref.id,
    name,
    brand,
    image: product.default_image,
    price_band: product.price_band,
    pros: ref.article_specific_pros ?? product.default_pros,
    cons: ref.article_specific_cons ?? product.default_cons,
    affiliate_url: buildAffiliateUrl(ref.id, articleSlug),
    role: ref.role,
  }
}

/** Return a display name that never repeats the brand prefix. */
export function productDisplayName(product: { brand: string | null; name: string | null }): string {
  const name = product.name ?? ''
  if (!product.brand) return name
  return name.toLowerCase().startsWith(product.brand.toLowerCase())
    ? name
    : `${product.brand} ${name}`
}
