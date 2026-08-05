import type { HttpClient } from '../http/client'

import type { QueryRows } from './results'

/**
 * Remote execution (design D7's T3 branch).
 *
 * The endpoint holds the ontology, so it answers what a local engine over materialised collections
 * cannot: subclass closure, and questions whose scope is wider than any one collection.
 *
 * **It does not remove the completeness gate.** This docstring used to say that it did — "a server
 * aggregating over its own store is aggregating over all of it, and there is nothing for this client
 * to prove". That is true of the endpoint and false of the question. It aggregates over all of *its
 * own store*, which is not all of the API's data: this deployment advertised a live, probe-answering
 * endpoint holding 10 contacts while the collection declared 3,467, and the query returned a
 * confident wrong number without erroring. `sync.ts` is the gate that replaced the assumption, and it
 * runs before anything here is believed.
 *
 * **The term gate still runs first.** That is the point design D7 makes most insistently: an
 * undeclared predicate sent to a live endpoint does not error, it matches nothing and returns zero
 * rows, and zero rows reported as an answer is the failure the gate exists to eliminate. Remote is
 * where the failure is *quietest*, not where it is absent.
 */

/** The standard result serialisation. Asking for it by name is what makes the response parseable. */
const RESULTS_JSON = 'application/sparql-results+json'

interface SparqlBinding {
  readonly type: string
  readonly value: string
}

interface SparqlResults {
  readonly head?: { readonly vars?: readonly string[] }
  readonly results?: { readonly bindings?: readonly Record<string, SparqlBinding>[] }
  readonly boolean?: boolean
}

export interface RemoteFailure {
  readonly failed: true
  readonly reason: string
}

export function isRemoteFailure(result: QueryRows | RemoteFailure): result is RemoteFailure {
  return 'failed' in result
}

/**
 * Send a query to the advertised endpoint.
 *
 * Sent as a form-encoded POST rather than a query-string GET: a materialisation-scale query is longer
 * than a URL length that no specification fixes, and the failure mode of exceeding one is a 414 from
 * a proxy nobody controls.
 */
export async function runRemotely(
  query: string,
  endpoint: string,
  http: HttpClient,
): Promise<QueryRows | RemoteFailure> {
  let response
  try {
    response = await http.request(endpoint, {
      method: 'POST',
      body: `query=${encodeURIComponent(query)}`,
      contentType: 'application/x-www-form-urlencoded',
      accept: RESULTS_JSON,
    })
  } catch (cause) {
    return {
      failed: true,
      reason:
        `The SPARQL endpoint at <${endpoint}> could not be reached: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  if (!response.ok) {
    /*
     * Reported, never retried locally without saying so.
     *
     * Falling back silently would mean two runs of the same query answering from different data —
     * the endpoint's whole dataset, or this client's materialised subset — with nothing in the
     * result to say which.
     */
    return {
      failed: true,
      reason:
        `The SPARQL endpoint at <${endpoint}> answered ${response.status}. ` +
        `${response.body.slice(0, 300)}`,
    }
  }

  let parsed: SparqlResults
  try {
    parsed = JSON.parse(response.body) as SparqlResults
  } catch {
    return {
      failed: true,
      reason:
        `The SPARQL endpoint at <${endpoint}> answered ${response.status} with a body that is not ` +
        `${RESULTS_JSON}. Content-Type was ${response.contentType ?? 'absent'}.`,
    }
  }

  if (typeof parsed.boolean === 'boolean') {
    return { variables: ['result'], rows: [{ result: String(parsed.boolean) }], truncated: false }
  }

  const variables = parsed.head?.vars ?? []
  const rows = (parsed.results?.bindings ?? []).map((binding) => {
    const row: Record<string, string> = {}
    for (const [name, term] of Object.entries(binding)) row[name] = term.value
    return row
  })

  return { variables: [...variables], rows, truncated: false }
}
