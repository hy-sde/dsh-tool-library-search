/**
 * README retrieval for the semantic rerank layer. Best-effort per candidate:
 * - npm packages: the registry's own `/pkg` JSON carries the full `readme`
 *   markdown (no extra GitHub hop).
 * - GitHub projects (and cargo candidates whose crates.io entry carries a
 *   `repository`): `raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`
 *   (HEAD resolves branch-agnostically; `README.rst` fallback tried).
 * - Everything else (Maven/Go/PyPI via deps.dev, cargo without a repository):
 *   no readable free README lane — the candidate goes on with its
 *   name+description as the only document text.
 *
 * Why not crates.io's `/readme` endpoint: it redirects to
 * `static.crates.io/readmes/...` which serves a bot-blocked AccessDenied to
 * non-browser clients (verified 2026-09-06), so we follow the `repository`
 * field to GitHub raw instead.
 * @module @hy-sde-org/dsh-tool-library-search/readme
 */

import type { Candidate } from './candidates.ts'
import type { Fetcher, SourceContext } from './sources/http.ts'
import { SourceHttpError } from './sources/http.ts'

/** Maximum characters retained from one README before embedding. */
export const README_MAX_CHARS = 12_000

/** Per-request timeout for README fetches (ms). */
export const README_FETCH_TIMEOUT_MS = 6_000

/** One document ready for embedding. */
export interface CandidateDocument {
  /** Dedupe key of the candidate this document describes. */
  readonly key: string
  /** Concatenated text: description + README (name already ranks lexically). */
  readonly text: string
  /** Whether a README was actually fetched (vs. description-only). */
  readonly hasReadme: boolean
}

/**
 * Build the candidate→README retrieval plan: the URLs to try per candidate,
 * in order. npm uses the registry JSON; everything else with a repository
 * uses GitHub raw (README.md, then README.rst). Candidates without a lane
 * return an empty list.
 */
export function readmeUrlsFor(candidate: Candidate): string[] {
  if (candidate.ecosystem === 'npm') {
    return [`https://registry.npmjs.org/${encodeURIComponent(candidate.name)}`]
  }
  const repository = candidate.repository
  if (repository === undefined || repository.length === 0) return []
  const [owner, repo] = repository.split('/')
  if (owner === undefined || repo === undefined) return []
  const base = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/`
  return [`${base}README.md`, `${base}README.rst`]
}

/**
 * Fetch one candidate's README text.
 * @returns the README markdown (truncated to {@link README_MAX_CHARS}), or
 * undefined when every URL failed (404/403/timeout) or the field is absent.
 */
export async function fetchCandidateReadme(
  candidate: Candidate,
  ctx: SourceContext,
): Promise<string | undefined> {
  const urls = readmeUrlsFor(candidate)
  let lastError: unknown
  for (const url of urls) {
    try {
      const text = await fetchText(url, ctx)
      if (text !== undefined) return text
    } catch (error) {
      lastError = error
    }
  }
  void lastError // best-effort by design; failures are normal (no README)
  return undefined
}

/** GET a URL as truncated text; npm JSON returns `readme`, raw returns the body. */
async function fetchText(url: string, ctx: SourceContext): Promise<string | undefined> {
  const fetcher: Fetcher = ctx.fetch ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), README_FETCH_TIMEOUT_MS)
  const headers: Record<string, string> = { 'User-Agent': ctx.userAgent, Accept: '*/*' }
  if (ctx.token !== undefined && ctx.token.length > 0 && url.includes('api.github.com')) {
    headers.Authorization = `Bearer ${ctx.token}`
  }
  try {
    const response = await fetcher(url, { headers, signal: controller.signal })
    if (!response.ok) throw new SourceHttpError(`HTTP ${response.status} for ${url}`, response.status)
    let text = ''
    if (url.includes('registry.npmjs.org')) {
      const data = await response.json() as { readme?: string }
      text = data.readme ?? ''
    } else {
      text = await response.text()
    }
    if (text.length === 0) return undefined
    return text.length > README_MAX_CHARS ? text.slice(0, README_MAX_CHARS) : text
  } catch (error) {
    if (error instanceof SourceHttpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new SourceHttpError(`fetch failed for ${url}: ${message}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch READMEs for a batch with bounded concurrency. Individual failures and
 * missing READMEs never throw: they yield a description-only document. All
 * candidates get a document, so the rerank always has something to embed.
 * @param candidates - the rerank pool.
 * @param ctx - source context (UA/timeout/fetch seam).
 * @param concurrency - max in-flight fetches (default 6).
 */
export async function fetchCandidateDocuments(
  candidates: readonly Candidate[],
  ctx: SourceContext,
  concurrency = 6,
): Promise<CandidateDocument[]> {
  const docs: CandidateDocument[] = new Array(candidates.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= candidates.length) return
      const candidate = candidates[index]
      if (candidate === undefined) return
      const readme = await fetchCandidateReadme(candidate, ctx).catch(() => undefined)
      const parts: string[] = []
      if (candidate.description !== undefined) parts.push(candidate.description)
      if (readme !== undefined) parts.push(readme)
      docs[index] = {
        key: `${candidate.ecosystem}:${candidate.name.toLowerCase()}`,
        text: parts.join('\n\n'),
        hasReadme: readme !== undefined,
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, candidates.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return docs
}
