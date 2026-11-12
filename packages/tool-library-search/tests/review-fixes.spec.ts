/**
 * Regression tests for the 2026-11 review findings on
 * `@hy-sde-org/dsh-tool-library-search` (dsh-tool-library-review.md). One
 * describe block per claim; every test asserts the FIXED behavior that the
 * original probe demonstrated was broken:
 * 1. GitHub token scoped to api.github.com only.
 * 2. exec.signal observed (pre-aborted calls fetch nothing, settle quiescently).
 * 3. Malformed source responses surface as failures; empty+failed is rendered
 *    as an INCOMPLETE search, never as "nothing exists".
 * 4. Registry identities dedupe exactly (foobar ≠ foo-bar).
 * 5. Repository URL → GitHub raw slug parsing (no `https%3A//HEAD` garbage).
 * 6. Per-embedder model state; embedder probed before README fetching.
 * 7. Structured output (typed candidates + source ledger + presentationMeta).
 * 8. Config/args validation and per-call maxResults resolved BEFORE the pool.
 * 9. README bodies read as a bounded stream (no full 200 KB buffer).
 * 10. Prompt section: concise, visibility-aware, config-toggleable.
 */

import { describe, expect, it, vi } from 'vitest'
import { mergeCandidates, rankCandidates } from '../src/candidates.ts'
import type { Candidate } from '../src/candidates.ts'
import { renderResult, searchLibraries } from '../src/library-search.ts'
import { fetchCandidateReadme, readmeUrlsFor } from '../src/readme.ts'
import { applyLibrarySearchTool } from '../src/tool.ts'
import { apply, LIBRARY_SEARCH_PROMPT_TEXT } from '../src/index.ts'
import { buildLibrarySearchPromptSection } from '../src/prompt.ts'

const CTX = { timeoutMs: 500, userAgent: 'probe', maxResults: 5, perSourceLimit: 3 }

interface CapturedTool {
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<{
    query?: string
    complete?: boolean
    candidates?: unknown[]
    sources?: Array<{ id: string; status: string; hits: number }>
    semanticNote?: string
    text: string
  }>
  output?: { presentationMeta?: (args: unknown, value: unknown) => unknown }
}

function captureTool(config: Parameters<typeof applyLibrarySearchTool>[1]): CapturedTool {
  let captured: CapturedTool | undefined
  const ctx = { tools: { register: (def: never) => { captured = def as unknown as CapturedTool } } }
  applyLibrarySearchTool(ctx as never, config)
  if (captured === undefined) throw new Error('tool never registered')
  return captured
}

function npmBody(names: string[]) {
  return {
    objects: names.map(name => ({
      package: { name, version: '1.0.0', description: `desc of ${name}` },
      downloads: { monthly: 100 },
    })),
  }
}

function stubFetch(routes: Array<{ match: (url: string) => boolean; body: unknown }>) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const route = routes.find(r => r.match(url))
    return new Response(JSON.stringify(route?.body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { seen, fetch }
}

const FAKE = (name: string, ecosystem: Candidate['ecosystem'], extra: Partial<Candidate> = {}): Candidate => ({
  name, ecosystem, kind: ecosystem === 'github' ? 'project' : 'package',
  link: `https://example.com/${name}`, sources: ['test'], ...extra,
})

describe('claim 1: GitHub token is scoped to api.github.com', () => {
  it('never sends the token to deps.dev, npm, crates.io, or pkg.go.dev', async () => {
    const { seen, fetch } = stubFetch([])
    await searchLibraries('yaml', { ...CTX, githubToken: 'ghp_SECRET', fetch })
    const authedUrls = seen.filter(s => s.headers.Authorization !== undefined).map(s => s.url)
    expect(authedUrls.length).toBeGreaterThan(0)
    for (const url of authedUrls) {
      expect(url).toContain('api.github.com')
    }
    for (const url of seen.map(s => s.url)) {
      if (!url.includes('api.github.com')) {
        expect(seen.find(s => s.url === url)?.headers.Authorization).toBeUndefined()
      }
    }
  })
})

describe('claim 2: cancellation is observed', () => {
  it('searchLibraries with a pre-aborted signal fetches nothing', async () => {
    const { seen, fetch } = stubFetch([{
      match: () => true,
      body: npmBody(['pkg0']),
    }])
    const ac = new AbortController()
    ac.abort()
    await expect(searchLibraries('pkg', { ...CTX, fetch, signal: ac.signal })).rejects.toThrow(/aborted/)
    expect(seen).toHaveLength(0)
  })

  it('tool execute with a pre-aborted exec.signal settles without fetching', async () => {
    const { seen, fetch } = stubFetch([{ match: u => u.includes('registry.npmjs.org/-/v1'), body: npmBody(['pkg0']) }])
    const tool = captureTool({ ...CTX, fetch })
    const ac = new AbortController()
    ac.abort()
    const value = await tool.execute({ query: 'pkg' }, { signal: ac.signal })
    expect(value.complete).toBe(false)
    expect(value.candidates).toHaveLength(0)
    expect(seen).toHaveLength(0)
  })
})

describe('claim 3: empty is distinguished from failed', () => {
  it('malformed source responses surface as failures with a per-source ledger', async () => {
    // Every JSON source unrouted → default `{}` → malformed envelope. Only
    // pkg.go.dev is tolerant-by-design, so the call must NOT throw.
    const { fetch } = stubFetch([{ match: u => u.includes('registry.npmjs.org'), body: { oops: true } }])
    const result = await searchLibraries('yaml', { ...CTX, fetch })
    expect(result.candidates).toHaveLength(0)
    expect(result.failures.length).toBeGreaterThanOrEqual(4)
    const failed = result.sources.filter(s => s.status === 'failed').map(s => s.id)
    expect(failed).toEqual(expect.arrayContaining(['npm', 'deps.dev', 'crates.io', 'github']))
    expect(result.sources.find(s => s.id === 'pkg.go.dev')?.status).toBe('ok')
  })

  it('renders zero candidates + failures as an INCOMPLETE search', () => {
    const text = renderResult(
      { candidates: [], sources: [{ id: 'npm', status: 'failed', hits: 0, error: 'HTTP 503' }], failures: ['npm: HTTP 503'] },
      'yaml',
    )
    expect(text).toContain('INCOMPLETE')
    expect(text).toContain('npm: HTTP 503')
    expect(text).not.toContain('No existing package or repository matched')
  })

  it('renders zero candidates with all sources ok as a plain no-match', () => {
    const text = renderResult({ candidates: [], sources: [], failures: [] }, 'xyzzy')
    expect(text).toContain('No existing package or repository matched')
    expect(text).not.toContain('INCOMPLETE')
  })
})

describe('claim 4: registry identities dedupe exactly', () => {
  it('keeps foobar and foo-bar as separate npm candidates', () => {
    const a = FAKE('foobar', 'npm', { link: 'https://www.npmjs.com/package/foobar' })
    const b = FAKE('foo-bar', 'npm', { link: 'https://www.npmjs.com/package/foo-bar', description: 'the one you meant' })
    const merged = mergeCandidates([a, b])
    expect(merged).toHaveLength(2)
    const ranked = rankCandidates(merged, 'foo-bar')
    expect(ranked[0]?.name).toBe('foo-bar')
    expect(ranked[0]?.exactness).toBe(2)
    expect(ranked[0]?.link).toBe('https://www.npmjs.com/package/foo-bar')
  })
})

describe('claim 5: repository URLs parse into GitHub raw slugs', () => {
  it('maps a crates.io repository URL to owner/repo README URLs', () => {
    const urls = readmeUrlsFor(FAKE('serde-yaml', 'cargo', {
      link: 'https://crates.io/crates/serde-yaml',
      repository: 'https://github.com/dtolnay/serde-yaml',
    }))
    expect(urls[0]).toBe('https://raw.githubusercontent.com/dtolnay/serde-yaml/HEAD/README.md')
    expect(urls[1]).toBe('https://raw.githubusercontent.com/dtolnay/serde-yaml/HEAD/README.rst')
  })

  it('handles SCP form and strips .git', () => {
    expect(readmeUrlsFor(FAKE('x', 'cargo', { repository: 'git@github.com:dtolnay/serde-yaml.git' }))[0])
      .toBe('https://raw.githubusercontent.com/dtolnay/serde-yaml/HEAD/README.md')
  })

  it('non-GitHub repositories have no raw lane', () => {
    expect(readmeUrlsFor(FAKE('x', 'cargo', { repository: 'https://gitlab.com/owner/repo' }))).toEqual([])
  })
})

describe('claim 6: embedder state and probing', () => {
  it('each local embedder loads its own model', async () => {
    const loadedModels: string[] = []
    vi.doMock('@huggingface/transformers', () => ({
      pipeline: async (_task: string, model: string) => {
        loadedModels.push(model)
        return async (texts: string[]) => ({ tolist: () => texts.map(() => [1, 0]) })
      },
    }))
    const { createLocalEmbedder } = await import('../src/semantic.ts')
    const a = createLocalEmbedder('modelA')
    await a.embed(['x'])
    const b = createLocalEmbedder('modelB')
    await b.embed(['y'])
    expect(loadedModels).toEqual(['modelA', 'modelB'])
    vi.doUnmock('@huggingface/transformers')
  })

  it('rerankSemantic probes the embedder BEFORE fetching any README', async () => {
    const { seen, fetch } = stubFetch([])
    const { rerankSemantic, SemanticUnavailableError } = await import('../src/semantic.ts')
    const embedder = {
      label: 'broken',
      probe: async (): Promise<void> => { throw new SemanticUnavailableError('peer missing') },
      embed: async (): Promise<readonly (readonly number[])[]> => { throw new Error('should never embed') },
    }
    await expect(rerankSemantic([FAKE('yaml', 'npm', { description: 'd' })], 'yaml', embedder, { ...CTX, fetch }))
      .rejects.toThrow(/peer missing/)
    expect(seen).toHaveLength(0)
  })
})

describe('claim 7: structured output', () => {
  const allSourcesOk = () => stubFetch([
    { match: u => u.includes('registry.npmjs.org/-/v1'), body: npmBody(['left-pad']) },
    { match: u => u.includes('deps.dev'), body: { results: [] } },
    { match: u => u.includes('crates.io'), body: { crates: [] } },
    { match: u => u.includes('api.github.com'), body: { items: [] } },
  ])

  it('execute returns typed candidates + source ledger + markdown text', async () => {
    const { fetch } = allSourcesOk()
    const tool = captureTool({ ...CTX, fetch })
    const value = await tool.execute({ query: 'left-pad' }, { signal: new AbortController().signal })
    expect(value.query).toBe('left-pad')
    expect(value.complete).toBe(true)
    expect(value.candidates?.length).toBeGreaterThan(0)
    expect(value.sources?.length).toBe(5)
    expect(value.text).toContain('left-pad')
  })

  it('presentationMeta exposes a compact UI card payload', async () => {
    const { fetch } = allSourcesOk()
    const tool = captureTool({ ...CTX, fetch })
    const value = await tool.execute({ query: 'left-pad' }, { signal: new AbortController().signal })
    const meta = tool.output?.presentationMeta?.({}, value) as {
      tool?: string
      complete?: boolean
      resultCount?: number
      candidates?: Array<{ name?: string }>
      sources?: Array<{ id?: string }>
    }
    expect(meta.tool).toBe('library_search')
    expect(meta.complete).toBe(true)
    expect(meta.resultCount).toBeGreaterThan(0)
    expect(meta.candidates?.[0]?.name).toBe('left-pad')
    expect(meta.sources).toHaveLength(5)
  })
})

describe('claim 8: validation and effective per-call caps', () => {
  it('args.maxResults resolves BEFORE the search pool (no over-fetch/under-deliver)', async () => {
    const { fetch } = stubFetch([{
      match: u => u.includes('registry.npmjs.org/-/v1'),
      body: npmBody(['pkg0', 'pkg1', 'pkg2', 'pkg3', 'pkg4']),
    }])
    const tool = captureTool({ ...CTX, maxResults: 2, fetch })
    const exec = { signal: new AbortController().signal }
    const bullets = (t: string) => t.split('\n').filter(l => l.startsWith('- ')).length
    expect(bullets((await tool.execute({ query: 'pkg', maxResults: 5 }, exec)).text)).toBe(5)
    expect(bullets((await tool.execute({ query: 'pkg', maxResults: 1 }, exec)).text)).toBe(1)
  })

  it('rejects out-of-bounds args.maxResults', async () => {
    const tool = captureTool({ ...CTX })
    const exec = { signal: new AbortController().signal }
    for (const bad of [0, -1, 1.5, Number.NaN, 101]) {
      await expect(tool.execute({ query: 'pkg', maxResults: bad }, exec)).rejects.toThrow(/maxResults/)
    }
  })

  it('validates config bounds fail-fast at apply', () => {
    expect(() => captureTool({ ...CTX, maxResults: Number.NaN })).toThrow(/maxResults/)
    expect(() => captureTool({ ...CTX, maxResults: 1.5 })).toThrow(/maxResults/)
    expect(() => captureTool({ ...CTX, maxResults: 101 })).toThrow(/maxResults/)
    expect(() => captureTool({ ...CTX, timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => captureTool({ ...CTX, timeoutMs: 200_000 })).toThrow(/timeoutMs/)
    expect(() => captureTool({ ...CTX, perSourceLimit: 501 })).toThrow(/perSourceLimit/)
    expect(() => captureTool({ ...CTX, semanticPoolSize: 0, semantic: true })).toThrow(/semanticPoolSize/)
    expect(() => captureTool({ ...CTX, maxResults: 100, timeoutMs: 120_000, perSourceLimit: 500 })).not.toThrow()
  })
})

describe('claim 9: README bodies are read as a bounded stream', () => {
  it('stops pulling past the byte cap instead of buffering 200 KB', async () => {
    let pulls = 0
    const chunk = new TextEncoder().encode('x'.repeat(10_000))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
        if (pulls >= 20) controller.close()
      },
    })
    const fetch = async (): Promise<Response> => new Response(stream as unknown as BodyInit, { status: 200 })
    const text = await fetchCandidateReadme(
      FAKE('a/b', 'github', { repository: 'a/b' }),
      { timeoutMs: 500, userAgent: 'probe', fetch },
    )
    expect(text).toHaveLength(12_000)
    expect(text?.startsWith('xxx')).toBe(true)
    expect(pulls).toBeLessThan(20) // the full 200 KB was never pulled
  })
})

describe('claim 10: prompt section is concise, visible, and toggleable', () => {
  it('static builder emits the concise text; enabled:false empties it', () => {
    expect(buildLibrarySearchPromptSection().text).toBe(LIBRARY_SEARCH_PROMPT_TEXT)
    expect(buildLibrarySearchPromptSection({ enabled: false }).text).toBe('')
    // No tool-doc duplication: params/ranking/semantic details live in the tool.
    expect(LIBRARY_SEARCH_PROMPT_TEXT).not.toContain('ecosystems')
    expect(LIBRARY_SEARCH_PROMPT_TEXT).not.toContain('Semantic rerank')
    expect(LIBRARY_SEARCH_PROMPT_TEXT.length).toBeLessThan(500)
  })

  it('plugin section text is visibility-aware via ctx.tools.get', () => {
    let registered: unknown
    let visible = true
    let section: { name: string; text: (context: unknown) => string } | undefined
    const ctx = {
      tools: {
        register: (def: never) => { registered = def },
        get: () => (visible ? registered : undefined),
      },
      systemPrompt: { section: (s: never) => { section = s as unknown as { name: string; text: (context: unknown) => string } } },
    }
    apply(ctx as never, {})
    expect(section?.name).toBe('library:search')
    expect(section?.text({})).toBe(LIBRARY_SEARCH_PROMPT_TEXT)
    visible = false
    expect(section?.text({})).toBe('')
  })

  it('config prompt:false suppresses the section entirely', () => {
    let registered: unknown
    let section: { text: (context: unknown) => string } | undefined
    const ctx = {
      tools: {
        register: (def: never) => { registered = def },
        get: () => registered,
      },
      systemPrompt: { section: (s: never) => { section = s as unknown as { text: (context: unknown) => string } } },
    }
    apply(ctx as never, { prompt: false })
    expect(section?.text({})).toBe('')
  })
})
