---
description: "Model-facing library_search tool that answers 'has this already been built?' across npm, crates.io, Maven, Go, PyPI, RubyGems, and GitHub — free no-key APIs, exact-name ranked, stars/downloads as fitness signals."
kind: "package-reference"
---

# @hy-sde-org/dsh-tool-library-search

English | [中文](README.zh.md)

## Summary

`dsh-tool-library-search` gives the model one tool — `library_search` — whose whole job is to answer "has someone already built this?" before it writes a new library or reimplements a wheel. One call fans the query out to the **free, no-credential** data sources concurrently (deps.dev for cross-ecosystem existence, npm + crates.io for descriptions/downloads, GitHub repo search for the semantic "someone already built this" signal), merges the hits, and ranks **exact-name matches first** — popularity only breaks ties, so a small exactly-named package beats a popular repo with a different name.

The included `library:search` prompt section teaches the model when to reach for it.

## Tool surface

- `library_search [query] [ecosystems] [language] [maxResults]` — one natural-language need or exact package name, e.g. `"parse yaml"` or `"serde_yaml"`.
  - `ecosystems` — restrict to `npm | cargo | maven | go | pypi | rubygems | nuget | github` (default: all).
  - `language` — GitHub language bias (e.g. `rust`, `typescript`); only affects GitHub repo results.
  - `maxResults` — upper bound on returned candidates (default 20).

Each candidate is tagged with its ecosystem and carries GitHub stars or monthly downloads as fitness signals, plus the sources that reported it (cross-source agreement is a confidence co-signal).

## Data sources (verified live, 2026-09-06)

| Source | Why it's in | Limits |
|---|---|---|
| **deps.dev** `deps.dev/_/search` | The ONE call that knows names across npm/cargo/maven/go/pypi/rubygems/nuget + GitHub projects. Maven/PyPI have no usable free search, so this is their only lane. | Name-based: natural-language queries return 0 hits. Undocumented endpoint — treat as best-effort. |
| **npm** `registry.npmjs.org/-/v1/search` | Best free description search of the set + monthly downloads. | No explicit quota; heavy bursts may throttle. |
| **crates.io** `crates.io/api/v1/crates` | Cargo descriptions + downloads. | Requires a non-default User-Agent (bare clients get 403). Name-oriented ranking. |
| **GitHub** `api.github.com/search/repositories` | The semantic-ish leader: matches names AND descriptions, star-sorted, optional language bias. | **10 searches/min unauthenticated** (30/min with a token); code search requires authentication and is out of scope. Never pages without a token; with one, `perSourceLimit` above 100 walks `page=` links (≤5 pages, each = 1 search) to feed the semantic pool. |
| **pkg.go.dev** `pkg.go.dev/search` | Go modules: the only free source that DESCRIBES Go for a natural-language query (synopsis + "Imported by" count; canonical import path as name). | **HTML-only, no JSON API** — the `SearchSnippet` cards are regex-parsed; a page-shape change yields 0 hits (never fails the call; deps.dev still covers Go names). |

Excluded after live probing: **libraries.io** (API key required, 401), **OpenLib** (bot-protected, 403), **PyPI search** (XML-RPC removed; `/search` behind a client challenge), **Maven solrsearch** (`q=yaml` does not even surface `org.yaml:snakeyaml` in the top 30 — only `a:<artifact>` field queries work), **api.deps.dev/v3alpha/search** (404).

## Ranking

1. **Exact-name match** (2) — the name or its last path segment equals the query after compaction (`serde_yaml` ≡ `serde-yaml` ≡ `serdeyaml`; covers `org.yaml:snakeyaml`, `dtolnay/serde-yaml`). Exactness is whole-name/last-segment equality by design: a `*_serde_yaml` fork is *related* (1), not exact.
2. **Full token match** (1) — EVERY query token appears in the name. Deliberately not any single token: sharing only `parser` in `"yaml parser"` gets the candidate a 0, letting popularity surface the canonical star-heavy repo instead of every `*-parser` package.
3. **Popularity** — log-scaled stars (weight 35) above downloads (weight 10); pkg.go.dev "Imported by" counts join the download weight, so Go candidates get a fitness number too.
4. **Consensus** — a candidate reported by more than one source gets a small co-signal boost.

Exactness dominates popularity by two orders of magnitude by design: if a package with that exact name exists, that IS the answer to "has this been built?", regardless of how many stars an unrelated repo has.

**Descriptions are clipped.** Candidate one-line descriptions (GitHub repo
descriptions are unvetted user text) are truncated to 300 chars with a `…`
marker before merging/rinking, so one abusive 50k-char repo description cannot
drown the answer.

## Semantic rerank (README similarity)

Beyond name/popularity ranking, `semantic: true` (the bundled `cordis.patch.yml`
enables it) embeds the query and each candidate's README and re-sorts by cosine
similarity. This is the fix for the cases name-searching cannot see: `saphyr`
does not contain "yaml parser" but IS the Rust YAML parser; `pulldown-cmark`
does not contain "markdown parser" but IS one.

**How it works** (`src/readme.ts` + `src/semantic.ts`):

1. **README retrieval, best-effort, per candidate.** npm packages come from the
   registry's own `readme` field (one JSON call per package); GitHub projects
   (and cargo crates whose crates.io entry carries a `repository`) come from
   `raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md` (`.rst` fallback).
   crates.io's own `/readme` endpoint is NOT used: it redirects to
   `static.crates.io/readmes/...`, which 403s non-browser clients (verified
   2026-09-06); the `repository` field is followed to GitHub raw instead.
   Maven/PyPI and pkg.go.dev Go hits (which carry no repository) have no README
   lane — those candidates embed their name+description only. Fetches run with
   bounded concurrency (6), a 6s timeout each, and are individually
   fault-tolerant: one missing README never fails a call.
2. **Local embedding, free and keyless.** The query + up to ~30 README texts are
   embedded in one batched call with a small all-MiniLM-L6-v2 quantized model
   (~25 MB, cached after first download), via the **optional peer**
   `@huggingface/transformers`. No API key, no external embedding service.
   Without that peer installed, `semantic: true` degrades gracefully to the
   lexical ranking and says so in the tool output.
3. **Rerank, contract preserved.** Exact-name matches (exactness 2) stay a hard
   top tier — nothing unseats the package with THE name. Below that, README
   similarity (weight 800) leads; a full name-token match is only a +300 head
   start; popularity breaks close calls. A repo whose README describes exactly
   what you asked for surfaces even when its name says nothing.

## Configuration

```ts
import toolLibrarySearch from '@hy-sde-org/dsh-tool-library-search'

ctx.plugin(toolLibrarySearch, {
  timeoutMs: 12000,     // per-source transport timeout (default 10000)
  maxResults: 20,       // default result cap after merge+rank (default 15)
  perSourceLimit: 8,    // per-source hit cap before merge; >100 pages GitHub when a token is set
  githubToken: 'ghp_…', // optional: raises GitHub repo-search quota 10/min → 30/min AND enables paging
  semantic: true,       // enable README-similarity rerank (default false)
  embedderModel: 'Xenova/all-MiniLM-L6-v2', // optional local model id
  semanticPoolSize: 50, // candidates entering the rerank before maxResults cut
})
```

> Install the optional peer to activate semantic rerank:
> `npm i @huggingface/transformers` (or `pnpm add @huggingface/transformers`).
> The first call downloads ~25 MB of model weights; subsequent calls reuse the
> in-memory pipeline. Without the peer the tool still fully works lexically.

Install as a preset/patch row via the bundled `cordis.patch.yml` (row id `hy-sde-libsearch-tool-library-search`), which also registers the `library:search` prompt section.

## Known Limitations and Deferred Work

- **Semantic meaning is single-turn and README-sized.** The rerank reads a
  candidate's README (≤ 12k chars) and the query only — no learned
  cross-query cache, no second-stage corpus, no RAG over prior conversations.
  all-MiniLM-L6-v2 truncates long READMEs to its 256-token window, which is
  ample for the top-of-README summary but misses deep-dive sections.
- **deps.dev search is undocumented** (`_/search` is the website's internal endpoint; the documented v3alpha search 404s). It may change without notice; the source is isolated behind one module.
- **GitHub quota drives call cost.** Unauthenticated, more than ~10 calls/min hits 403 and the GitHub source reports a failure (tolerated; other sources still answer). Set `githubToken` in busy deployments.
- **PyPI/Maven have no first-class free search**; those ecosystems are covered
  by deps.dev name-existence + GitHub repos, and have no README lane for the
  semantic layer (name+description only). Go got a real lane with pkg.go.dev
  (synopsis + imports), but that too has no README.
- **GitHub paging needs a token to matter.** Without one the source stays on
  one page (10/min budget); with one, set `perSourceLimit` above 100 (e.g.
  300) to page through 5×100 star-sorted repos and hand the semantic pool a
  deep candidate set (each page = 1 of the 30/min searches).
- **crates.io ranking is name-oriented**: it rarely surfaces a crate whose name lacks the query token (`pulldown-cmark` under `markdown parser`). The semantic rerank partially recovers this when the crate's `repository` is registered.

## Dev Note

```bash
pnpm install
pnpm -r check   # tsc --noEmit over src + tests
pnpm -r test    # vitest (hermetic: stubbed fetch, no network)
pnpm -r build   # tsc emit to dist
```

The source-parsing tests pin one fixture per free API; ranking tests pin the exact-name-over-popularity behavior; the semantic tests pin the exact-name-first contract with a stub embedder (no model download in CI). A real-network smoke can be run against the built `dist` with a script like the one in the project probes; for the semantic path, install the optional peer in a throwaway dir (or `pnpm add -D @huggingface/transformers`) and run with `--install-links`-style local install.
