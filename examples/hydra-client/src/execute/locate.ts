import type { SessionGraph } from '../rdf/session-graph'
import { GRAPHS, HYDRA, RDFS } from '../rdf/terms'
import type { ClassCapability } from '../vocab/capability'

import { expandTemplate, isQueryOnlyTemplate } from './template'

/**
 * Where a class lives (task 5.1).
 *
 * An operation declared on a resource class acts on a resource the caller names, so its URL is the
 * subject IRI and there is nothing to locate. An operation declared on a *collection* class has no
 * such subject: the vocabulary says a POST is accepted, and says nothing about the address it is
 * accepted at. That address has to come from somewhere, and the one thing it must not come from is a
 * naming convention — `base + '/' + localName` is the class of assumption this rebuild exists to
 * remove.
 *
 * Two routes, both readings of what the server published, tried in that order:
 *
 * 1. **An entry point link whose declared range is the class.** Exact, and the route Hydra intends:
 *    the entry point carries live IRIs, and `rdfs:range` on the corresponding supported property says
 *    which class each one identifies.
 * 2. **A published search template with only form-style expressions.** RFC 6570 defines expansion
 *    with nothing bound as yielding the literal prefix, so such a template *is* a statement of the
 *    unconstrained resource's IRI. `…/Contact{?q,firstName}` says the collection is at `…/Contact`.
 *    A template with a path expression says no such thing and is not used.
 *
 * Neither available is a gap, reported as one. Against this API route 1 is unavailable: the entry
 * point's links are declared `hydra:Link` with no `rdfs:range`, so nothing connects `…#contacts` to
 * `…#ContactCollection` except the spelling — which is exactly what may not be consulted.
 */

export interface Located {
  readonly url: string
  readonly via: 'entrypoint-link' | 'search-template'
  /** The declaration this came out of, so the trace can show the reading rather than assert it. */
  readonly evidence: string
}

export interface NotLocated {
  readonly url: null
  /** What is undeclared, in terms an operator can act on. */
  readonly reason: string
}

export type Location = Located | NotLocated

export interface LocateDeps {
  readonly graph: SessionGraph
  /** The entry point IRI, as discovery resolved it. */
  readonly entrypoint: string | null
}

/**
 * Classes an entry point link is declared to identify.
 *
 * The range may sit on the supported-property node — where Hydra puts it — or on the property itself,
 * where RDFS puts it. Both are declarations of the same fact, so both are read.
 */
function rangeOfProperty(graph: SessionGraph, propertyIri: string): string[] {
  const ranges = new Set<string>()

  for (const supported of graph.match(null, HYDRA.property, propertyIri, GRAPHS.vocab)) {
    for (const range of graph.match(supported.subject, RDFS.range, null, GRAPHS.vocab)) {
      ranges.add(range.object.value)
    }
  }
  for (const graphName of [GRAPHS.vocab, GRAPHS.ontology] as const) {
    for (const range of graph.match(propertyIri, RDFS.range, null, graphName)) {
      ranges.add(range.object.value)
    }
  }

  return [...ranges]
}

/** The live IRI an entry point link declares for this class, if one is declared. */
function fromEntrypoint(classIri: string, deps: LocateDeps): Located | null {
  if (deps.entrypoint === null) return null

  const links = deps.graph
    .match(deps.entrypoint, null, null, GRAPHS.context)
    .filter((quad) => quad.object.termType === 'NamedNode')
    // Deterministic: two links declaring the same range must resolve the same way on every connect.
    .sort((a, b) => (a.predicate.value < b.predicate.value ? -1 : 1))

  for (const link of links) {
    if (!rangeOfProperty(deps.graph, link.predicate.value).includes(classIri)) continue
    return {
      url: link.object.value,
      via: 'entrypoint-link',
      evidence: `<${deps.entrypoint}> <${link.predicate.value}> <${link.object.value}>, and <${link.predicate.value}> declares range <${classIri}>`,
    }
  }

  return null
}

/** The IRI a form-style search template states, by expanding it with nothing bound. */
function fromSearchTemplate(cls: ClassCapability): Located | null {
  // Templates arrive sorted by template string, so the choice is stable across connects.
  for (const template of cls.templates) {
    if (!isQueryOnlyTemplate(template.template)) continue
    const { url } = expandTemplate(template.template, {})
    if (url.length === 0 || url.includes('{')) continue
    return {
      url,
      via: 'search-template',
      evidence: `<${cls.iri}> publishes the template ${template.template}, which with no variables bound expands to ${url}`,
    }
  }
  return null
}

export function locateClass(cls: ClassCapability, deps: LocateDeps): Location {
  const located = fromEntrypoint(cls.iri, deps) ?? fromSearchTemplate(cls)
  if (located) return located

  return {
    url: null,
    reason:
      `The vocabulary declares operations on <${cls.iri}> but never states the IRI it lives at. ` +
      `Nothing in the entry point is declared to identify that class — an entry point link needs an ` +
      `rdfs:range naming it — and the class publishes no form-style IriTemplate whose unbound ` +
      `expansion would give the address. The client will not derive one from the class name: a URL ` +
      `built from a naming convention is an assumption about this API that it has not published.`,
  }
}
