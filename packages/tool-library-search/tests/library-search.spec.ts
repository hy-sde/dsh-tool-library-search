/**
 * Orchestration and tool-mount tests: fan-out tolerance, ecosystem filter,
 * total-failure error, and the full `library_search` tool through a real
 * Cordis bench (tools + systemPrompt services, stubbed fetch).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderResult, searchLibraries } from '../src/library-search.ts'
import type { Fetcher } from '../src/sources/http.ts'
import { applyLibrarySearchTool } from '../src/tool.ts'
import { buildLibrarySearchPromptSection } from '../src/prompt.ts'
import { apply } from '../src/index.ts'
import type { Candidate } from '../src/candidates.ts'

const FAKE = (name: string, ecosystem: Candidate['ecosystem'], extra: Partial<Candidate> = {}): Candidate => ({
  name, ecosystem, kind: ecosystem === 'github' ? 'project' : 'package',
  link: `https://example.com/${name}`, sources: ['test'], ...extra,
})

function routingFetch(routes: Record<string, () => unknown | Promise<unknown>>): Fetcher {
  return async (url) => {
    const key = Object.keys(routes).find(k => url.includes(k))
    if (key === undefined) return new Response('{}', { status: 200 })
    const handler = routes[key]
    if (handler === undefined) return new Response('{}', { status: 200 })
    return new Response(JSON.stringify(await handler()), { status: 200 })
  }
}

const OPTIONS = {
  timeoutMs: 5000,
  userAgent: 'test-agent',
  maxResults: 20,
  perSourceLimit: 8,
  fetch: routingFetch({
    '_/search': () => ({ results: [{ kind: 'PACKAGE', name: 'serde_yaml', system: 'CARGO', defaultVersion: '0.9.33' }] }),
    '-/v1/search': () => ({ objects: [{ package: { name: 'yaml', version: '2.9.0', description: 'YAML parser' }, downloads: { monthly: 100 } }] }),
    'crates.io/api/v1/crates': () => ({ crates: [{ name: 'serde_yaml', max_version: '0.9.34', description: 'YAML', recent_downloads: 50 }] }),
    'api.github.com': () => ({ items: [{ full_name: 'eemeli/yaml', html_url: 'u', description: 'repo', stargazers_count: 1688 }] }),
  }),
}

describe('searchLibraries', () => {
  it('merges across sources and ranks exact-name matches first', async () => {
    const result = await searchLibraries('serde_yaml', OPTIONS)
    expect(result.failures).toHaveLength(0)
    expect(result.candidates[0]?.name).toBe('serde_yaml')
    expect(result.candidates[0]?.sources).toEqual(expect.arrayContaining(['crates.io', 'deps.dev']))
  })

  it('tolerates individual source failures and reports them', async () => {
    const fetch = routingFetch({
      '_/search': () => { throw new Error('boom') },
      'api.github.com': () => ({ items: [{ full_name: 'eemeli/yaml', html_url: 'u', stargazers_count: 1 }] }),
    })
    const result = await searchLibraries('yaml', { ...OPTIONS, fetch })
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.failures.some(f => f.includes('deps.dev'))).toBe(true)
  })

  it('throws only when every source fails', async () => {
    const throwing = async (): Promise<never> => { throw new Error('down') }
    const fetchAllFail: Fetcher = () => throwing().then(() => new Response('{}'))
    await expect(searchLibraries('x', { ...OPTIONS, fetch: fetchAllFail })).rejects.toThrow(/all library-search sources failed/)
  })

  it('filters by ecosystem', async () => {
    const result = await searchLibraries('yaml', OPTIONS, undefined, ['npm', 'github'])
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.every(c => c.ecosystem === 'npm' || c.ecosystem === 'github')).toBe(true)
  })
})

describe('renderResult', () => {
  it('renders empty result as a clear no-match line', () => {
    const text = renderResult({ candidates: [], failures: [] }, 'xyzzy')
    expect(text).toContain('No existing package or repository')
  })

  it('renders candidates with ecosystem, stars, downloads', () => {
    const text = renderResult({
      candidates: [FAKE('yaml', 'npm', { downloads: 1_000_000, description: 'parser' }), FAKE('eemeli/yaml', 'github', { stars: 1688 })],
      failures: [],
    }, 'yaml')
    expect(text).toContain('1.0M/mo')
    expect(text).toContain('1688★')
    expect(text).toContain('parser')
  })
})

describe('library_search tool mount', () => {
  it('registers and executes through ctx.tools with the prompt section', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyLibrarySearchTool(ctx, { fetch: OPTIONS.fetch, timeoutMs: 5000 })
    const section = buildLibrarySearchPromptSection()
    ctx.systemPrompt.section(section)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ls-1'),
      name: 'library_search',
      arguments: { query: 'serde_yaml' },
      agent: { session: { header: { id: 't1', cwd: '' } } } as never,
    })
    expect(result.isError).toBe(false)
    const content = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    expect(content).toContain('serde_yaml')

    await ctx.fiber.dispose()
  })

  it('plugin apply registers tool + prompt and rejects empty query', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { fetch: OPTIONS.fetch, timeoutMs: 5000 })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ls-2'),
      name: 'library_search',
      arguments: { query: '   ' },
      agent: { session: { header: { id: 't2', cwd: '' } } } as never,
    })
    expect(result.isError).toBe(true)

    await ctx.fiber.dispose()
  })

  it('semantic:true reranks with a stub embedder and never errors', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const embedder = {
      label: 'stub',
      async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
        return texts.map((text, index) => (index === 0 ? [1, 0, 0] : [Math.max(0, text.length % 2), 1, 0]))
      },
    }
    // Source routes as in OPTIONS, but README lanes 404 so the test asserts
    // the description-only note deterministically.
    const semanticFetch: Fetcher = async (url, init) => {
      if (url.includes('registry.npmjs.org') || url.includes('raw.githubusercontent.com')) {
        return new Response('', { status: 404 })
      }
      return OPTIONS.fetch(url, init)
    }
    applyLibrarySearchTool(ctx, { fetch: semanticFetch, timeoutMs: 5000, semantic: true, embedder })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ls-3'),
      name: 'library_search',
      arguments: { query: 'serde_yaml' },
      agent: { session: { header: { id: 't3', cwd: '' } } } as never,
    })
    expect(result.isError).toBe(false)
    const content = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    expect(content).toContain('serde_yaml')
    // Every README lane 404'd → the rerank ran on name+description only.
    expect(content).toContain('semantic rerank ran on name+description only')

    await ctx.fiber.dispose()
  })

  it('clips an abusive candidate description so one huge README-ish repo cannot drown the answer', async () => {
    const huge = 'x'.repeat(50_000)
    const result = await searchLibraries('ghost', {
      ...OPTIONS,
      fetch: routingFetch({
        '_/search': () => ({ results: [] }),
        '-/v1/search': () => ({ objects: [] }),
        'crates.io/api/v1/crates': () => ({ crates: [] }),
        'api.github.com': () => ({ items: [{ full_name: 'evil/repo', html_url: 'u', description: huge, stargazers_count: 1 }] }),
      }),
    })
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates[0]?.description?.length).toBe(300)
    const rendered = renderResult(result, 'ghost')
    expect(rendered.length).toBeLessThan(2_000)
    expect(rendered).toContain('…')
  })

  it('semantic:true degrades to lexical ranking when the local embedder is unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // No `embedder` injected: the local transformers.js peer is not installed
    // in this hermetic test env, so rerankSemantic must be caught and noted.
    applyLibrarySearchTool(ctx, { fetch: OPTIONS.fetch, timeoutMs: 5000, semantic: true, embedderModel: 'definitely-nonexistent' })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ls-4'),
      name: 'library_search',
      arguments: { query: 'yaml' },
      agent: { session: { header: { id: 't4', cwd: '' } } } as never,
    })
    expect(result.isError).toBe(false)
    const content = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    expect(content).toContain('semantic rerank unavailable')
    expect(content).toContain('kept lexical ranking')

    await ctx.fiber.dispose()
  })
})
