import { readPage, type CollectionDeps } from '../execute/collection'

import { compactIri } from './gate'
import type { ParsedQuery } from './parse'
import { isRemoteFailure, runRemotely } from './remote'
import type { QueryScope } from './scope'

/**
 * The completeness gate for the remote path (design D7, closing baseline §1.0a).
 *
 * The local path proves `memberCount === totalItems` before it aggregates. The remote path used to
 * prove nothing, on the reasoning that "a server aggregating over its own store is aggregating over
 * all of it, and there is nothing for this client to prove". That reasoning is sound about the
 * *endpoint* and wrong about the *question*: it aggregates over all of its own store, which is not
 * the same thing as all of the API's data.
 *
 * Observed, not theorised. This deployment advertised a live, CORS-clean, probe-answering endpoint
 * holding **10 contacts** while the API's own collection declared **3,467**. Asked how many contacts
 * existed, the query ran, the endpoint answered without error, and the number came back wrong by 346x
 * with nothing anywhere saying so. A reachable endpoint is not a synchronised one, and reachability
 * is the only thing the probe establishes.
 *
 * So the remote path gets the same guarantee, proven the other way round: instead of counting what it
 * retrieved, the client compares what the endpoint holds against what the API declares it has.
 *
 *     declared  = hydra:totalItems on the collection that serves the class   (from the API)
 *     held      = SELECT (COUNT(DISTINCT ?s)) WHERE { ?s a <Class> }         (from the endpoint)
 *     agree?    → run remotely.   disagree? → the ENGINE degrades to the local path.
 *
 * **Why a mismatch never runs remotely, and never merely warns.** Both failures produce a number
 * rather than an error, and a number is what gets believed; a caveat attached to a confident total
 * is read as a hedge on a right answer, not as notice of a wrong one. This checker only reports —
 * the policy on a diverged endpoint lives in `engine.ts`, which answers the same query from
 * collections materialised off the API itself (the authoritative copy), with provenance. The
 * refusal text below is the verdict for the cases the engine cannot answer better locally.
 *
 * **Why an unserved class is not a refusal.** The endpoint legitimately holds more than the API
 * serves — the ontology and the shapes graph are in it, and asking how many `owl:Class` it declares
 * is a real question with no collection behind it. There is no declared total to compare against, so
 * there is nothing to check and nothing to claim. Those classes are disclosed as unchecked rather
 * than counted as verified, which is the same rule the stage-5 constraint gate follows: a check that
 * did not run must never be reported as a check that passed.
 */

export interface SyncCheck {
  readonly classIri: string
  readonly collectionIri: string
  /** What the API declares. `null` when it declares nothing this client can read as a total. */
  readonly declared: number | null
  /** What the endpoint holds. `null` when the count could not be obtained. */
  readonly held: number | null
  readonly agrees: boolean
  /** Why it could not be established, when it could not. */
  readonly reason: string | null
}

export interface SyncVerdict {
  readonly checked: readonly SyncCheck[]
  /** Classes the query names that no collection serves — nothing to compare them against. */
  readonly unchecked: readonly string[]
  /** Set when the query must not run. */
  readonly refusal: string | null
  /** Whether any HTTP request was issued, so a refusal can prove what it spent. */
  readonly requested: boolean
}

export interface SyncDeps extends CollectionDeps {
  readonly endpoint: string
  readonly prefixes?: ReadonlyMap<string, string>
}

/**
 * How many instances of a class the endpoint holds.
 *
 * `DISTINCT` because a subject typed twice — which a store carrying both data and an ontology will
 * have — would otherwise count twice and manufacture a mismatch out of nothing.
 */
function countQuery(classIri: string): string {
  return `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a <${classIri}> }`
}

export async function checkEndpointSync(
  parsed: ParsedQuery,
  scope: QueryScope,
  deps: SyncDeps,
): Promise<SyncVerdict> {
  const short = (iri: string) => compactIri(iri, deps.prefixes)
  const checks: SyncCheck[] = []
  let requested = false

  const named = new Set(parsed.types.map((pattern) => pattern.classIri))
  const servedClasses = new Set<string>()

  for (const entry of scope.collections) {
    servedClasses.add(entry.memberClassIri)
    servedClasses.add(entry.collectionClassIri)

    if (entry.url === null) {
      checks.push({
        classIri: entry.memberClassIri,
        collectionIri: entry.collectionClassIri,
        declared: null,
        held: null,
        agrees: false,
        reason: entry.reason ?? 'the vocabulary does not state where this collection lives.',
      })
      continue
    }

    // One page, only to read the declared size. Deliberately not `materialise`: the point is to
    // learn what the API says it has, not to retrieve it — retrieving it would be doing the local
    // path's work on the path that exists to avoid it.
    let declared: number | null = null
    let reason: string | null = null
    try {
      requested = true
      const page = await readPage(entry.url, deps)
      if (page.totalItems !== null) {
        declared = page.totalItems
      } else if (!page.partial) {
        // No total, but no partial view either: the collection served everything it has. That is a
        // completeness proof in its own right, and the reference collections rely on it.
        declared = page.members.length
      } else {
        reason =
          'the collection is served in pages and declares no hydra:totalItems, so the API states no ' +
          'size to compare the endpoint against.'
      }
    } catch (cause) {
      reason = `its first page could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
    }

    let held: number | null = null
    if (declared !== null) {
      requested = true
      const counted = await runRemotely(countQuery(entry.memberClassIri), deps.endpoint, deps.http)
      if (isRemoteFailure(counted)) {
        reason = `the endpoint could not be counted: ${counted.reason}`
      } else {
        const raw = counted.rows[0]?.[counted.variables[0] ?? 'n']
        const parsedCount = raw === undefined ? Number.NaN : Number(raw)
        if (Number.isFinite(parsedCount)) held = parsedCount
        else reason = 'the endpoint returned no count for this class.'
      }
    }

    const agrees = declared !== null && held !== null && declared === held
    checks.push({
      classIri: entry.memberClassIri,
      collectionIri: entry.collectionClassIri,
      declared,
      held,
      agrees,
      reason: agrees ? null : reason,
    })

    if (!agrees && reason === null) {
      deps.trace.log(
        `Endpoint sync: ${short(entry.memberClassIri)} — API declares ${declared}, endpoint holds ${held}.`,
        'error',
      )
    } else if (agrees) {
      deps.trace.log(
        `Endpoint sync: ${short(entry.memberClassIri)} — ${declared} in the API, ${held} at the endpoint. In step.`,
        'success',
      )
    }
  }

  const unchecked = [...named].filter((iri) => !servedClasses.has(iri)).sort()

  const diverged = checks.filter((check) => !check.agrees && check.declared !== null && check.held !== null)
  const unprovable = checks.filter((check) => check.reason !== null)

  if (diverged.length > 0) {
    return {
      checked: checks,
      unchecked,
      requested,
      refusal: [
        `The query was not run. The SPARQL endpoint does not hold what this API says it has, so an ` +
          `answer from it would be an answer about the endpoint's copy rather than about your data.`,
        '',
        ...diverged.map(
          (check) =>
            `- ${short(check.classIri)}: the API declares ${check.declared}, the endpoint holds ` +
            `${check.held}${
              check.declared !== null && check.held !== null && check.declared > check.held
                ? ` — ${check.declared - check.held} missing`
                : ''
            }.`,
        ),
        '',
        `The endpoint answered without error, which is what makes this worth refusing rather than ` +
          `reporting: a stale copy returns a confident number, not a failure. Either re-sync the ` +
          `endpoint with the API, or remove it from the entry point so queries are answered from ` +
          `collections retrieved live.`,
      ].join('\n'),
    }
  }

  // Cannot prove sync, and the query aggregates. An aggregate is a single number that carries no
  // trace of what it was computed over, so an unprovable set is refused for the same reason task 5.3
  // refuses a traversal whose cost cannot be known in advance.
  if (unprovable.length > 0 && parsed.aggregates.length > 0) {
    return {
      checked: checks,
      unchecked,
      requested,
      refusal: [
        `The query was not run. It aggregates, and the endpoint's holding could not be checked ` +
          `against what the API declares:`,
        '',
        ...unprovable.map((check) => `- ${short(check.classIri)}: ${check.reason}`),
        '',
        `An aggregate is one number with nothing in it to say what it was computed over, so a set ` +
          `that cannot be shown to be whole is refused rather than totalled.`,
      ].join('\n'),
    }
  }

  return { checked: checks, unchecked, requested, refusal: null }
}
