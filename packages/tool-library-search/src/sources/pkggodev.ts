/**
 * pkg.go.dev source: Go module/package search. pkg.go.dev has NO JSON search
 * API — `/search` is server-rendered HTML. We parse the `SearchSnippet` cards
 * its own frontend consumes (verified structure, 2026-09-06) with a tolerant
 * regex pull: if the page shape changes we return ZERO candidates (never throw
 * — the fan-out tolerates it, and deps.dev already covers Go names). Each hit
 * carries the canonical import path as its name, the synopsis as description,
 * and the "Imported by" count as a popularity signal (`imports`), which gives
 * Go candidates a fitness number like npm/crates downloads.
 *
 * Why not the deps.dev GO lane only: deps.dev is name-existence; pkg.go.dev
 * is the only free source that DESCRIBES Go modules for a natural-language
 * query ("go yaml parser" → gopkg.in/yaml.v3, sigs.k8s.io/yaml).
 * @module @hy-sde-org/dsh-tool-library-search/sources/pkggodev
 */

import type { Candidate } from '../candidates.ts'
import { SourceHttpError, type Fetcher, type SourceContext } from './http.ts'

/** One parsed card from the pkg.go.dev search page. */
export interface PkgGoDevHit {
  /** Canonical import path, e.g. `gopkg.in/yaml.v3`. */
  readonly path: string
  /** Package title (display name), e.g. `yaml`. */
  readonly title: string
  /** Search snippet / package synopsis, when present. */
  readonly synopsis?: string
  /** "Imported by N" — the only free popularity number pkg.go.dev exposes. */
  readonly importedBy?: number
  /** Latest major version shown, e.g. `v3.0.1` (kept verbatim). */
  readonly version?: string
}

/** Decode the handful of HTML entities that appear in snippet text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, '')).trim()
}

/**
 * Parse pkg.go.dev `/search` HTML into hits. Returns up to `limit` cards.
 * Tolerant by design: unknown/missing fields are skipped, and a structurally
 * unexpected page yields `[]` — the caller treats that as "no Go hits".
 */
export function parsePkgGoDevSearch(html: string, limit: number): PkgGoDevHit[] {
  const hits: PkgGoDevHit[] = []
  // Split on the exact card opener (`<div class="SearchSnippet" >`); the
  // prefix WITHOUT the quoted exact match would also cut the
  // `SearchSnippet-headerContainer` wrapper and parse every card twice.
  const chunks = html.split(/<div class="SearchSnippet"\s*>/)
  for (const chunk of chunks.slice(1)) {
    if (hits.length >= limit) break
    const titleAnchor = chunk.match(/<a[^>]*data-test-id="snippet-title"[^>]*>/)
    if (titleAnchor === null) continue
    const href = titleAnchor[0].match(/href="([^"]+)"/)?.[1]
    if (href === undefined) continue
    // Path: prefer the parenthesized span, fall back to the href itself.
    const pathSpan = chunk.match(/SearchSnippet-header-path">\(([^)]+)\)/)
    const path = (pathSpan?.[1] ?? href.replace(/^\//, '')).trim()
    if (path.length === 0) continue
    const title = stripTags(
      (chunk.match(/data-test-id="snippet-title"[^>]*>(.*?)<\/a>/s)?.[1] ?? '')
        .replace(/\([^)]*\)/g, ''),
    )
    const synopsis = stripTags(chunk.match(/class="SearchSnippet-synopsis"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '')
    const importedBy = Number(chunk.match(/Imported by\s*<\/span>\s*<strong>([\d,]+)<\/strong>/)?.[1]?.replace(/,/g, '') ?? 0)
    const version = chunk.match(/<strong>(v?\d+\.\d+[^<]*)<\/strong>/)?.[1]
    hits.push({
      path,
      title: title.length > 0 ? title : path,
      ...(synopsis.length > 0 ? { synopsis } : {}),
      ...(importedBy > 0 ? { importedBy } : {}),
      ...(version !== undefined ? { version } : {}),
    })
  }
  return hits
}

/**
 * Search pkg.go.dev for a query; returns Go candidates (canonical import path
 * as name). Parsing failure or an unexpected page shape returns `[]` — this
 * source is enrichment, never a blocker.
 * @throws {import('./http.ts').SourceHttpError} only when the TRANSPORT fails
 * (network/HTTP error) — same contract as the other sources.
 */
export async function searchPkgGoDev(
  query: string,
  ctx: SourceContext,
  limit: number,
): Promise<Candidate[]> {
  const fetcher: Fetcher = ctx.fetch ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs)
  try {
    const response = await fetcher(`https://pkg.go.dev/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': ctx.userAgent, Accept: 'text/html' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for pkg.go.dev/search`)
    }
    const html = await response.text()
    const hits = parsePkgGoDevSearch(html, limit)
    return hits.map(hit => ({
      name: hit.path,
      ecosystem: 'go' as const,
      kind: 'package' as const,
      link: `https://pkg.go.dev/${hit.path}`,
      ...(hit.synopsis !== undefined ? { description: hit.synopsis } : {}),
      ...(hit.version !== undefined ? { version: hit.version } : {}),
      ...(hit.importedBy !== undefined ? { imports: hit.importedBy } : {}),
      sources: ['pkg.go.dev'],
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SourceHttpError(`pkg.go.dev search failed: ${message}`)
  } finally {
    clearTimeout(timer)
  }
}
