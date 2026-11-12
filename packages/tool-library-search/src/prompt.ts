/**
 * `library:search` system-prompt section: tells the model WHEN to reach for
 * `library_search` (the recurring "don't rebuild a wheel" moment) and how to
 * weigh an incomplete answer. Deliberately short — parameter and ranking
 * details live in the tool's own description, not here.
 * @module @hy-sde-org/dsh-tool-library-search/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Section name in the assembled system prompt. */
export const LIBRARY_SEARCH_SECTION_NAME = 'library:search'

/** Section order (near the other tool guidance sections). */
export const LIBRARY_SEARCH_SECTION_ORDER = 140

/**
 * Guidance text. Two sentences: when to call the tool, and how to treat a
 * partial result (a failed source means "incomplete", never "nothing exists").
 */
export const LIBRARY_SEARCH_PROMPT_TEXT = [
  'Before building or reimplementing any library/module/algorithm, check `library_search` first; if a clear match exists, prefer and cite it, and if nothing matches, say so in one line before building.',
  'The result lists per-source status: when any source failed the search was incomplete — retry or narrow the query instead of concluding that nothing exists.',
].join('\n')

/**
 * Build the library-search prompt section.
 * @param config - configuration; `enabled: false` forces the section empty
 *   (visibility-aware emission is wired at the plugin level, which passes a
 *   context-dependent `text` function instead of a static string).
 * @returns the {@link PromptSection} to register.
 */
export function buildLibrarySearchPromptSection(config: { enabled?: boolean } = {}): PromptSection {
  return {
    name: LIBRARY_SEARCH_SECTION_NAME,
    order: LIBRARY_SEARCH_SECTION_ORDER,
    text: config.enabled === false ? '' : LIBRARY_SEARCH_PROMPT_TEXT,
  }
}
