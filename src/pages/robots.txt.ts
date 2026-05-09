import { getSiteConfig } from '@platform/core/src/lib/config'

export async function GET() {
  const cfg = getSiteConfig()
  const domain = import.meta.env.SITE_URL ?? `https://${cfg.site.domain}`
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${domain}/sitemap-index.xml\n`
  return new Response(body, { headers: { 'Content-Type': 'text/plain' } })
}
