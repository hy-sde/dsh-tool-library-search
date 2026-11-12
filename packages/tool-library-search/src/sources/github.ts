/**
 * GitHub source: repository search, the closest free thing to "has someone
 * already built this?" It ranks by stars (optionally biased to one language)
 * and matches names AND descriptions, so natural-language queries work — the
 * one source that does. Unauthenticated quota is 10 searches/min (each page is
 * one search); a token raises it to 30/min. Code search would need a token and
 * is out of scope for this v0 surface.
 *
 * PAGING (token-aware): without a token the source NEVER pages — one
 * `per_page=limit` request, so a busy query stays inside the 10/min budget.
 * With a token, `limit` may exceed 100 (GitHub's per-page cap) and the source
 * then walks pages until it has `limit` candidates or ran out of `next` links
 * (or hit `maxPages`, default 5 — each page is one of the 30/min searches).
 * Raise `perSourceLimit` (e.g. 300) to hand the semantic rerank a deep pool.
 *
 * CANCELLATION vs PARTIAL SUCCESS: aborting mid-paging THROWS — returning the
 * earlier pages as success would render a cancelled search as a definitive
 * (truncated) answer. GitHub's own `incomplete_results: true` flag (documented
 * as "the search may be missing results", e.g. on timeout) surfaces as
 * {@link SourceIncompleteError} with the hits gathered so far as `partial`:
 * the ledger records the gap, the tool reports `complete: false`.
 * @module @hy-sde-org/dsh-tool-library-search/sources/github
 */

import type { Candidate } from '../candidates.ts'
import { getJson, requireEnvelope, SourceHttpError, SourceIncompleteError, takeValid, type SourceContext } from './http.ts'

interface GithubRepo {
  readonly full_name?: string
  readonly html_url?: string
  /** GitHub returns `null` for repos without a description. */
  readonly description?: string | null
  readonly stargazers_count?: number
}

interface GithubSearchResponse {
  readonly items?: GithubRepo[]
  /** GitHub sets this when the search may be missing results (timeout). */
  readonly incomplete_results?: boolean
}

/** Pages fetched per query at most; each is one search-API request. */
const DEFAULT_MAX_PAGES = 5

/** Validate collected repos and shape them into candidates (order preserved). */
function collectCandidates(items: readonly GithubRepo[], limit: number): Candidate[] {
  const usable = takeValid<GithubRepo>(
    items,
    repo => typeof repo.full_name === 'string' && repo.full_name.length > 0,
    'github',
    'items',
  )
  const candidates: Candidate[] = []
  for (const repo of usable.slice(0, limit)) {
    candidates.push({
      name: repo.full_name as string,
      ecosystem: 'github',
      kind: 'project',
      link: repo.html_url ?? `https://github.com/${repo.full_name as string}`,
      ...(repo.description != null ? { description: repo.description } : {}),
      ...(repo.stargazers_count !== undefined ? { stars: repo.stargazers_count } : {}),
      repository: repo.full_name as string,
      sources: ['github'],
    })
  }
  return candidates
}

/**
 * Run one GitHub repository search with name/description + optional language
 * qualifiers, sorted by stars, walking `page=` links when the caller's limit
 * exceeds one page (token required: paging without a token would burn the
 * 10/min unauth budget on a single query).
 * @param limit - how many candidates to return (per-source cap).
 * @param maxPages - page ceiling; defaults to 1 without a token, 5 with one.
 * @throws {SourceHttpError} propagated from the transport layer, when a page's
 *   `items` envelope is missing (GitHub always returns `items` — its absence
 *   is a failure, not an empty result), or on cancellation mid-paging.
 * @throws {SourceIncompleteError} when GitHub reports `incomplete_results`;
 *   hits collected so far ride along as `partial`.
 */
export async function searchGithub(
  query: string,
  ctx: SourceContext,
  limit: number,
  language?: string,
  maxPages?: number,
): Promise<Candidate[]> {
  let q = `${query} in:name,description`
  if (language !== undefined && language.length > 0) {
    q += ` language:${language}`
  }
  const hasToken = ctx.token !== undefined && ctx.token.length > 0
  const pageCap = maxPages ?? (hasToken ? DEFAULT_MAX_PAGES : 1)
  const perPage = Math.min(Math.max(limit, 1), 100)
  const items: GithubRepo[] = []
  for (let page = 1; page <= pageCap; page++) {
    // Cancellation is not a partial result: stop the whole source with a
    // failure so the ledger never dresses a truncated page walk as success.
    if (ctx.signal?.aborted) {
      throw new SourceHttpError('aborted for github search')
    }
    const data = await getJson(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`,
      ctx,
    ) as GithubSearchResponse
    const batch = requireEnvelope(data, 'github', 'items').items as GithubRepo[]
    items.push(...batch)
    // GitHub says this page's search may be missing results. Everything
    // collected so far is real, so it rides the error as `partial` instead of
    // being silently promoted to a definitive (but truncated) success.
    if (data.incomplete_results === true) {
      throw new SourceIncompleteError(
        'github: reported potentially incomplete results (incomplete_results)',
        collectCandidates(items, limit),
      )
    }
    if (items.length >= limit) break
    if (batch.length < perPage) break
  }
  return collectCandidates(items, limit)
}
