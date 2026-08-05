import { materialise } from '../execute/collection'
import { chooseTemplateUrl } from '../execute/select-view'
import type { HttpClient } from '../http/client'
import type { ContextStore } from '../rdf/document-loader'
import type { Findings } from '../rdf/findings'
import type { SessionGraph } from '../rdf/session-graph'
import type { ToolSurface } from '../project/tools'
import type { Trace } from '../trace'
import type { CapabilityModel, PropertyConstraints } from '../vocab/capability'
import { assessPageSerialisation } from '../vocab/member-serialisation'

import { checkTerms, compactIri, describeUndeclared } from './gate'
import { runLocally } from './local'
import { isParseFailure, parseQuery, type ParsedQuery } from './parse'
import { isRemoteFailure, runRemotely } from './remote'
import { renderRows, type QueryRows } from './results'
import { scopeQuery, type ScopedCollection } from './scope'
import { checkEndpointSync } from './sync'

/**
 * Analytics without an endpoint (tasks 7.1 to 7.4, design D7).
 *
 * One `sparql` tool at every tier, and this is what routes it. The model never learns whether an
 * endpoint exists — it writes a query, and where that query runs is a property of the deployment
 * rather than a decision the model should be making or a fact it should have to carry.
 *
 *     sparql(query)
 *          ├─ parse                       — a query that will not parse runs nowhere
 *          ├─ TERM GATE                   — before the fork, on both paths
 *          ├─ T3 ─▶ scope ─▶ SYNC GATE ─▶ run on the advertised endpoint
 *          └─ T0–T2 ─▶ scope ─▶ materialise ─▶ COMPLETENESS GATE ─▶ run locally
 *
 * Three gates, and none substitutes for another. The term gate asks whether the query names anything
 * that does not exist. The completeness gate asks whether the data retrieved is all of the data. The
 * sync gate asks the same question of a dataset this client did not retrieve — whether the endpoint
 * holds what the API says it has — because *reachable is not synchronised*, and the probe establishes
 * only the first. Every one of those failures produces a number rather than an error, which is why
 * all three refuse rather than warn.
 */

export interface QueryOutcome {
  readonly ok: boolean
  readonly content: string
  /** Where it ran, or `null` when it was refused before running. */
  readonly ranOn: 'remote' | 'local' | null
  /** Whether any HTTP request was issued. A refusal must be able to prove it issued none. */
  readonly requested: boolean
}

export interface QueryEngineDeps {
  readonly graph: SessionGraph
  readonly model: CapabilityModel
  readonly http: HttpClient
  readonly contexts: ContextStore
  readonly findings: Findings
  readonly trace: Trace
  readonly constraintsFor: (classIri: string) => Map<string, PropertyConstraints>
  readonly origin: string
  readonly entrypoint: string | null
  /**
   * The endpoint, and only when it has been **probed and answered**.
   *
   * Not the advertised value: this deployment has advertised an endpoint that was live and one that
   * was dead within a single session, with the advertisement unchanged. Routing on an advertisement
   * would send the query somewhere that does not answer and report the failure as the API's.
   */
  readonly sparqlEndpoint: string | null
  readonly prefixes?: ReadonlyMap<string, string>
  /** Members one materialisation may retrieve before asking. Design D5: a budget, not a cap. */
  readonly budget?: number
  /**
   * The tool surface, for filter pushdown (design D1).
   *
   * Optional: absent, a scoped collection materialises at its base URL exactly as before. Present, the
   * query's exact-equality conjuncts are pushed into the smallest declared view that covers them —
   * reusing the *same* `chooseTemplateUrl` the interactive `search_collection` path uses, so the two
   * cannot drift.
   */
  readonly surface?: ToolSurface
}

export interface QueryRunner {
  run(query: string): Promise<QueryOutcome>
}

/** A refusal: nothing ran, nothing was requested, and the reason is the whole content. */
function refuse(content: string, requested = false): QueryOutcome {
  return { ok: false, content, ranOn: null, requested }
}

export function createQueryRunner(deps: QueryEngineDeps): QueryRunner {
  const budget = deps.budget ?? 10_000
  const short = (iri: string) => compactIri(iri, deps.prefixes)

  /** Predicates an aggregate reads, resolved through the variables the query bound them to. */
  function aggregatedPredicates(parsed: ParsedQuery): string[] {
    const predicates = new Set<string>()
    for (const aggregate of parsed.aggregates) {
      if (aggregate.variable === null) continue
      for (const predicate of parsed.variableSources.get(aggregate.variable) ?? []) {
        predicates.add(predicate)
      }
    }
    return [...predicates]
  }

  /**
   * The URL to materialise for a scoped collection: the smallest declared view covering the query's
   * exact-equality conjuncts, or the base collection where none covers them (design D1).
   *
   * Only **identity** equalities (an IRI object — an enum individual, a GUID reference) push down.
   * They match the server's own `eq`, so the covering view is a superset of what the query needs and
   * evaluating the full query locally over it stays exact. A literal (text) equality is *not* pushed:
   * this kind of API matches text by analyzer, not by equality, so a text view is not a guaranteed
   * superset — it falls through, the whole collection materialises, and the filter evaluates locally
   * exactly as before. A filter no declared view carries falls through the same way, never dropped.
   */
  function viewUrlFor(entry: ScopedCollection, parsed: ParsedQuery): string {
    const base = entry.url as string
    if (!deps.surface) return base

    const cls = deps.model.byIri(entry.collectionClassIri)
    const record = deps.surface.tools.find(
      (tool) => tool.dispatch.kind === 'template' && tool.dispatch.classIri === entry.collectionClassIri,
    )
    if (!cls || !record || record.dispatch.templates.length === 0) return base

    const filters: Record<string, unknown> = {}
    for (const equality of parsed.equalityFilters) {
      if (!equality.isIri) continue
      const binding = record.dispatch.bindings.find((bound) => bound.property === equality.predicate)
      if (binding && !(binding.name in filters)) filters[binding.name] = equality.value
    }
    if (Object.keys(filters).length === 0) return base

    const target = chooseTemplateUrl(record, cls, filters, {
      graph: deps.graph,
      entrypoint: deps.entrypoint,
      origin: deps.origin,
      findings: deps.findings,
      trace: deps.trace,
    })
    if ('url' in target) {
      const count = Object.keys(filters).length
      deps.trace.log(
        `Pushed ${count} exact filter${count === 1 ? '' : 's'} into a declared view of ` +
          `${short(entry.collectionClassIri)}: ${target.url} — materialising the covering view ` +
          `instead of the whole collection.`,
        'sparql',
      )
      return target.url
    }
    return base
  }

  /**
   * Retrieve everything the query is scoped to, in full or not at all.
   *
   * Task 3.5's assessment runs on the first page of each collection, from the page already in hand.
   * It has to happen here rather than at connect time: it costs a page per collection, and a session
   * that never asks an analytical question should not pay for one.
   */
  async function materialiseScope(
    scoped: readonly ScopedCollection[],
    parsed: ParsedQuery,
  ): Promise<{ collections: { iri: string; complete: boolean; refusal: string | null }[] }> {
    const collections: { iri: string; complete: boolean; refusal: string | null }[] = []

    for (const entry of scoped) {
      if (entry.url === null) continue

      const memberClass = deps.model.byIri(entry.memberClassIri)

      // Push the query's covered exact filters into the smallest declared view before fetching.
      const url = viewUrlFor(entry, parsed)

      deps.trace.log(
        `Materialising ${short(entry.collectionClassIri)} from ${url} — a local query is ` +
          `answered from what is held, so what is held has to be all of it.`,
        'sparql',
      )

      const result = await materialise(
        url,
        {
          http: deps.http,
          graph: deps.graph,
          contexts: deps.contexts,
          findings: deps.findings,
          trace: deps.trace,
          origin: deps.origin,
        },
        {
          budget,
          assessFirstPage: memberClass
            ? async (document, collectionIri) => {
                const assessment = await assessPageSerialisation(document, memberClass, collectionIri, {
                  loader: deps.contexts.load,
                  findings: deps.findings,
                })
                if (!assessment) return
                deps.graph.recordCompleteness(collectionIri, {
                  have: deps.graph.completenessOf(collectionIri)?.have ?? 0,
                  at: new Date(),
                  aggregationReady: assessment.aggregationReady,
                  unserved: assessment.missing,
                })
              }
            : undefined,
        },
      )

      collections.push({
        iri: result.collection,
        complete: result.complete,
        refusal: result.refusal,
      })
    }

    return { collections }
  }

  /**
   * The completeness gate (task 7.4).
   *
   * > A total over part of a collection is a wrong number presented as a right one.
   *
   * Two conditions, and both are refusals rather than caveats. The set has to be provably whole, and
   * every field an aggregate reads has to be one the collection actually serves — because a `SUM` over
   * a field no member carries returns `0` with the same confidence as a real total.
   */
  function gateCompleteness(
    parsed: ParsedQuery,
    materialised: { iri: string; complete: boolean; refusal: string | null }[],
  ): string | null {
    const incomplete = materialised.filter((entry) => !entry.complete)
    if (incomplete.length > 0) {
      return [
        `The query was not run. It is scoped to ${incomplete.length} collection` +
          `${incomplete.length === 1 ? '' : 's'} the client does not hold in full, and a query over ` +
          `part of a set answers about that part while looking like an answer about all of it.`,
        '',
        ...incomplete.map((entry) => `- <${entry.iri}>: ${entry.refusal ?? 'the set held is not provably complete.'}`),
      ].join('\n')
    }

    const reads = aggregatedPredicates(parsed)
    if (reads.length === 0) return null

    const unserved: string[] = []
    for (const entry of materialised) {
      const known = deps.graph.completenessOf(entry.iri)
      for (const predicate of known?.unserved ?? []) {
        if (reads.includes(predicate)) unserved.push(`${short(predicate)} on <${entry.iri}>`)
      }
    }

    if (unserved.length === 0) return null

    return (
      `The query was not run. It aggregates over ${unserved.length} field` +
      `${unserved.length === 1 ? '' : 's'} that the collection declares readable but never serialises ` +
      `in its members: ${unserved.join(', ')}. Every record held is missing ${unserved.length === 1 ? 'it' : 'them'}, ` +
      `so the aggregate would total nothing and report a confident zero. Ask for a field the ` +
      `collection serves, or read the resources individually — a dereference returns the full ` +
      `representation where a listing does not.`
    )
  }

  function present(result: QueryRows, where: 'remote' | 'local', note?: string): QueryOutcome {
    const rendered = renderRows(result)
    return {
      ok: true,
      content: note ? `${note}\n\n${rendered}` : rendered,
      ranOn: where,
      requested: true,
    }
  }

  /**
   * The unbound-aggregate guard (design D2).
   *
   * An ungrouped aggregate always returns exactly one row. When that row binds none of the query's
   * aggregate outputs, the aggregate produced no value — `AVG`/`SUM`/`MIN`/`MAX` over an empty or
   * all-null field yields unbound, where `COUNT` would yield a bound zero. Rendered as an `ok` result
   * it would show one row with an empty cell, indistinguishable from a true zero — and it is the one
   * confident-wrong-number that slips past the completeness gate, because the set was complete and the
   * arithmetic still yielded nothing. So it is reported as no-value, not as a successful answer.
   *
   * Returns the message when it fires, or `null` when the result is a genuine answer.
   */
  function unboundAggregateReport(parsed: ParsedQuery, result: QueryRows): string | null {
    if (parsed.aggregates.length === 0 || parsed.grouped || result.rows.length !== 1) return null
    const row = result.rows[0] ?? {}
    const unbound = parsed.aggregateOutputs.filter((name) => !(name in row))
    if (unbound.length === 0) return null

    return (
      `The query ran over a complete set, and its aggregate produced no value: ` +
      `${unbound.join(', ')} ${unbound.length === 1 ? 'is' : 'are'} unbound. This is not a zero — a ` +
      `zero is a value and this is the absence of one, which over a complete set means no member ` +
      `carried an aggregatable value for the field. Reported as no value rather than as a confident ` +
      `zero: read the resources individually if a single record's figure is what is needed, or check ` +
      `that the field aggregated is the one that holds the number.`
    )
  }

  /**
   * The local sequence: scope, materialise, completeness gate, run. Shared by the endpoint-less
   * tier and the stale-endpoint degrade, which differ only in why they are here — carried in
   * `provenance`, which rides the result so a reader can see which dataset answered.
   */
  async function runLocalPath(
    query: string,
    parsed: ParsedQuery,
    provenance: string | null,
  ): Promise<QueryOutcome> {
    const scope = scopeQuery(parsed, {
      graph: deps.graph,
      model: deps.model,
      entrypoint: deps.entrypoint,
      prefixes: deps.prefixes,
    })

    if (scope.refusal !== null) {
      deps.trace.log('The query could not be scoped — nothing was retrieved.', 'error')
      return refuse(scope.refusal)
    }

    deps.trace.log(
      `${provenance === null ? 'No reachable SPARQL endpoint, so the' : 'The'} query runs here ` +
        `over ${scope.collections.length} ` +
        `collection${scope.collections.length === 1 ? '' : 's'}: ` +
        `${scope.collections.map((entry) => short(entry.collectionClassIri)).join(', ')}.`,
      'sparql',
    )

    const { collections } = await materialiseScope(scope.collections, parsed)

    const blocked = gateCompleteness(parsed, collections)
    if (blocked !== null) {
      deps.trace.log('The completeness gate refused the query.', 'error')
      return { ok: false, content: blocked, ranOn: null, requested: true }
    }

    deps.trace.log(
      `Complete: ${collections.map((entry) => `<${entry.iri}>`).join(', ')} held in full. Executing locally.`,
      'success',
    )

    const result = await runLocally(query, parsed.form, deps.graph.queryable())
    deps.trace.log(
      `${result.rows.length} row${result.rows.length === 1 ? '' : 's'} from the local engine.`,
      'sparql',
    )

    // An aggregate that yielded nothing over a complete set is a no-value, not a confident zero (D2).
    const unbound = unboundAggregateReport(parsed, result)
    if (unbound !== null) {
      deps.trace.log('The aggregate produced no value over a complete set — reported as no-value.', 'warn')
      return { ok: false, content: unbound, ranOn: 'local', requested: true }
    }

    return present(result, 'local', provenance ?? undefined)
  }

  return {
    async run(query: string): Promise<QueryOutcome> {
      const parsed = parseQuery(query)
      if (isParseFailure(parsed)) {
        deps.trace.log('The query did not parse — nothing was run.', 'error')
        return refuse(parsed.error)
      }

      /*
       * The gate, before the fork. Design D7 is emphatic about the order and the reason is the whole
       * point of the component: an undeclared predicate is *quieter* at T3, not louder.
       */
      const verdict = checkTerms(parsed.iris, {
        graph: deps.graph,
        model: deps.model,
        constraintsFor: deps.constraintsFor,
        prefixes: deps.prefixes,
      })

      if (!verdict.passed) {
        deps.trace.log(
          `Term gate: ${verdict.undeclared.map((term) => short(term.iri)).join(', ')} ` +
            `${verdict.undeclared.length === 1 ? 'is' : 'are'} not declared. Nothing was executed.`,
          'error',
        )
        return refuse(describeUndeclared(verdict, deps.prefixes))
      }

      deps.trace.log(
        `Term gate: ${verdict.checked} IRI${verdict.checked === 1 ? '' : 's'} checked, all declared.`,
        'sparql',
      )

      if (deps.sparqlEndpoint !== null) {
        /*
         * The endpoint is checked against the API before it is believed (baseline §1.0a).
         *
         * Scoped leniently, and that is deliberate: `scopeQuery` refuses a class no collection
         * serves, which is right locally — there would be nothing to materialise — and wrong here.
         * The endpoint also holds the ontology and the shapes graph, so asking about a class the API
         * does not serve is a real question. Its `collections` are populated either way, so the
         * refusal is ignored and what it found is used.
         */
        const remoteScope = scopeQuery(parsed, {
          graph: deps.graph,
          model: deps.model,
          entrypoint: deps.entrypoint,
          prefixes: deps.prefixes,
        })

        const sync = await checkEndpointSync(parsed, remoteScope, {
          http: deps.http,
          graph: deps.graph,
          contexts: deps.contexts,
          findings: deps.findings,
          trace: deps.trace,
          origin: deps.origin,
          endpoint: deps.sparqlEndpoint,
          ...(deps.prefixes === undefined ? {} : { prefixes: deps.prefixes }),
        })

        if (sync.refusal !== null) {
          /*
           * Two refusal kinds, two policies — the distinction is epistemic, not stylistic, and a
           * future unification of these branches would be a regression:
           *
           * - DIVERGED (declared and held both known, unequal): the check has produced positive
           *   proof the endpoint's copy differs from the API. The local path materialises the
           *   scoped collections FROM THE API ITSELF, completeness-gated against declared totals,
           *   so the local answer is the authoritative one — degrade to it, and say why. This is
           *   NOT the remote-execution-failure case below, where nothing establishes which
           *   dataset would have answered.
           *
           * - UNPROVABLE (no declared total to compare): the sync gate's refusal is crisp and
           *   teaches the fix (declare hydra:totalItems). Kept as a refusal: it only bites
           *   aggregates over collections the API serves sizeless and endless, where the local
           *   walk has no better proof to offer.
           */
          const diverged = sync.checked.filter(
            (check) => !check.agrees && check.declared !== null && check.held !== null,
          )
          if (diverged.length === 0) {
            deps.trace.log('The endpoint is not in step with the API — the query was not run.', 'error')
            return { ok: false, content: sync.refusal, ranOn: null, requested: sync.requested }
          }

          const evidence = diverged
            .map(
              (check) =>
                `${short(check.classIri)}: the API declares ${check.declared}, the endpoint holds ${check.held}`,
            )
            .join('; ')
          deps.trace.log(
            `The endpoint is out of step with the API (${evidence}) — computing locally over the ` +
              `API's own collections instead.`,
            'warn',
          )
          return runLocalPath(
            query,
            parsed,
            `Computed locally over collections retrieved from the API, not on the advertised ` +
              `SPARQL endpoint: the endpoint is out of step with the API (${evidence}).`,
          )
        }

        if (sync.unchecked.length > 0) {
          // Disclosed, never folded into the passed set. A check that did not run is not a check that
          // passed — the same rule the stage-5 constraint gate follows for a constraint it could not
          // evaluate.
          deps.trace.log(
            `Endpoint sync: ${sync.unchecked.map(short).join(', ')} ` +
              `${sync.unchecked.length === 1 ? 'is' : 'are'} served by no collection, so the ` +
              `endpoint's holding could not be compared against a declared total. Not checked.`,
            'sparql',
          )
        }

        deps.trace.log(`Running the query on the endpoint at ${deps.sparqlEndpoint}`, 'sparql')
        const result = await runRemotely(query, deps.sparqlEndpoint, deps.http)
        if (isRemoteFailure(result)) {
          // Not retried locally. Two runs of one query answering from different datasets, with
          // nothing in the result saying which, is worse than one honest failure.
          deps.trace.log(result.reason, 'error')
          return {
            ok: false,
            content: `${result.reason}\n\nThe query was not re-run locally: the endpoint holds the whole dataset and this client holds what it has retrieved, so the two would answer different questions with no way to tell them apart.`,
            ranOn: null,
            requested: true,
          }
        }
        return present(result, 'remote')
      }

      return runLocalPath(query, parsed, null)
    },
  }
}
