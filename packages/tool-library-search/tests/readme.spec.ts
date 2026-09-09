/**
 * README lane tests: URL planning per ecosystem, npm registry `readme` field,
 * GitHub raw fetch, 404/absence tolerance, and bounded-concurrency batching.
 * All hermetic via a stubbed fetch.
 */

import { describe, expect, it } from 'vitest'
import type { Candidate } from '../src/candidates.ts'
import {
  fetchCandidateDocuments,
  fetchCandidateReadme,
  README_MAX_CHARS,
  readmeUrlsFor,
} from '../src/readme.ts'
import type { Fetcher, SourceContext } from '../src/sources/http.ts'

const CTX: SourceContext = { timeoutMs: 5000, userAgent: 'test-agent' }

const pkg = (name: string, ecosystem: Candidate['ecosystem'], extra: Partial<Candidate> = {}): Candidate => ({
  name, ecosystem, kind: ecosystem === 'github' ? 'project' : 'package',
  link: `https://example.com/${name}`, sources: ['test'], ...extra,
})

function routingFetch(routes: Record<string, () => unknown | Promise<unknown>>): Fetcher {
  return async (url) => {
    const key = Object.keys(routes).find(k => url.includes(k))
    if (key === undefined) return new Response('', { status: 404 })
    const handler = routes[key]
    if (handler === undefined) return new Response('', { status: 404 })
    const body = await handler()
    if (body === null) return new Response('', { status: 404 })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }
}

describe('readmeUrlsFor', () => {
  it('plans an npm registry JSON fetch for npm candidates', () => {
    expect(readmeUrlsFor(pkg('yaml', 'npm'))).toEqual(['https://registry.npmjs.org/yaml'])
  })

  it('plans GitHub raw README.md + README.rst when a repository is known', () => {
    expect(readmeUrlsFor(pkg('eemeli/yaml', 'github', { repository: 'eemeli/yaml' }))).toEqual([
      'https://raw.githubusercontent.com/eemeli/yaml/HEAD/README.md',
      'https://raw.githubusercontent.com/eemeli/yaml/HEAD/README.rst',
    ])
    expect(readmeUrlsFor(pkg('serde_yaml', 'cargo', { repository: 'dtolnay/serde-yaml' }))).toEqual([
      'https://raw.githubusercontent.com/dtolnay/serde-yaml/HEAD/README.md',
      'https://raw.githubusercontent.com/dtolnay/serde-yaml/HEAD/README.rst',
    ])
  })

  it('returns no lane for ecosystems without a repository (maven/go/pypi via deps.dev)', () => {
    expect(readmeUrlsFor(pkg('org.yaml:snakeyaml', 'maven'))).toEqual([])
  })
})

describe('fetchCandidateReadme', () => {
  it('extracts the npm registry readme field', async () => {
    const fetch = routingFetch({ 'registry.npmjs.org': () => ({ readme: '# yaml\n\n yaml lib' }) })
    const url = readmeUrlsFor(pkg('yaml', 'npm'))[0]
    expect(url).toBeDefined()
    const text = await fetchCandidateReadme(pkg('yaml', 'npm'), { ...CTX, fetch })
    expect(text).toBe('# yaml\n\n yaml lib')
  })

  it('truncates oversized READMEs to README_MAX_CHARS', async () => {
    const fetch = routingFetch({ 'raw.githubusercontent.com': () => 'x'.repeat(README_MAX_CHARS + 1000) })
    const text = await fetchCandidateReadme(pkg('eemeli/yaml', 'github', { repository: 'eemeli/yaml' }), { ...CTX, fetch })
    expect(text?.length).toBe(README_MAX_CHARS)
  })

  it('falls through to README.rst when README.md 404s', async () => {
    let calls = 0
    const fetch = routingFetch({
      'raw.githubusercontent.com': () => {
        calls += 1
        return calls === 1 ? null : 'rst content'
      },
    })
    const text = await fetchCandidateReadme(pkg('eemeli/yaml', 'github', { repository: 'eemeli/yaml' }), { ...CTX, fetch })
    expect(text).toBe('rst content')
  })

  it('returns undefined (never throws) when every lane fails', async () => {
    const fetch: Fetcher = async () => new Response('', { status: 403 })
    await expect(
      fetchCandidateReadme(pkg('yaml', 'npm'), { ...CTX, fetch }),
    ).resolves.toBeUndefined()
  })
})

describe('fetchCandidateDocuments', () => {
  it('produces one document per candidate with hasReadme and description fallback', async () => {
    const fetch = routingFetch({
      'raw.githubusercontent.com': () => 'README body',
      'registry.npmjs.org': () => ({ readme: 'npm readme' }),
    })
    const candidates = [
      pkg('yaml', 'npm', { description: 'npm desc' }),
      pkg('eemeli/yaml', 'github', { repository: 'eemeli/yaml', description: 'github desc' }),
      pkg('org.yaml:snakeyaml', 'maven', { description: 'maven desc' }),
    ]
    const docs = await fetchCandidateDocuments(candidates, { ...CTX, fetch }, 2)
    expect(docs).toHaveLength(3)
    expect(docs[0]).toMatchObject({ key: 'npm:yaml', hasReadme: true })
    expect(docs[0]?.text).toContain('npm desc')
    expect(docs[0]?.text).toContain('npm readme')
    expect(docs[1]?.text).toContain('README body')
    expect(docs[2]).toMatchObject({ hasReadme: false })
    expect(docs[2]?.text).toBe('maven desc')
  })

  it('still yields a document when a fetch rejects (never throws)', async () => {
    const fetch: Fetcher = async () => { throw new Error('network down') }
    const docs = await fetchCandidateDocuments([pkg('yaml', 'npm', { description: 'only desc' })], { ...CTX, fetch })
    expect(docs[0]).toMatchObject({ key: 'npm:yaml', hasReadme: false })
    expect(docs[0]?.text).toBe('only desc')
  })
})
