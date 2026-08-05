import { materialise, type CollectionDeps } from '../execute/collection'
import { locateClass } from '../execute/locate'
import { rebaseAndDisclose } from '../execute/origin'
import { GRAPHS, LD_LABELS } from '../rdf/terms'
import type { ValueSetIndex, ValueSetMember } from '../render/affordances'
import type { CapabilityModel, ClassCapability } from './capability'

/**
 * Live enums (design D5).
 *
 * Where a property declares `sh:class` naming a class whose instances a **read-only** collection
 * serves **in full**, those instances are the property's value set: rendered in the map and in
 * affordance contracts, and enforced at the dispatch gate. Both conditions are read, never
 * guessed:
 *
 * - *Read-only* is a property of the vocabulary — the collection declares no unsafe operation.
 * - *In full* is a property of the response — a page serving no `hydra:PartialCollectionView`
 *   served every member it has (the no-view proof `execute/collection` already relies on).
 *
 * Where either condition fails — an unlocatable collection, an incomplete traversal, a budget the
 * set exceeds — that class simply has no value set, and every consumer degrades to the plain IRI
 * reference behaviour it had before. The feature never blocks a connect and never guesses
 * enumerability.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

/**
 * The collections eligible to serve a value set: a declared member class, and nothing unsafe.
 *
 * A collection declaring no operations at all still qualifies — read-only is the absence of a
 * declared write, not the presence of a declared read.
 */
export function referenceCollections(model: CapabilityModel): ClassCapability[] {
  return model.collections.filter(
    (cls) =>
      cls.memberClass !== null &&
      cls.operations.every((operation) => SAFE_METHODS.has(operation.method.toUpperCase())),
  )
}

export interface ValueSetOptions {
  /**
   * Members one reference collection may cost at connect. A modest guard, not the traversal
   * budget: a "reference" collection with thousands of members is not an enumeration the prompt
   * should inline, so it degrades rather than being paid for.
   */
  readonly budget?: number
  /** The entry point IRI, for locating a collection from a declared link. */
  readonly entrypoint?: string | null
}

/**
 * Materialise every reference collection and index the members by the class they instantiate.
 *
 * Members are sorted by IRI so every consumer that renders them — the map, a contract, a refusal —
 * is byte-stable across connects.
 */
export async function materialiseValueSets(
  model: CapabilityModel,
  deps: CollectionDeps,
  options: ValueSetOptions = {},
): Promise<ValueSetIndex> {
  const budget = options.budget ?? 500
  const entrypoint = options.entrypoint ?? null
  const sets = new Map<string, readonly ValueSetMember[]>()

  const labelOf = (iri: string): string | null => {
    for (const predicate of LD_LABELS) {
      const [found] = deps.graph.match(iri, predicate, null, GRAPHS.data)
      if (found) return found.object.value
    }
    return null
  }

  for (const cls of referenceCollections(model)) {
    const located = locateClass(cls, { graph: deps.graph, entrypoint })
    if (located.url === null) continue

    const url = rebaseAndDisclose(located.url, `The IRI declared for <${cls.iri}>`, {
      origin: deps.origin,
      findings: deps.findings,
      trace: deps.trace,
    })

    try {
      const result = await materialise(url, deps, { budget })
      // Completeness by the no-view proof. An incomplete set is not a value set — enforcing
      // membership against it would refuse values the server actually serves.
      if (!result.complete) {
        deps.trace.log(
          `<${cls.iri}> could not be materialised in full, so <${cls.memberClass}> carries no ` +
            `value set and stays a plain IRI reference.`,
          'warn',
        )
        continue
      }

      const members = [...result.members]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((iri) => ({ iri, label: labelOf(iri) }))
      sets.set(cls.memberClass as string, members)

      deps.trace.log(
        `<${cls.memberClass}> has a live value set: ${members.length} member` +
          `${members.length === 1 ? '' : 's'} served in full by <${cls.iri}>.`,
        'success',
      )
    } catch (cause) {
      // An unreachable reference collection costs the value set, never the connect.
      const reason = cause instanceof Error ? cause.message : String(cause)
      deps.trace.log(
        `Materialising <${cls.iri}> failed (${reason}); <${cls.memberClass}> stays a plain IRI ` +
          `reference.`,
        'warn',
      )
    }
  }

  return { byClass: (classIri) => sets.get(classIri) }
}
