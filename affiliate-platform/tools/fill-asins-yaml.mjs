#!/usr/bin/env node
/**
 * fill-asins-yaml.mjs
 *
 * Limited-scope Phase 1 tool: updates amazon_asin: VERIFY entries in products.yaml only.
 * Does NOT touch article markdown bodies. Phase 2 (article body rewrite) is a separate tool.
 *
 * CLI: node tools/fill-asins-yaml.mjs --site <site-path> --input <csv-path>
 *
 * The CSV must have columns: product_id, asin
 * Rows with a blank asin are silently skipped.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

// ── ASIN validation ──────────────────────────────────────────────────────────

const ASIN_RE = /^(?:B0[A-Z0-9]{8}|[0-9]{10})$/;
const NOT_ON_AMAZON = 'NOT_ON_AMAZON';

function validAsin(s) {
  const u = s.trim().toUpperCase();
  return u === NOT_ON_AMAZON || ASIN_RE.test(u);
}

// ── CSV parser (no external deps) ────────────────────────────────────────────

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rows = [];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const fields = [];
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === '"') {
        let val = '';
        i++; // skip opening quote
        while (i < raw.length) {
          if (raw[i] === '"' && raw[i + 1] === '"') {
            val += '"';
            i += 2;
          } else if (raw[i] === '"') {
            i++; // skip closing quote
            break;
          } else {
            val += raw[i++];
          }
        }
        fields.push(val);
        if (raw[i] === ',') i++;
      } else {
        let val = '';
        while (i < raw.length && raw[i] !== ',') val += raw[i++];
        if (raw[i] === ',') i++;
        fields.push(val);
      }
    }
    rows.push(fields);
  }

  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(fields => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (fields[i] ?? '').trim(); });
    return obj;
  });
}

// ── YAML line-level updater ──────────────────────────────────────────────────
// Operates line-by-line to preserve formatting, comments, and whitespace exactly.

function applyAsinsToYaml(yamlText, updates) {
  // updates: Map<product_id, asin>
  const lines = yamlText.split('\n');
  const result = [];
  const stats = {
    updated: [],
    alreadyResolved: [],
  };

  let currentId = null;
  let inProductBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect product key line (non-indented, not a comment, ends with colon)
    // Include dot to handle keys like staub-braiser-3.5qt
    const keyMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9_./-]*):\s*$/);
    if (keyMatch) {
      currentId = keyMatch[1];
      inProductBlock = updates.has(currentId);
      result.push(line);
      continue;
    }

    // Reset on section comment lines (treat as block boundary signal)
    if (line.startsWith('#')) {
      currentId = null;
      inProductBlock = false;
      result.push(line);
      continue;
    }

    // If we're in a product block that needs updating, look for amazon_asin line
    if (inProductBlock) {
      const asinMatch = line.match(/^(\s+amazon_asin:\s*)(.+)$/);
      if (asinMatch) {
        const existing = asinMatch[2].trim();
        const newAsin = updates.get(currentId);

        if (existing === 'VERIFY') {
          result.push(`${asinMatch[1]}${newAsin.toUpperCase()}`);
          stats.updated.push(currentId);
          inProductBlock = false; // done with this product
          continue;
        } else {
          // Non-VERIFY value already there — refuse to overwrite
          stats.alreadyResolved.push({ id: currentId, existing });
          inProductBlock = false;
          result.push(line);
          continue;
        }
      }
    }

    result.push(line);
  }

  return { yaml: result.join('\n'), stats };
}

// ── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--site') args.site = argv[++i];
    else if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (!args.site || !args.input) {
    console.error('Usage: node tools/fill-asins-yaml.mjs --site <site-path> --input <csv-path> [--dry-run]');
    process.exit(1);
  }

  const sitePath = resolve(args.site);
  const csvPath = resolve(args.input);
  const yamlPath = join(sitePath, 'content', 'products', 'products.yaml');

  // Read inputs
  let csvText, yamlText;
  try {
    csvText = readFileSync(csvPath, 'utf8');
  } catch (e) {
    console.error(`Cannot read CSV: ${csvPath}\n${e.message}`);
    process.exit(1);
  }
  try {
    yamlText = readFileSync(yamlPath, 'utf8');
  } catch (e) {
    console.error(`Cannot read products.yaml: ${yamlPath}\n${e.message}`);
    process.exit(1);
  }

  const rows = parseCsv(csvText);
  if (!rows.length) {
    console.error('CSV appears empty or malformed.');
    process.exit(1);
  }

  if (!('product_id' in rows[0]) || !('asin' in rows[0])) {
    console.error('CSV must have columns: product_id, asin');
    process.exit(1);
  }

  // Build update map, collecting errors
  const updates = new Map();       // product_id → ASIN or NOT_ON_AMAZON
  const notOnAmazon = [];          // products flagged NOT_ON_AMAZON (informational)
  const skippedBlank = [];
  const failedFormat = [];
  const notFoundInYaml = [];

  for (const row of rows) {
    const pid = row.product_id?.trim();
    const asin = row.asin?.trim().toUpperCase();

    if (!pid) continue;
    if (!asin) {
      skippedBlank.push(pid);
      continue;
    }
    if (!validAsin(asin)) {
      failedFormat.push({ id: pid, asin: row.asin });
      continue;
    }

    // Check product exists in yaml
    const presentInYaml = yamlText.includes(`\n${pid}:\n`) || yamlText.startsWith(`${pid}:\n`);
    if (!presentInYaml) {
      notFoundInYaml.push(pid);
      continue;
    }

    if (asin === NOT_ON_AMAZON) notOnAmazon.push(pid);
    updates.set(pid, asin);
  }

  // Apply updates
  const { yaml: updatedYaml, stats } = applyAsinsToYaml(yamlText, updates);

  // Report
  console.log('\n── fill-asins-yaml report ──────────────────────────────────────────────────');
  console.log(`Products with value to apply:    ${updates.size}`);
  console.log(`  Updated:                       ${stats.updated.length}`);
  console.log(`    of which NOT_ON_AMAZON:      ${notOnAmazon.filter(id => stats.updated.includes(id)).length}`);
  console.log(`  Skipped (already resolved):    ${stats.alreadyResolved.length}`);
  console.log(`Skipped (blank asin in CSV):     ${skippedBlank.length}`);
  console.log(`Failed (invalid ASIN format):    ${failedFormat.length}`);
  console.log(`Not found in products.yaml:      ${notFoundInYaml.length}`);

  if (stats.updated.length) {
    console.log('\nUpdated:');
    for (const id of stats.updated) console.log(`  ✓ ${id} → ${updates.get(id)}`);
  }

  if (stats.alreadyResolved.length) {
    console.log('\nSkipped (already resolved — not overwritten):');
    for (const { id, existing } of stats.alreadyResolved) console.log(`  – ${id}: existing ASIN ${existing}`);
  }

  if (failedFormat.length) {
    console.log('\nFailed (invalid ASIN format — must match B0[A-Z0-9]{8} or [0-9]{10}):');
    for (const { id, asin } of failedFormat) console.log(`  ✗ ${id}: "${asin}"`);
  }

  if (notFoundInYaml.length) {
    console.log('\nNot found in products.yaml:');
    for (const id of notFoundInYaml) console.log(`  ? ${id}`);
  }

  // Write or dry-run
  if (args.dryRun) {
    console.log('\n[dry-run] No files written.');
  } else if (stats.updated.length === 0) {
    console.log('\nNo changes to write.');
  } else {
    writeFileSync(yamlPath, updatedYaml, 'utf8');
    console.log(`\nWrote: ${yamlPath}`);
  }

  console.log(`
⚠️  WARNING: This tool only updates products.yaml.
   Article bodies still contain hardcoded dp/VERIFY links and require Phase 2.
   Do not consider the ASIN remediation complete until Phase 2 runs.
`);

  // Exit non-zero if any hard failures
  if (failedFormat.length || notFoundInYaml.length) process.exit(1);
}

main();
