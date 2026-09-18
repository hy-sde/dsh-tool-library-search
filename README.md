# dsh-tool-library-search — "has this already been built?" for DeepSeek Harness

One standalone package, installable as **one plugin row**, for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-tool-library-search` | the plugin: model-facing `library_search` tool + `library:search` prompt section (`hy-sde-libsearch-tool-library-search` row) | yes |

`library_search` answers "has someone already built this?" **before** the
model writes a new library or reimplements a wheel: one call fans the query
out to the free, no-credential registry sources concurrently — deps.dev
(cross-ecosystem existence), npm + crates.io (descriptions/downloads),
pkg.go.dev (Go module descriptions), GitHub repo search (the semantic
"someone already built this" signal) — merges the hits, and ranks
**exact-name matches first** (popularity only breaks ties). Optional
semantic rerank (`semantic: true`, bundled default) embeds the query and each
candidate's README and re-sorts by cosine similarity, catching libraries
whose name does not contain the query ("saphyr" IS the Rust YAML parser).

No API key, no fetch provider, no service realm: it mounts as one plain
agent-plane row like the harness's own tool rows and consumes the stock
`tools` + `systemPrompt` host services.

## The surface

- **`library_search [query] [ecosystems] [language] [maxResults]`** — one
  natural-language need or exact package name (default ecosystems: all of
  `npm | cargo | maven | go | pypi | rubygems | nuget | github`).
- Each candidate is tagged with its ecosystem and carries GitHub stars or
  monthly downloads as fitness signals, plus the sources that reported it
  (cross-source agreement is a confidence co-signal).
- **`library:search` prompt section** — registered by the same plugin, no
  separate prompt row — teaches the model when to reach for it.
- Descriptions are clipped to 300 chars before ranking; README retrieval is
  best-effort per candidate (registry `readme` fields or
  `raw.githubusercontent.com/…/README.md`).

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-library-search
```

### From this repository (pre-publish)

```bash
pnpm install                              # workspace setup
pnpm -r --filter './packages/*' build
pnpm -r --filter './packages/*' pack      # defaults to prebuilt dist/ (prepack rebuilds)
dsh plugin --profile web add "$PWD/packages/tool-library-search/hy-sde-org-….tgz"
```

## Mounting

The package declares a DSH bundle (`dsh.bundle.patch` → `cordis.patch.yml`),
so `dsh plugin` inserts one row (id `hy-sde-libsearch-tool-library-search` —
the `hy-sde-` row prefix avoids clashing with any shipped row of the same
name). Override per deployment by patching the row by id, e.g.:

```yaml
- id: hy-sde-libsearch-tool-library-search
  config:
    githubToken: ghp_xxx   # raises GitHub search quota 10/min -> 30/min
    timeoutMs: 12000
    maxResults: 20
    perSourceLimit: 8      # >100 walks page= links (≤5 pages) with a token
    semantic: false        # disable the README-similarity rerank layer
```

`semantic: true` embeds the query + READMEs locally (all-MiniLM-L6-v2 via the
OPTIONAL peer `@huggingface/transformers`, ~25 MB one-time download, no key);
without that peer the tool still answers with lexical ranking and notes that
the rerank was unavailable, so enabling it by default is safe.

## Data sources (verified live, 2026-09-06)

| Source | Notes |
|---|---|
| deps.dev `/_/search` | name-existence across npm/cargo/maven/go/pypi/rubygems/nuget + GitHub projects; Maven/PyPI live here (no usable free search elsewhere). Undocumented endpoint — best-effort. |
| npm `registry.npmjs.org/-/v1/search` | best free description search + monthly downloads |
| crates.io `/api/v1/crates` | Cargo descriptions + downloads; requires a library-shaped User-Agent (bare clients get 403) |
| GitHub `/search/repositories` | semantic-ish leader; **10 searches/min unauthenticated**, 30/min with a token; code search is out of scope |
| pkg.go.dev `/search` | Go modules with synopsis + "Imported by"; HTML-only, regex-parsed `SearchSnippet` cards — shape change yields 0 hits (never fails the call; deps.dev still covers Go names) |

Excluded after live probing: libraries.io (401), OpenLib (403), PyPI search
(behind a client challenge), Maven solrsearch (`q=yaml` misses snakeyaml),
api.deps.dev/v3alpha (404). Full ranking/rerank details in the package
README.

## Develop

```bash
pnpm install
pnpm -r --filter './packages/*' check    # tsc --noEmit
pnpm -r --filter './packages/*' test     # vitest run (fixture-based HTTP seams)
pnpm -r --filter './packages/*' build    # tsc -p tsconfig.build.json
pnpm run release:check                   # non-publishing release gate
```

Renderer code never hits the live web in `pnpm test` — source calls accept an
injected fetch seam and parser tests use fixture pages.

## License

MIT — see [LICENSE](./LICENSE) and [packages/tool-library-search/LICENSE](./packages/tool-library-search/LICENSE).

See also: [packages/tool-library-search/README.md](./packages/tool-library-search/README.md) (full package
docs), [SECURITY.md](./SECURITY.md), [CONTRIBUTING.md](./CONTRIBUTING.md),
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
