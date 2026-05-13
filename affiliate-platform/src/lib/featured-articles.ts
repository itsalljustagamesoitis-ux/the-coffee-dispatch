/**
 * Hub-distributed homepage article selection.
 *
 * Groups articles by hub, samples perHub articles per hub (shuffled),
 * then shuffles the flattened result and caps at maxTotal.
 * Randomness happens at Astro build time — each build produces a new selection.
 */

interface ArticleLike {
  data: {
    hub: string
    draft?: boolean
    [key: string]: unknown
  }
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface FeaturedOptions {
  perHub?: number
  maxTotal?: number
}

export function selectFeaturedArticles<T extends ArticleLike>(
  articles: T[],
  options: FeaturedOptions = {},
): T[] {
  const { perHub = 2, maxTotal = 12 } = options

  const live = articles.filter(a => a.data.draft !== true)

  // Group by hub
  const byHub = new Map<string, T[]>()
  for (const article of live) {
    const hub = article.data.hub
    if (!byHub.has(hub)) byHub.set(hub, [])
    byHub.get(hub)!.push(article)
  }

  // Sample perHub from each hub
  const sampled: T[] = []
  for (const hubArticles of byHub.values()) {
    const picked = shuffle(hubArticles).slice(0, perHub)
    sampled.push(...picked)
  }

  return shuffle(sampled).slice(0, maxTotal)
}
