#!/usr/bin/env node
/**
 * rewrite-article-asins.mjs
 *
 * Phase 2 tool: rewrites dp/VERIFY links in article markdown bodies with resolved ASINs
 * from products.yaml. Strips NOT_ON_AMAZON links to plain text. Applies frontmatter
 * slug rewrites (e.g. duplicate product ID dedup).
 *
 * CLI:
 *   node tools/rewrite-article-asins.mjs \
 *     --site <site-path> \
 *     [--slug-rewrites <json-path>] \
 *     [--dry-run]
 *
 * Acceptance criteria:
 *   - 0 dp/VERIFY remaining after run
 *   - 0 occurrences of any rewritten slug after run
 *   - All 169 affected files modified
 *
 * Does NOT touch products.yaml or any file outside content/articles/.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

// ── constants ────────────────────────────────────────────────────────────────

// Matches [anchor text](https://www.amazon.com/dp/VERIFY...) in any context.
// Anchor excludes newlines to avoid cross-line JSON false-positives (e.g. mainEntity: [...]).
const VERIFY_LINK_RE = /\[([^\]\n]*)\]\(https?:\/\/(?:www\.)?amazon\.com\/dp\/VERIFY[^)]*\)/g;

const NOT_ON_AMAZON = 'NOT_ON_AMAZON';

// ── YAML products parser ─────────────────────────────────────────────────────
// Line-by-line; preserves nothing (read-only). Extracts name + amazon_asin per product.

function parseProductsYaml(text) {
  const products = new Map(); // product_id → {name, amazon_asin}
  const lines = text.split('\n');
  let currentId = null;
  let current = {};

  for (const line of lines) {
    // Root-level key (product ID)
    const rootKey = line.match(/^([A-Za-z0-9][A-Za-z0-9_./-]*):\s*$/);
    if (rootKey) {
      if (currentId && current.name && current.amazon_asin) {
        products.set(currentId, { name: current.name, amazon_asin: current.amazon_asin });
      }
      currentId = rootKey[1];
      current = {};
      continue;
    }
    // Section comments — save current product before resetting context
    if (line.startsWith('#')) {
      if (currentId && current.name && current.amazon_asin) {
        products.set(currentId, { name: current.name, amazon_asin: current.amazon_asin });
      }
      currentId = null; current = {};
      continue;
    }
    // Field lines
    if (currentId && line.startsWith('  ')) {
      const field = line.match(/^\s+(\w[\w_]*):\s+(.+)$/);
      if (field) current[field[1]] = field[2].trim();
    }
  }
  // Last block
  if (currentId && current.name && current.amazon_asin) {
    products.set(currentId, { name: current.name, amazon_asin: current.amazon_asin });
  }
  return products;
}

// ── Name index ───────────────────────────────────────────────────────────────

function buildNameIndex(products) {
  // Maps lowercase(name) → product_id. Duplicates: last writer wins (post-dedup).
  const index = new Map();
  for (const [id, { name }] of products) {
    index.set(name.toLowerCase(), id);
  }
  return index;
}

// ── Fuzzy name matching ──────────────────────────────────────────────────────

// CTA phrases that contain VERIFY links but are not product names — strip silently.
const CTA_RE = /^check\s+(the\s+)?current\s+price|^buy\s+on\s+amazon|^view\s+on\s+amazon|^see\s+on\s+amazon|^amazon$/i;

function tokenize(s) {
  return new Set(
    s.toLowerCase()
      .replace(/\bqts?\b/g, 'quart')         // Qt/qt/qts → quart
      .replace(/\bknives\b/g, 'knife')        // knives → knife (for steak knives)
      .replace(/(\d)-([a-z])/g, '$1 $2')      // 3.5-quart → 3.5 quart, 4-piece → 4 piece
      .replace(/[^a-z0-9./\s-]/g, ' ')
      .split(/[\s/]+/)
      .filter(Boolean)
  );
}

function jaccardSimilarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

// Coverage: what fraction of anchor tokens appear in the product name.
// High coverage (≥ 0.85) means the anchor text is likely an abbreviation of the product name.
function coverageScore(anchor, productName) {
  const ta = tokenize(anchor);
  const tb = tokenize(productName);
  if (ta.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / ta.size;
}

// Resolve anchor text → { productId, method, isCta } or null.
// Resolution order:
//   1. CTA phrase detection (strip silently — not a product name)
//   2. Exact name match (global)
//   3. Jaccard ≥ 0.70 within article-scoped products
//   4. Coverage ≥ 0.85, unique match within article-scoped products
//   5. Jaccard ≥ 0.85 across all products (global, high threshold)
//   6. Coverage ≥ 0.85, unique match across all products
function resolveAnchorText(anchorText, nameIndex, products, articleProductIds) {
  // 1. CTA detection
  if (CTA_RE.test(anchorText.trim())) return { productId: null, method: 'cta', isCta: true };

  // 2. Exact (case-insensitive)
  const exactId = nameIndex.get(anchorText.toLowerCase());
  if (exactId) return { productId: exactId, method: 'exact' };

  // Helpers for scoped and global searches
  function bestMatch(candidateIds, jaccardThreshold, coverageThreshold) {
    let bestJId = null, bestJScore = 0;
    const covMatches = [];
    for (const id of candidateIds) {
      const p = products.get(id);
      if (!p) continue;
      const j = jaccardSimilarity(anchorText, p.name);
      if (j > bestJScore) { bestJScore = j; bestJId = id; }
      const cov = coverageScore(anchorText, p.name);
      if (cov >= coverageThreshold) covMatches.push({ id, cov });
    }
    if (bestJScore >= jaccardThreshold) return { productId: bestJId, method: `jaccard(${bestJScore.toFixed(2)})` };
    if (covMatches.length === 1) return { productId: covMatches[0].id, method: `coverage(${covMatches[0].cov.toFixed(2)})` };
    return null;
  }

  // 3 & 4. Article-scoped
  const scoped = bestMatch(articleProductIds, 0.70, 0.85);
  if (scoped) return scoped;

  // 5 & 6. Global (all products)
  const global = bestMatch(products.keys(), 0.85, 0.85);
  if (global) return global;

  return null;
}

// ── Frontmatter helpers ──────────────────────────────────────────────────────

function splitFrontmatter(content) {
  const m = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!m) return { fm: '', body: content };
  return { fm: m[1], body: m[2] };
}

function extractArticleProductIds(fm) {
  // Matches id: "slug" or id: slug in frontmatter products list
  const ids = new Set();
  for (const m of fm.matchAll(/\bid:\s*["']?([A-Za-z0-9][A-Za-z0-9_./-]*)["']?/g)) {
    ids.add(m[1]);
  }
  return ids;
}

function applySlugRewrites(text, slugRewrites) {
  let result = text;
  const changes = [];
  for (const [oldSlug, newSlug] of Object.entries(slugRewrites)) {
    const re = new RegExp(`(id:\\s*["']?)${escapeRe(oldSlug)}(["']?)`, 'g');
    const replaced = result.replace(re, `$1${newSlug}$2`);
    if (replaced !== result) changes.push(`  slug-rewrite: "${oldSlug}" → "${newSlug}"`);
    result = replaced;
  }
  return { text: result, changes };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Core VERIFY link replacement ─────────────────────────────────────────────

function rewriteVerifyLinks(text, nameIndex, products, articleProductIds, filePath) {
  const resolved = [];
  const stripped = [];
  const unresolved = [];

  const result = text.replace(VERIFY_LINK_RE, (fullMatch, anchorText) => {
    const match = resolveAnchorText(anchorText, nameIndex, products, articleProductIds);

    if (!match) {
      unresolved.push({ anchorText, fullMatch: fullMatch.slice(0, 80) });
      return fullMatch; // leave unchanged — flagged for manual review
    }

    // CTA phrase: strip the link, keep the text, no product lookup needed
    if (match.isCta) {
      stripped.push({ anchorText, productId: null, method: 'cta' });
      return anchorText;
    }

    const { productId, method } = match;
    const product = products.get(productId);
    const asin = product.amazon_asin;

    if (asin === NOT_ON_AMAZON) {
      // Strip the Amazon link; keep anchor text as plain text
      stripped.push({ anchorText, productId, method });
      return anchorText;
    }

    // Real ASIN: replace dp/VERIFY with dp/{ASIN}, preserve query string
    resolved.push({ anchorText, productId, asin, method });
    return fullMatch.replace('/dp/VERIFY', `/dp/${asin}`);
  });

  return { text: result, resolved, stripped, unresolved };
}

// ── Diff display ─────────────────────────────────────────────────────────────

function showDiff(original, updated, label) {
  const orig = original.split('\n');
  const upd = updated.split('\n');
  let shown = 0;
  for (let i = 0; i < Math.max(orig.length, upd.length); i++) {
    if (orig[i] !== upd[i]) {
      if (shown === 0) console.log(`\n  ${label}`);
      if (orig[i] !== undefined) console.log(`  - ${orig[i].trim().slice(0, 120)}`);
      if (upd[i] !== undefined)  console.log(`  + ${upd[i].trim().slice(0, 120)}`);
      shown++;
      if (shown >= 8) { console.log('  ... (more changes)'); break; }
    }
  }
}

// ── Process one article file ──────────────────────────────────────────────────

function processFile(filePath, products, nameIndex, slugRewrites, dryRun, verbose) {
  const original = readFileSync(filePath, 'utf8');
  const { fm, body } = splitFrontmatter(original);
  const articleProductIds = extractArticleProductIds(fm);

  // 1. Slug rewrites in frontmatter
  const { text: newFm, changes: slugChanges } = applySlugRewrites(fm, slugRewrites);

  // 2. VERIFY link replacement across both body AND frontmatter (JSON-LD in body, but
  //    also catches any VERIFY link that slipped into schema text fields)
  const combined = newFm + body;
  const { text: rewritten, resolved, stripped, unresolved } =
    rewriteVerifyLinks(combined, nameIndex, products, articleProductIds, filePath);

  const changed = rewritten !== original;
  const totalChanges = slugChanges.length + resolved.length + stripped.length;

  if (!changed) return { changed: false, resolved: 0, stripped: 0, unresolved: [], slugRewrites: 0 };

  if (verbose && totalChanges > 0) {
    showDiff(original, rewritten, require_relative_path(filePath));
  }

  if (!dryRun) {
    writeFileSync(filePath, rewritten, 'utf8');
  }

  return {
    changed: true,
    resolved: resolved.length,
    stripped: stripped.length,
    unresolved,
    slugRewrites: slugChanges.length,
  };
}

function require_relative_path(filePath) {
  // For display only — trim to last 2 path segments
  return filePath.split('/').slice(-2).join('/');
}

// ── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { verbose: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--site') args.site = argv[++i];
    else if (argv[i] === '--slug-rewrites') args.slugRewrites = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--verbose') args.verbose = true;
  }
  return args;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (!args.site) {
    console.error('Usage: node tools/rewrite-article-asins.mjs --site <site-path> [--slug-rewrites <json>] [--dry-run] [--verbose]');
    process.exit(1);
  }

  const sitePath = resolve(args.site);
  const articlesDir = join(sitePath, 'content', 'articles');
  const yamlPath = join(sitePath, 'content', 'products', 'products.yaml');

  // Load products
  let yamlText;
  try { yamlText = readFileSync(yamlPath, 'utf8'); }
  catch (e) { console.error(`Cannot read products.yaml: ${e.message}`); process.exit(1); }

  const products = parseProductsYaml(yamlText);
  const nameIndex = buildNameIndex(products);
  console.log(`Loaded ${products.size} products from products.yaml.`);

  // Load slug rewrites
  let slugRewrites = {};
  if (args.slugRewrites) {
    try { slugRewrites = JSON.parse(readFileSync(resolve(args.slugRewrites), 'utf8')); }
    catch (e) { console.error(`Cannot read slug-rewrites: ${e.message}`); process.exit(1); }
    console.log(`Slug rewrites loaded: ${Object.keys(slugRewrites).length} entry/entries.`);
  }

  // Find article files
  let files;
  try { files = readdirSync(articlesDir).filter(f => f.endsWith('.md') || f.endsWith('.mdx')); }
  catch (e) { console.error(`Cannot read articles directory: ${e.message}`); process.exit(1); }
  console.log(`Found ${files.length} article files.`);

  if (args.dryRun) console.log('\n[dry-run mode — no files will be written]\n');

  // Process all files
  const summary = {
    filesChanged: 0,
    filesUnchanged: 0,
    totalResolved: 0,
    totalStripped: 0,
    totalSlugRewrites: 0,
    allUnresolved: [],
  };

  for (const fname of files) {
    const filePath = join(articlesDir, fname);
    const result = processFile(filePath, products, nameIndex, slugRewrites, args.dryRun, args.verbose);

    if (result.changed) {
      summary.filesChanged++;
      summary.totalResolved += result.resolved;
      summary.totalStripped += result.stripped;
      summary.totalSlugRewrites += result.slugRewrites;
      if (result.unresolved.length) {
        for (const u of result.unresolved) {
          summary.allUnresolved.push({ file: fname, ...u });
        }
      }
    } else {
      summary.filesUnchanged++;
    }
  }

  // Report
  console.log('\n── rewrite-article-asins report ────────────────────────────────────────────');
  console.log(`Files changed:          ${summary.filesChanged}`);
  console.log(`Files unchanged:        ${summary.filesUnchanged}`);
  console.log(`VERIFY links resolved:  ${summary.totalResolved}`);
  console.log(`NOT_ON_AMAZON stripped: ${summary.totalStripped}`);
  console.log(`Slug rewrites applied:  ${summary.totalSlugRewrites}`);
  console.log(`Unresolved links:       ${summary.allUnresolved.length}`);

  if (summary.allUnresolved.length) {
    console.log('\n⚠ UNRESOLVED — manual review required:');
    for (const u of summary.allUnresolved) {
      console.log(`  [${u.file}] anchor: "${u.anchorText}" — ${u.fullMatch}`);
    }
  }

  if (!args.dryRun) {
    // Post-run verification
    let remainingVerify = 0;
    for (const fname of files) {
      const content = readFileSync(join(articlesDir, fname), 'utf8');
      if (content.includes('dp/VERIFY')) remainingVerify++;
    }
    console.log(`\nPost-run scan: ${remainingVerify} files still contain dp/VERIFY`);

    if (Object.keys(slugRewrites).length) {
      for (const oldSlug of Object.keys(slugRewrites)) {
        let remaining = 0;
        for (const fname of files) {
          const content = readFileSync(join(articlesDir, fname), 'utf8');
          if (content.includes(oldSlug)) remaining++;
        }
        if (remaining) console.log(`  ⚠ "${oldSlug}" still present in ${remaining} files`);
        else console.log(`  ✓ "${oldSlug}" fully removed from articles`);
      }
    }

    if (remainingVerify === 0 && summary.allUnresolved.length === 0) {
      console.log('\n✓ All VERIFY links resolved. Ready for git commit.');
      console.log('\nSuggested commit:');
      console.log('  fix(mlt): rewrite 169 article bodies — replace dp/VERIFY with resolved ASINs (Phase 2); strip NOT_ON_AMAZON anchors; merge kitchenaid-pasta-roller-attachment slug');
    } else {
      console.log('\n✗ Some links remain unresolved. Review above before committing.');
    }
  }
}

main();
