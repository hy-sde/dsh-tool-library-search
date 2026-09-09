/**
 * `library_search` tool definition: one model-facing tool over the
 * cross-ecosystem "has this already been built?" search engine
 * ({@link searchLibraries}). Registers into `ctx.tools` with a strict
 * parameter schema (query required; ecosystems/language/maxResults optional)
 * and renders the ranked candidates as compact markdown.
 * @module @hy-sde-org/dsh-tool-library-search/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  DefineToolOptions,
  ParameterSchemaSpec,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import { ECOSYSTEMS, type Ecosystem } from './candidates.ts'
import {
  LIBRARY_SEARCH_USER_AGENT,
  renderResult,
  searchLibraries,
  type LibrarySearchOptions,
} from './library-search.ts'
import { createLocalEmbedder, rerankSemantic, type Embedder } from './semantic.ts'
import type { SourceContext } from './sources/http.ts'

/**
 * `defineTool` passthrough that additionally accepts the fork's `device`
 * device-catalog marker. The published `@deepseek-ai/dsh-tools` types predate
 * that option (it landed in the harness's in-repo registry), so the marker
 * rides a widened but fully typed options shape; a consumer registry without
 * the device concept simply ignores it at runtime.
 */
function defineLibrarySearchTool<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O> & { device?: boolean },
) {
  return defineTool<S, O>(options)
}

/** Plugin-configurable tool settings (all optional; defaults apply). */
export interface LibrarySearchToolConfig {
  /** Per-source transport timeout (ms). Default 10000. */
  timeoutMs?: number
  /** Default result cap after merge+rank. Default 15. */
  maxResults?: number
  /** Per-source hit cap before merge. Default 8. */
  perSourceLimit?: number
  /** Optional GitHub token (raises repo-search quota 10/min → 30/min). */
  githubToken?: string
  /** User-Agent sent to free endpoints. Default: a library-shaped identifier. */
  userAgent?: string
  /** Fetch implementation (test seam). Defaults to global fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /**
   * Enable semantic rerank: embed the query and each candidate's README
   * (local transformers.js by default) and re-sort by similarity, keeping
   * exact-name matches on top. Default false (keeps the base package
   * dependency-free; the rerank needs the optional `@huggingface/transformers`
   * peer — without it, requests degrade to lexical ranking with a note).
   */
  semantic?: boolean
  /** Embedder implementation (test seam). Default: local transformers.js. */
  embedder?: Embedder
  /** Model id for the local embedder. Default Xenova/all-MiniLM-L6-v2. */
  embedderModel?: string
  /** How many top-lexical candidates enter the semantic rerank. Default 50. */
  semanticPoolSize?: number
}

/** Resolved options after defaults. */
export interface ResolvedLibrarySearchToolConfig extends LibrarySearchOptions {}

/** Output schema: every search resolves to one text document. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

/**
 * Register the `library_search` tool.
 * @param ctx - Cordis context carrying `tools`.
 * @param config - tool-level configuration.
 */
export function applyLibrarySearchTool(ctx: Context, config: LibrarySearchToolConfig = {}): void {
  const semanticEnabled = config.semantic === true
  const options: LibrarySearchOptions = {
    timeoutMs: config.timeoutMs ?? 10_000,
    userAgent: config.userAgent ?? LIBRARY_SEARCH_USER_AGENT,
    maxResults: config.maxResults ?? 15,
    perSourceLimit: config.perSourceLimit ?? 8,
    ...(config.githubToken !== undefined && config.githubToken.length > 0 ? { githubToken: config.githubToken } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(semanticEnabled ? { poolSize: config.semanticPoolSize ?? 50 } : {}),
  }
  if (options.timeoutMs < 1) throw new Error('tool-library-search: timeoutMs must be a positive integer')
  if (options.maxResults < 1) throw new Error('tool-library-search: maxResults must be a positive integer')
  if (options.perSourceLimit < 1) throw new Error('tool-library-search: perSourceLimit must be a positive integer')
  const embedder = config.embedder ?? createLocalEmbedder(config.embedderModel)
  const rerankCtx: SourceContext = {
    timeoutMs: options.timeoutMs,
    userAgent: options.userAgent,
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(config.githubToken !== undefined && config.githubToken.length > 0 ? { token: config.githubToken } : {}),
  }

  ctx.tools.register(defineLibrarySearchTool({
    name: 'library_search',
    device: true,
    description:
      'Search npm, crates.io, Maven, Go, PyPI, RubyGems, and GitHub for existing packages/repositories matching a query — before writing a new library or reimplementing a wheel. Best for: "is there already a lib that does X?", "what is the canonical/<name> for Y?", "name that one npm package". Exact-name queries surface the package itself; natural-language queries surface well-known repos and packages ranked by stars/downloads and, when semantic rerank is enabled, by README similarity to the query. Optional `ecosystems` narrows to specific registries; `language` biases GitHub repo results (e.g. rust, typescript); `maxResults` caps the answer.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language need or exact package/repo name, e.g. "parse yaml" or "serde_yaml".' },
      ecosystems: {
        type: 'array',
        items: { type: 'string', enum: [...ECOSYSTEMS] },
        description: 'Restrict to registries: npm, cargo, maven, go, pypi, rubygems, nuget, github. Omit to search everything.',
      },
      language: { type: 'string', description: 'GitHub language bias, e.g. rust, typescript, python. Only affects GitHub repo results.' },
      maxResults: { type: 'integer', description: 'Upper bound on returned candidates (default 15).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const query = args.query.trim()
      if (query.length === 0) throw new Error('library_search: query must not be empty')
      const result = await searchLibraries(
        query,
        options,
        args.language !== undefined && args.language.length > 0 ? args.language : undefined,
        args.ecosystems !== undefined && args.ecosystems.length > 0 ? args.ecosystems as Ecosystem[] : undefined,
      )
      const maxResults = args.maxResults !== undefined ? args.maxResults : options.maxResults
      let candidates = result.candidates
      let semanticNote: string | undefined
      if (semanticEnabled && candidates.length > 0) {
        try {
          const { ranked, usedReadmes } = await rerankSemantic(candidates, query, embedder, rerankCtx)
          candidates = ranked
          if (usedReadmes === 0) {
            semanticNote = '(semantic rerank ran on name+description only — no READMEs were reachable this call)'
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const detail = message.replace(/^semantic rerank unavailable: /, '')
          semanticNote = `(semantic rerank unavailable (${detail}); kept lexical ranking)`
        }
      }
      const capped = { ...result, candidates: candidates.slice(0, maxResults) }
      return { text: renderResult(capped, query, args.language, semanticNote) }
    },
  }))
}
