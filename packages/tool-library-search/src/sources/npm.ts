/**
 * npm source: the registry's own search endpoint. Of the free set this is the
 * best *description* search — it matches package metadata, not just names,
 * and returns live monthly/weekly download counts. No auth, no key.
 * @module @hy-sde-org/dsh-tool-library-search/sources/npm
 */

import type { Candidate } from '../candidates.ts'
import { getJson, type SourceContext } from './http.ts'

interface NpmSearchObject {
  readonly package?: {
    readonly name?: string
    readonly version?: string
    readonly description?: string
    readonly links?: { readonly repository?: string; readonly homepage?: string }
  }
  readonly downloads?: { readonly monthly?: number }
}

interface NpmSearchResponse {
  readonly objects?: NpmSearchObject[]
}

/**
 * Run one npm registry search and normalize hits to candidates.
 * @throws {SourceHttpError} propagated from the transport layer.
 */
export async function searchNpm(query: string, ctx: SourceContext, limit: number): Promise<Candidate[]> {
  const data = await getJson(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`,
    ctx,
  ) as NpmSearchResponse
  const candidates: Candidate[] = []
  for (const object of data.objects ?? []) {
    const pkg = object.package
    if (pkg?.name === undefined) continue
    const link = normalizeLink(pkg.links?.repository ?? pkg.links?.homepage ?? `https://www.npmjs.com/package/${pkg.name}`)
    candidates.push({
      name: pkg.name,
      ecosystem: 'npm',
      kind: 'package',
      link,
      ...(pkg.version !== undefined ? { version: pkg.version } : {}),
      ...(pkg.description !== undefined ? { description: pkg.description } : {}),
      ...(object.downloads?.monthly !== undefined ? { downloads: object.downloads.monthly } : {}),
      sources: ['npm'],
    })
  }
  return candidates
}

/**
 * npm `repository`/`homepage` fields are often `git+https://…` or `git://…`,
 * and the GUI cannot open those as https links; normalize to https and strip
 * the trailing `.git` so a rendered markdown link actually opens. Order
 * matters: `git://` must become `https://` BEFORE the optional `git+` prefix
 * is dropped, or `git://` collapses to `://`.
 */
export function normalizeLink(link: string): string {
  return link
    .replace(/^git:\/\//, 'https://')
    .replace(/^git\+/, '')
    .replace(/\.git(#.*)?$/, (_, fragment: string | undefined) => fragment ?? '')
    .replace(/#.*$/, '')
}
