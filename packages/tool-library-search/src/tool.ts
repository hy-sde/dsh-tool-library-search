/**
 * `library_search` tool definition: one model-facing tool over the
 * cross-ecosystem "has this already been built?" search engine
 * ({@link searchLibraries}). Registers into `ctx.tools` with a strict
 * parameter schema (query required; ecosystems/language/maxResults optional),
 * a STRUCTURED output schema (typed candidates + per-source status ledger)
 * whose markdown projection is rendered for the model, exec-signal threading
 * (every network leg observes cancellation), and fail-fast config validation.
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
  /** Per-source transport timeout (ms). Default 10000. Bounds 1–120000. */
  timeoutMs?: number
  /** Default result cap after merge+rank. Default 15. Bounds 1–100. */
  maxResults?: number
  /** Per-source hit cap before merge. Default 8. Bounds 1–500. */
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
  /** How many top-lexical candidates enter the semantic rerank. Default 50. Bounds 1–500. */
  semanticPoolSize?: number
  /**
   * Emit the system-prompt guidance section for this tool. Default true.
   * The section is visibility-aware: it renders nothing for tool sets or
   * scopes where `library_search` is not registered.
   */
  prompt?: boolean
}

/** Resolved options after defaults. */
export interface ResolvedLibrarySearchToolConfig extends LibrarySearchOptions {}

/** Fail-fast config bounds, validated once at plugin apply. */
const CONFIG_BOUNDS = {
  timeoutMs: { min: 1, max: 120_000 },
  maxResults: { min: 1, max: 100 },
  perSourceLimit: { min: 1, max: 500 },
  semanticPoolSize: { min: 1, max: 500 },
} as const

/** Positive-integer bound check with a self-locating error message. */
function validateBound(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`tool-library-search: ${name} must be an integer between ${min} and ${max} (got ${value})`)
  }
}

/** One ranked candidate in the structured output. */
interface OutputCandidate {
  readonly name: string
  readonly ecosystem: string
  readonly kind: string
  readonly link: string
  readonly description?: string
  readonly version?: string
  readonly stars?: number
  readonly downloads?: number
  readonly imports?: number
  readonly sources: string[]
}

/** One fan-out source attempt in the structured output. */
interface OutputSourceStatus {
  readonly id: string
  readonly status: 'ok' | 'failed' | 'skipped'
  readonly hits: number
  readonly error?: string
}

/** Structured tool output: typed data for callers/UI, `text` for the model. */
interface LibrarySearchToolOutput {
  readonly query: string
  readonly language?: string
  /** false when at least one queried source failed — the answer may be incomplete. */
  readonly complete: boolean
  readonly candidates: OutputCandidate[]
  readonly sources: OutputSourceStatus[]
  readonly semanticNote?: string
  /** Markdown projection of the result (what the model reads). */
  readonly text: string
}

/** Structured output schema: candidates + per-source ledger + markdown text. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    language: { type: 'string' },
    complete: { type: 'boolean', required: true },
    candidates: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          ecosystem: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          link: { type: 'string', required: true },
          description: { type: 'string' },
          version: { type: 'string' },
          stars: { type: 'integer' },
          downloads: { type: 'integer' },
          imports: { type: 'integer' },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    sources: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          hits: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
    },
    semanticNote: { type: 'string' },
    text: { type: 'string', required: true },
  },
} as const

/**
 * Register the `library_search` tool.
 * @param ctx - Cordis context carrying `tools`.
 * @param config - tool-level configuration.
 * @throws when a numeric config value is out of bounds (fail fast at apply).
 */
export function applyLibrarySearchTool(ctx: Context, config: LibrarySearchToolConfig = {}): void {
  const semanticEnabled = config.semantic === true
  if (config.timeoutMs !== undefined) validateBound('timeoutMs', config.timeoutMs, CONFIG_BOUNDS.timeoutMs.min, CONFIG_BOUNDS.timeoutMs.max)
  if (config.maxResults !== undefined) validateBound('maxResults', config.maxResults, CONFIG_BOUNDS.maxResults.min, CONFIG_BOUNDS.maxResults.max)
  if (config.perSourceLimit !== undefined) validateBound('perSourceLimit', config.perSourceLimit, CONFIG_BOUNDS.perSourceLimit.min, CONFIG_BOUNDS.perSourceLimit.max)
  if (config.semanticPoolSize !== undefined) validateBound('semanticPoolSize', config.semanticPoolSize, CONFIG_BOUNDS.semanticPoolSize.min, CONFIG_BOUNDS.semanticPoolSize.max)
  const options: LibrarySearchOptions = {
    timeoutMs: config.timeoutMs ?? 10_000,
    userAgent: config.userAgent ?? LIBRARY_SEARCH_USER_AGENT,
    maxResults: config.maxResults ?? 15,
    perSourceLimit: config.perSourceLimit ?? 8,
    ...(config.githubToken !== undefined && config.githubToken.length > 0 ? { githubToken: config.githubToken } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(semanticEnabled ? { poolSize: config.semanticPoolSize ?? 50 } : {}),
  }
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
      'Search npm, crates.io, Maven, Go, PyPI, RubyGems, and GitHub for existing packages/repositories matching a query — before writing a new library or reimplementing a wheel. Best for: "is there already a lib that does X?", "what is the canonical/<name> for Y?", "name that one npm package". Exact-name queries surface the package itself; natural-language queries surface well-known repos and packages ranked by stars/downloads and, when semantic rerank is enabled, by README similarity to the query. Optional `ecosystems` narrows to specific registries; `language` biases GitHub repo results (e.g. rust, typescript); `maxResults` caps the answer. The result reports per-source status: when a source failed, the answer may be incomplete — treat "no match" with suspicion and retry.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language need or exact package/repo name, e.g. "parse yaml" or "serde_yaml".' },
      ecosystems: {
        type: 'array',
        items: { type: 'string', enum: [...ECOSYSTEMS] },
        description: 'Restrict to registries: npm, cargo, maven, go, pypi, rubygems, nuget, github. Omit to search everything.',
      },
      language: { type: 'string', description: 'GitHub language bias, e.g. rust, typescript, python. Only affects GitHub repo results.' },
      maxResults: { type: 'integer', description: 'Upper bound on returned candidates, 1–100 (default 15).' },
    },
    // No tool-level `timeoutMs` budget: the tool bounds itself with per-source
    // transport timeouts plus README byte caps, and the optional local-model
    // semantic rerank has no meaningful wall-clock upper bound on first load.
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        tool: 'library_search',
        query: value.query,
        ...(value.language !== undefined ? { language: value.language } : {}),
        complete: value.complete,
        resultCount: value.candidates.length,
        candidates: value.candidates.slice(0, 5).map(candidate => ({
          name: candidate.name,
          ecosystem: candidate.ecosystem,
          link: candidate.link,
          ...(candidate.version !== undefined ? { version: candidate.version } : {}),
          ...(candidate.stars !== undefined ? { stars: candidate.stars } : {}),
        })),
        sources: value.sources.map(source => ({ id: source.id, status: source.status, hits: source.hits })),
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec.signal
      const query = args.query.trim()
      if (query.length === 0) throw new Error('library_search: query must not be empty')
      if (args.maxResults !== undefined) {
        validateBound('maxResults', args.maxResults, CONFIG_BOUNDS.maxResults.min, CONFIG_BOUNDS.maxResults.max)
      }
      const language = args.language !== undefined && args.language.length > 0 ? args.language : undefined
      const ecosystems = args.ecosystems !== undefined && args.ecosystems.length > 0 ? args.ecosystems as Ecosystem[] : undefined
      // Effective cap resolved BEFORE the search so the fetch pool is sized to
      // the actual ask (no over-fetching when the caller wants fewer results).
      const maxResults = args.maxResults ?? options.maxResults
      // Abort settles: the executor classifies a returned-while-aborted body
      // as an aborted call, so stop work and return instead of throwing.
      const abortedOutput: LibrarySearchToolOutput = {
        query,
        ...(language !== undefined ? { language } : {}),
        complete: false,
        candidates: [],
        sources: [],
        text: '',
      }
      if (signal?.aborted) return abortedOutput
      const result = await searchLibraries(query, { ...options, maxResults }, language, ecosystems)
      if (signal?.aborted) return abortedOutput
      let candidates = result.candidates
      let semanticNote: string | undefined
      if (semanticEnabled && candidates.length > 0) {
        try {
          const rerankOptions: SourceContext = signal !== undefined ? { ...rerankCtx, signal } : rerankCtx
          const { ranked, usedReadmes } = await rerankSemantic(candidates, query, embedder, rerankOptions)
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
      if (signal?.aborted) return abortedOutput
      const capped = { ...result, candidates: candidates.slice(0, maxResults) }
      const output: LibrarySearchToolOutput = {
        query,
        ...(language !== undefined ? { language } : {}),
        complete: result.failures.length === 0,
        candidates: capped.candidates.map(candidate => ({
          name: candidate.name,
          ecosystem: candidate.ecosystem,
          kind: candidate.kind,
          link: candidate.link,
          ...(candidate.description !== undefined ? { description: candidate.description } : {}),
          ...(candidate.version !== undefined ? { version: candidate.version } : {}),
          ...(candidate.stars !== undefined ? { stars: candidate.stars } : {}),
          ...(candidate.downloads !== undefined ? { downloads: candidate.downloads } : {}),
          ...(candidate.imports !== undefined ? { imports: candidate.imports } : {}),
          sources: [...candidate.sources],
        })),
        sources: result.sources.map(source => ({
          id: source.id,
          status: source.status,
          hits: source.hits,
          ...(source.error !== undefined ? { error: source.error } : {}),
        })),
        ...(semanticNote !== undefined ? { semanticNote } : {}),
        text: renderResult(capped, query, language, semanticNote),
      }
      return output
    },
  }))
}
