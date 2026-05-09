import rss from '@astrojs/rss'
import { getCollection } from 'astro:content'
import { getSiteConfig } from '@platform/core/src/lib/config'

export async function GET(context) {
  const cfg = getSiteConfig()
  const articles = await getCollection('articles')
  const sorted = articles.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())

  return rss({
    title: cfg.site.brand_name,
    description: cfg.site.tagline,
    site: context.site,
    items: sorted.map(article => ({
      title: article.data.title,
      pubDate: article.data.date,
      description: article.data.description,
      link: `/${article.data.slug}/`,
    })),
  })
}
