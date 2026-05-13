/**
 * Resolves the Cloudflare API token.
 *
 * Resolution order:
 *   1. CLOUDFLARE_API_TOKEN env var (already exported in shell)
 *   2. .env.local in the platform root (CLOUDFLARE_API_TOKEN=<value>)
 *   3. wrangler oauth_token from ~/Library/Preferences/.wrangler/config/default.toml
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const PLATFORM_ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENV_LOCAL      = join(PLATFORM_ROOT, '.env.local')
const WRANGLER_CONFIG = join(homedir(), 'Library/Preferences/.wrangler/config/default.toml')

/**
 * Returns the Cloudflare API token.
 * Throws if no token can be resolved from any source.
 * @returns {string}
 */
export function getCloudflareToken() {
  // 1. Shell env var
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return process.env.CLOUDFLARE_API_TOKEN
  }

  // 2. .env.local in platform root
  if (existsSync(ENV_LOCAL)) {
    const match = readFileSync(ENV_LOCAL, 'utf-8').match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)
    if (match) return match[1].trim()
  }

  // 3. Wrangler OAuth token (expires — prefer .env.local for long-lived use)
  try {
    const raw = readFileSync(WRANGLER_CONFIG, 'utf-8')
    const match = raw.match(/oauth_token\s*=\s*"([^"]+)"/)
    if (match) return match[1]
  } catch { /* fall through */ }

  throw new Error(
    'Cloudflare API token not found. Set CLOUDFLARE_API_TOKEN env var or add it to .env.local'
  )
}
