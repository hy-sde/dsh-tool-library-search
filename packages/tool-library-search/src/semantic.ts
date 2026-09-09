/**
 * Semantic rerank layer: embed the query and each candidate's README (or
 * description-only doc), cosine-match, and re-sort the pool. The contract —
 * exact-name matches (exactness 2) stay a hard top tier — is preserved; the
 * semantic signal reorders everything else, which is exactly where name-based
 * ranking misleads (a repo called `saphyr` is THE yaml parser, `pulldown-cmark`
 * IS a markdown parser, but neither name says so).
 *
 * Two embedders:
 * - {@link createLocalEmbedder}: transformers.js (optional peer
 *   `@huggingface/transformers`) running a small all-MiniLM-L6-v2 locally —
 *   free, offline after first download, no key. Deliberately a dynamically
 *   imported OPTIONAL peer so the package stays dependency-free: without it,
 *   semantic rerank degrades to lexical ranking with a note.
 * - Tests inject a stub embedder through the same {@link Embedder} interface.
 *
 * Vector math is deliberately plain JS (no ndarray dependency): `embed()`
 * returns one unit vector per text (embedders should normalize; cosine is
 * still computed defensively).
 * @module @hy-sde-org/dsh-tool-library-search/semantic
 */

import type { Candidate } from './candidates.ts'
import { exactness, popularityScore } from './candidates.ts'
import { fetchCandidateDocuments } from './readme.ts'
import type { SourceContext } from './sources/http.ts'

/** Text-embedding provider. One vector per input text; nalgebra not needed. */
export interface Embedder {
  /** Human-readable model label for diagnostics/notes. */
  readonly label: string
  /** Embed a batch of texts; returns one unit-ish vector per text. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

/** Raised when semantic rerank is requested but no embedder is available. */
export class SemanticUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SemanticUnavailableError'
  }
}

/** Cosine similarity of two vectors (defensive against zero-norm inputs). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Rerank scoring per candidate. Contract: exact-name matches (exactness 2,
 * i.e. the package with THIS name exists) are a hard top tier — nothing can
 * unseat them. Below that, README similarity (weight 800) leads, a full
 * name-token match (exactness 1) is only a +300 head start (a repo whose
 * README says exactly what you need beats a package whose NAME merely
 * contains the query tokens but does something else), and popularity breaks
 * close calls.
 */
function semanticScore(exact: number, similarity: number, popularity: number): number {
  if (exact === 2) return 1_000_000 + similarity * 800 + popularity
  return similarity * 800 + popularity + exact * 300
}

/**
 * Rerank a pool by query-embedding × document-embedding similarity.
 *
 * Pipeline: fetch READMEs (bounded concurrency, per-candidate failure
 * tolerance) → one batched embed([query, ...docs]) → cosine → re-sort
 * preserving the exact-name-first contract.
 *
 * @param candidates - the ranked pool (already lexical-ranked).
 * @param query - the original query (embedded).
 * @param embedder - embedding provider (stub in tests).
 * @param ctx - source context (UA/timeout/fetch seam) for README fetches.
 * @returns the re-ranked candidates (with `similarity` attached) + diagnostics.
 * @throws {@link SemanticUnavailableError} when the embedder cannot run;
 * the caller decides whether to degrade or fail.
 */
export async function rerankSemantic(
  candidates: readonly Candidate[],
  query: string,
  embedder: Embedder,
  ctx: SourceContext,
): Promise<{ ranked: readonly (Candidate & { similarity: number })[]; usedReadmes: number; docsChecked: number }> {
  const docs = await fetchCandidateDocuments(candidates, ctx)
  const texts = [query, ...docs.map(document => document.text)]
  const vectors = await embedder.embed(texts)
  const queryVector = vectors[0]
  if (queryVector === undefined || vectors.length !== texts.length) {
    throw new SemanticUnavailableError(`semantic rerank: embedder returned ${vectors.length} vectors for ${texts.length} texts`)
  }

  const ranked = candidates.map((candidate, index) => {
    const doc = docs[index]
    const vector = vectors[index + 1]
    const similarity = vector === undefined || doc === undefined ? 0 : cosineSimilarity(queryVector, vector)
    const exact = exactness(candidate.name, query)
    return {
      ...candidate,
      similarity,
      score: semanticScore(exact, similarity, popularityScore(candidate)),
    }
  })
  ranked.sort((a, b) => b.score - a.score || (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name))
  return {
    ranked,
    usedReadmes: docs.filter(document => document.hasReadme).length,
    docsChecked: docs.length,
  }
}

/** Model used by {@link createLocalEmbedder} when none is configured. */
export const DEFAULT_EMBEDDER_MODEL = 'Xenova/all-MiniLM-L6-v2'

let localPipelinePromise: Promise<{
  extractor: (texts: string[], options: { pooling: string; normalize: boolean }) => Promise<{ tolist(): number[][] }>
} | null> | null = null

/**
 * Create a local transformers.js embedder (all-MiniLM-L6-v2, quantized).
 * The `@huggingface/transformers` package is an OPTIONAL peer: it is
 * dynamically imported here, so the rest of the package works without it.
 * The first `embed()` call downloads/caches the model (~25 MB); subsequent
 * calls reuse the loaded pipeline.
 * @param model - HF model id (default {@link DEFAULT_EMBEDDER_MODEL}).
 * @throws {@link SemanticUnavailableError} when the peer is not installed.
 */
export function createLocalEmbedder(model: string = DEFAULT_EMBEDDER_MODEL): Embedder {
  return {
    label: `local:${model}`,
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      const pipeline = await loadLocalPipeline(model)
      if (pipeline === null) {
        throw new SemanticUnavailableError(
          'semantic rerank unavailable: `@huggingface/transformers` is not installed. '
          + 'Install it alongside this package (optional peer) or disable `semantic` config.',
        )
      }
      const output = await pipeline.extractor([...texts], { pooling: 'mean', normalize: true })
      return output.tolist()
    },
  }
}

/** Load + memoize the transformers.js feature-extraction pipeline. */
async function loadLocalPipeline(model: string): Promise<
  { extractor: (texts: string[], options: { pooling: string; normalize: boolean }) => Promise<{ tolist(): number[][] }> } | null
> {
  if (localPipelinePromise === null) {
    localPipelinePromise = (async () => {
      try {
        // Computed specifier: keeps the OPTIONAL peer out of static type
        // resolution (it is not installed in base deployments) while still
        // allowing a deployment that installed it to be picked up lazily.
        const moduleName = '@huggingface/transformers'
        const mod = await import(moduleName) as {
          pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<unknown>
        }
        const pipeline = mod.pipeline
        return {
          extractor: await pipeline('feature-extraction', model, { dtype: 'q8' }) as unknown as {
            (texts: string[], options: { pooling: string; normalize: boolean }): Promise<{ tolist(): number[][] }>
          },
        }
      } catch {
        return null
      }
    })()
  }
  const result = await localPipelinePromise
  if (result === null) localPipelinePromise = null // let a later install retry
  return result
}
