/**
 * Pure ranking/merge tests for `@hy-sde-org/dsh-tool-library-search`:
 * the exact-name-over-popularity fix, cross-source merge, and the
 * ecosystem filter feed. Hermetic — no network.
 */

import { describe, expect, it } from 'vitest'
import {
  ECOSYSTEMS,
  exactness,
  mergeCandidates,
  normCompact,
  rankCandidates,
  tokens,
} from '../src/candidates.ts'
import type { Candidate } from '../src/candidates.ts'

describe('normCompact / tokens', () => {
  it('collapses case, hyphen, underscore, dot, and slash', () => {
    expect(normCompact('serde_yaml')).toBe('serdeyaml')
    expect(normCompact('serde-yaml')).toBe('serdeyaml')
    expect(normCompact('org.yaml:snakeyaml')).toBe('orgyamlsnakeyaml')
    expect(normCompact('gopkg.in/yaml.v3')).toBe('gopkginyamlv3')
  })

  it('splits on non-alphanumeric boundaries', () => {
    expect(tokens('yaml-parser')).toEqual(['yaml', 'parser'])
    expect(tokens('org.yaml:snakeyaml')).toEqual(['org', 'yaml', 'snakeyaml'])
  })
})

describe('exactness', () => {
  it('scores 2 for compact equality', () => {
    expect(exactness('serde_yaml', 'serde_yaml')).toBe(2)
    expect(exactness('serde-yaml', 'serde_yaml')).toBe(2)
  })

  it('scores 2 when the name ends with the query (owner/repo and group:artifact)', () => {
    expect(exactness('dtolnay/serde-yaml', 'serde_yaml')).toBe(2)
    expect(exactness('org.yaml:snakeyaml', 'snakeyaml')).toBe(2)
    expect(exactness('eemeli/yaml', 'yaml')).toBe(2)
  })

  it('does NOT treat a 3+ segment name ending in /yaml as exact (Go subpackages)', () => {
    // github.com/knadh/koanf/parsers/yaml is a comparison SUBPACKAGE, not "the
    // yaml library"; only ≤2-segment names get the last-segment exact score.
    expect(exactness('github.com/knadh/koanf/parsers/yaml', 'yaml')).toBe(1)
    expect(exactness('k8s.io/apimachinery/pkg/util/yaml', 'yaml')).toBe(1)
    expect(exactness('gopkg.in/yaml.v3', 'yaml')).toBe(1)
    // A 2-segment path is org/repo-shaped (sigs.k8s.io/yaml ≈ a GitHub repo) → exact.
    expect(exactness('sigs.k8s.io/yaml', 'yaml')).toBe(2)
  })

  it('scores 1 only when EVERY query token appears in the name', () => {
    expect(exactness('yaml-eslint-parser', 'yaml parser')).toBe(1)
    expect(exactness('some-yaml-parser', 'yaml parser')).toBe(1)
    // A name whose compaction IS the query gets the full exact score.
    expect(exactness('yaml-parser', 'yaml parser')).toBe(2)
    // Shares only the generic "parser" token — no longer treated as exact-ish.
    expect(exactness('js-yaml', 'yaml parser')).toBe(0)
    expect(exactness('granit-parser', 'yaml parser')).toBe(0)
  })

  it('scores 1 for contained compact query', () => {
    expect(exactness('yamlparser', 'yaml')).toBe(1)
  })

  it('does NOT treat every `*_serde_yaml` fork as exact-name', () => {
    // The whole-name endsWith bug: mk_ext_serde_yaml must be related (1), not exact (2).
    expect(exactness('mk_ext_serde_yaml', 'serde_yaml')).toBe(1)
    expect(exactness('noyalib-serde-yaml', 'serde_yaml')).toBe(1)
    // But the exact crate itself stays exact.
    expect(exactness('serde_yaml', 'serde_yaml')).toBe(2)
  })

  it('scores 0 when no name relation exists', () => {
    expect(exactness('pulldown-cmark', 'yaml parser')).toBe(0)
    expect(exactness('prettier', 'yaml')).toBe(0)
  })
})

describe('mergeCandidates', () => {
  it('dedupes by ecosystem + compact name across sources', () => {
    const hits: Candidate[] = [
      { name: 'serde_yaml', ecosystem: 'cargo', kind: 'package', link: 'https://crates.io/crates/serde_yaml', description: 'short', sources: ['crates.io'] },
      { name: 'serde_yaml', ecosystem: 'cargo', kind: 'package', link: 'https://deps.dev/cargo/serde_yaml', version: '0.9.33', sources: ['deps.dev'] },
    ]
    const merged = mergeCandidates(hits)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.sources).toEqual(['crates.io', 'deps.dev'])
  })

  it('keeps the longest description and max stars/downloads', () => {
    const hits: Candidate[] = [
      { name: 'repo/x', ecosystem: 'github', kind: 'project', link: 'u', description: 'a', stars: 5, sources: ['github'] },
      { name: 'repo/x', ecosystem: 'github', kind: 'project', link: 'u', description: 'a longer description', stars: 9, downloads: 10, sources: ['deps.dev'] },
    ]
    const [merged] = mergeCandidates(hits)
    expect(merged?.description).toBe('a longer description')
    expect(merged?.stars).toBe(9)
    expect(merged?.downloads).toBe(10)
  })

  it('absorbs a popularity signal that only the SECOND hit carries (regression)', () => {
    const hits: Candidate[] = [
      { name: 'gopkg.in/yaml.v3', ecosystem: 'go', kind: 'package', link: 'u', version: 'old', sources: ['deps.dev'] },
      { name: 'gopkg.in/yaml.v3', ecosystem: 'go', kind: 'package', link: 'u', version: 'v3.0.1', imports: 34_113, description: 'Package yaml', sources: ['pkg.go.dev'] },
    ]
    const [merged] = mergeCandidates(hits)
    expect(merged?.imports).toBe(34_113)
    expect(merged?.version).toBe('old') // first-seen kept, but imports absorbed
    expect(merged?.description).toBe('Package yaml')
  })

  it('does not merge same name across ecosystems', () => {
    const hits: Candidate[] = [
      { name: 'yaml', ecosystem: 'npm', kind: 'package', link: 'u', sources: ['npm'] },
      { name: 'yaml', ecosystem: 'cargo', kind: 'package', link: 'u', sources: ['crates.io'] },
    ]
    expect(mergeCandidates(hits)).toHaveLength(2)
  })
})

describe('rankCandidates — exact name beats popularity', () => {
  it('ranks an exact-name package above a popular unrelated repo', () => {
    const candidates: Candidate[] = [
      { name: 'yaml', ecosystem: 'npm', kind: 'package', link: 'u', downloads: 100, sources: ['npm'] },
      { name: 'some-popular-thing', ecosystem: 'github', kind: 'project', link: 'u', stars: 50_000, sources: ['github'] },
    ]
    const ranked = rankCandidates(candidates, 'yaml')
    expect(ranked[0]?.name).toBe('yaml')
    expect(ranked[0]?.exactness).toBe(2)
  })

  it('ranks an exact-name Maven artifact above unrelated popularity', () => {
    const candidates: Candidate[] = [
      { name: 'org.yaml:snakeyaml', ecosystem: 'maven', kind: 'package', link: 'u', sources: ['deps.dev'] },
      { name: 'popular-java-lib', ecosystem: 'github', kind: 'project', link: 'u', stars: 600_000, sources: ['github'] },
    ]
    const ranked = rankCandidates(candidates, 'snakeyaml')
    expect(ranked[0]?.name).toBe('org.yaml:snakeyaml')
  })

  it('orders by popularity for non-exact natural-language queries', () => {
    const candidates: Candidate[] = [
      { name: 'tiny-yaml-tool', ecosystem: 'github', kind: 'project', link: 'u', stars: 2, sources: ['github'] },
      { name: 'js-yaml', ecosystem: 'github', kind: 'project', link: 'u', stars: 6_000, sources: ['github'] },
    ]
    const ranked = rankCandidates(candidates, 'yaml parser')
    expect(ranked[0]?.name).toBe('js-yaml')
    // Shares only one token ("yaml") — popularity alone orders this tier.
    expect(ranked[0]?.exactness).toBe(0)
  })

  it('lets a star-heavy canonical repo beat a download-heavy near-name package', () => {
    // saphyr (336★) is the canonical Rust YAML answer; a 3.1M-download crate
    // with a "parser" name has no name relation and must not bury it.
    const candidates: Candidate[] = [
      { name: 'granit-parser', ecosystem: 'cargo', kind: 'package', link: 'u', downloads: 3_100_000, sources: ['crates.io'] },
      { name: 'saphyr-rs/saphyr', ecosystem: 'github', kind: 'project', link: 'u', stars: 336, sources: ['github'] },
    ]
    const ranked = rankCandidates(candidates, 'yaml parser')
    expect(ranked[0]?.name).toBe('saphyr-rs/saphyr')
  })

  it('uses cross-source consensus as a small co-signal tiebreak', () => {
    const candidates: Candidate[] = [
      { name: 'serde_yaml', ecosystem: 'cargo', kind: 'package', link: 'u', sources: ['crates.io'] },
      { name: 'serde_yaml', ecosystem: 'cargo', kind: 'package', link: 'u', sources: ['crates.io', 'deps.dev'] },
    ]
    // mergeCandidates would have deduped these; rank standalone to prove ordering.
    const ranked = rankCandidates(candidates, 'serde_yaml')
    expect(ranked[0]?.sources).toHaveLength(2)
  })

  it('knows every ECOSYSTEM constant is one of the schema values', () => {
    expect(ECOSYSTEMS).toContain('npm')
    expect(ECOSYSTEMS).toContain('cargo')
    expect(ECOSYSTEMS).toContain('maven')
    expect(ECOSYSTEMS).toContain('go')
    expect(ECOSYSTEMS).toContain('pypi')
    expect(ECOSYSTEMS).toContain('rubygems')
    expect(ECOSYSTEMS).toContain('nuget')
    expect(ECOSYSTEMS).toContain('github')
  })
})
