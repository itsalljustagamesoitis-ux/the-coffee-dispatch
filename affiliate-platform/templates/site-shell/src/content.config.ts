import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const ProductRefSchema = z.object({
  id: z.string(),
  role: z.enum([
    'best_overall', 'best_value', 'best_budget', 'best_premium',
    'best_for_beginners', 'best_for_professionals', 'honorable_mention',
    'also_consider', 'primary', 'alternative',
  ]).optional(),
  article_specific_pros: z.array(z.string()).optional(),
  article_specific_cons: z.array(z.string()).optional(),
})

// ── Articles collection ───────────────────────────────────────────────────────

const ArticleSchema = z.object({
  title: z.string(),
  slug: z.string(),
  type: z.enum(['roundup', 'review', 'comparison', 'buyer_guide', 'informational']),
  date: z.date(),
  updated: z.date().optional(),
  author: z.string().default('{{PERSONA_SLUG}}'),
  category: z.string(),
  hub: z.string(),
  hero_image: z.string(),
  hero_image_alt: z.string().optional(),
  description: z.string().max(200),
  target_keyword: z.string(),
  products: z.array(ProductRefSchema).default([]),
  tags: z.array(z.string()).default([]),
  rating: z.number().min(1).max(5).optional(),
  disclosure_required: z.boolean().default(true),
  noindex: z.boolean().default(false),
  // Comparison-type only
  product_a: z.string().optional(),
  product_b: z.string().optional(),
  winner: z.enum(['product_a', 'product_b']).optional(),
  winner_reason: z.string().optional(),
})

// ── Collections ───────────────────────────────────────────────────────────────

export const collections = {
  articles: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './content/articles' }),
    schema: ArticleSchema,
  }),
}
