import { describe, expect, it } from 'vitest'

import { createContextStore } from '../src/rdf/document-loader'
import { quadsFromJsonLd, quadsFromTurtle } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { assessTier, dereferenceTargetOf, describeLadder } from '../src/vocab/tiers'

import libraryVocab from './fixtures/library-vocab.json'

function offlineContexts() {
  return createContextStore({
    fetchJson: async (url) => {
      throw new Error(`no network in tests: ${url}`)
    },
  })
}

async function graphWith(parts: { vocab?: boolean; shapes?: boolean }): Promise<SessionGraph> {
  const graph = createSessionGraph()
  if (parts.vocab) {
    graph.ingestDocument(
      await quadsFromJsonLd(libraryVocab, offlineContexts().load, 'https://lending.example/api/vocab'),
      GRAPHS.vocab,
    )
  }
  if (parts.shapes) {
    graph.ingestDocument(
      quadsFromTurtle(
        `@prefix sh: <http://www.w3.org/ns/shacl#> .
         @prefix lend: <https://lending.example/ns#> .
         [] a sh:NodeShape ; sh:targetClass lend:Tome ;
            sh:property [ sh:path lend:heading ; sh:maxLength 200 ] .`,
        'https://lending.example/api/shapes',
      ),
      GRAPHS.shapes,
    )
  }
  return graph
}

const NO_SPARQL = { sparqlEndpoint: null, sparqlReachable: null }

/**
 * The tier matrix (task 3.8, design D6).
 *
 * The claim being tested is degradation, not capability: each rung down must still work. An API
 * publishing only a Hydra ApiDocumentation has to yield a working surface, or the portability claim is
 * empty — every customer would need all four documents before seeing anything at all.
 */
describe('tier detection', () => {
  it('reports T0 from a vocabulary alone, and says what T1 buys', async () => {
    const graph = await graphWith({ vocab: true })
    const assessment = assessTier(graph, NO_SPARQL, { ontology: false, contextResolved: false })

    expect(assessment.tier).toBe('T0')
    expect(assessment.evidence.vocabulary).toBe(true)
    expect(assessment.nextUnlocks).toMatch(/context/i)
  })

  it('reports T1 once a context resolves', async () => {
    const graph = await graphWith({ vocab: true })
    const assessment = assessTier(graph, NO_SPARQL, { ontology: false, contextResolved: true })

    expect(assessment.tier).toBe('T1')
    expect(assessment.nextUnlocks).toMatch(/SHACL|shapes/i)
  })

  it('reports T2 once shapes load', async () => {
    const graph = await graphWith({ vocab: true, shapes: true })
    const assessment = assessTier(graph, NO_SPARQL, { ontology: false, contextResolved: true })

    expect(assessment.tier).toBe('T2')
    expect(assessment.evidence.shapes).toBe(true)
    expect(assessment.nextUnlocks).toMatch(/ontology/i)
  })

  it('reports T3 only with an ontology and an endpoint that answers', async () => {
    const graph = await graphWith({ vocab: true, shapes: true })
    const assessment = assessTier(
      graph,
      { sparqlEndpoint: 'https://lending.example/sparql', sparqlReachable: true },
      { ontology: true, contextResolved: true },
    )

    expect(assessment.tier).toBe('T3')
    expect(assessment.nextUnlocks).toBeNull()
  })

  describe('degrading rather than breaking', () => {
    it('stays at T2 when an advertised endpoint does not answer, and says so', async () => {
      /*
       * The case this deployment actually exhibited: `void:sparqlEndpoint` populated, nothing listening.
       * Within a single session it was both dead and alive with the advertisement unchanged, which is why
       * reachability is probed rather than inferred from the declaration.
       */
      const graph = await graphWith({ vocab: true, shapes: true })
      const assessment = assessTier(
        graph,
        { sparqlEndpoint: 'https://lending.example/sparql', sparqlReachable: false },
        { ontology: true, contextResolved: true },
      )

      expect(assessment.tier).toBe('T2')
      expect(assessment.evidence.sparqlAdvertised).toBe(true)
      expect(assessment.evidence.sparqlReachable).toBe(false)
      expect(assessment.caveats.join(' ')).toMatch(/advertised but did not answer/i)
      // And it must say what happens instead, not merely that something is missing.
      expect(assessment.caveats.join(' ')).toMatch(/locally/i)
    })

    it('does not claim T2 from shapes alone when no context resolved', async () => {
      // Each tier requires the ones beneath it. Claiming T2 would claim payload keys the client cannot
      // resolve, which is a promise it cannot keep.
      const graph = await graphWith({ vocab: true, shapes: true })
      const assessment = assessTier(graph, NO_SPARQL, { ontology: false, contextResolved: false })

      expect(assessment.tier).toBe('T0')
    })

    it('is honest when there is no vocabulary at all', async () => {
      const graph = await graphWith({})
      const assessment = assessTier(graph, NO_SPARQL, { ontology: false, contextResolved: false })

      expect(assessment.evidence.vocabulary).toBe(false)
      expect(assessment.nextUnlocks).toMatch(/floor/i)
    })

    it('notes an ontology that is reachable but unadvertised', async () => {
      const graph = await graphWith({ vocab: true, shapes: true })
      const assessment = assessTier(
        graph,
        NO_SPARQL,
        { ontology: true, contextResolved: true },
      )

      expect(assessment.tier).toBe('T2')
      expect(assessment.caveats.join(' ')).toMatch(/dereferencing a term IRI/i)
    })

    it('drops the recommendation once the ontology is advertised', async () => {
      // The whole point of the caveat above is to recommend advertising the ontology. When the
      // vocabulary does advertise it (rdfs:isDefinedBy / owl:imports / void:vocabulary), the
      // recommendation is moot and must not keep firing.
      const graph = await graphWith({ vocab: true, shapes: true })
      const assessment = assessTier(
        graph,
        NO_SPARQL,
        { ontology: true, contextResolved: true, ontologyAdvertised: true },
      )

      expect(assessment.tier).toBe('T2')
      expect(assessment.caveats.join(' ')).not.toMatch(/dereferencing a term IRI/i)
    })
  })

  describe('the ladder shown to an operator', () => {
    it('marks every rung up to the tier reached', async () => {
      const graph = await graphWith({ vocab: true, shapes: true })
      const ladder = describeLadder(
        assessTier(graph, NO_SPARQL, { ontology: false, contextResolved: true }),
      )

      expect(ladder.map((r) => r.reached)).toEqual([true, true, true, false])
      expect(ladder[3]?.label).toMatch(/SPARQL/)
    })
  })
})

describe('finding the ontology by dereferencing a term', () => {
  /**
   * The vocabulary references the ontology nowhere — no `owl:imports`, no `void:vocabulary`. The only
   * route is a term IRI, and stripping its fragment is what a hash namespace *means*: it is IRI
   * semantics, not a URL the client invented.
   */
  it('strips the fragment from a term IRI', () => {
    expect(dereferenceTargetOf('https://lending.example/ns#Tome')).toBe('https://lending.example/ns')
    expect(dereferenceTargetOf('https://lending.example/ns#heading')).toBe('https://lending.example/ns')
  })

  it('declines a term with no fragment rather than guessing a document', () => {
    // A slash namespace dereferences per-term; there is nothing to strip and no document to assume.
    expect(dereferenceTargetOf('https://lending.example/ns/Tome')).toBeNull()
    expect(dereferenceTargetOf('#local')).toBeNull()
  })
})
