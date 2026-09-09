# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-tool-library-search` opens no listener and spawns no
  subprocess. Its only outbound surface is outbound HTTPS calls to the free
  registry APIs (deps.dev, npm registry, crates.io, GitHub REST,
  raw.githubusercontent.com, pkg.go.dev) and, with `semantic: true`,
  model-weight downloads from hf.co when the optional
  `@huggingface/transformers` peer is installed. Queries are URL-encoded
  (`encodeURIComponent`) before they reach a query string, and the only
  headers added are a fixed User-Agent, `Accept: application/json`, and the
  optional GitHub bearer token.
- Prompt-derived query text is treated as untrusted data: it is never passed
  through a shell, never interpreted as a URL, and only interpolated into
  search query strings.
- The optional `githubToken` is a privileged secret; prefer injecting it via
  the deployment's secret configuration rather than committing it, and never
  log it. The token is sent only to `api.github.com`.
- Result links come from third-party payloads (npm `repository`/`homepage`
  fields, deps.dev names) and are normalized to https before rendering; they
  are still third-party URLs and must not be treated as trusted.
- With `semantic: true`, README text fetched from npm registry or
  raw.githubusercontent.com is embedded locally in-process and never sent to a
  third party; the only third-party transfer is the one-time model-weight
  download from the Hugging Face Hub.
