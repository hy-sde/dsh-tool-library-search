/**
 * crates.io source: the Cargo registry API. Requires a non-default User-Agent
 * (bare clients get 403); returns descriptions and download counts, but no
 * stars, and its ranking is name-oriented — known gaps, documented.
 * @module @hy-sde-org/dsh-tool-library-search/sources/crates
 */

import type { Candidate } from '../candidates.ts'
import { getJson, type SourceContext } from './http.ts'

interface Crate {
  readonly name?: string
  readonly max_version?: string
  readonly description?: string
  readonly downloads?: number
  readonly recent_downloads?: number
  readonly repository?: string
}

interface CratesResponse {
  readonly crates?: Crate[]
}

/**
 * Run one crates.io search and normalize hits to candidates.
 * @throws {SourceHttpError} propagated from the transport layer.
 */
export async function searchCrates(query: string, ctx: SourceContext, limit: number): Promise<Candidate[]> {
  const data = await getJson(
    `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${limit}`,
    ctx,
  ) as CratesResponse
  const candidates: Candidate[] = []
  for (const crate of data.crates ?? []) {
    if (crate.name === undefined) continue
    candidates.push({
      name: crate.name,
      ecosystem: 'cargo',
      kind: 'package',
      link: `https://crates.io/crates/${crate.name}`,
      ...(crate.max_version !== undefined ? { version: crate.max_version } : {}),
      ...(crate.description !== undefined ? { description: crate.description } : {}),
      ...(crate.recent_downloads !== undefined ? { downloads: crate.recent_downloads } : {}),
      ...(crate.repository !== undefined ? { repository: crate.repository } : {}),
      sources: ['crates.io'],
    })
  }
  return candidates
}
