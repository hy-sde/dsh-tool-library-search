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
 *
 * Bodies are read as a STREAM with byte caps and cancelled past the cap: a
 * pathological 200 KB README costs at most one bounded read, never a full
 * buffer-then-slice (review claim 9).
 * @module @hy-sde-org/dsh-tool-library-search/readme
 */

import type { Candidate } from './candidates.ts'
import { composeAbortSignal, readBodyCapped, SourceHttpError } from './sources/http.ts'
import type { Fetcher, SourceContext } from './sources/http.ts'

/** Maximum characters retained from one README before embedding. */
export const README_MAX_CHARS = 12_000

/** Per-request timeout for README fetches (ms). */
export const README_FETCH_TIMEOUT_MS = 6_000

/** Byte cap on raw README bodies (≥ README_MAX_CHARS in any UTF-8 encoding). */
export const README_MAX_BYTES = 64_000

/**
 * Byte cap on the npm registry JSON envelope before parsing (npm readmes can
 * be large; the JSON wrapper adds metadata on top).
 */
export const README_JSON_MAX_BYTES = 256_000

/** `owner/repo` slug extracted from a repository field. */
export interface RepoSlug {
  readonly owner: string
  readonly repo: string
}

/**
 * Extract the GitHub `owner/repo` slug from whatever shape a registry hands
 * over. Handles `owner/repo` (deps.dev PROJECT entries), full https URLs with
 * optional `.git`/fragment/path suffixes, `git+https://…`, `git://…`, and SCP
 * form `git@github.com:owner/repo(.git)`. Non-GitHub hosts have no raw-README
 * lane here and return undefined.
 */
export function parseRepositoryOwnerRepo(repository: string): RepoSlug | undefined {
  const value = repository.trim()
  if (value.length === 0) return undefined
  // SCP form first: `git@github.com:owner/repo.git` is not a parseable URL.
  const scp = /^git@github\.com:([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:#.*)?$/i.exec(value)
  if (scp !== null) return { owner: scp[1]!, repo: scp[2]! }
  const urlCandidate = value.replace(/^git\+/i, '')
  try {
    const url = new URL(urlCandidate)
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined
    const segments = url.pathname.split('/').filter(segment => segment.length > 0)
    const owner = segments[0]
    const repo = segments[1]
    if (owner === undefined || repo === undefined) return undefined
    return { owner, repo: repo.replace(/\.git$/i, '') }
  } catch {
    // Bare `owner/repo` form (deps.dev PROJECT entries and some crates).
    const bare = /^([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:#.*)?$/.exec(value)
    if (bare === null) return undefined
    return { owner: bare[1]!, repo: bare[2]! }
  }
}

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
  const slug = parseRepositoryOwnerRepo(repository)
  if (slug === undefined) return []
  const base = `https://raw.githubusercontent.com/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}/HEAD/`
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
    if (ctx.signal?.aborted) return undefined
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

/** GET a URL as capped text; npm JSON returns `readme`, raw returns the body. */
async function fetchText(url: string, ctx: SourceContext): Promise<string | undefined> {
  const fetcher: Fetcher = ctx.fetch ?? globalThis.fetch.bind(globalThis)
  const signal = composeAbortSignal({
    timeoutMs: README_FETCH_TIMEOUT_MS,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  })
  const headers: Record<string, string> = { 'User-Agent': ctx.userAgent, Accept: '*/*' }
  if (ctx.token !== undefined && ctx.token.length > 0 && url.includes('api.github.com')) {
    headers.Authorization = `Bearer ${ctx.token}`
  }
  try {
    const response = await fetcher(url, { headers, signal })
    if (!response.ok) throw new SourceHttpError(`HTTP ${response.status} for ${url}`, response.status)
    let text = ''
    if (url.includes('registry.npmjs.org')) {
      const { text: json } = await readBodyCapped(response, README_JSON_MAX_BYTES, ctx.signal)
      let data: { readme?: string }
      try {
        data = JSON.parse(json) as { readme?: string }
      } catch {
        throw new SourceHttpError(`npm: malformed readme JSON for ${url}`)
      }
      text = data.readme ?? ''
    } else {
      const { text: raw } = await readBodyCapped(response, README_MAX_BYTES, ctx.signal)
      text = raw
    }
    if (text.length === 0) return undefined
    return text.length > README_MAX_CHARS ? text.slice(0, README_MAX_CHARS) : text
  } catch (error) {
    if (error instanceof SourceHttpError) throw error
    if (ctx.signal?.aborted) throw new SourceHttpError(`aborted for ${url}`)
    const message = error instanceof Error ? error.message : String(error)
    throw new SourceHttpError(`fetch failed for ${url}: ${message}`)
  }
}

/** The description-only document a candidate falls back to. */
function documentFor(candidate: Candidate, readme: string | undefined): CandidateDocument {
  const parts: string[] = []
  if (candidate.description !== undefined) parts.push(candidate.description)
  if (readme !== undefined) parts.push(readme)
  return {
    key: `${candidate.ecosystem}:${candidate.name.toLowerCase()}`,
    text: parts.join('\n\n'),
    hasReadme: readme !== undefined,
  }
}

/**
 * Fetch READMEs for a batch with bounded concurrency. Individual failures and
 * missing READMEs never throw: they yield a description-only document. All
 * candidates get a document, so the rerank always has something to embed.
 * When the context signal is already aborted, remaining candidates skip the
 * network entirely and fall back to description-only documents.
 * @param candidates - the rerank pool.
 * @param ctx - source context (UA/timeout/fetch seam, cancellation signal).
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
      // Cancellation stops ADMISSION of new network work; in-flight requests
      // abort via their fused signal and the pool settles quiescently.
      const readme = ctx.signal?.aborted
        ? undefined
        : await fetchCandidateReadme(candidate, ctx).catch(() => undefined)
      docs[index] = documentFor(candidate, readme)
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, candidates.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return docs
}
