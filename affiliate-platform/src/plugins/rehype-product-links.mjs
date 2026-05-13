/**
 * rehype-product-links.mjs
 *
 * Rehype plugin that resolves product:slug URLs in article bodies.
 *
 * Markdown: [anchor text](product:staub-cocotte-7qt)
 * Renders as: <a href="https://www.amazon.com/dp/B000RWGAYG?tag=...">anchor text</a>
 *   OR for NOT_ON_AMAZON: <span data-product="..." data-unavailable="true">anchor text</span>
 *
 * Runs during the Astro markdown/content pipeline, before rehypeExternalLinks.
 * rehypeExternalLinks then adds rel="sponsored noopener" to the resolved amazon.com links.
 *
 * Usage in astro.config.mjs:
 *   import { rehypeProductLinks } from '@platform/core/src/plugins/rehype-product-links.mjs'
 *   markdown: { rehypePlugins: [rehypeProductLinks, [rehypeExternalLinks, {...}]] }
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import yaml from 'js-yaml'

let _products = null
let _tag = null

function getProducts() {
  if (!_products) {
    const path = resolve(process.cwd(), 'content/products/products.yaml')
    _products = yaml.load(readFileSync(path, 'utf8'))
  }
  return _products
}

function getAmazonTag() {
  if (_tag !== null) return _tag
  if (process.env.AMAZON_TAG) { _tag = process.env.AMAZON_TAG; return _tag }
  try {
    const cfg = yaml.load(readFileSync(resolve(process.cwd(), 'site.config.yaml'), 'utf8'))
    _tag = cfg?.affiliate?.amazon_tracking_id ?? ''
  } catch { _tag = '' }
  return _tag
}

function resolveProductUrl(product, slug) {
  const { amazon_asin, awin_advertiser_id, awin_product_url } = product

  if (awin_advertiser_id && awin_product_url) {
    // Return the base AWIN product URL — awin clickref requires article context we don't have here.
    // Full clickref tracking is handled by ProductCard (Astro component) in layout templates.
    return awin_product_url
  }

  if (amazon_asin && amazon_asin !== 'NOT_ON_AMAZON') {
    const tag = getAmazonTag()
    return `https://www.amazon.com/dp/${amazon_asin}${tag ? `?tag=${tag}` : ''}`
  }

  return null
}

function visitNode(node, parent, index) {
  if (
    node.type === 'element' &&
    node.tagName === 'a' &&
    typeof node.properties?.href === 'string' &&
    node.properties.href.startsWith('product:')
  ) {
    const products = getProducts()
    const productSlug = node.properties.href.slice('product:'.length)
    const product = products[productSlug]

    if (!product) {
      throw new Error(
        `[rehypeProductLinks] Unknown product slug: "${productSlug}". ` +
        `Add this slug to content/products/products.yaml before building.`
      )
    }

    const url = resolveProductUrl(product, productSlug)

    if (url) {
      node.properties.href = url
      node.properties['data-product'] = productSlug
      // rel/target added by rehypeExternalLinks for amazon.com URLs — don't duplicate
    } else {
      // NOT_ON_AMAZON: strip link, render anchor text as plain <span>
      node.tagName = 'span'
      const { href, ...rest } = node.properties
      node.properties = { ...rest, 'data-product': productSlug, 'data-unavailable': 'true' }
    }
    return
  }

  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      visitNode(node.children[i], node, i)
    }
  }
}

export function rehypeProductLinks() {
  return function transformer(tree) {
    visitNode(tree, null, null)
  }
}
