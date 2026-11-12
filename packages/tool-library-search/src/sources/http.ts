/**
 * Shared HTTP spine for `@hy-sde-org/dsh-tool-library-search` sources: a small
 * `fetch` wrapper with a per-call timeout, an optional external cancellation
 * signal, a library-shaped User-Agent (some sources 403 bare clients), and
 * token injection gated to the one endpoint that consumes it (GitHub API).
 *
 * Deliberately does NOT retry: these are free/no-credential endpoints where
 * the failure mode is rate limiting, and a retry loop would deepen the block
 * (the same reasoning behind web-search-public's fast-fail cooldown).
 * @module @hy-sde-org/dsh-tool-library-search/sources/http
 */

/** Transport errors carry this code so fan-out can classify them. */
export class SourceHttpError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'SourceHttpError'
    this.status = status
  }
}

/** Minimal fetch surface so tests can inject a stub; matches `globalThis.fetch`. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/** Options shared by every source call. */
export interface SourceContext {
  /** Per-request transport timeout (ms). */
  readonly timeoutMs: number
  /** User-Agent sent to every endpoint. */
  readonly userAgent: string
  /** Optional bearer token (GitHub). Only ever sent to api.github.com. */
  readonly token?: string
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: Fetcher
  /** External cancellation; aborts every request as soon as it is observed. */
  readonly signal?: AbortSignal
}

/** Inputs for {@link composeAbortSignal}: an external signal plus a timeout. */
export interface AbortComposition {
  /** External cancellation signal, when any. */
  readonly signal?: AbortSignal
  /** Timeout budget (ms); non-finite or non-positive values disable the timer. */
  readonly timeoutMs: number
}

/**
 * Fuse an external cancellation signal with a timeout into one signal.
 * Uses `AbortSignal.any`/`AbortSignal.timeout` (Node >= 22.19, the package's
 * engine floor) so no timer/listener cleanup is required by callers.
 */
export function composeAbortSignal(ctx: AbortComposition): AbortSignal {
  const signals: AbortSignal[] = []
  if (ctx.signal !== undefined) signals.push(ctx.signal)
  if (Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(ctx.timeoutMs))
  }
  return AbortSignal.any(signals)
}

/** True only for the GitHub API origin — the single token-bearing endpoint. */
function isGitHubApiUrl(url: string): boolean {
  try {
    return new URL(url).host === 'api.github.com'
  } catch {
    return false
  }
}

/**
 * Enforce the response ENVELOPE a live API guarantees. An empty result set is
 * legitimate (an empty array passes); a MISSING envelope (`{}`, an error page,
 * a shape change) is a source failure and must surface as one — silently
 * yielding `[]` would render a broken search as "no matches".
 */
export function requireEnvelope(data: unknown, source: string, field: string): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) {
    throw new SourceHttpError(`${source}: malformed response (expected JSON object, got ${data === null ? 'null' : typeof data})`)
  }
  const record = data as Record<string, unknown>
  if (!Array.isArray(record[field])) {
    throw new SourceHttpError(`${source}: malformed response (missing ${field} array)`)
  }
  return record
}

/**
 * GET a JSON endpoint, bounding the whole request with a fused signal
 * (external cancellation + timeout).
 * @throws {@link SourceHttpError} on non-OK status, network failure, or abort.
 */
export async function getJson(url: string, ctx: SourceContext): Promise<unknown> {
  const fetcher = ctx.fetch ?? globalThis.fetch.bind(globalThis)
  const signal = composeAbortSignal(ctx)
  const headers: Record<string, string> = {
    'User-Agent': ctx.userAgent,
    Accept: 'application/json',
  }
  // Bearer tokens go ONLY to the endpoint that consumes them. Attaching a
  // GitHub PAT to deps.dev / npm / crates.io requests would leak a credential
  // to every third-party registry in the fan-out.
  if (ctx.token !== undefined && ctx.token.length > 0 && isGitHubApiUrl(url)) {
    headers.Authorization = `Bearer ${ctx.token}`
  }
  try {
    const response = await fetcher(url, { headers, signal })
    if (!response.ok) {
      throw new SourceHttpError(`HTTP ${response.status} for ${url}`, response.status)
    }
    return await response.json() as unknown
  } catch (error) {
    if (error instanceof SourceHttpError) throw error
    if (ctx.signal?.aborted) {
      throw new SourceHttpError(`aborted for ${url}`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new SourceHttpError(`fetch failed for ${url}: ${message}`)
  }
}
