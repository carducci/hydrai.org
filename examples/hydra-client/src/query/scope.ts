import { locateClass } from '../execute/locate'
import type { SessionGraph } from '../rdf/session-graph'
import type { CapabilityModel } from '../vocab/capability'

import { compactIri } from './gate'
import type { ParsedQuery } from './parse'

/**
 * Query scoping (task 7.2a, design D7).
 *
 * A local query runs over what the store holds, so something has to decide what the store must hold
 * before it runs. That decision is read out of the query: every class named in an `rdf:type` pattern
 * is a class whose instances the query will touch, and each maps to a collection through the
 * `hydra:member` range the vocabulary declares — the same association task 3.3 reads, and emphatically
 * not the class name with an `s` on the end.
 *
 * A query that cannot be scoped is refused rather than run over whatever happens to be held. `?s ?p ?o`
 * with no type pattern would execute perfectly well against a store holding one page of one collection
 * and return an answer about that page, which is the shape of wrong answer this whole stage exists to
 * prevent.
 */

export interface ScopedCollection {
  /** The class whose instances the query names. */
  readonly memberClassIri: string
  /** The collection class that declares those instances as its members. */
  readonly collectionClassIri: string
  /** Where that collection lives, as the server published it. `null` when nothing published it. */
  readonly url: string | null
  /** Why there is no URL, when there is none. */
  readonly reason: string | null
}

export interface QueryScope {
  readonly collections: readonly ScopedCollection[]
  /** Why this query cannot be answered locally. `null` when it can. */
  readonly refusal: string | null
}

export interface ScopeDeps {
  readonly graph: SessionGraph
  readonly model: CapabilityModel
  readonly entrypoint: string | null
  readonly prefixes?: ReadonlyMap<string, string>
}

/**
 * What the query needs materialised, or why that cannot be worked out.
 *
 * Collections come back sorted by class IRI so a plan for the same query is the same plan on every
 * run — the traversal order is observable in the trace, and an order that varied would make two
 * identical runs look like different ones.
 */
export function scopeQuery(parsed: ParsedQuery, deps: ScopeDeps): QueryScope {
  const short = (iri: string) => compactIri(iri, deps.prefixes)

  const named = [...new Set(parsed.types.map((pattern) => pattern.classIri))].sort()

  if (named.length === 0) {
    return {
      collections: [],
      refusal:
        `The query names no class, so there is no way to tell what it should run over. Nothing is ` +
        `retrieved speculatively here: a query without a type pattern would be answered from whatever ` +
        `happened to be held already, and a total over that is a wrong number that looks like a right ` +
        `one. Add a type pattern — "?x a <Class>" — naming the class whose instances you mean. The ` +
        `classes this API declares are in the vocabulary section of your instructions.`,
    }
  }

  const collections: ScopedCollection[] = []
  const unmapped: string[] = []

  for (const classIri of named) {
    const declared = deps.model.byIri(classIri)

    /*
     * A query may name the collection class itself rather than its member class. Both are real
     * readings of the vocabulary, so both resolve — what must not happen is guessing one from the
     * other's spelling.
     */
    const collection = declared?.isCollection ? declared : deps.model.collectionFor(classIri)

    if (!collection) {
      unmapped.push(classIri)
      continue
    }

    const location = locateClass(collection, { graph: deps.graph, entrypoint: deps.entrypoint })
    collections.push({
      memberClassIri: collection.memberClass ?? classIri,
      collectionClassIri: collection.iri,
      url: location.url,
      reason: location.url === null ? location.reason : null,
    })
  }

  if (unmapped.length > 0) {
    return {
      collections,
      refusal:
        `${unmapped.map(short).join(', ')} ${unmapped.length === 1 ? 'is a class' : 'are classes'} ` +
        `this API declares, but no collection declares ${unmapped.length === 1 ? 'it' : 'them'} as ` +
        `its members — no supported property with a hydra:member range names ` +
        `${unmapped.length === 1 ? 'it' : 'them'}. So there is no published route to the instances, ` +
        `and this client will not construct one from the class name. Query a class that a collection ` +
        `serves, or read the resources individually by IRI.`,
    }
  }

  const unlocatable = collections.filter((entry) => entry.url === null)
  if (unlocatable.length > 0) {
    return {
      collections,
      refusal: unlocatable
        .map((entry) => `${short(entry.collectionClassIri)}: ${entry.reason}`)
        .join('\n\n'),
    }
  }

  return { collections, refusal: null }
}
