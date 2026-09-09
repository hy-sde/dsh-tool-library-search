/**
 * Shared HTTP spine for `@hy-sde-org/dsh-tool-library-search` sources: a small
 * `fetch` wrapper with a per-call timeout, a library-shaped User-Agent (some
 * sources 403 bare clients), and optional token injection (GitHub search).
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
  /** Optional bearer token (GitHub). */
  readonly token?: string
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: Fetcher
}

/**
 * GET a JSON endpoint, bounding the whole request with an abort timer.
 * @throws {@link SourceHttpError} on non-OK status, network failure, or timeout.
 */
export async function getJson(url: string, ctx: SourceContext): Promise<unknown> {
  const fetcher = ctx.fetch ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs)
  const headers: Record<string, string> = {
    'User-Agent': ctx.userAgent,
    Accept: 'application/json',
  }
  if (ctx.token !== undefined && ctx.token.length > 0) {
    headers.Authorization = `Bearer ${ctx.token}`
  }
  try {
    const response = await fetcher(url, { headers, signal: controller.signal })
    if (!response.ok) {
      throw new SourceHttpError(`HTTP ${response.status} for ${url}`, response.status)
    }
    return await response.json() as unknown
  } catch (error) {
    if (error instanceof SourceHttpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new SourceHttpError(`fetch failed for ${url}: ${message}`)
  } finally {
    clearTimeout(timer)
  }
}
