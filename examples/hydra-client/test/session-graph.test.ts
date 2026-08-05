import { beforeEach, describe, expect, it } from 'vitest'

import { quadsFromTurtle } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'

const JANE = 'http://example.test/Api/Contact/Id/a3f'
const CONTACTS = 'http://example.test/Api/Contact/'
const SEARCH = 'http://example.test/Api/Contact?q=jane'

const listingQuads = quadsFromTurtle(
  `@prefix schema: <http://schema.org/> .
   <${JANE}> schema:givenName "Jane" .`,
  SEARCH,
)

const dereferencedQuads = quadsFromTurtle(
  `@prefix schema: <http://schema.org/> .
   <${JANE}> schema:givenName "Jane" ; schema:jobTitle "Engineer" .`,
  JANE,
)

describe('the session graph', () => {
  let graph: SessionGraph

  beforeEach(() => {
    graph = createSessionGraph()
  })

  it('holds what it ingests, addressed by IRI', () => {
    graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })

    expect(graph.describe(JANE)).toHaveLength(1)
    expect(graph.subjects()).toEqual([JANE])
  })

  it('keeps provenance out of the data graph', () => {
    graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })

    // Provenance is *about* the data, not *in* it — otherwise every data query has to exclude it.
    expect(graph.match(JANE, null, null, GRAPHS.data)).toHaveLength(1)
    expect(graph.match(JANE, null, null, GRAPHS.prov).length).toBeGreaterThan(0)
  })

  describe('a dereferenced description and a collection member are distinguishable', () => {
    /**
     * This is what makes absence meaningful. RDF cannot tell "Jane has no jobTitle" from "the
     * description I hold does not mention jobTitle", so a missing value may only be reported to the
     * user over a dereferenced description or a completeness-gated collection.
     */
    it('records which kind of description it holds', () => {
      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })
      expect(graph.provenanceOf(JANE)?.kind).toBe('collection-member')

      const fresh = createSessionGraph()
      fresh.ingest(dereferencedQuads, { url: JANE, kind: 'dereferenced', fetchedAt: new Date() })
      expect(fresh.provenanceOf(JANE)?.kind).toBe('dereferenced')
    })

    it('never demotes a dereferenced description back to a collection member', () => {
      graph.ingest(dereferencedQuads, { url: JANE, kind: 'dereferenced', fetchedAt: new Date() })
      // Seeing the subject again in a listing adds nothing about absence, so it must not take away
      // the right to reason about missing values.
      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })

      expect(graph.provenanceOf(JANE)?.kind).toBe('dereferenced')
    })

    it('ranks member-complete between collection-member and dereferenced', () => {
      // Task 2.1 / design D3. A member proven complete by its listing is stronger than a plain
      // listing entry — a later ordinary sighting does not demote it — but weaker than a dereference,
      // which still supersedes it so the provenance never claims a fetch that did not happen.
      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })
      graph.markMembersComplete([JANE])
      expect(graph.provenanceOf(JANE)?.kind).toBe('member-complete')

      // A later plain listing sighting must not knock it back to collection-member.
      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })
      expect(graph.provenanceOf(JANE)?.kind).toBe('member-complete')

      // A dereference supersedes it.
      graph.ingest(dereferencedQuads, { url: JANE, kind: 'dereferenced', fetchedAt: new Date() })
      expect(graph.provenanceOf(JANE)?.kind).toBe('dereferenced')
    })

    it('does not invent a description for a member never ingested', () => {
      // markMembersComplete strengthens what is held; it never conjures a description for an IRI the
      // session has never seen, which would claim completeness for a resource never retrieved.
      graph.markMembersComplete(['http://example.test/Api/Contact/Id/never'])
      expect(graph.provenanceOf('http://example.test/Api/Contact/Id/never')).toBeNull()
    })
  })

  describe('provenance survives re-ingestion from a second source', () => {
    it('accumulates sources and advances the retrieval time', () => {
      const first = new Date('2026-07-29T10:00:00.000Z')
      const second = new Date('2026-07-29T11:30:00.000Z')

      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: first })
      graph.ingest(dereferencedQuads, { url: JANE, kind: 'dereferenced', fetchedAt: second })

      const prov = graph.provenanceOf(JANE)
      expect(prov?.sources).toHaveLength(2)
      expect(prov?.sources).toContain(SEARCH)
      expect(prov?.sources).toContain(JANE)
      // Staleness is about the most recent read, so the timestamp is single-valued and latest-wins.
      expect(prov?.fetchedAt.toISOString()).toBe(second.toISOString())
    })

    it('does not record the same source twice', () => {
      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })
      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })

      expect(graph.provenanceOf(JANE)?.sources).toEqual([SEARCH])
    })

    it('reports an age, so a value served from the store can be labelled with it', () => {
      graph.ingest(listingQuads, {
        url: SEARCH,
        kind: 'collection-member',
        fetchedAt: new Date(Date.now() - 60_000),
      })
      expect(graph.provenanceOf(JANE)?.ageMs).toBeGreaterThanOrEqual(59_000)
    })

    it('has no provenance for a subject it has never seen', () => {
      expect(graph.provenanceOf('http://example.test/Api/Contact/Id/unknown')).toBeNull()
    })
  })

  describe('replacing a subject after a write', () => {
    it('drops the stale description rather than merging with it', () => {
      graph.ingest(dereferencedQuads, { url: JANE, kind: 'dereferenced', fetchedAt: new Date() })
      expect(graph.describe(JANE)).toHaveLength(2)

      // A PUT replaces the whole resource, so the echoed representation replaces the whole
      // description. Merging would resurrect a field the write removed.
      const afterWrite = quadsFromTurtle(
        `@prefix schema: <http://schema.org/> .
         <${JANE}> schema:givenName "Jane" .`,
        JANE,
      )
      graph.replaceSubject(JANE, afterWrite, {
        url: JANE,
        kind: 'dereferenced',
        fetchedAt: new Date(),
      })

      const held = graph.describe(JANE)
      expect(held).toHaveLength(1)
      expect(held.map((q) => q.predicate.value)).not.toContain('http://schema.org/jobTitle')
    })
  })

  describe('completeness gates aggregation (design D5)', () => {
    it('refuses to call a partial materialisation complete', () => {
      graph.recordCompleteness(CONTACTS, { have: 250, total: 4832, at: new Date() })

      const state = graph.completenessOf(CONTACTS)
      expect(state?.have).toBe(250)
      expect(state?.total).toBe(4832)
      expect(state?.complete).toBe(false)
    })

    it('is complete only when every member is held', () => {
      graph.recordCompleteness(CONTACTS, { have: 4832, total: 4832, at: new Date() })
      expect(graph.completenessOf(CONTACTS)?.complete).toBe(true)
    })

    it('is never complete on a partial view with no declared total', () => {
      // Unknowable is not the same as satisfied. A partial view and no total means there is nothing to
      // check against, and an aggregate would be a guess wearing a number's clothing.
      graph.recordCompleteness(CONTACTS, { have: 12, total: null, at: new Date(), partial: true })

      const state = graph.completenessOf(CONTACTS)
      expect(state?.total).toBeNull()
      expect(state?.complete).toBe(false)
    })

    it('is never complete when the collection was silent about being partial', () => {
      // Not asked is not the same as answered "no".
      graph.recordCompleteness(CONTACTS, { have: 12, total: null, at: new Date() })
      expect(graph.completenessOf(CONTACTS)?.complete).toBe(false)
    })

    it('is complete with no declared total when the collection is not partial', () => {
      /*
       * A collection serving no `hydra:PartialCollectionView` is not partial — the document held every
       * member. This API's reference collections are exactly that: `/Api/Salutation` returns two
       * members with no `hydra:view` and no `hydra:totalItems`. Demanding a declared total would
       * refuse aggregation over them permanently, which is the wrong answer arrived at cautiously.
       */
      graph.recordCompleteness(CONTACTS, { have: 2, total: null, at: new Date(), partial: false })

      const state = graph.completenessOf(CONTACTS)
      expect(state?.total).toBeNull()
      expect(state?.complete).toBe(true)
    })

    it('carries whether members serve every readable field', () => {
      graph.recordCompleteness(CONTACTS, {
        have: 4832,
        total: 4832,
        at: new Date(),
        aggregationReady: false,
      })
      // Complete but not aggregation-ready: all 4,832 members held, none of them carrying the field
      // being summed. That combination is exactly how a confidently wrong total arises.
      const state = graph.completenessOf(CONTACTS)
      expect(state?.complete).toBe(true)
      expect(state?.aggregationReady).toBe(false)
    })

    it('has nothing to say about a collection it has not materialised', () => {
      expect(graph.completenessOf(CONTACTS)).toBeNull()
    })
  })

  describe('connect-time documents', () => {
    it('replaces a document wholesale rather than merging revisions', () => {
      const v1 = quadsFromTurtle(
        `<http://example.test/ns#Contact> <http://www.w3.org/ns/hydra/core#method> "PUT" .`,
        'http://example.test/Api/Vocab',
      )
      const v2 = quadsFromTurtle(
        `<http://example.test/ns#Contact> <http://www.w3.org/ns/hydra/core#method> "PATCH" .`,
        'http://example.test/Api/Vocab',
      )

      graph.ingestDocument(v1, GRAPHS.vocab)
      graph.ingestDocument(v2, GRAPHS.vocab)

      // An operation the API stopped declaring must disappear from the capability model, not linger.
      const methods = graph.match(null, null, null, GRAPHS.vocab).map((q) => q.object.value)
      expect(methods).toEqual(['PATCH'])
    })

    it('keeps documents out of the data graph', () => {
      const vocab = quadsFromTurtle(
        `<http://example.test/ns#Contact> <http://www.w3.org/2000/01/rdf-schema#label> "Contact" .`,
        'http://example.test/Api/Vocab',
      )
      graph.ingestDocument(vocab, GRAPHS.vocab)

      expect(graph.match(null, null, null, GRAPHS.data)).toHaveLength(0)
      expect(graph.subjects()).toEqual([])
    })
  })

  describe('eviction', () => {
    it('drops subjects older than a cutoff, with their provenance', () => {
      graph.ingest(listingQuads, {
        url: SEARCH,
        kind: 'collection-member',
        fetchedAt: new Date('2026-07-01T00:00:00.000Z'),
      })
      graph.evict({ olderThan: new Date('2026-07-15T00:00:00.000Z') })

      expect(graph.describe(JANE)).toHaveLength(0)
      expect(graph.provenanceOf(JANE)).toBeNull()
    })

    it('keeps subjects newer than the cutoff', () => {
      graph.ingest(listingQuads, {
        url: SEARCH,
        kind: 'collection-member',
        fetchedAt: new Date('2026-07-29T00:00:00.000Z'),
      })
      graph.evict({ olderThan: new Date('2026-07-15T00:00:00.000Z') })

      expect(graph.describe(JANE)).toHaveLength(1)
    })

    it('leaves connect-time documents alone when clearing all data', () => {
      const vocab = quadsFromTurtle(
        `<http://example.test/ns#Contact> <http://www.w3.org/2000/01/rdf-schema#label> "Contact" .`,
        'http://example.test/Api/Vocab',
      )
      graph.ingestDocument(vocab, GRAPHS.vocab)
      graph.ingest(listingQuads, { url: SEARCH, kind: 'collection-member', fetchedAt: new Date() })

      graph.evict({ all: true })

      // Evicting data must not force a reconnect: the vocabulary is what the tool surface is built
      // from and re-fetching it would rebuild every tool definition.
      expect(graph.describe(JANE)).toHaveLength(0)
      expect(graph.match(null, null, null, GRAPHS.vocab)).toHaveLength(1)
    })
  })
})
