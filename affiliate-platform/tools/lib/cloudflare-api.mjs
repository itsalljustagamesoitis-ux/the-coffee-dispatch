/**
 * Cloudflare Pages API client — thin fetch wrapper with auth and error handling.
 */

const ACCOUNT_ID = 'fedb496b1addc0743cb2a84fa5a7ba67'
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`

/**
 * Performs an authenticated GET against the Cloudflare API.
 * Throws on network error or non-2xx HTTP status.
 * @param {string} token
 * @param {string} path  — path relative to account base, e.g. /pages/projects/foo
 * @returns {Promise<any>} — parsed response body (.result field)
 */
async function cfGet(token, path) {
  const url = `${BASE}${path}`
  let res
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  } catch (err) {
    throw new Error(`Network error fetching ${url}: ${err.message}`)
  }
  const body = await res.json()
  if (!body.success) {
    const msg = body.errors?.map(e => `${e.code}: ${e.message}`).join(', ') ?? 'unknown error'
    throw new Error(`Cloudflare API error on ${path}: ${msg}`)
  }
  return body.result
}

/**
 * Returns the Pages project object for the given project name.
 * @param {string} token
 * @param {string} projectName
 */
export async function getProject(token, projectName) {
  return cfGet(token, `/pages/projects/${projectName}`)
}

/**
 * Returns the list of custom domains for a Pages project.
 * @param {string} token
 * @param {string} projectName
 * @returns {Promise<Array<{name: string, status: string}>>}
 */
export async function getCustomDomains(token, projectName) {
  return cfGet(token, `/pages/projects/${projectName}/domains`)
}

/**
 * @typedef {{ value: string|null, type: 'plain_text'|'secret_text' }} EnvBinding
 */

/**
 * Returns the environment variable bindings for a Pages project.
 * Secrets have type "secret_text" and value "" (Cloudflare does not expose secret values).
 * Plain env vars have type "plain_text" and a readable value.
 *
 * @param {string} token
 * @param {string} projectName
 * @returns {Promise<{production: Record<string, EnvBinding>, preview: Record<string, EnvBinding>}>}
 */
export async function getEnvVars(token, projectName) {
  const project = await getProject(token, projectName)
  const extract = (envVars) => {
    if (!envVars) return {}
    return Object.fromEntries(
      Object.entries(envVars).map(([k, v]) => [k, {
        value: v?.value ?? null,
        type: v?.type ?? 'plain_text',
      }])
    )
  }
  return {
    production: extract(project.deployment_configs?.production?.env_vars),
    preview: extract(project.deployment_configs?.preview?.env_vars),
  }
}
