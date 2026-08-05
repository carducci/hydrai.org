import { describe, expect, it } from 'vitest'

import { discoverContexts } from '../src/rdf/context-discovery'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS, HYDRA, SHACL } from '../src/rdf/terms'

import entryPoint from './fixtures/mago-entrypoint.json'
import shapes from './fixtures/mago-shapes.json'
import vocab from './fixtures/mago-vocab.json'

/**
 * The graph layer against documents the API really publishes, captured from a live boot.
 *
 * Everything else in the suite uses shapes I wrote, which means it proves the code does what I
 * expected the server to do. This file proves it does what the server actually does — and it is where
 * finding F1 is closed rather than argued about.
 */

const VOCAB_URL = 'http://localhost:1648/Api/Vocab'
const SHAPES_URL = 'http://localhost:1648/Api/Shapes'
const ENTRY_URL = 'http://localhost:1648/Api/'

function offlineContexts() {
  return createContextStore({
    fetchJson: async (url) => {
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })
}

describe('the published vocabulary', () => {
  it('expands with no network call, because the Hydra context is bundled', async () => {
    const contexts = offlineContexts()

    const quads = await quadsFromJsonLd(vocab, contexts.load, VOCAB_URL)

    // The vocabulary's own @context is <http://www.w3.org/ns/hydra/context.jsonld>, served with no
    // Access-Control-Allow-Origin header. Bundling it is what makes a browser connect possible at all.
    expect(contexts.resolutions().get('http://www.w3.org/ns/hydra/context.jsonld')).toBe('bundled')
    expect(quads.length).toBeGreaterThan(1000)
  })

  it('declares supported classes that survive expansion', async () => {
    const quads = await quadsFromJsonLd(vocab, offlineContexts().load, VOCAB_URL)

    const supportedClasses = quads.filter((q) => q.predicate.value === HYDRA.supportedClass)
    expect(supportedClasses.length).toBeGreaterThan(10)
  })

  describe('finding F1 — the shapes graph pointer', () => {
    /**
     * The bug, stated as a test.
     *
     * `VocabularyController.cs:55` emits the pointer as a full IRI, correctly, because the W3C Hydra
     * context does not map `sh:`. `index.html:331` reads `vocab['sh:shapesGraph']`. Against this very
     * document that lookup yields `undefined`, so shapes discovery has been silently broken in
     * production and eleven sibling lookups carry the same latent break.
     */
    it('is not findable by the compact key the proof of concept looked for', () => {
      const asJson = vocab as Record<string, unknown>
      expect(asJson['sh:shapesGraph']).toBeUndefined()
    })

    it('resolves to the SHACL term once the document is read as RDF', async () => {
      const quads = await quadsFromJsonLd(vocab, offlineContexts().load, VOCAB_URL)

      const pointer = quads.filter((q) => q.predicate.value === SHACL.shapesGraph)

      expect(pointer).toHaveLength(1)
      expect(pointer[0]?.object.value).toBe(SHAPES_URL)
    })
  })
})

describe('the published shapes graph', () => {
  it('parses, and carries the constraints the projection will need', async () => {
    const quads = await quadsFromJsonLd(shapes, offlineContexts().load, SHAPES_URL)

    const predicates = new Set(quads.map((q) => q.predicate.value))

    expect(predicates.has(SHACL.targetClass)).toBe(true)
    expect(predicates.has(SHACL.path)).toBe(true)
    expect(predicates.has(SHACL.datatype)).toBe(true)
  })

  it('carries value constraints that JSON Schema cannot express, which the gate will own', async () => {
    const quads = await quadsFromJsonLd(shapes, offlineContexts().load, SHAPES_URL)
    const predicates = new Set(quads.map((q) => q.predicate.value))

    // Design D3 splits SHACL across the schema boundary. Whatever is here and not expressible becomes
    // a dispatch-time gate — so if the server publishes none of it, stage 5.4 has nothing to enforce.
    const residue = [SHACL.maxLength, SHACL.pattern, SHACL.maxCount, SHACL.in].filter((p) =>
      predicates.has(p),
    )
    expect(residue.length).toBeGreaterThan(0)
  })

  it('loads into its own named graph, separate from the data', async () => {
    const graph = createSessionGraph()
    const quads = await quadsFromJsonLd(shapes, offlineContexts().load, SHAPES_URL)

    graph.ingestDocument(quads, GRAPHS.shapes)

    expect(graph.match(null, null, null, GRAPHS.shapes).length).toBe(quads.length)
    expect(graph.subjects()).toEqual([])
  })
})

describe('the published entry point', () => {
  it('references a served context, which discovery finds and fetches', async () => {
    let fetched: string[] = []
    const contexts = createContextStore({
      fetchJson: async (url) => {
        fetched.push(url)
        return { '@context': {} }
      },
    })

    const result = await discoverContexts([{ url: ENTRY_URL, document: entryPoint }], {
      contexts,
      findings: createFindings(),
    })

    expect(result.referenced).toContain('http://localhost:1648/Api/Context')
    expect(fetched).toEqual(['http://localhost:1648/Api/Context'])
    expect(result.unreachable).toEqual([])
  })

  it('advertises a SPARQL endpoint, whose reachability is a separate question', async () => {
    // Declared capability and available capability are different things. This deployment advertises
    // <http://localhost:3030/mago/sparql> and nothing listens on that port, so tier detection has to
    // probe rather than trust — see baseline.md. An API in this state must degrade to T2, not break.
    const asJson = entryPoint as Record<string, unknown>
    const advertised = asJson['void:sparqlEndpoint'] as { '@id'?: string } | undefined

    expect(advertised?.['@id']).toBeTruthy()
  })
})
