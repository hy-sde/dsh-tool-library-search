/**
 * Candidate vocabulary for `@hy-sde-org/dsh-tool-library-search`: the
 * normalized record one source produces, plus the pure merge/rank logic that
 * turns per-source hits into one "does this already exist?" answer.
 *
 * Sources disagree on shape (a GitHub repo has stars but no downloads; an npm
 * package has downloads but no stars; deps.dev has neither but knows the name
 * exists in *which* ecosystems), so candidates carry optional signal fields
 * and the ranker combines exact-name match, popularity, and cross-source
 * consensus.
 * @module @hy-sde-org/dsh-tool-library-search/candidates
 */

/** Ecosystem labels used across sources; deps.dev systems map onto these. */
export const ECOSYSTEMS = [
  'npm',
  'cargo',
  'maven',
  'go',
  'pypi',
  'rubygems',
  'nuget',
  'github',
] as const

export type Ecosystem = (typeof ECOSYSTEMS)[number]

/** Whether a hit is a distributable package or a source repository/project. */
export type CandidateKind = 'package' | 'project'

/** One normalized "this thing exists" hit from any source. */
export interface Candidate {
  /** Display name: package name, or `owner/repo` for GitHub projects. */
  readonly name: string
  readonly ecosystem: Ecosystem
  readonly kind: CandidateKind
  /** Best available one-line description. */
  readonly description?: string
  /** Where to look: registry page, repo URL, or deps.dev page. */
  readonly link: string
  /** Latest known version, when the source reports one. */
  readonly version?: string
  /** GitHub stars (project sources only). */
  readonly stars?: number
  /** Monthly downloads (npm/crates.io sources only). */
  readonly downloads?: number
  /** "Imported by N" popularity (pkg.go.dev only). */
  readonly imports?: number
  /**
   * Source repository (owner/repo form) when the source reports one — the
   * semantic layer needs it to fetch a README (GitHub raw) for candidates
   * whose registry has no readable README lane (crates.io readme redirects to
   * a bot-blocked static host).
   */
  readonly repository?: string
  /** Which backends reported this candidate (dedupe + consensus signal). */
  readonly sources: readonly string[]
}

/** Source-internal rank; used only as a deterministic tiebreak. */
export interface RankedCandidate extends Candidate {
  /** 0-based index within its source's result list. */
  readonly sourceRank: number
  /** Computed exactness score (0–2). */
  readonly exactness: number
  /** Composite sort score (exactness-dominant). */
  readonly score: number
}

/**
 * Collapse a name/query for equality: lowercase, strip everything but
 * alphanumerics. `serde_yaml`, `serde-yaml`, and `serdeyaml` all compare
 * equal, which is exactly the variation registries and repos use.
 */
export function normCompact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Split a name/query into alphanumeric tokens (hyphen/underscore/dot bound). */
export function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 0)
}

/** Whether the name token set contains the query token (equal or prefix/suffix). */
function hasNameToken(nameTokens: ReadonlySet<string>, token: string): boolean {
  if (nameTokens.has(token)) return true
  for (const nt of nameTokens) {
    if (nt.startsWith(token) || nt.endsWith(token) || token.startsWith(nt)) return true
  }
  return false
}

/**
 * Exactness of a candidate name against the query, 0–2:
 * - 2: name equals the query after compaction, or its LAST path segment does
 *   AND the name has at most two path segments (covers `org.yaml:snakeyaml` →
 *   `snakeyaml`, `dtolnay/serde-yaml` → `serde-yaml`, `eemeli/yaml` → `yaml`).
 *   Deliberately NOT a whole-name `endsWith` (every `*_serde_yaml` fork would
 *   be "exact"), and NOT a last-segment rule on 3+ segment names: Go import
 *   paths like `github.com/knadh/koanf/parsers/yaml` end in `/yaml` but are a
 *   comparison SUBPACKAGE, not "the yaml library" — they get 1.
 * - 1: EVERY query token (len ≥ 3) appears in the name's tokens. Requires the
 *   full set, not one generic token: sharing "parser" with "yaml parser" is a
 *   0, leaving popularity free to surface the canonical star-heavy repo.
 * - 0: no name-level relation; the hit comes from description/ranking alone.
 */
export function exactness(candidateName: string, query: string): number {
  const q = normCompact(query)
  const n = normCompact(candidateName)
  const segments = candidateName.split(/[/:]/)
  const lastSegment = normCompact(segments[segments.length - 1] ?? '')
  if (q.length > 0 && n === q) return 2
  if (
    q.length > 0
    && lastSegment.length > 0
    && lastSegment === q
    && segments.length <= 2
  ) return 2
  const qTokens = tokens(query).filter(t => t.length >= 3)
  if (qTokens.length > 0) {
    const nTokens = new Set(tokens(candidateName))
    return qTokens.every(t => hasNameToken(nTokens, t)) ? 1 : 0
  }
  // Query has no ≥3-char tokens (very short): containment only.
  return q.length >= 4 && n.includes(q) ? 1 : 0
}

/** Dedupe key: ecosystem + compact name (package and repo names both compare). */
export function dedupeKey(candidate: Candidate): string {
  return `${candidate.ecosystem}:${normCompact(candidate.name)}`
}

/** Mutable accumulator for the merge pass. */
interface MergeAccumulator {
  readonly name: string
  readonly ecosystem: Ecosystem
  readonly kind: CandidateKind
  description?: string
  readonly link: string
  version?: string
  stars?: number
  downloads?: number
  imports?: number
  repository?: string
  readonly sources: Set<string>
}

/**
 * Merge per-source hits into one candidate per ecosystem+name, keeping the
 * best description, max stars/downloads, and the set of sources that reported
 * it. Cross-source agreement is itself a signal: a package named by both
 * deps.dev and crates.io exists with high confidence.
 */
export function mergeCandidates(hits: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, MergeAccumulator>()
  for (const hit of hits) {
    const key = dedupeKey(hit)
    const merged = byKey.get(key)
    if (merged === undefined) {
      byKey.set(key, {
        name: hit.name,
        ecosystem: hit.ecosystem,
        kind: hit.kind,
        link: hit.link,
        ...(hit.description !== undefined ? { description: hit.description } : {}),
        ...(hit.version !== undefined ? { version: hit.version } : {}),
        ...(hit.stars !== undefined ? { stars: hit.stars } : {}),
        ...(hit.downloads !== undefined ? { downloads: hit.downloads } : {}),
        ...(hit.imports !== undefined ? { imports: hit.imports } : {}),
        ...(hit.repository !== undefined ? { repository: hit.repository } : {}),
        sources: new Set(hit.sources),
      })
      continue
    }
    // Keep the longest description (most informative), first-seen otherwise.
    if (hit.description !== undefined && (merged.description === undefined || hit.description.length > merged.description.length)) {
      merged.description = hit.description
    }
    if (hit.stars !== undefined && hit.stars > (merged.stars ?? 0)) merged.stars = hit.stars
    if (hit.downloads !== undefined && hit.downloads > (merged.downloads ?? 0)) merged.downloads = hit.downloads
    if (hit.imports !== undefined && hit.imports > (merged.imports ?? 0)) merged.imports = hit.imports
    if (merged.version === undefined && hit.version !== undefined) merged.version = hit.version
    if (merged.repository === undefined && hit.repository !== undefined) merged.repository = hit.repository
    for (const source of hit.sources) merged.sources.add(source)
  }
  return [...byKey.values()].map(accumulator => ({
    name: accumulator.name,
    ecosystem: accumulator.ecosystem,
    kind: accumulator.kind,
    link: accumulator.link,
    sources: [...accumulator.sources],
    ...(accumulator.description !== undefined ? { description: accumulator.description } : {}),
    ...(accumulator.version !== undefined ? { version: accumulator.version } : {}),
    ...(accumulator.stars !== undefined ? { stars: accumulator.stars } : {}),
    ...(accumulator.downloads !== undefined ? { downloads: accumulator.downloads } : {}),
    ...(accumulator.imports !== undefined ? { imports: accumulator.imports } : {}),
    ...(accumulator.repository !== undefined ? { repository: accumulator.repository } : {}),
  }))
}

/**
 * Log-popularity weights. Stars are consciously weighted HIGHER than
 * downloads: a GitHub repo's stars are the community "this is the answer"
 * signal for natural-language queries, while npm/crates downloads include
 * dependents-of-dependents noise and are ~10^2 greater in scale, so an equal
 * weight lets a heavily-counted mediocre package bury the canonical repo
 * (a 3.1M-download crate must not outrank a 336★ canonical one).
 * Exactness dominates both; popularity only orders 0/1-tier hits.
 */
const STARS_WEIGHT = 35
const DOWNLOADS_WEIGHT = 10

/**
 * The popularity component of a candidate's score: log-scaled star/download
 * weighted terms plus a small cross-source consensus co-signal. Shared by the
 * lexical ranker and the semantic rerank so both blend the same fitness
 * signal. Exactness is added separately (it dominates by design).
 */
export function popularityScore(candidate: Candidate): number {
  const starsScore = candidate.stars !== undefined ? Math.log10(1 + candidate.stars) * STARS_WEIGHT : 0
  const downloadsScore = candidate.downloads !== undefined ? Math.log10(1 + candidate.downloads) * DOWNLOADS_WEIGHT : 0
  const importsScore = candidate.imports !== undefined ? Math.log10(1 + candidate.imports) * DOWNLOADS_WEIGHT : 0
  return starsScore + downloadsScore + importsScore + candidate.sources.length
}

/**
 * Score + sort candidates. Exactness dominates (an exact-name hit exists,
 * regardless of how many stars an unrelated repo has), then popularity as a
 * log scale, then cross-source consensus as a small co-signal. Returns ranked
 * candidates with their computed score; the caller caps to `maxResults`.
 */
export function rankCandidates(candidates: readonly Candidate[], query: string): RankedCandidate[] {
  const ranked = candidates.map((candidate, sourceRank) => {
    const e = exactness(candidate.name, query)
    return {
      ...candidate,
      sourceRank,
      exactness: e,
      score: e * 1000 + popularityScore(candidate),
    }
  })
  ranked.sort((a, b) =>
    b.score - a.score
    || (b.stars ?? 0) - (a.stars ?? 0)
    || (b.downloads ?? 0) - (a.downloads ?? 0)
    || a.name.localeCompare(b.name),
  )
  return ranked
}
