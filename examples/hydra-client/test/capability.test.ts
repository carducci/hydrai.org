import { beforeAll, describe, expect, it } from 'vitest'

import { createContextStore } from '../src/rdf/document-loader'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS, HYDRA } from '../src/rdf/terms'
import { buildCapabilityModel, constraintsFor, type CapabilityModel } from '../src/vocab/capability'

import libraryVocab from './fixtures/library-vocab.json'
import magoShapes from './fixtures/mago-shapes.json'
import magoVocab from './fixtures/mago-vocab.json'

const LEND = 'https://lending.example/ns#'

function offlineContexts() {
  return createContextStore({
    fetchJson: async (url) => {
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })
}

async function modelFor(vocab: unknown, url: string): Promise<{ model: CapabilityModel; graph: SessionGraph }> {
  const graph = createSessionGraph()
  graph.ingestDocument(await quadsFromJsonLd(vocab, offlineContexts().load, url), GRAPHS.vocab)
  return { model: buildCapabilityModel(graph), graph }
}

/**
 * The genericity proof (tasks 3.7, 3.8, design D11).
 *
 * `library-vocab.json` describes an API that does not exist. Its collections and member classes share no
 * word stem, and `lend:Stacks` has a near-homograph decoy — `lend:Stack`, a real class with real
 * operations. A client that singularises the collection name lands on the decoy and reads the wrong type
 * *without failing*, which is strictly worse than failing.
 */
describe('an API the source has never seen', () => {
  let model: CapabilityModel

  beforeAll(async () => {
    model = (await modelFor(libraryVocab, 'https://lending.example/api/vocab')).model
  })

  it('produces a capability model with no code change', () => {
    expect(model.classes.map((c) => c.iri)).toEqual([
      `${LEND}Ledger`,
      `${LEND}Loan`,
      `${LEND}Patron`,
      `${LEND}Roster`,
      `${LEND}Stack`,
      `${LEND}Stacks`,
      `${LEND}Tome`,
    ])
  })

  describe('collections are associated with member classes from the graph', () => {
    it('reads each association from hydra:member’s declared range', () => {
      expect(model.byIri(`${LEND}Stacks`)?.memberClass).toBe(`${LEND}Tome`)
      expect(model.byIri(`${LEND}Roster`)?.memberClass).toBe(`${LEND}Patron`)
      expect(model.byIri(`${LEND}Ledger`)?.memberClass).toBe(`${LEND}Loan`)
    })

    it('resists the decoy that morphology would fall for', () => {
      /*
       * The proof of concept lowercased the collection key, stripped a trailing `s`, and substring-matched
       * class IRIs (`index.html:350-355`). "Stacks" → "stack" → `lend:Stack`, the shelving unit. The
       * declared range says `lend:Tome`.
       */
      const stacks = model.byIri(`${LEND}Stacks`)
      expect(stacks?.memberClass).toBe(`${LEND}Tome`)
      expect(stacks?.memberClass).not.toBe(`${LEND}Stack`)

      // And the decoy is a real class, so the wrong answer would have gone unnoticed.
      const decoy = model.byIri(`${LEND}Stack`)
      expect(decoy).toBeDefined()
      expect(decoy?.operations.map((o) => o.method)).toEqual(['GET'])
      expect(decoy?.isCollection).toBe(false)
    })

    it('resolves the reverse direction too', () => {
      expect(model.collectionFor(`${LEND}Tome`)?.iri).toBe(`${LEND}Stacks`)
      expect(model.collectionFor(`${LEND}Loan`)?.iri).toBe(`${LEND}Ledger`)
      // Nothing collects shelving units, and inventing a collection for them would be a guess.
      expect(model.collectionFor(`${LEND}Stack`)).toBeUndefined()
    })

    it('identifies collections by their member declaration, not by their name', () => {
      const collections = model.collections.map((c) => c.iri).sort()
      expect(collections).toEqual([`${LEND}Ledger`, `${LEND}Roster`, `${LEND}Stacks`])
      // None of these three contains the word "Collection"; the decoy would pass a name test.
      for (const iri of collections) expect(iri).not.toContain('Collection')
    })
  })

  describe('operations', () => {
    it('carries method, expects and returns per operation', () => {
      const tome = model.byIri(`${LEND}Tome`)
      const methods = tome?.operations.map((o) => o.method).sort()
      expect(methods).toEqual(['DELETE', 'GET', 'PUT'])

      const put = tome?.operations.find((o) => o.method === 'PUT')
      expect(put?.expects).toBe(`${LEND}Tome`)
      expect(put?.returns).toBe(`${LEND}Tome`)
    })

    it('keeps the replace-semantics prose that stops a model mangling an update', () => {
      // Task 4.2 carries this into the tool description verbatim.
      const put = model.byIri(`${LEND}Tome`)?.operations.find((o) => o.method === 'PUT')
      expect(put?.description).toMatch(/cleared/)
    })

    it('reads declared outcomes so a status is reported by meaning, not by body slice', () => {
      const put = model.byIri(`${LEND}Loan`)?.operations.find((o) => o.method === 'PUT')
      expect(put?.possibleStatus.map((s) => s.code)).toEqual([402, 423])
      expect(put?.possibleStatus.find((s) => s.code === 402)?.description).toMatch(/fines/)
    })

    it('offers no write operations on a class that declares none', () => {
      expect(model.byIri(`${LEND}Stack`)?.operations.map((o) => o.method)).toEqual(['GET'])
    })
  })

  describe('IRI templates', () => {
    it('classifies by what variables bind to, not by the label text', () => {
      const templates = model.byIri(`${LEND}Stacks`)?.templates ?? []
      const kinds = templates.map((t) => t.kind).sort()
      expect(kinds).toEqual(['freetext', 'pagination'])

      // The pagination variable is named "leaf", not "page" — a name-based client would miss it.
      const pagination = templates.find((t) => t.kind === 'pagination')
      expect(pagination?.mappings[0]?.variable).toBe('leaf')
      expect(pagination?.mappings[0]?.property).toBe(HYDRA.pageIndex)
    })

    it('binds filter variables to their properties', () => {
      const search = model.byIri(`${LEND}Stacks`)?.templates.find((t) => t.kind === 'freetext')
      const byVariable = new Map(search?.mappings.map((m) => [m.variable, m.property]))
      expect(byVariable.get('anything')).toBe(HYDRA.freetextQuery)
      expect(byVariable.get('heading')).toBe(`${LEND}heading`)
    })
  })

  describe('properties and gaps', () => {
    it('marks a Link and carries its declared range', () => {
      const borrower = model.byIri(`${LEND}Loan`)?.properties.find((p) => p.iri === `${LEND}borrower`)
      expect(borrower?.isLink).toBe(true)
      expect(borrower?.range).toBe(`${LEND}Patron`)
      expect(borrower?.required).toBe(true)
    })

    it('reports an undeclared range as absent rather than inventing one', () => {
      // Design D8: the client states its limit precisely and hands the problem to the layer permitted
      // to guess. What it must never do is quietly drop the field, which the POC did at index.html:608.
      const guarantor = model.byIri(`${LEND}Loan`)?.properties.find((p) => p.iri === `${LEND}guarantor`)
      expect(guarantor?.isLink).toBe(true)
      expect(guarantor?.range).toBeNull()
    })

    it('distinguishes readable from writeable', () => {
      const member = model.byIri(`${LEND}Stacks`)?.properties.find((p) => p.iri === HYDRA.member)
      expect(member?.readable).toBe(true)
      expect(member?.writeable).toBe(false)
    })
  })

  it('is byte-identical across two builds of the same vocabulary', async () => {
    // Tools render at prompt-prefix position 0. Any reordering invalidates the cache on every request.
    const again = await modelFor(libraryVocab, 'https://lending.example/api/vocab')
    expect(JSON.stringify(again.model.classes)).toBe(JSON.stringify(model.classes))
  })
})

describe('the same code against the real vocabulary', () => {
  let model: CapabilityModel
  let graph: SessionGraph

  beforeAll(async () => {
    const built = await modelFor(magoVocab, 'http://localhost:1648/Api/Vocab')
    model = built.model
    graph = built.graph
  })

  it('finds the declared classes and collections', () => {
    expect(model.classes.length).toBeGreaterThan(20)
    expect(model.collections.length).toBeGreaterThan(5)
  })

  it('associates a real collection with its member class from the declaration', () => {
    const contacts = model.classes.find((c) => c.iri.endsWith('ContactCollection'))
    expect(contacts?.memberClass).toMatch(/ns#Contact$/)
  })

  it('reads the 402 this API declares, which is the reason possibleStatus matters', () => {
    const declared = model.classes
      .flatMap((c) => c.operations)
      .flatMap((o) => o.possibleStatus)
      .map((s) => s.code)
    expect(declared).toContain(402)
  })

  describe('joining SHACL to Hydra on the predicate IRI', () => {
    beforeAll(async () => {
      graph.ingestDocument(
        await quadsFromJsonLd(magoShapes, offlineContexts().load, 'http://localhost:1648/Api/Shapes'),
        GRAPHS.shapes,
      )
    })

    it('finds constraints for a class, keyed by predicate', () => {
      const contactClass = model.classes.find((c) => /ns#Contact$/.test(c.iri))
      expect(contactClass).toBeDefined()

      const constraints = constraintsFor(graph, contactClass!.iri)
      expect(constraints.size).toBeGreaterThan(0)

      // The join key is an IRI, which is the only reason two independently written documents line up.
      const hydraProperties = new Set(contactClass!.properties.map((p) => p.iri))
      const joined = [...constraints.keys()].filter((path) => hydraProperties.has(path))
      expect(joined.length).toBeGreaterThan(0)
    })

    it('carries the residue that JSON Schema cannot express, for the dispatch gate', () => {
      const all = model.classes.flatMap((c) => [...constraintsFor(graph, c.iri).values()])
      expect(all.some((c) => c.maxLength !== null)).toBe(true)
    })

    it('reads sh:in as a value set, walking the RDF list', () => {
      const all = model.classes.flatMap((c) => [...constraintsFor(graph, c.iri).values()])
      const withEnum = all.filter((c) => c.allowedValues.length > 0)

      // sh:in is the highest-value mapping in design D3: a prose hint becomes an enum the model cannot
      // deviate from. If the list walk were broken this would silently be empty.
      expect(withEnum.length).toBeGreaterThan(0)
      expect(withEnum[0]?.allowedValues.length).toBeGreaterThan(1)
    })
  })
})
