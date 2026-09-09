/**
 * Source-parsing tests: each free source's response mapping is pinned with a
 * stubbed fetch (Response objects like Node 22's global fetch produces).
 * Hermetic — no network.
 */

import { describe, expect, it } from 'vitest'
import type { Fetcher, SourceContext } from '../src/sources/http.ts'
import { searchDepsDev } from '../src/sources/depsdev.ts'
import { normalizeLink, searchNpm } from '../src/sources/npm.ts'
import { searchCrates } from '../src/sources/crates.ts'
import { searchGithub } from '../src/sources/github.ts'

function stubFetch(routes: Record<string, unknown>): Fetcher {
  return async (url) => {
    const key = Object.keys(routes).find(k => url.includes(k))
    if (key === undefined) throw new Error(`unexpected url: ${url}`)
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

const ctx = (routes: Record<string, unknown>): SourceContext => ({
  timeoutMs: 5000,
  userAgent: 'test-agent',
  fetch: stubFetch(routes),
})

describe('searchDepsDev', () => {
  it('maps PACKAGE hits to their ecosystem and link', async () => {
    const result = await searchDepsDev('yaml', ctx({
      '_/search': {
        totalMatches: 2,
        results: [
          { kind: 'PACKAGE', name: 'yaml', system: 'NPM', defaultVersion: '2.9.0' },
          { kind: 'PACKAGE', name: 'org.yaml:snakeyaml', system: 'MAVEN', defaultVersion: '2.7' },
        ],
      },
    }), 8)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ name: 'yaml', ecosystem: 'npm', kind: 'package', version: '2.9.0', sources: ['deps.dev'] })
    expect(result[0]?.link).toBe('https://deps.dev/npm/yaml')
    expect(result[1]?.ecosystem).toBe('maven')
  })

  it('maps PROJECT hits to github candidates', async () => {
    const result = await searchDepsDev('saphyr', ctx({
      '_/search': {
        results: [
          { kind: 'PROJECT', name: 'saphyr-rs/saphyr', projectType: 'GITHUB' },
        ],
      },
    }), 8)
    expect(result[0]).toMatchObject({ name: 'saphyr-rs/saphyr', ecosystem: 'github', kind: 'project' })
    expect(result[0]?.link).toBe('https://github.com/saphyr-rs/saphyr')
  })

  it('refuses to die on missing fields', async () => {
    const result = await searchDepsDev('x', ctx({ '_/search': { results: [{ kind: 'PACKAGE', name: 'x', system: null }] } }), 8)
    expect(result[0]?.name).toBe('x')
  })
})

describe('normalizeLink', () => {
  it('turns git://repo and git+https://repo into clickable https links', () => {
    expect(normalizeLink('git://github.com/h4evr/yaml-parser.git')).toBe('https://github.com/h4evr/yaml-parser')
    expect(normalizeLink('git+https://github.com/ota-meshi/yaml-eslint-parser.git')).toBe('https://github.com/ota-meshi/yaml-eslint-parser')
    expect(normalizeLink('https://github.com/eemeli/yaml')).toBe('https://github.com/eemeli/yaml')
    expect(normalizeLink('https://github.com/micromark/micromark.git#main')).toBe('https://github.com/micromark/micromark')
  })
})

describe('searchNpm', () => {
  it('maps objects with description + monthly downloads', async () => {
    const result = await searchNpm('yaml', ctx({
      '-/v1/search': {
        objects: [
          { package: { name: 'yaml', version: '2.9.0', description: 'parser', links: { repository: 'https://github.com/eemeli/yaml' } }, downloads: { monthly: 782_824_751 } },
        ],
      },
    }), 5)
    expect(result[0]).toMatchObject({
      name: 'yaml', ecosystem: 'npm', kind: 'package',
      description: 'parser', downloads: 782_824_751,
    })
    expect(result[0]?.link).toBe('https://github.com/eemeli/yaml')
  })
})

describe('searchCrates', () => {
  it('maps crates with recent downloads and repository', async () => {
    const result = await searchCrates('serde_yaml', ctx({
      'crates.io/api/v1/crates': {
        crates: [
          { name: 'serde_yaml', max_version: '0.9.34', description: 'YAML support', downloads: 5_942_618, recent_downloads: 4_590_835, repository: 'https://github.com/dtolnay/serde-yaml' },
        ],
      },
    }), 5)
    expect(result[0]).toMatchObject({
      name: 'serde_yaml', ecosystem: 'cargo', kind: 'package',
      version: '0.9.34', downloads: 4_590_835, repository: 'https://github.com/dtolnay/serde-yaml',
    })
    expect(result[0]?.link).toBe('https://crates.io/crates/serde_yaml')
  })
})

describe('searchGithub', () => {
  it('maps repos with stars and adds the language qualifier', async () => {
    let requested = ''
    const fetcher: Fetcher = async (url) => {
      requested = url
      return new Response(JSON.stringify({
        items: [{ full_name: 'saphyr-rs/saphyr', html_url: 'https://github.com/saphyr-rs/saphyr', description: 'YAML crates', stargazers_count: 336 }],
      }), { status: 200 })
    }
    const result = await searchGithub('yaml parser', { timeoutMs: 5000, userAgent: 't', fetch: fetcher }, 5, 'rust')
    expect(requested).toContain('language%3Arust')
    expect(result[0]).toMatchObject({ name: 'saphyr-rs/saphyr', ecosystem: 'github', stars: 336, repository: 'saphyr-rs/saphyr' })
  })

  it('never pages without a token (one request regardless of the limit)', async () => {
    const urls: string[] = []
    const fetcher: Fetcher = async (url) => {
      urls.push(url)
      const items = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}`, stargazers_count: 100 - i }))
      return new Response(JSON.stringify({ items }), { status: 200 })
    }
    const result = await searchGithub('yaml', { timeoutMs: 5000, userAgent: 't', fetch: fetcher }, 250)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('page=1')
    expect(result).toHaveLength(100) // one page cap = 100
  })

  it('pages to satisfy the limit when a token is present', async () => {
    const urls: string[] = []
    const fetcher: Fetcher = async (url) => {
      urls.push(url)
      const page = new URL(url).searchParams.get('page') ?? '1'
      const n = Number(page)
      const count = n === 1 ? 100 : 50
      const items = Array.from({ length: count }, (_, i) => ({ full_name: `o/r${n}-${i}`, stargazers_count: 100 }))
      return new Response(JSON.stringify({ items }), { status: 200 })
    }
    const result = await searchGithub('yaml', { timeoutMs: 5000, userAgent: 't', token: 'ghp_x', fetch: fetcher }, 150)
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('page=2')
    expect(result).toHaveLength(150)
  })

  it('stops paging early once enough candidates are collected and slices to limit', async () => {
    const urls: string[] = []
    const fetcher: Fetcher = async (url) => {
      urls.push(url)
      const items = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}`, stargazers_count: 100 }))
      return new Response(JSON.stringify({ items }), { status: 200 })
    }
    const result = await searchGithub('yaml', { timeoutMs: 5000, userAgent: 't', token: 'ghp_x', fetch: fetcher }, 250, undefined, 3)
    expect(urls).toHaveLength(3) // 100 + 100 + 50 needed? no: 3 pages * 100 = 300 >= 250 → stops after 3rd
    expect(result).toHaveLength(250)
  })
})
