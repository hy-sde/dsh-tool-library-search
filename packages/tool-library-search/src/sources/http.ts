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

import type { Candidate } from '../candidates.ts'

/** Transport errors carry this code so fan-out can classify them. */
export class SourceHttpError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'SourceHttpError'
    this.status = status
  }
}

/**
 * Upstream ran but REPORTED incomplete coverage (e.g. GitHub's
 * `incomplete_results` flag). Any hits collected so far are real and ride
 * along in `partial`; the ledger records the gap, because a truncated search
 * rendered as a clean success would let a model conclude "nothing exists"
 * from data GitHub itself says may be missing.
 */
export class SourceIncompleteError extends SourceHttpError {
  /** Hits gathered before upstream reported the gap (may be empty). */
  readonly partial: readonly Candidate[]

  constructor(message: string, partial: readonly Candidate[] = []) {
    super(message)
    this.name = 'SourceIncompleteError'
    this.partial = partial
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

/**
 * Filter envelope items down to the records this source can actually use.
 * Item-level validation guards against a partially-malformed page: one
 * nameless entry must not crash the whole fan-out (an undefined `name` used
 * to escape as a TypeError and kill the entire search, taking healthy
 * sources' candidates down with it). But an envelope where NOTHING parses is
 * a shape change, not "no hits", and fails the source outright.
 */
export function takeValid<T>(
  items: readonly unknown[],
  isUsable: (item: T) => boolean,
  source: string,
  field: string,
): T[] {
  const valid: T[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    if (isUsable(item as T)) valid.push(item as T)
  }
  if (items.length > 0 && valid.length === 0) {
    throw new SourceHttpError(`${source}: malformed response (${items.length} ${field}, none parseable)`)
  }
  return valid
}

/** Result of {@link readBodyCapped}: decoded text plus whether the cap hit. */
export interface CappedBody {
  /** UTF-8 text read before the cap (or the whole body when under it). */
  readonly text: string
  /** True when the byte cap or the signal stopped the stream early. */
  readonly truncated: boolean
}

/**
 * Read a response body as a UTF-8 stream up to `maxBytes`, then stop pulling.
 *
 * Byte-exact: only the remaining permitted bytes of each chunk are decoded —
 * `decoder.decode(slice, { stream: true })` keeps a cut multi-byte code point
 * pending inside the decoder — so a hostile 200 KB chunk cannot push 200 KB of
 * string through a 64 KB cap. Stream cancellation is AWAITED: the helper
 * settles only after teardown ran, and a failing `cancel()` is swallowed so it
 * never masks the original read error. Once `signal` aborts, no further chunks
 * are pulled.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<CappedBody> {
  const body = response.body
  if (body === null) return { text: '', truncated: false }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let bytes = 0
  let text = ''
  let truncated = false
  try {
    for (;;) {
      if (signal?.aborted) {
        truncated = true
        break
  }
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - bytes
      if (remaining <= 0) {
        truncated = true
        break
}
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
      bytes += slice.byteLength
      text += decoder.decode(slice, { stream: true })
      if (bytes >= maxBytes) truncated = true
      if (truncated) break
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Stream teardown failures must not mask the original read error.
    }
  }
  if (!truncated) text += decoder.decode()
  return { text, truncated }
}
