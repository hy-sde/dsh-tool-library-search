# Third-Party Notices

This project incorporates no vendored third-party source code. It is an
original implementation that consumes free, public network APIs (deps.dev,
npm registry, crates.io, GitHub REST, raw.githubusercontent.com) at runtime;
those services and their data remain the property of their respective
operators and are used under their published terms.

Runtime dependencies are consumed from the npm registry under their own
licenses:

- `@deepseek-ai/cordis` — plugin composition runtime
- `@deepseek-ai/dsh-system-prompt` — prompt-section service
- `@deepseek-ai/dsh-tools` — defineTool/tool-registry contract
- `@deepseek-ai/dsh-llm` — tool-execution types (dev/test only)
- `@huggingface/transformers` — **optional** peer for semantic rerank; when
  installed it downloads model weights (default `Xenova/all-MiniLM-L6-v2`,
  Apache-2.0, via Hugging Face Hub) on first semantic call and caches them
  locally. Not installed by default; the package works without it.

No other third-party code is vendored or bundled in this repository.
