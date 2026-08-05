import type { SessionGraph } from '../rdf/session-graph'
import { GRAPHS, HCT, HYDRA, PROV, RDF, RDFS, SHACL, VOID } from '../rdf/terms'
import { MAPPED_DATATYPES } from '../project/tools'
import type { CapabilityModel, PropertyConstraints } from '../vocab/capability'

/**
 * The term gate (task 7.2, design D7).
 *
 * SPARQL is the one surface where the division that governs the rest of this client leaks. Everywhere
 * else a published constraint becomes a guarantee — the model picks from a strict schema and the
 * platform rejects anything else. Here the model emits free text, and nothing structural stops it
 * naming a predicate that does not exist.
 *
 * **The failure is worse at T3, not better.** A remote endpoint given an undeclared predicate does not
 * error: it matches nothing and returns zero rows, and a model reading that reports you earned nothing
 * last year. Locally the same query returns an empty binding set with the same confidence. So the gate
 * runs before the tier fork, on both paths, and rejects rather than executes.
 *
 * What the gate checks is term *existence*, which is mechanical. What it cannot check is term
 * *choice* — nothing here knows that "money I made" means one predicate rather than another — and that
 * stays with the model, correctly.
 */

/**
 * The standard vocabularies the client reads with.
 *
 * Collected from the constants rather than listed again, so a term added to `rdf/terms.ts` is
 * automatically one the gate accepts. These are not the API's to declare: knowing that `rdf:type`
 * types things is the language the client reads in, and rejecting it would be rejecting the query
 * language itself.
 */
const READING_VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...Object.values(RDF),
  ...Object.values(RDFS),
  ...Object.values(HYDRA),
  ...Object.values(SHACL),
  ...Object.values(VOID),
  ...Object.values(PROV),
  ...Object.values(HCT),
  ...Object.values(GRAPHS),
  // The datatypes the projection knows how to map. Deliberately not the whole XSD namespace: a
  // misspelt datatype matches nothing and reports zero rows, which is the failure this gate exists
  // to catch, and the suggestion list turns the rejection into a one-round-trip correction.
  ...MAPPED_DATATYPES,
])

export interface TermSuggestion {
  readonly iri: string
  /** What the store knows about it — enough to tell whether it is the term that was meant. */
  readonly note: string
}

export interface UndeclaredTerm {
  readonly iri: string
  readonly suggestions: readonly TermSuggestion[]
}

export interface GateVerdict {
  readonly passed: boolean
  readonly undeclared: readonly UndeclaredTerm[]
  /** How many IRIs were checked. A gate that checked nothing is not a gate that passed. */
  readonly checked: number
}

export interface TermGateDeps {
  readonly graph: SessionGraph
  readonly model: CapabilityModel
  readonly constraintsFor: (classIri: string) => Map<string, PropertyConstraints>
  /** Prefix labels, so a rejection is phrased the way the query was written. */
  readonly prefixes?: ReadonlyMap<string, string>
}

/** Render an IRI compactly where a prefix covers it, and in full otherwise. */
export function compactIri(iri: string, prefixes: ReadonlyMap<string, string> | undefined): string {
  if (prefixes) {
    for (const [label, namespace] of prefixes) {
      if (iri.startsWith(namespace) && iri.length > namespace.length) {
        return `${label}:${iri.slice(namespace.length)}`
      }
    }
  }
  return `<${iri}>`
}

/**
 * Every IRI the store declares.
 *
 * Four sources, and the distinction between them matters:
 *
 * - The **schema graphs** — vocabulary, shapes, ontology. Any position: a class is a subject, a
 *   predicate is an object of `hydra:property`, a datatype is an object of `sh:datatype`. Mentioning
 *   a term in a document describing the API *is* declaring it.
 * - **Subjects held in the data graph**, so a query naming a resource an earlier turn retrieved is
 *   not rejected for naming it.
 * - The **reading vocabulary** above.
 *
 * The data graph's *predicates* are deliberately not a source. A server serving a predicate it never
 * declared is a conformance gap, and treating the serving of it as a declaration would launder that
 * gap into a licence.
 */
export function declaredTerms(graph: SessionGraph): Set<string> {
  const declared = new Set<string>(READING_VOCABULARY)

  for (const name of [GRAPHS.vocab, GRAPHS.shapes, GRAPHS.ontology] as const) {
    for (const quad of graph.match(null, null, null, name)) {
      if (quad.subject.termType === 'NamedNode') declared.add(quad.subject.value)
      declared.add(quad.predicate.value)
      if (quad.object.termType === 'NamedNode') declared.add(quad.object.value)
    }
  }

  for (const subject of graph.subjects()) declared.add(subject)

  return declared
}

/** The local name of an IRI — what a near-match is measured over. */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  if (hash >= 0) return iri.slice(hash + 1)
  const slash = iri.lastIndexOf('/')
  return slash >= 0 ? iri.slice(slash + 1) : iri
}

/** Levenshtein distance, iterative and allocation-light. */
function distance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      current[j] = Math.min(substitution, deletion, insertion)
    }
    previous = current
  }

  return previous[b.length] ?? Math.max(a.length, b.length)
}

/**
 * What is known about a candidate term, so a suggestion can be judged rather than guessed at.
 *
 * Drawn from the same store the gate rejected against — a suggestion sourced from anywhere else would
 * be the client inventing vocabulary at the exact moment it is refusing to accept invented vocabulary.
 */
function describe(
  iri: string,
  deps: TermGateDeps,
  prefixes: ReadonlyMap<string, string> | undefined,
): string {
  const cls = deps.model.byIri(iri)
  if (cls) {
    const prose = cls.title ?? cls.description
    return prose ? `a class — ${prose.replace(/\s+/g, ' ').trim().slice(0, 80)}` : 'a class'
  }

  for (const owner of deps.model.classes) {
    const property = owner.properties.find((candidate) => candidate.iri === iri)
    if (!property) continue

    const constraint = deps.constraintsFor(owner.iri).get(iri)
    const target = property.range ?? constraint?.class ?? constraint?.datatype ?? null
    const parts = [property.title ?? localName(iri)]
    if (target) parts.push(compactIri(target, prefixes))
    parts.push(`on ${compactIri(owner.iri, prefixes)}`)
    return parts.join(' · ')
  }

  return 'declared by this API'
}

/**
 * Declared terms closest to one that is not.
 *
 * Measured over local names, because a namespace typo and a term typo are different mistakes and it
 * is the term the model chose. A candidate qualifies on edit distance relative to its length, or on
 * containment — `fee` inside `eventFee` is a near match no edit-distance threshold would catch.
 */
export function suggestionsFor(
  iri: string,
  declared: ReadonlySet<string>,
  deps: TermGateDeps,
  limit = 3,
): TermSuggestion[] {
  const target = localName(iri).toLowerCase()
  if (target.length === 0) return []

  const scored: { iri: string; score: number }[] = []

  for (const candidate of declared) {
    // Terms the client reads with are never the answer to "did you mean" about an API's vocabulary.
    if (READING_VOCABULARY.has(candidate)) continue

    const name = localName(candidate).toLowerCase()
    if (name.length === 0) continue

    const edits = distance(target, name)
    const contains = name.includes(target) || target.includes(name)
    const ratio = edits / Math.max(target.length, name.length)

    if (ratio <= 0.5) scored.push({ iri: candidate, score: ratio })
    else if (contains) scored.push({ iri: candidate, score: 0.6 })
  }

  scored.sort((a, b) => (a.score === b.score ? (a.iri < b.iri ? -1 : 1) : a.score - b.score))

  return scored
    .slice(0, limit)
    .map((entry) => ({ iri: entry.iri, note: describe(entry.iri, deps, deps.prefixes) }))
}

/** Check every IRI a query names against what the store declares. */
export function checkTerms(iris: readonly string[], deps: TermGateDeps): GateVerdict {
  const declared = declaredTerms(deps.graph)
  const undeclared: UndeclaredTerm[] = []

  for (const iri of iris) {
    if (declared.has(iri)) continue
    undeclared.push({ iri, suggestions: suggestionsFor(iri, declared, deps) })
  }

  return { passed: undeclared.length === 0, undeclared, checked: iris.length }
}

/** The refusal, phrased so the next attempt can be a correction rather than a guess. */
export function describeUndeclared(verdict: GateVerdict, prefixes?: ReadonlyMap<string, string>): string {
  const lines = [
    `The query was not executed. It names ${verdict.undeclared.length} term` +
      `${verdict.undeclared.length === 1 ? '' : 's'} this API does not declare, and a query over an ` +
      `undeclared term does not fail — it matches nothing and returns zero rows, which reads exactly ` +
      `like a true answer of zero.`,
    '',
  ]

  for (const term of verdict.undeclared) {
    lines.push(`- ${compactIri(term.iri, prefixes)} is not declared.`)
    for (const suggestion of term.suggestions) {
      lines.push(`    Did you mean ${compactIri(suggestion.iri, prefixes)} (${suggestion.note})?`)
    }
    if (term.suggestions.length === 0) {
      lines.push(`    Nothing declared is close to it.`)
    }
  }

  lines.push(
    '',
    'The classes and predicates this API declares are listed in the vocabulary section of your ' +
      'instructions. Rewrite the query using those, or say what is missing.',
  )

  return lines.join('\n')
}
