// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import rehypeExternalLinks from 'rehype-external-links'
import { rehypeProductLinks } from '@platform/core/src/plugins/rehype-product-links.mjs'
import { readFileSync } from 'fs'
import yaml from 'js-yaml'
import { makeLastmod } from '@platform/core/src/lib/sitemap-lastmod.mjs'

const _lastmodFor = makeLastmod()
const _cfg = yaml.load(readFileSync('./site.config.yaml', 'utf8'))

// Per-article lastmod map — slug → ISO date string
const _articleDates = {}
try {
  const _artDir = './content/articles'
  for (const _f of readdirSync(_artDir)) {
    if (!_f.endsWith('.md')) continue
    const _raw = readFileSync(`${_artDir}/${_f}`, 'utf8')
    const _fm = _raw.match(/^---\n([\s\S]*?)\n---/)
    if (!_fm) continue
    const _slug = (_fm[1].match(/^slug:\s*["']?([^"'\n]+)/m) ?? [])[1]?.trim()
    const _upd  = (_fm[1].match(/^updated:\s*["']?([^"'\n]+)/m) ?? [])[1]?.trim()
    const _dt   = (_fm[1].match(/^date:\s*["']?([^"'\n]+)/m) ?? [])[1]?.trim()
    if (_slug) _articleDates[_slug] = _upd ?? _dt
  }
} catch {}

if (!process.env.SITE_URL && !_cfg?.site?.domain) {
  throw new Error('Build error: set SITE_URL env var or site.config.yaml site.domain')
}

const siteUrl = process.env.SITE_URL ?? `https://${_cfg.site.domain}`

const isCloudflareProduction = process.env.CF_PAGES === '1' && process.env.CF_PAGES_BRANCH === 'main'

if (!process.env.GOOGLE_SITE_VERIFICATION) {
  // DNS TXT verification is equally valid — warn only, never throw
  console.warn('\x1b[33m⚠ GOOGLE_SITE_VERIFICATION not set — GSC meta tag will not render (fine if using DNS verification)\x1b[0m')
}
if (!process.env.BING_SITE_VERIFICATION) {
  const msg = '⚠ BING_SITE_VERIFICATION not set — Bing meta tag will not render'
  if (isCloudflareProduction) throw new Error(msg)
  else console.warn('\x1b[33m' + msg + '\x1b[0m')
}

export default defineConfig({
  site: siteUrl,
  integrations: [
    sitemap({
      filter: (page) => !page.endsWith('/privacy/'),
      serialize(item) {
        const _slug = item.url.replace(/\/$/, '').split('/').pop() ?? ''
        item.lastmod = _lastmodFor(item.url)
        // Prioritise homepage and category pages
        if (item.url === `${siteUrl}/`) {
          item.changefreq = 'weekly'
          item.priority = 1.0
        } else if (!item.url.includes('.')) {
          item.changefreq = 'monthly'
          item.priority = 0.8
        }
        return item
      },
    }),
  ],
  markdown: {
    rehypePlugins: [
      rehypeProductLinks,
      [rehypeExternalLinks, {
        rel: ['nofollow', 'sponsored'],
        target: '_blank',
        test: (node) => {
          const href = node.properties?.href ?? ''
          return typeof href === 'string' && href.includes('amazon.com')
        },
      }],
    ],
  },
  image: {
    service: {
      entrypoint: 'astro/assets/services/sharp',
    },
  },
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    optimizeDeps: {
      exclude: ['sharp'],
    },
  },
})
