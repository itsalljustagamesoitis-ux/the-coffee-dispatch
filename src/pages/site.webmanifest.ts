import type { APIRoute } from 'astro'
import { getSiteConfig } from '@platform/core/src/lib/config'

export const GET: APIRoute = () => {
  const cfg = getSiteConfig()
  const manifest = {
    name: cfg.site.brand_name,
    short_name: cfg.site.brand_name.split(' ').slice(-2).join(' '),
    icons: [
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: '/favicon.ico', sizes: '32x32', type: 'image/x-icon' },
    ],
    theme_color: cfg.visual.primary_color,
    background_color: cfg.visual.background_color,
    display: 'browser',
  }
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { 'Content-Type': 'application/manifest+json' },
  })
}
