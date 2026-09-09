/**
 * deps.dev source: the ONE free endpoint that searches across every registry
 * (npm, cargo, maven, go, pypi, rubygems, nuget) plus GitHub projects, no key
 * required. Its search is NAME-based — a natural-language query like
 * "yaml parser" returns zero matches — so this source is the ecosystem
 * *existence* check: "does a package with this name exist anywhere?"
 *
 * Endpoint note: the documented `api.deps.dev/v3alpha/search` is gone (404
 * as of 2026-09); the site's own JSON endpoint `https://deps.dev/_/search`
 * still answers, so this source uses that (undocumented, best-effort).
 * @module @hy-sde-org/dsh-tool-library-search/sources/depsdev
 */

import type { Candidate, Ecosystem } from '../candidates.ts'
import { getJson, type SourceContext } from './http.ts'

/** Whole set of names deps.dev search can surface. */
const DEPSDEV_SYSTEM_TO_ECOSYSTEM: Readonly<Record<string, Ecosystem>> = {
  NPM: 'npm',
  CARGO: 'cargo',
  MAVEN: 'maven',
  GO: 'go',
  PYPI: 'pypi',
  RUBYGEMS: 'rubygems',
  NUGET: 'nuget',
}

interface DepsDevResult {
  readonly kind: 'PACKAGE' | 'PROJECT'
  readonly name: string
  readonly system?: string | null
  readonly projectType?: string
  readonly defaultVersion?: string | null
}

interface DepsDevSearchResponse {
  readonly results?: DepsDevResult[]
}

/**
 * Run one deps.dev name search and normalize hits to candidates.
 * @throws {@link SourceHttpError} propagated from the transport layer.
 */
export async function searchDepsDev(query: string, ctx: SourceContext, limit: number): Promise<Candidate[]> {
  const data = await getJson(`https://deps.dev/_/search?q=${encodeURIComponent(query)}`, ctx) as DepsDevSearchResponse
  const results = data.results ?? []
  const candidates: Candidate[] = []
  for (const result of results.slice(0, limit)) {
    if (result.kind === 'PROJECT') {
      // GitHub project entry: `owner/repo`.
      candidates.push({
        name: result.name,
        ecosystem: 'github',
        kind: 'project',
        link: `https://github.com/${result.name}`,
        repository: result.name,
        sources: ['deps.dev'],
      })
      continue
    }
    const ecosystem = result.system === undefined || result.system === null
      ? undefined
      : DEPSDEV_SYSTEM_TO_ECOSYSTEM[result.system]
    const name = result.name
    const system = result.system?.toLowerCase() ?? ''
    candidates.push({
      name,
      ecosystem: ecosystem ?? 'github',
      kind: ecosystem === 'github' ? 'project' : 'package',
      link: `https://deps.dev/${system}/${encodeURIComponent(name)}`,
      ...(result.defaultVersion ? { version: result.defaultVersion } : {}),
      sources: ['deps.dev'],
    })
  }
  return candidates
}
