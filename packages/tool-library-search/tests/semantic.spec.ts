/**
 * Semantic rerank tests: cosine math, exact-name-first contract preservation
 * (a semantic winner must NOT unseat an exact-name match), README-similarity
 * promotion of a name-mismatched but on-point repo, description-only docs,
 * and embedder failure tolerance. All hermetic: stub embedder + stub fetch.
 */

import { describe, expect, it } from 'vitest'
import type { Candidate } from '../src/candidates.ts'
import type { Embedder } from '../src/semantic.ts'
import {
  cosineSimilarity,
  rerankSemantic,
  SemanticUnavailableError,
} from '../src/semantic.ts'
import type { Fetcher, SourceContext } from '../src/sources/http.ts'

const CTX: SourceContext = { timeoutMs: 5000, userAgent: 'test-agent' }

const pkg = (name: string, ecosystem: Candidate['ecosystem'], extra: Partial<Candidate> = {}): Candidate => ({
  name, ecosystem, kind: ecosystem === 'github' ? 'project' : 'package',
  link: `https://example.com/${name}`, sources: ['test'], ...extra,
})

/** Deterministic "embedding": text → vector table (first text = query). */
function makeStubEmbedder(table: Record<string, number[]>, queryVector: number[] = [1, 0, 0]): Embedder {
  return {
    label: 'stub',
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      return texts.map((text, index) => {
        if (index === 0) return queryVector
        const known = Object.keys(table).find(key => text.includes(key))
        return known !== undefined ? table[known] ?? [] : [0, 1, 0]
      })
    },
  }
}

/** Stub fetch: known routes, else 404 (so READMEs exist only where planned). */
function routingFetch(routes: Record<string, () => unknown | Promise<unknown>>): Fetcher {
  return async (url) => {
    const key = Object.keys(routes).find(k => url.includes(k))
    if (key === undefined) return new Response('', { status: 404 })
    const handler = routes[key]
    if (handler === undefined) return new Response('', { status: 404 })
    return new Response(JSON.stringify(await handler()), { status: 200 })
  }
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1)
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0)
  })

  it('handles length mismatch and zero vectors defensively', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0)
  })
})

describe('rerankSemantic', () => {
  const candidates = [
    pkg('yaml_parser', 'cargo', { description: 'nothing', repository: 'x/yaml_parser' }),
    pkg('saphyr-rs/saphyr', 'github', {
      description: 'A set of crates dedicated to parsing YAML.', stars: 336, repository: 'saphyr-rs/saphyr',
    }),
    pkg('yaml-eslint-parser', 'npm', {
      description: 'A YAML parser that produces output compatible with ESLint', downloads: 11_100_000,
    }),
  ]
  const fetch = routingFetch({
    'raw.githubusercontent.com/saphyr-rs/saphyr': () => ({ readme: 'Parsing YAML in Rust with comments support' }),
  })

  it('keeps exact-name matches first even when their README is unrelated', async () => {
    // yaml_parser: exact-name (2) but README about nginx → sim 0.
    // saphyr: non-exact but README perfectly on point (sim ~1).
    const embedder = makeStubEmbedder({
      'Parsing YAML in Rust': [1, 0, 0],
      'nginx config': [0, 1, 0],
      'ESLint': [0.6, 0, 0.8],
    })
    const { ranked, usedReadmes } = await rerankSemantic(candidates, 'yaml parser', embedder, { ...CTX, fetch })
    expect(ranked[0]?.name).toBe('yaml_parser')
    expect(ranked[0]?.similarity).toBe(0)
    expect(usedReadmes).toBeGreaterThanOrEqual(1)
  })

  it('promotes a README-relevant repo above a weak name match', async () => {
    // saphyr full semantic match (sim 1) vs yaml-eslint-parser weak match
    // (sim 0.5): 800 + popularity vs 0.5*800 + 300(exactness-1) + popularity.
    const embedder = makeStubEmbedder({
      'Parsing YAML in Rust': [1, 0, 0],
      'nginx config': [0, 1, 0],
      'ESLint': [0.5, 0, 0.866],
    })
    const { ranked } = await rerankSemantic(candidates, 'yaml parser', embedder, { ...CTX, fetch })
    const names = ranked.map(candidate => candidate.name)
    expect(names.indexOf('saphyr-rs/saphyr')).toBeLessThan(names.indexOf('yaml-eslint-parser'))
  })

  it('embeds description-only text when no README lane exists (maven)', async () => {
    const maven = pkg('org.yaml:snakeyaml', 'maven', { description: 'YAML parser for Java' })
    const mavenVector = [0.9, 0.43589, 0]
    const embedder = makeStubEmbedder({ 'YAML parser for Java': mavenVector })
    const { ranked } = await rerankSemantic([...candidates, maven], 'yaml parser', embedder, { ...CTX, fetch })
    const found = ranked.find(candidate => candidate.name === 'org.yaml:snakeyaml')
    expect(found?.similarity).toBeCloseTo(cosineSimilarity([1, 0, 0], mavenVector), 4)
  })

  it('throws SemanticUnavailableError when the embedder returns a wrong vector count', async () => {
    const broken: Embedder = {
      label: 'broken',
      async embed() { return [[1, 0, 0]] },
    }
    await expect(rerankSemantic(candidates, 'yaml parser', broken, { ...CTX, fetch })).rejects.toThrow(SemanticUnavailableError)
  })
})
