# Contributing

Thanks for helping with `dsh-tool-library-search`. This is a small,
dependency-light monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-tool-library-search`
  beyond its declared peers (`@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tools`). The sources use
  Node's built-in `fetch` and no third-party HTTP client.
- **Stay free and keyless.** The whole point is that a deployment can enable
  the tool with zero credentials. A source that demands an API key must stay
  optional (like the GitHub token) and never block the others. The semantic
  layer must follow the same rule: local embeddings via the OPTIONAL peer
  `@huggingface/transformers`; never add a paid/external embedding endpoint as
  the default.
- **One source per file, one failure per source.** Fan-out must always
  tolerate individual source failures and only error when everything failed;
  a single rate-limited API must never make `library_search` unusable. The
  semantic layer inherits this: a missing README or an unavailable embedder
  must degrade to lexical ranking with a note, never error.
- **Ranking is exact-name-first on purpose.** Do not let popularity outrank
  exactness: before any weight change, add a test that pins
  exact-name-beats-popularity, and re-run the real-network smoke to confirm
  `serde_yaml`/`snakeyaml` still surface their exact crate.
- **Hermetic tests only.** Specs stub `fetch`; nothing in `pnpm test` may hit
  the network. Keep any live check in a separate script.
- Keep `README.md` and `README.zh.md` in sync (and re-record the
  `README.i18n.yaml` blob hashes with `git hash-object` after either side
  changes).

## Development

```bash
pnpm install
pnpm -r check   # tsc --noEmit over src + tests
pnpm -r test    # vitest, hermetic
pnpm -r build   # tsc emit to dist
```
