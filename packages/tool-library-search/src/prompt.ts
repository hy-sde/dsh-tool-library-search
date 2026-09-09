/**
 * `library:search` system-prompt section: tells the model WHEN to reach for
 * `library_search` — the recurring "don't rebuild a wheel" moment — and how
 * to read the ranked answer (exact names first, ecosystems tagged, stars and
 * downloads as fitness signals).
 * @module @hy-sde-org/dsh-tool-library-search/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

const SECTION_NAME = 'library:search'
const SECTION_ORDER = 140

const TEXT = [
  'Before building or reimplementing any library/module/algorithm, check that someone has not already shipped it: call `library_search` with the need as a natural-language query (e.g. "parse yaml", "background job queue") or an exact package name (e.g. "serde_yaml").',
  '`library_search` covers npm, crates.io, Maven, Go, PyPI, RubyGems, and GitHub in one call. Exact-name matches are ranked first regardless of popularity; stars/downloads only break ties, so a small but exactly-named package beats a popular repo with a different name.',
  'Each candidate is tagged with its ecosystem and carries stars (GitHub) or monthly downloads (npm/crates.io) as fitness signals. Use `ecosystems` to restrict to one registry and `language` to bias GitHub results to the implementation language you intend to use.',
  'Semantic rerank (when enabled) embeds the query and each candidate README and re-sorts by similarity — a repo whose README describes exactly what you need can surface even when its name is unrelated, while exact-name matches stay on top.',
  'If the results include a clear match, prefer it over writing new code; cite the chosen package/repo. If nothing matches, say so in one line before building.',
].join('\n')

/**
 * Build the library-search prompt section.
 * @param config - configuration; `enabled: false` disables the section.
 * @returns the {@link PromptSection} to register.
 */
export function buildLibrarySearchPromptSection(config: { enabled?: boolean } = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
