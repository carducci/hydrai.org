import { describe, expect, it } from 'vitest'

import { ContextFetchError, createContextStore } from '../src/rdf/document-loader'
import { quadsFromJsonLd, quadsFromTurtle, serialisationOf } from '../src/rdf/ingest'
import { SHACL } from '../src/rdf/terms'

const HYDRA_CONTEXT = 'http://www.w3.org/ns/hydra/context.jsonld'

function store() {
  // No network in tests. Anything not bundled is a hard failure, which is also what we want to assert.
  return createContextStore({
    allowNetwork: false,
    fetchJson: async () => {
      throw new Error('the test loader must never reach the network')
    },
  })
}

describe('consuming Linked Data as RDF', () => {
  /**
   * The bug that motivated the rebuild.
   *
   * `VocabularyController.cs:55` emits the shapes pointer as the full IRI
   * `http://www.w3.org/ns/shacl#shapesGraph`, correctly, because the W3C Hydra context does not map
   * `sh:`. The proof of concept looked for the string `sh:shapesGraph` and so found nothing — shapes
   * discovery has been silently broken in production. After expansion the two spellings are one term
   * and the failure cannot be expressed.
   */
  it('resolves a compact CURIE and a full IRI to the same term', async () => {
    const asCurie = {
      '@context': { sh: 'http://www.w3.org/ns/shacl#' },
      '@id': 'http://example.test/Api/Vocab',
      'sh:shapesGraph': { '@id': 'http://example.test/Api/Shapes' },
    }
    const asFullIri = {
      '@context': HYDRA_CONTEXT,
      '@id': 'http://example.test/Api/Vocab',
      'http://www.w3.org/ns/shacl#shapesGraph': { '@id': 'http://example.test/Api/Shapes' },
    }

    const loader = store().load
    const fromCurie = await quadsFromJsonLd(asCurie, loader, 'http://example.test/Api/Vocab')
    const fromFullIri = await quadsFromJsonLd(asFullIri, loader, 'http://example.test/Api/Vocab')

    const shapesPointer = (quads: Awaited<ReturnType<typeof quadsFromJsonLd>>) =>
      quads.filter((q) => q.predicate.value === SHACL.shapesGraph).map((q) => q.object.value)

    expect(shapesPointer(fromCurie)).toEqual(['http://example.test/Api/Shapes'])
    expect(shapesPointer(fromFullIri)).toEqual(['http://example.test/Api/Shapes'])
    expect(shapesPointer(fromCurie)).toEqual(shapesPointer(fromFullIri))
  })

  it('expands against the bundled Hydra context without touching the network', async () => {
    const document = {
      '@context': HYDRA_CONTEXT,
      '@id': 'http://example.test/Api/Contact/',
      '@type': 'Collection',
      totalItems: 4832,
    }

    const contexts = store()
    const quads = await quadsFromJsonLd(document, contexts.load, 'http://example.test/Api/Contact/')

    // If the Hydra context had not resolved, `totalItems` and `Collection` would simply be absent.
    const predicates = quads.map((q) => q.predicate.value)
    expect(predicates).toContain('http://www.w3.org/ns/hydra/core#totalItems')
    expect(contexts.resolutions().get(HYDRA_CONTEXT)).toBe('bundled')
  })

  it('parses Turtle into quads', () => {
    const quads = quadsFromTurtle(
      `@prefix sh: <http://www.w3.org/ns/shacl#> .
       <http://example.test/Shape> a sh:NodeShape ; sh:maxLength 40 .`,
      'http://example.test/Api/Shapes',
    )
    expect(quads).toHaveLength(2)
    expect(quads.map((q) => q.predicate.value)).toContain(SHACL.maxLength)
  })

  describe('an unfetchable context is a hard error (design D9)', () => {
    it('throws a named error rather than returning a partial graph', async () => {
      const document = {
        '@context': 'http://example.test/Api/Context',
        '@id': 'http://example.test/Api/',
        contacts: 'http://example.test/Api/Contact/',
      }

      const attempt = quadsFromJsonLd(document, store().load, 'http://example.test/Api/')

      // The danger is not an exception — it is the absence of one. A JSON-LD processor that cannot
      // fetch a context drops the terms that context would have mapped and returns a smaller graph
      // that looks entirely valid, which later presents as "the vocabulary does not declare X".
      await expect(attempt).rejects.toBeInstanceOf(ContextFetchError)
      await expect(attempt).rejects.toThrow(/http:\/\/example\.test\/Api\/Context/)
      await expect(attempt).rejects.toThrow(/CORS/)
    })

    it('names the document, so the operator knows which one to make readable', async () => {
      const error = await quadsFromJsonLd(
        { '@context': 'http://example.test/missing-context', '@id': 'http://example.test/x' },
        store().load,
        'http://example.test/x',
      ).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ContextFetchError)
      expect((error as ContextFetchError).url).toBe('http://example.test/missing-context')
    })
  })

  it('recognises the serialisations it can read', () => {
    expect(serialisationOf('application/ld+json')).toBe('json-ld')
    expect(serialisationOf('text/turtle; charset=utf-8')).toBe('turtle')
    expect(serialisationOf('application/n-quads')).toBe('n-quads')
    // Content negotiation asked for ld+json, so an unfamiliar type most likely means it was ignored.
    expect(serialisationOf(null)).toBe('json-ld')
  })
})
