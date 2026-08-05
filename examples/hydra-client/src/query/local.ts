import type { Source } from '@rdfjs/types'

import type { QueryForm } from './parse'
import type { QueryRows } from './results'

/**
 * Local execution (task 7.3, design D7).
 *
 * The analytics path for every tier below T3. An API that publishes a vocabulary and nothing else
 * still answers "how much did I make last year", because the client materialises the collection the
 * query is scoped to and runs the query over what it holds — which is the whole argument for holding
 * retrieved data outside the model's context in the first place.
 *
 * ## Why the import is dynamic
 *
 * The engine is by far the heaviest thing this client can load — several hundred packages against a
 * runtime that is otherwise a parser, a store and an HTTP client. At T3 it is never needed: the
 * endpoint answers, and loading a local engine to not use it would make every T3 session pay for a
 * capability it has a better version of. `import()` at the point of use is what makes that true at
 * runtime rather than merely intended, and the bundler splits it out on the strength of the same
 * syntax.
 *
 * The module is cached after the first load, so a session running several queries loads it once.
 */

/** Resolved on first use and kept. `null` until then. */
let engine: { queryBindings: Function; queryBoolean: Function; queryQuads: Function } | null = null

async function load(): Promise<NonNullable<typeof engine>> {
  if (engine) return engine

  const { QueryEngine } = await import('@comunica/query-sparql-rdfjs')
  engine = new QueryEngine() as unknown as NonNullable<typeof engine>
  return engine
}

/** Whether the engine has been loaded. Exposed so a T3 test can assert it never was. */
export function engineLoaded(): boolean {
  return engine !== null
}

/** Drop the cached engine. Tests only — it exists so `engineLoaded` can be asserted from a clean start. */
export function resetEngine(): void {
  engine = null
}

/** A term as a string, keeping the distinction between an IRI and a literal's value. */
function valueOf(term: { termType: string; value: string } | undefined): string | null {
  if (!term) return null
  return term.value
}

/**
 * Run a query over what the store holds.
 *
 * The form decides which of the engine's three shapes is used. Reading it from the parsed query
 * rather than from the text is the same rule as everywhere else here: a `CONSTRUCT` inside a comment
 * would fool a string test, and the syntax tree already knows.
 */
export async function runLocally(
  query: string,
  form: QueryForm,
  source: Source,
): Promise<QueryRows> {
  const comunica = await load()
  const context = { sources: [source] }

  if (form === 'ASK') {
    const answer: boolean = await comunica.queryBoolean(query, context)
    return { variables: ['result'], rows: [{ result: String(answer) }], truncated: false }
  }

  if (form === 'CONSTRUCT' || form === 'DESCRIBE') {
    const stream = await comunica.queryQuads(query, context)
    const quads: { subject: { value: string }; predicate: { value: string }; object: { value: string } }[] =
      await stream.toArray()
    return {
      variables: ['subject', 'predicate', 'object'],
      rows: quads.map((quad) => ({
        subject: quad.subject.value,
        predicate: quad.predicate.value,
        object: quad.object.value,
      })),
      truncated: false,
    }
  }

  const stream = await comunica.queryBindings(query, context)
  const bindings: Iterable<{ keys(): Iterable<{ value: string }>; get(key: string): { termType: string; value: string } | undefined }> =
    await stream.toArray()

  const variables = new Set<string>()
  const rows: Record<string, string>[] = []

  for (const binding of bindings) {
    const row: Record<string, string> = {}
    for (const key of binding.keys()) {
      variables.add(key.value)
      const bound = valueOf(binding.get(key.value))
      // An unbound variable in one row is a real answer — OPTIONAL exists — and rendering it as an
      // empty string would be indistinguishable from a bound empty literal.
      if (bound !== null) row[key.value] = bound
    }
    rows.push(row)
  }

  return { variables: [...variables], rows, truncated: false }
}
