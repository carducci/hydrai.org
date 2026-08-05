import { describe, expect, it } from 'vitest'

import {
  collectContextReferences,
  discoverContexts,
  type DocumentToWalk,
} from '../src/rdf/context-discovery'
import { createContextStore } from '../src/rdf/document-loader'
import { FINDING_KINDS, createFindings } from '../src/rdf/findings'

const HYDRA_CONTEXT = 'http://www.w3.org/ns/hydra/context.jsonld'

/** Shaped after what the live API actually serves — see baseline.md §1a. */
const ENTRY_POINT: DocumentToWalk = {
  url: 'http://example.test/Api/',
  document: {
    '@context': 'http://example.test/Api/Context',
    '@id': 'http://example.test/Api/',
    '@type': 'hydra:EntryPoint',
    contacts: 'http://example.test/Api/Contact/',
  },
}

const VOCAB: DocumentToWalk = {
  url: 'http://example.test/Api/Vocab',
  document: { '@context': HYDRA_CONTEXT, '@id': 'http://example.test/Api/Vocab' },
}

describe('collecting @context references', () => {
  it('finds a plain string reference', () => {
    expect(collectContextReferences(ENTRY_POINT.document, ENTRY_POINT.url)).toEqual([
      'http://example.test/Api/Context',
    ])
  })

  it('finds every reference in an array, and ignores the inline object beside them', () => {
    const refs = collectContextReferences({
      '@context': [HYDRA_CONTEXT, 'http://example.test/Api/Context', { ns: 'http://example.test/ns#' }],
    })
    expect(refs).toEqual([HYDRA_CONTEXT, 'http://example.test/Api/Context'])
  })

  it('finds references nested anywhere in the document', () => {
    const refs = collectContextReferences({
      '@id': 'http://example.test/Api/',
      member: [{ '@context': 'http://example.test/Api/Context/Contact', '@id': 'x' }],
    })
    expect(refs).toEqual(['http://example.test/Api/Context/Contact'])
  })

  it('resolves a relative reference against the document it came from', () => {
    const refs = collectContextReferences({ '@context': 'Context' }, 'http://example.test/Api/Vocab')
    expect(refs).toEqual(['http://example.test/Api/Context'])
  })

  it('skips a relative reference with no base rather than guessing one', () => {
    // Inventing a base would be inventing a convention; expansion will report the term as unmapped.
    expect(collectContextReferences({ '@context': 'Context' })).toEqual([])
  })

  it('terminates on a self-referential document', () => {
    const cyclic: Record<string, unknown> = { '@context': 'http://example.test/c' }
    cyclic['self'] = cyclic
    expect(() => collectContextReferences(cyclic)).not.toThrow()
  })
})

describe('discovering contexts at connect time', () => {
  it('resolves the bundled Hydra context without a network call', async () => {
    let networkCalls = 0
    const contexts = createContextStore({
      fetchJson: async (url) => {
        networkCalls++
        return { '@context': {}, url }
      },
    })

    const result = await discoverContexts([VOCAB], { contexts, findings: createFindings() })

    expect(result.referenced).toEqual([HYDRA_CONTEXT])
    expect(result.resolved.get(HYDRA_CONTEXT)).toBe('bundled')
    expect(networkCalls).toBe(0)
  })

  it('fetches a served context once and caches it for the session', async () => {
    const fetched: string[] = []
    const contexts = createContextStore({
      fetchJson: async (url) => {
        fetched.push(url)
        return { '@context': { schema: 'http://schema.org/' } }
      },
    })

    await discoverContexts([ENTRY_POINT], { contexts, findings: createFindings() })
    // A second document referencing the same context must not re-fetch it.
    await discoverContexts([ENTRY_POINT], { contexts, findings: createFindings() })

    expect(fetched).toEqual(['http://example.test/Api/Context'])
  })

  it('follows references out of a context it just fetched', async () => {
    const contexts = createContextStore({
      fetchJson: async (url) =>
        url === 'http://example.test/Api/Context'
          ? { '@context': ['http://example.test/Api/Context/Shared', { a: 'b' }] }
          : { '@context': {} },
    })

    const result = await discoverContexts([ENTRY_POINT], { contexts, findings: createFindings() })

    expect(result.referenced).toContain('http://example.test/Api/Context/Shared')
    expect(result.unreachable).toEqual([])
  })

  describe('a context that cannot be retrieved', () => {
    it('is reported by document name as a deployment finding', async () => {
      const contexts = createContextStore({
        // What a cross-origin rejection looks like from `fetch`: indistinguishable from offline.
        fetchJson: async () => {
          throw new TypeError('Failed to fetch')
        },
      })
      const findings = createFindings()

      const result = await discoverContexts([ENTRY_POINT], { contexts, findings })

      expect(result.unreachable).toEqual(['http://example.test/Api/Context'])

      const recorded = findings.all()
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.kind).toBe(FINDING_KINDS.contextUnreachable)
      expect(recorded[0]?.about).toBe('http://example.test/Api/Context')
      // The operator has to be able to act on it, which means knowing it is a CORS question.
      expect(recorded[0]?.message).toMatch(/CORS/)
    })

    it('does not abort discovery of the contexts that are reachable', async () => {
      const contexts = createContextStore({
        fetchJson: async (url) => {
          if (url === 'http://example.test/Api/Context') throw new TypeError('Failed to fetch')
          return { '@context': {} }
        },
      })
      const findings = createFindings()

      const result = await discoverContexts([ENTRY_POINT, VOCAB], { contexts, findings })

      expect(result.unreachable).toEqual(['http://example.test/Api/Context'])
      expect(result.resolved.get(HYDRA_CONTEXT)).toBe('bundled')
    })

    it('records one finding for a gap met twice', async () => {
      const contexts = createContextStore({
        fetchJson: async () => {
          throw new TypeError('Failed to fetch')
        },
      })
      const findings = createFindings()

      await discoverContexts([ENTRY_POINT], { contexts, findings })
      await discoverContexts([ENTRY_POINT], { contexts, findings })

      expect(findings.all()).toHaveLength(1)
    })
  })
})

describe('the conformance report', () => {
  it('exports findings as Turtle', async () => {
    const findings = createFindings()
    findings.record({
      about: 'http://example.test/ns#company',
      kind: FINDING_KINDS.undeclaredLinkRange,
      message: 'The vocabulary declares no Link range for ns:company.',
      detectedAt: new Date('2026-07-29T12:00:00.000Z'),
    })

    const turtle = await findings.toTurtle()

    expect(turtle).toContain('urn:hydraclient:term:')
    expect(turtle).toContain('http://example.test/ns#company')
    expect(turtle).toContain('2026-07-29T12:00:00.000Z')
  })

  it('is empty when the API described everything the client needed', async () => {
    expect(await createFindings().toTurtle()).not.toContain('Finding')
  })
})
