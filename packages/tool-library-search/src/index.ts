/**
 * `@hy-sde-org/dsh-tool-library-search`: a model-facing `library_search` tool
 * over the FREE package-registry/ repository search APIs (deps.dev for
 * cross-ecosystem existence, npm + crates.io for descriptions/downloads,
 * GitHub repo search for the "someone already built this" signal), merged and
 * ranked by exact-name match first — the answer to "has this already been
 * built?" before anyone writes a new library. No API key required (GitHub
 * token optional to raise the repo-search quota).
 * @module @hy-sde-org/dsh-tool-library-search
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  applyLibrarySearchTool,
  type LibrarySearchToolConfig,
} from './tool.ts'
import { buildLibrarySearchPromptSection } from './prompt.ts'

export {
  ECOSYSTEMS,
  exactness,
  mergeCandidates,
  normCompact,
  rankCandidates,
  tokens,
} from './candidates.ts'
export type { Candidate, CandidateKind, Ecosystem, RankedCandidate } from './candidates.ts'
export {
  LIBRARY_SEARCH_USER_AGENT,
  renderResult,
  searchLibraries,
} from './library-search.ts'
export type {
  LibrarySearchOptions,
  LibrarySearchResult,
} from './library-search.ts'
export {
  applyLibrarySearchTool,
} from './tool.ts'
export type {
  LibrarySearchToolConfig,
  ResolvedLibrarySearchToolConfig,
} from './tool.ts'
export {
  buildLibrarySearchPromptSection,
} from './prompt.ts'
export { getJson, SourceHttpError } from './sources/http.ts'
export type { Fetcher, SourceContext } from './sources/http.ts'
export { searchCrates } from './sources/crates.ts'
export { searchDepsDev } from './sources/depsdev.ts'
export { searchGithub } from './sources/github.ts'
export { searchNpm } from './sources/npm.ts'
export { parsePkgGoDevSearch, searchPkgGoDev } from './sources/pkggodev.ts'
export type { PkgGoDevHit } from './sources/pkggodev.ts'
export { fetchCandidateDocuments, fetchCandidateReadme, readmeUrlsFor } from './readme.ts'
export type { CandidateDocument } from './readme.ts'
export {
  cosineSimilarity,
  createLocalEmbedder,
  DEFAULT_EMBEDDER_MODEL,
  rerankSemantic,
  SemanticUnavailableError,
} from './semantic.ts'
export type { Embedder } from './semantic.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-library-search'

/** Services required by the tool + prompt section. */
export const inject = ['tools', 'systemPrompt']

/**
 * Register the `library_search` tool and its prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: LibrarySearchToolConfig = {}): void {
  applyLibrarySearchTool(ctx, config)
  ctx.systemPrompt.section(buildLibrarySearchPromptSection())
}

/** Cordis plugin object for `@hy-sde-org/dsh-tool-library-search`. */
export default { name, inject, apply }
