import type { ProjectedTool, ToolSurface } from '../project/tools'

/**
 * The query tool (task 7.1, design D7).
 *
 * > One `sparql` tool at every tier. The model never needs to know whether an endpoint exists.
 *
 * This is the one tool on the surface that is **not** a projection. Every other one is derived from
 * something the server declared, which is what makes the toolset change with the API and no code; this
 * one is a capability the client brings. Keeping it out of `projectTools` is what keeps that claim
 * checkable — the projection stays a pure function of the vocabulary, and a fixture-based test of it
 * still counts exactly the affordances the fixture declares.
 *
 * ## Why the description says nothing about tiers
 *
 * Where the query runs is a property of the deployment. A description that said "runs remotely if an
 * endpoint is advertised" would put a routing decision in the model's context, and a model that knows
 * about the fork will eventually reason about it — writing one query for one branch and a different
 * one for the other, which is exactly the API-specific behaviour this client exists not to have. What
 * the model needs is what is true on every branch: the terms must be declared, and an aggregate needs
 * a complete set.
 */

export const QUERY_TOOL_NAME = 'sparql'

const DESCRIPTION = `Answer a question by querying this API's data with SPARQL. Use it for figures
no declared filter expresses — sums and averages, groupings, joins across resource types, and
conditions over ranges of dates or numbers — none of which the read tools can do. For finding
records by a field's value, or for counting how many match a declared filter, use
search_collection instead: the filter answers that, and its result declares the total, without a
query.

Write a complete query, including its own PREFIX lines; the vocabulary section of your instructions
lists the classes, the predicates and the prefixes to use.

Two rules decide whether a query runs, and both refuse rather than return something approximate:

- Every IRI in the query must be one this API declares. An undeclared term is not an error at
  execution — it matches nothing and returns zero rows, which is indistinguishable from a true zero —
  so it is rejected beforehand and the closest declared terms are offered.
- A query must name the class it is about, with a type pattern such as "?x a <SomeClass>". That is
  what identifies the data to be gathered. Without one there is nothing to gather and the query would
  be answered from whatever happened to be held already.

Results come back as rows. An aggregate returns the figure, not the records it was computed from.`

const INPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    query: {
      type: 'string' as const,
      description:
        'A complete SPARQL query, with its own PREFIX declarations. SELECT, ASK, CONSTRUCT and ' +
        'DESCRIBE are read; updates are not accepted, because writes go through the operations this ' +
        'API declares.',
    },
  },
  required: ['query'] as const,
}

/**
 * The tool, under a name that does not collide with a projected one.
 *
 * On a collision the **client's** tool moves rather than the server's. A projected name is derived
 * from the vocabulary and is part of what task 4.4's determinism test pins; renaming one to make room
 * for this would mean the surface depended on which client capabilities happened to exist.
 */
export function queryTool(taken: ReadonlySet<string> = new Set()): ProjectedTool {
  let name: string = QUERY_TOOL_NAME
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${QUERY_TOOL_NAME}_${suffix}`

  return {
    name,
    description: DESCRIPTION,
    input_schema: INPUT_SCHEMA,
    strict: true,
    dispatch: {
      kind: 'query',
      // A query acts on the API rather than on any one class, so there is no declaring class and
      // nothing for the execution layer to locate. The empty values say that, rather than standing in
      // for something that was not looked up.
      classIri: '',
      method: 'QUERY',
      templates: [],
      expects: null,
      returns: null,
      possibleStatus: [],
      needsSubject: false,
      bindings: [],
      residue: [],
    },
  }
}

/**
 * The projected surface plus the query tool.
 *
 * Composition rather than mutation: `projectTools` returns a surface derived entirely from the
 * vocabulary, and this returns that surface with one client capability added. Sorted by name for the
 * same reason the projection is — the tool block renders at prompt-prefix position 0, so an unstable
 * order invalidates the whole cache on every request.
 */
export function withQueryTool(surface: ToolSurface): ToolSurface {
  const tool = queryTool(new Set(surface.tools.map((existing) => existing.name)))

  const tools = [...surface.tools, tool].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const byName = new Map(tools.map((entry) => [entry.name, entry]))

  return {
    tools,
    residue: surface.residue,
    byName: (name) => byName.get(name),
    definitions: () =>
      tools.map((entry) => ({
        name: entry.name,
        description: entry.description,
        input_schema: entry.input_schema,
        strict: entry.strict,
      })),
  }
}
