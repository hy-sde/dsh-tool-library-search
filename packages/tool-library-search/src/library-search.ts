/**
 * The `library_search` core: fans one query out to the free sources
 * concurrently (deps.dev, npm, crates.io, GitHub, pkg.go.dev), tolerates
 * per-source failures (only a total failure errors), merges, ranks with the
 * exact-name boost, and renders a markdown "does this already exist?" answer.
 *
 * Every source attempt is REPORTED — ok, failed, or skipped — so a partial
 * search can never masquerade as a definitive "no match" (review claim 3).
 * Ecosystem filters also skip sources that cannot answer the filtered
 * ecosystems instead of spending requests on guaranteed-zero lanes.
 *
 * The sources were picked after a live probe (2026-09-06, queries
 * "yaml parser" / "markdown parser" / "serde_yaml"):
 * - npm: best free description search + downloads.
 * - GitHub repo search (qualifiers, stars): the semantic-ish leader; the only
 *   source that answers natural-language queries.
 * - deps.dev: ONE call covering every ecosystem by NAME (the existence check;
 *   Maven/PyPI/Go have no usable free search, so deps.dev is their only lane).
 * - crates.io: cargo descriptions + downloads (needs a UA).
 * - pkg.go.dev: Go module import counts (HTML scrape, tolerant by design).
 * - Excluded: libraries.io (key required), OpenLib (bot-protected), PyPI
 *   search (removed/challenged), Maven solrsearch (doesn't rank snakeyaml in
 *   top-30 of q=yaml), api.deps.dev/v3alpha/search (404).
 * @module @hy-sde-org/dsh-tool-library-search/library-search
 */

import type { Candidate, Ecosystem } from './candidates.ts'
import { mergeCandidates, rankCandidates } from './candidates.ts'
import { searchCrates } from './sources/crates.ts'
import { searchDepsDev } from './sources/depsdev.ts'
import { searchGithub } from './sources/github.ts'
import type { Fetcher, SourceContext } from './sources/http.ts'
import { searchNpm } from './sources/npm.ts'
import { searchPkgGoDev } from './sources/pkggodev.ts'

/** Facade options after plugin defaults are applied. */
export interface LibrarySearchOptions {
  /** Per-source transport timeout (ms). */
  readonly timeoutMs: number
  /** User-Agent for the free endpoints (crates.io 403s bare clients). */
  readonly userAgent: string
  /** Optional GitHub token (raises repo-search quota 10/min → 30/min). */
  readonly githubToken?: string
  /** Fetch implementation (test seam); defaults to global fetch. */
  readonly fetch?: Fetcher
  /** Result cap after merge+rank. */
  readonly maxResults: number
  /** Per-source hit cap (before merge). */
  readonly perSourceLimit: number
  /**
   * Top-candidate count returned before semantic rerank (default: maxResults).
   * The semantic layer needs the full merged pool (~40–50) so it can promote
   * a README-relevant candidate that name-based ranking buried.
   */
  readonly poolSize?: number
  /** External cancellation signal, forwarded to every source request. */
  readonly signal?: AbortSignal
}

/** Outcome of one fan-out source attempt. */
export interface SourceStatus {
  /** Source id, as shown in failure lines (e.g. `deps.dev`). */
  readonly id: string
  /** ok = ran clean; failed = error (see `error`); skipped = not queried. */
  readonly status: 'ok' | 'failed' | 'skipped'
  /** Candidate hits the source contributed (0 when failed/skipped). */
  readonly hits: number
  /** One-line reason when `status` is `failed`. */
  readonly error?: string
}

export interface LibrarySearchResult {
  readonly candidates: readonly Candidate[]
  /** Per-source attempt ledger — the structured form of `failures`. */
  readonly sources: readonly SourceStatus[]
  /** Which sources failed, with a one-line reason (informational). */
  readonly failures: readonly string[]
}

/** Which ecosystems each source can answer; `deps.dev` covers them all. */
const SOURCE_ECOSYSTEMS = {
  'deps.dev': 'all',
  npm: ['npm'],
  'crates.io': ['cargo'],
  github: ['github'],
  'pkg.go.dev': ['go'],
} as const satisfies Readonly<Record<string, readonly Ecosystem[] | 'all'>>

/** Render cap for candidate descriptions (GitHub repo descriptions are unvetted user text; one hostile repo can carry 50k+ chars and drown the answer). */
export const MAX_DESCRIPTION_CHARS = 300

/** Clip a description to {@link MAX_DESCRIPTION_CHARS}, preserving the tail marker. */
export function clipDescription(description: string): string {
  if (description.length <= MAX_DESCRIPTION_CHARS) return description
  return `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
}

/**
 * Fan out to the free sources, merge, and rank. Per-source failures are
 * tolerated and reported (each becomes a `failed` {@link SourceStatus}); only
 * when EVERY queried source fails does this throw. Sources whose ecosystem
 * coverage cannot match the requested filter are skipped, not queried.
 * @param ecosystems - optional filter on result ecosystems (empty/undefined = all).
 * @throws when every queried source failed, or the call was cancelled.
 */
export async function searchLibraries(
  query: string,
  options: LibrarySearchOptions,
  language?: string,
  ecosystems?: readonly Ecosystem[],
): Promise<LibrarySearchResult> {
  if (options.signal?.aborted) {
    throw new Error('library search aborted before dispatch')
  }
  const ctx: SourceContext = {
    timeoutMs: options.timeoutMs,
    userAgent: options.userAgent,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.githubToken !== undefined && options.githubToken.length > 0
      ? { token: options.githubToken }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }
  const limit = Math.max(1, options.perSourceLimit)
  const ecosystemFilter = ecosystems !== undefined && ecosystems.length > 0 ? ecosystems : undefined
  const specs = [
    { id: 'deps.dev', ecosystems: SOURCE_ECOSYSTEMS['deps.dev'], run: () => searchDepsDev(query, ctx, limit) },
    { id: 'npm', ecosystems: SOURCE_ECOSYSTEMS.npm, run: () => searchNpm(query, ctx, limit) },
    { id: 'crates.io', ecosystems: SOURCE_ECOSYSTEMS['crates.io'], run: () => searchCrates(query, ctx, limit) },
    { id: 'github', ecosystems: SOURCE_ECOSYSTEMS.github, run: () => searchGithub(query, ctx, limit, language) },
    { id: 'pkg.go.dev', ecosystems: SOURCE_ECOSYSTEMS['pkg.go.dev'], run: () => searchPkgGoDev(query, ctx, limit) },
  ]
  const statuses: SourceStatus[] = specs.map(spec => {
    const relevant = ecosystemFilter === undefined
      || spec.ecosystems === 'all'
      || spec.ecosystems.some(ecosystem => ecosystemFilter.includes(ecosystem))
    return { id: spec.id, status: relevant ? 'ok' : 'skipped', hits: 0 }
  })
  const byId = new Map(statuses.map(status => [status.id, status]))

  const active = specs.filter(spec => byId.get(spec.id)?.status === 'ok')
  const settled = await Promise.allSettled(active.map(spec => spec.run()))
  const hits: Candidate[] = []
  const failures: string[] = []
  for (const [index, outcome] of settled.entries()) {
    const status = byId.get(active[index]?.id ?? '')
    if (status === undefined) continue
    if (outcome.status === 'fulfilled') {
      hits.push(...outcome.value)
      statuses[statuses.indexOf(status)] = { ...status, status: 'ok', hits: outcome.value.length }
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      statuses[statuses.indexOf(status)] = { ...status, status: 'failed', hits: 0, error: reason }
      failures.push(`${status.id}: ${reason}`)
    }
  }
  const queried = active.length
  if (hits.length === 0 && failures.length === queried && queried > 0) {
    if (options.signal?.aborted) throw new Error('library search aborted')
    throw new Error(`all library-search sources failed: ${failures.join('; ')}`)
  }

  const clipped = hits.map(hit => hit.description != null && hit.description.length > MAX_DESCRIPTION_CHARS
    ? { ...hit, description: clipDescription(hit.description) }
    : hit)
  const merged = mergeCandidates(clipped)
  const filtered = ecosystemFilter !== undefined
    ? merged.filter(candidate => ecosystemFilter.includes(candidate.ecosystem))
    : merged
  const ranked = rankCandidates(filtered, query)
  const poolSize = Math.max(options.poolSize ?? options.maxResults, options.maxResults)
  return { candidates: ranked.slice(0, poolSize), sources: statuses, failures }
}

/** A stable default User-Agent; crates.io rejects bare `curl`-style clients. */
export const LIBRARY_SEARCH_USER_AGENT =
  'library-search/0.1 (+https://github.com/hy-sde/dsh-tool-library-search)'

/**
 * Render ranked candidates as a compact markdown answer for the model.
 * Failure disclosure is unconditional: a zero-candidate result WITH failures
 * reads as an incomplete search, never as a definitive "nothing exists".
 */
export function renderResult(
  result: LibrarySearchResult,
  query: string,
  language?: string,
  semanticNote?: string,
): string {
  const lines: string[] = []
  if (result.candidates.length === 0) {
    if (result.failures.length > 0) {
      lines.push(`No match for \`${query}\` — and the search was INCOMPLETE:`)
      lines.push(`${result.failures.length} source(s) failed (${result.failures.join('; ')}).`)
      lines.push('Results may be missing; retry or narrow the query before concluding nothing exists.')
    } else {
      lines.push(`No existing package or repository matched \`${query}\` in the free sources.`)
    }
  } else {
    lines.push(`Existing implementations matching \`${query}\`${language ? ` (${language})` : ''}, ranked:`)
    for (const candidate of result.candidates) {
      const meta: string[] = [candidate.ecosystem]
      if (candidate.version !== undefined) meta.push(candidate.version)
      if (candidate.stars !== undefined) meta.push(`${candidate.stars}★`)
      if (candidate.downloads !== undefined) meta.push(`${abbrev(candidate.downloads)}/mo`)
      if (candidate.imports !== undefined && candidate.downloads === undefined) meta.push(`${abbrev(candidate.imports)} imports`)
      if (candidate.sources.length > 1) meta.push(`via ${candidate.sources.join('+')}`)
      const description = candidate.description !== undefined ? ` — ${candidate.description}` : ''
      lines.push(`- [${candidate.name}](${candidate.link}) \`${meta.join(' · ')}\`${description}`)
    }
  }
  if (result.failures.length > 0 && result.candidates.length > 0) {
    lines.push('')
    lines.push(`(sources that failed this call: ${result.failures.join('; ')})`)
  }
  if (semanticNote !== undefined && semanticNote.length > 0) {
    lines.push('')
    lines.push(semanticNote)
  }
  return lines.join('\n')
}

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}
