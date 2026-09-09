/**
 * pkg.go.dev source tests: SearchSnippet HTML parsing (structure verified
 * live 2026-09-06) and candidate mapping. Hermetic via stubbed fetch.
 */

import { describe, expect, it } from 'vitest'
import { parsePkgGoDevSearch, searchPkgGoDev } from '../src/sources/pkggodev.ts'
import { SourceHttpError, type Fetcher, type SourceContext } from '../src/sources/http.ts'

const CTX: SourceContext = { timeoutMs: 5000, userAgent: 'test-agent' }

// Trimmed from the real page; three snippet shapes are covered: full card,
// no-synopsis card, and bare card (no imports/version).
const FIXTURE = `<!doctype html><html><body>
<div class="SearchSnippet" >
  <div class="SearchSnippet-headerContainer">
    <h2>
      <a href="/gopkg.in/yaml.v3" data-gtmc="search result" data-test-id="snippet-title"
          data-search-query="yaml" data-rank="0">
        yaml
        <span class="SearchSnippet-header-path">(gopkg.in/yaml.v3)</span>
      </a>
    </h2>
  </div>
  <p class="SearchSnippet-synopsis" data-test-id="snippet-synopsis">
    Package yaml implements YAML support for the Go language.
  </p>
  <div class="SearchSnippet-infoLabel">
    <a href="/gopkg.in/yaml.v3?tab=importedby" aria-label="Go to Imported By">
       <span class="go-textSubtle">Imported by </span><strong>34,113</strong>
    </a>
    <span class="go-textSubtle">|</span>
    <span class="go-textSubtle">
      <strong>v3.0.1</strong> published on <strong>May 27, 2022</strong>
    </span>
  </div>
</div>
<div class="SearchSnippet" >
  <div class="SearchSnippet-headerContainer">
    <h2>
      <a href="/sigs.k8s.io/yaml" data-test-id="snippet-title">
        sigs.k8s.io/yaml
        <span class="SearchSnippet-header-path">(sigs.k8s.io/yaml)</span>
      </a>
    </h2>
  </div>
  <div class="SearchSnippet-infoLabel">
    <a href="/sigs.k8s.io/yaml?tab=importedby"><span class="go-textSubtle">Imported by </span><strong>9,501</strong></a>
    <span class="go-textSubtle">|</span><span class="go-textSubtle"><strong>v1.4.0</strong> published on <strong>Aug 11, 2023</strong></span>
  </div>
</div>
<div class="SearchSnippet" >
  <div class="SearchSnippet-headerContainer">
    <h2>
      <a href="/gopkg.in/yaml.v2" data-test-id="snippet-title">
        yaml
        <span class="SearchSnippet-header-path">(gopkg.in/yaml.v2)</span>
      </a>
    </h2>
  </div>
</div>
</body></html>`

describe('parsePkgGoDevSearch', () => {
  it('parses path, title, synopsis, importedBy and version from a full card', () => {
    const [hit] = parsePkgGoDevSearch(FIXTURE, 10)
    expect(hit).toEqual({
      path: 'gopkg.in/yaml.v3',
      title: 'yaml',
      synopsis: 'Package yaml implements YAML support for the Go language.',
      importedBy: 34_113,
      version: 'v3.0.1',
    })
  })

  it('handles cards without synopsis and cards without imports/version', () => {
    const hits = parsePkgGoDevSearch(FIXTURE, 10)
    expect(hits).toHaveLength(3)
    expect(hits[1]).toEqual({ path: 'sigs.k8s.io/yaml', title: 'sigs.k8s.io/yaml', importedBy: 9_501, version: 'v1.4.0' })
    expect(hits[2]).toEqual({ path: 'gopkg.in/yaml.v2', title: 'yaml' })
  })

  it('does not double-parse a card because of the headerContainer wrapper', () => {
    const hits = parsePkgGoDevSearch(FIXTURE, 10)
    expect(hits.map(hit => hit.path)).toEqual([
      'gopkg.in/yaml.v3',
      'sigs.k8s.io/yaml',
      'gopkg.in/yaml.v2',
    ])
  })

  it('respects the limit and returns [] for a structurally unexpected page', () => {
    expect(parsePkgGoDevSearch(FIXTURE, 1)).toHaveLength(1)
    expect(parsePkgGoDevSearch('<html>no snippets</html>', 5)).toEqual([])
  })
})

describe('searchPkgGoDev', () => {
  const htmlFetch: Fetcher = async () => new Response(FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } })

  it('maps hits to Go candidates with imports as popularity', async () => {
    const result = await searchPkgGoDev('yaml', { ...CTX, fetch: htmlFetch }, 5)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({
      name: 'gopkg.in/yaml.v3',
      ecosystem: 'go',
      kind: 'package',
      link: 'https://pkg.go.dev/gopkg.in/yaml.v3',
      version: 'v3.0.1',
      imports: 34_113,
      description: 'Package yaml implements YAML support for the Go language.',
      sources: ['pkg.go.dev'],
    })
  })

  it('throws SourceHttpError on transport errors (HTTP 403, like the other sources)', async () => {
    const failing: Fetcher = async () => new Response('', { status: 403 })
    await expect(searchPkgGoDev('yaml', { ...CTX, fetch: failing }, 5)).rejects.toThrow(SourceHttpError)
  })
})
