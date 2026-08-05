import type { Source } from '@rdfjs/types'
import { DataFactory, Store, type Quad, type Term } from 'n3'

import {
  DESCRIPTION_KIND_IRI,
  GRAPHS,
  HCT,
  HYDRA,
  NS,
  PROV,
  type DescriptionKind,
  type GraphName,
} from './terms'

const { namedNode, literal, quad: makeQuad } = DataFactory

/**
 * The session graph (design D4).
 *
 * One data graph and one provenance graph. The rejected alternatives are worth remembering: per-URL
 * named graphs give exact provenance but turn a 194-page materialisation into 194 graphs and every
 * query into a union; per-turn graphs give one graph to query but throw away a complete Event set at
 * the end of each turn and re-fetch it in the next. Provenance does not need to live *in* the data —
 * it needs to be *about* it.
 *
 * **N3 does not leak past this module.** That is the seam that makes the layout changeable later:
 * swapping one-data-plus-prov for per-URL or per-turn graphs becomes a change inside this file with
 * the suite unchanged. Change it when a measurement says to, not before.
 */

/**
 * An IRI, or an RDF term carried back from a previous match.
 *
 * Strings are read as IRIs. Blank nodes must be passed as terms — see `match`.
 */
export type TermLike = string | Term

export interface IngestSource {
  /** The document these quads were read out of. */
  readonly url: string
  /** Whether this was a dereference of the subject, or an entry in a collection listing. */
  readonly kind: DescriptionKind
  readonly fetchedAt: Date
}

export interface Provenance {
  /** Every document this subject has been read from, most recent first. */
  readonly sources: readonly string[]
  readonly fetchedAt: Date
  readonly kind: DescriptionKind
  /** Age in milliseconds at the moment of asking. */
  readonly ageMs: number
}

export interface Completeness {
  /** Members currently held. */
  readonly have: number
  /** What the collection says it holds, or `null` if it did not say. */
  readonly total: number | null
  readonly at: Date
  /** Every member carries every readable property of its class — see design D5. */
  readonly aggregationReady: boolean | null
  /**
   * Readable properties the class declares that these members never mention.
   *
   * An aggregate over one of these would total records that never carried the field, so the gate
   * needs them named rather than counted — the refusal has to say *which* field is missing.
   */
  readonly unserved: readonly string[]
  /** The only condition under which an aggregate may be computed. */
  readonly complete: boolean
}

/**
 * What retrieving the rest of a collection would cost, decided before it is retrieved (design D5).
 *
 * > A cap truncates and returns partial data that looks complete. A budget refuses and says why.
 *
 * The distinction is the whole of task 5.3. The proof of concept stopped after ten pages and returned
 * 250 of 3,467 members as though they were the collection; nothing in the result said otherwise. A
 * plan is the opposite move: the cost is known from page one's declared total, so the decision to
 * proceed, to refuse, or to ask for consent happens *before* the requests, and no partial set is ever
 * presented as a whole one.
 */
export interface MaterialisationPlan {
  readonly collection: string
  /** Members already held. */
  readonly have: number
  /** What the collection says it holds, or `null` if it did not say. */
  readonly total: number | null
  /** Still to fetch. `null` when the total is undeclared, which is itself a reason to refuse. */
  readonly remaining: number | null
  readonly complete: boolean
  readonly budget: number
  readonly withinBudget: boolean
  /** Why this cannot proceed, phrased for the model. `null` when it can. */
  readonly refusal: string | null
}

export interface EvictionPolicy {
  /** Drop subjects last fetched before this instant. */
  readonly olderThan?: Date
  /** Drop everything in the data and provenance graphs. Connect-time documents are untouched. */
  readonly all?: boolean
}

/**
 * What everything above the graph layer talks to.
 *
 * The design's sketch put a `query(sparql)` here that "routes local vs remote". It landed as
 * `queryable()` instead, and the difference is a layering one: routing needs the tier, the advertised
 * endpoint and an HTTP client, none of which a store has any business holding. So this layer exposes
 * what a query engine consumes and `query/` decides where the query runs.
 */
export interface SessionGraph {
  /** Data about a subject, with its provenance recorded alongside. */
  ingest(quads: readonly Quad[], source: IngestSource): void
  /** A connect-time document — vocabulary, shapes, ontology, context — into its own stable graph. */
  ingestDocument(quads: readonly Quad[], graph: GraphName): void
  /** Every statement held about a subject. */
  describe(iri: string): Quad[]
  /** Replace everything held about a subject. Used after a write echoes the new representation. */
  replaceSubject(iri: string, quads: readonly Quad[], source: IngestSource): void
  provenanceOf(iri: string): Provenance | null
  /**
   * Record that these members were carried in full by a listing assessed complete for their class
   * (design D3), so a later value read is served from the store rather than re-dereferenced.
   *
   * Strengthens the description kind and nothing else — the members' data and retrieval time are
   * already held from the listing that ingested them. A member already `dereferenced` is left as it
   * is; `strongerKind` never demotes.
   */
  markMembersComplete(iris: readonly string[]): void
  completenessOf(collectionIri: string): Completeness | null
  recordCompleteness(collectionIri: string, facts: CompletenessFacts): void
  /**
   * What finishing this collection would cost, and whether that is affordable.
   *
   * On the seam rather than above it because every input is already here — what is held, what the
   * collection declared, and whether it declared anything at all. A caller that computed this for
   * itself would be reimplementing `completenessOf` with a different idea of what counts as proof.
   */
  planFor(collectionIri: string, options: { budget: number }): MaterialisationPlan
  /**
   * Pattern match. `null` is a wildcard. Returns quads from every graph unless one is named.
   *
   * Accepts a `Term` as well as an IRI string, and that is not a convenience — it is required for
   * correctness. Hydra puts its operations, supported properties, templates, mappings and statuses in
   * **blank nodes**, and a blank node's `value` is a bare label with no `_:`. Passing that label back as
   * a string would build a `NamedNode` and match nothing, so any traversal into those structures has to
   * carry the term itself. Terms here are RDF/JS interfaces, not N3 types, so the seam holds.
   */
  match(
    subject?: TermLike | null,
    predicate?: string | null,
    object?: TermLike | null,
    graph?: GraphName | null,
  ): Quad[]
  /** Subjects held in the data graph. */
  subjects(): string[]
  /**
   * The retrieved data, as something a query engine can read.
   *
   * Returns an RDF/JS `Source`, which is an interface rather than an implementation — the same
   * reason `match` accepts RDF/JS terms. N3 still does not leak.
   *
   * Quads are presented **in the default graph**, which is not cosmetic: data is held in a named
   * graph here, and a SPARQL query with no `GRAPH` clause reads the default graph. Handed the store
   * as it is laid out, every query would match nothing and return an empty result — the precise
   * failure the term gate exists to prevent, arriving through the plumbing instead.
   *
   * Only the data graph. Provenance, findings and the connect-time documents are statements *about*
   * the API rather than data retrieved from it, and folding them in would let a query total the
   * vocabulary alongside the records.
   */
  queryable(): Source
  evict(policy: EvictionPolicy): void
  readonly size: number
}

export interface CompletenessFacts {
  readonly have: number
  readonly total?: number | null
  readonly at: Date
  readonly aggregationReady?: boolean | null
  /**
   * Whether the collection served a `hydra:PartialCollectionView`.
   *
   * `false` is a completeness proof in its own right. A collection that declares no partial view is,
   * by Hydra, not partial — every member is in the document. This API's reference collections work
   * exactly that way: `/Api/Salutation` returns two members with no `hydra:view` and no
   * `hydra:totalItems`, and requiring a declared total would refuse aggregation over them forever.
   *
   * `undefined` means the question was not asked, which is not the same as `true`.
   */
  readonly partial?: boolean | null
  /**
   * Readable properties the class declares that these members never mention — task 3.5's `missing`.
   *
   * `undefined` means member serialisation was not assessed. Not the same as an empty list, which is
   * the positive finding that every declared property is served.
   */
  readonly unserved?: readonly string[] | null
}

function dateTime(value: Date) {
  return literal(value.toISOString(), namedNode(`${NS.xsd}dateTime`))
}

function integer(value: number) {
  return literal(String(value), namedNode(`${NS.xsd}integer`))
}

function boolean(value: boolean) {
  return literal(String(value), namedNode(`${NS.xsd}boolean`))
}

/** A bare string is an IRI; anything already a term keeps its identity, blank nodes included. */
function asTerm(value: TermLike | null): Term | null {
  if (value === null) return null
  return typeof value === 'string' ? namedNode(value) : value
}

/**
 * Description kind only ever strengthens (design D3).
 *
 * Ranked weakest to strongest: a plain listing entry, a listing proven to serialise every field, a
 * dereference. A later, weaker sighting never demotes a stronger one — a `member-complete` member is
 * not knocked back by being seen again in an ordinary listing, and neither is superseded by anything
 * short of a dereference. Equal strength lets the incoming win, which for two `collection-member`
 * sightings is the same as before.
 */
const KIND_RANK: Record<DescriptionKind, number> = {
  'collection-member': 0,
  'member-complete': 1,
  dereferenced: 2,
}

function strongerKind(existing: DescriptionKind | null, incoming: DescriptionKind): DescriptionKind {
  if (existing === null) return incoming
  return KIND_RANK[incoming] >= KIND_RANK[existing] ? incoming : existing
}

export function createSessionGraph(): SessionGraph {
  const store = new Store()
  const dataGraph = namedNode(GRAPHS.data)
  const provGraph = namedNode(GRAPHS.prov)

  /** Re-graph incoming quads. A document's own `@graph` structure flattens into the one data graph. */
  function into(quads: readonly Quad[], graph: string): Quad[] {
    return quads.map((q) => makeQuad(q.subject, q.predicate, q.object, namedNode(graph)))
  }

  function readKind(iri: string): DescriptionKind | null {
    const [held] = store.getQuads(namedNode(iri), namedNode(HCT.descriptionKind), null, provGraph)
    if (!held) return null
    if (held.object.value === HCT.DereferencedDescription) return 'dereferenced'
    if (held.object.value === HCT.MemberComplete) return 'member-complete'
    return 'collection-member'
  }

  /** Write the description kind for a subject, strengthening but never demoting what is already held. */
  function writeKind(iri: string, incoming: DescriptionKind): void {
    const subject = namedNode(iri)
    const kind = strongerKind(readKind(iri), incoming)
    store.removeQuads(store.getQuads(subject, namedNode(HCT.descriptionKind), null, provGraph))
    store.addQuad(subject, namedNode(HCT.descriptionKind), namedNode(DESCRIPTION_KIND_IRI[kind]), provGraph)
  }

  function recordProvenance(iri: string, source: IngestSource): void {
    const subject = namedNode(iri)

    // `wasDerivedFrom` accumulates: knowing a subject was seen in a listing *and* dereferenced is
    // strictly more than knowing only the latest of the two.
    const already = store
      .getQuads(subject, namedNode(PROV.wasDerivedFrom), null, provGraph)
      .some((q) => q.object.value === source.url)
    if (!already) {
      store.addQuad(subject, namedNode(PROV.wasDerivedFrom), namedNode(source.url), provGraph)
    }

    // Retrieval time is single-valued and the most recent wins — it answers "how stale is this".
    store.removeQuads(store.getQuads(subject, namedNode(PROV.generatedAtTime), null, provGraph))
    store.addQuad(subject, namedNode(PROV.generatedAtTime), dateTime(source.fetchedAt), provGraph)

    /*
     * Description kind only ever strengthens.
     *
     * This is what makes absence meaningful: RDF cannot distinguish "Jane has no jobTitle" from "the
     * description I hold does not mention jobTitle", and only a dereference settles it. Seeing a
     * subject again in a collection listing adds no information about absence, so demoting the kind
     * would lose the right to reason about missing values — a silent narrowing of what the client can
     * honestly say.
     */
    writeKind(iri, source.kind)
  }

  function subjectsOf(quads: readonly Quad[]): string[] {
    const seen = new Set<string>()
    for (const q of quads) {
      if (q.subject.termType === 'NamedNode') seen.add(q.subject.value)
    }
    return [...seen]
  }

  return {
    ingest(quads, source) {
      store.addQuads(into(quads, GRAPHS.data))
      for (const iri of subjectsOf(quads)) recordProvenance(iri, source)
    },

    ingestDocument(quads, graph) {
      // Replace wholesale: a refreshed vocabulary supersedes the previous one rather than merging
      // with it, or a removed operation would linger in the capability model forever.
      store.removeQuads(store.getQuads(null, null, null, namedNode(graph)))
      store.addQuads(into(quads, graph))
    },

    describe(iri) {
      return store.getQuads(namedNode(iri), null, null, dataGraph)
    },

    replaceSubject(iri, quads, source) {
      store.removeQuads(store.getQuads(namedNode(iri), null, null, dataGraph))
      store.addQuads(into(quads, GRAPHS.data))
      recordProvenance(iri, source)
    },

    markMembersComplete(iris) {
      for (const iri of iris) {
        // Only a member something is actually held about — an IRI never ingested has no description
        // to strengthen, and inventing one would claim completeness for a resource never seen.
        if (readKind(iri) === null) continue
        writeKind(iri, 'member-complete')
      }
    },

    provenanceOf(iri) {
      const subject = namedNode(iri)
      const [when] = store.getQuads(subject, namedNode(PROV.generatedAtTime), null, provGraph)
      if (!when) return null

      const sources = store
        .getQuads(subject, namedNode(PROV.wasDerivedFrom), null, provGraph)
        .map((q) => q.object.value)
      const fetchedAt = new Date(when.object.value)

      return {
        sources,
        fetchedAt,
        kind: readKind(iri) ?? 'collection-member',
        ageMs: Date.now() - fetchedAt.getTime(),
      }
    },

    completenessOf(collectionIri) {
      const subject = namedNode(collectionIri)
      const [at] = store.getQuads(subject, namedNode(HCT.materialisedAt), null, provGraph)
      if (!at) return null

      const value = (predicate: string): number | null => {
        const [held] = store.getQuads(subject, namedNode(predicate), null, provGraph)
        return held ? Number(held.object.value) : null
      }

      const have = value(HCT.memberCount) ?? 0
      const total = value(HYDRA.totalItems)

      const [ready] = store.getQuads(subject, namedNode(HCT.aggregationReady), null, provGraph)
      const [partialQuad] = store.getQuads(subject, namedNode(HCT.partial), null, provGraph)
      const partial = partialQuad ? partialQuad.object.value === 'true' : null

      const unserved = store
        .getQuads(subject, namedNode(HCT.unservedProperty), null, provGraph)
        .map((held) => held.object.value)
        .sort()

      return {
        have,
        total,
        at: new Date(at.object.value),
        aggregationReady: ready ? ready.object.value === 'true' : null,
        unserved,
        partial,
        /*
         * Two independent proofs of completeness, and nothing else counts.
         *
         * Either the collection declared its size and we hold all of it, or it declared itself not
         * partial — no `hydra:PartialCollectionView` — in which case the single document was the whole
         * collection. Design D5: a cap truncates and returns partial data that looks complete; a
         * budget refuses and says why. Anything short of a proof is the refusal.
         */
        complete: (total !== null && have === total) || partial === false,
      }
    },

    planFor(collectionIri, options) {
      const known = this.completenessOf(collectionIri)
      const have = known?.have ?? 0
      const total = known?.total ?? null
      const complete = known?.complete ?? false
      const remaining = total === null ? null : Math.max(0, total - have)
      const budget = options.budget

      // Nothing left to do, so nothing to afford.
      if (complete) {
        return {
          collection: collectionIri,
          have,
          total,
          remaining: 0,
          complete: true,
          budget,
          withinBudget: true,
          refusal: null,
        }
      }

      if (remaining === null) {
        return {
          collection: collectionIri,
          have,
          total,
          remaining: null,
          complete: false,
          budget,
          withinBudget: false,
          /*
           * An undeclared size is not a small size.
           *
           * Fetching until the links run out would work, but it would mean starting an unbounded
           * traversal with no way to say beforehand what it costs — which is precisely the decision a
           * budget exists to make. So the collection is described honestly and the choice is handed
           * up, rather than guessed at.
           */
          refusal:
            `<${collectionIri}> serves neither a declared total nor a proof that the page held every ` +
            `member, so the cost of completing it is unknown before starting. ${have} member` +
            `${have === 1 ? ' is' : 's are'} held. Publishing hydra:totalItems, or omitting the ` +
            `hydra:PartialCollectionView when a collection is whole, would make this decidable.`,
        }
      }

      const withinBudget = total !== null && total <= budget
      return {
        collection: collectionIri,
        have,
        total,
        remaining,
        complete: false,
        budget,
        withinBudget,
        refusal: withinBudget
          ? null
          : `<${collectionIri}> holds ${total} members and the budget for one materialisation is ` +
            `${budget}. ${have} are held. Completing it needs ${remaining} more, which exceeds the ` +
            `budget — so it is not started. Nothing partial is returned: a total computed over part ` +
            `of a collection is a wrong number that looks like a right one. Raise the budget to ` +
            `proceed, or narrow the question so a filtered view answers it.`,
      }
    },

    recordCompleteness(collectionIri, facts) {
      const subject = namedNode(collectionIri)
      const set = (predicate: string, value: Quad['object']) => {
        store.removeQuads(store.getQuads(subject, namedNode(predicate), null, provGraph))
        store.addQuad(subject, namedNode(predicate), value, provGraph)
      }

      set(HCT.memberCount, integer(facts.have))
      set(HCT.materialisedAt, dateTime(facts.at))
      if (facts.total !== undefined && facts.total !== null) set(HYDRA.totalItems, integer(facts.total))
      if (facts.aggregationReady !== undefined && facts.aggregationReady !== null) {
        set(HCT.aggregationReady, boolean(facts.aggregationReady))
      }
      if (facts.partial !== undefined && facts.partial !== null) set(HCT.partial, boolean(facts.partial))

      if (facts.unserved !== undefined && facts.unserved !== null) {
        // Multi-valued, so the whole set is replaced rather than added to: a re-assessment that found
        // a property now served must not leave the old claim standing beside the new one.
        store.removeQuads(store.getQuads(subject, namedNode(HCT.unservedProperty), null, provGraph))
        for (const property of facts.unserved) {
          store.addQuad(subject, namedNode(HCT.unservedProperty), namedNode(property), provGraph)
        }
      }
    },

    match(subject = null, predicate = null, object = null, graph = null) {
      return store.getQuads(
        asTerm(subject),
        predicate === null ? null : namedNode(predicate),
        asTerm(object),
        graph === null ? null : namedNode(graph),
      )
    },

    subjects() {
      return subjectsOf(store.getQuads(null, null, null, dataGraph))
    },

    queryable() {
      /*
       * A copy, deliberately, and the alternative is worse.
       *
       * Presenting the live store would mean an adapter that re-stamps the graph term of every quad
       * a pattern matches, on every pattern, for the life of the query — and getting that wrong is
       * silent, because a query over an empty result set does not error. Building the projection once
       * is O(quads held), it happens only on the local query path, and what the engine reads is then
       * a plain store with no interception in it.
       */
      const projected = new Store()
      for (const held of store.getQuads(null, null, null, dataGraph)) {
        projected.addQuad(held.subject, held.predicate, held.object)
      }
      return projected
    },

    evict(policy) {
      if (policy.all) {
        store.removeQuads(store.getQuads(null, null, null, dataGraph))
        store.removeQuads(store.getQuads(null, null, null, provGraph))
        return
      }

      const cutoff = policy.olderThan
      if (!cutoff) return

      for (const held of store.getQuads(null, namedNode(PROV.generatedAtTime), null, provGraph)) {
        if (new Date(held.object.value) >= cutoff) continue
        const subject = held.subject
        store.removeQuads(store.getQuads(subject, null, null, dataGraph))
        store.removeQuads(store.getQuads(subject, null, null, provGraph))
      }
    },

    get size() {
      return store.size
    },
  }
}
