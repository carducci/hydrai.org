import { describe, expect, it } from 'vitest'

import { createExecutor } from '../src/execute/dispatch'
import { createHttpClient } from '../src/http/client'
import { projectTools } from '../src/project/tools'
import { isParseFailure, parseQuery } from '../src/query/parse'
import { QUERY_TOOL_NAME, withQueryTool } from '../src/query/tool'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { createTrace } from '../src/trace'
import { buildCapabilityModel, constraintsFor, constraintsOfShape } from '../src/vocab/capability'

import { API, LD_CONTEXT, LEND, PREFIXES, harness, pagedStacks, tome, type Route } from './query-support'
import libraryVocab from './fixtures/library-vocab.json'

/**
 * The gates that run before a query does (stage 7, task 7.2b).
 *
 * Everything here refuses, and every assertion is about what did **not** happen — how many requests
 * were issued, whether anything executed. An outcome flag can be set by code that already did the
 * wrong thing; a request count cannot.
 *
 * The failure being tested for does not produce an error in the wild. A query naming a term the API
 * never declared **matches nothing and returns zero rows**, and zero rows reported as an answer says
 * you earned nothing last year. Design D7 puts the gate before the tier fork precisely because that
 * failure is *quieter* against a live endpoint, not louder.
 *
 * Local execution is tested separately in `query-local.test.ts` — see its header for why.
 *
 * `library-vocab.json` carries all of this: an API that does not exist, so a query path that works
 * against it read a vocabulary rather than remembering a deployment.
 */

describe('reading a query as facts', () => {
  it('refuses an update, because writes have a path with guarantees this one does not', () => {
    // Every projected write is gated before dispatch, read before replacing and verified afterwards.
    // A SPARQL update would be a second write path with none of that, and nothing would say which.
    const result = parseQuery(`${PREFIXES}\nINSERT DATA { <${API}/tomes/1> lend:heading "Dune" }`)
    expect(isParseFailure(result)).toBe(true)
    if (isParseFailure(result)) expect(result.error).toMatch(/writes go through the operations/i)
  })

  it('names every IRI it sees, including a literal’s datatype', () => {
    const result = parseQuery(
      `${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:dueOn ?d . FILTER(?d > "2025-01-01"^^xsd:date) }`,
    )
    if (isParseFailure(result)) throw new Error(result.error)

    expect(result.iris).toContain(`${LEND}Tome`)
    expect(result.iris).toContain(`${LEND}dueOn`)
    // A mistyped datatype matches nothing rather than erroring, so it is gated like any other term.
    expect(result.iris).toContain('http://www.w3.org/2001/XMLSchema#date')
  })

  it('reports which predicate bound each variable, so an aggregate can be traced to a field', () => {
    const result = parseQuery(`${PREFIXES}\nSELECT (SUM(?f) AS ?t) WHERE { ?l a lend:Loan ; lend:fine ?f }`)
    if (isParseFailure(result)) throw new Error(result.error)

    expect(result.aggregates).toEqual([{ aggregation: 'sum', variable: 'f' }])
    expect(result.variableSources.get('f')).toEqual([`${LEND}fine`])
    expect(result.types).toEqual([{ variable: 'l', classIri: `${LEND}Loan` }])
  })

  it('does not mistake COUNT(*) for an aggregate over a field', () => {
    // It reads no field, which is why it stays allowed over a set whose fields are unserved.
    const result = parseQuery(`${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?t a lend:Tome }`)
    if (isParseFailure(result)) throw new Error(result.error)
    expect(result.aggregates).toEqual([{ aggregation: 'count', variable: null }])
  })

  it('reads terms out of a nested pattern, not just the top-level one', () => {
    // A gate that walked only the outer BGP would pass an undeclared term hidden one OPTIONAL deep.
    const result = parseQuery(
      `${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome OPTIONAL { ?t lend:shelvedOn ?s } }`,
    )
    if (isParseFailure(result)) throw new Error(result.error)
    expect(result.iris).toContain(`${LEND}shelvedOn`)
  })

  it('reports conjunctive equality conjuncts, tagged IRI or literal (task 3.1)', () => {
    // The input to filter pushdown: a predicate bound to a constant in the conjunctive WHERE.
    const result = parseQuery(
      `${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:heading "Dune" ; lend:shelvedOn <${API}/stack/1> }`,
    )
    if (isParseFailure(result)) throw new Error(result.error)
    expect(result.equalityFilters).toContainEqual({ predicate: `${LEND}heading`, value: 'Dune', isIri: false })
    expect(result.equalityFilters).toContainEqual({
      predicate: `${LEND}shelvedOn`,
      value: `${API}/stack/1`,
      isIri: true,
    })
  })

  it('does not treat an equality under OPTIONAL as a conjunctive conjunct (task 3.1)', () => {
    // A row absent from an OPTIONAL still appears, so pushing its equality down would drop rows.
    const result = parseQuery(
      `${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome OPTIONAL { ?t lend:shelvedOn <${API}/stack/1> } }`,
    )
    if (isParseFailure(result)) throw new Error(result.error)
    expect(result.equalityFilters).toEqual([])
  })

  it('does not treat an equality inside a UNION branch as conjunctive (task 3.1)', () => {
    const result = parseQuery(
      `${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome { ?t lend:heading "A" } UNION { ?t lend:heading "B" } }`,
    )
    if (isParseFailure(result)) throw new Error(result.error)
    expect(result.equalityFilters).toEqual([])
  })

  it('marks an ungrouped aggregate and names its output variable (task 3.5 input)', () => {
    const result = parseQuery(`${PREFIXES}\nSELECT (AVG(?f) AS ?avg) WHERE { ?l a lend:Loan ; lend:fine ?f }`)
    if (isParseFailure(result)) throw new Error(result.error)
    expect(result.grouped).toBe(false)
    expect(result.aggregateOutputs).toEqual(['avg'])
  })

  it('records a GROUP BY as grouped', () => {
    const result = parseQuery(
      `${PREFIXES}\nSELECT ?s (COUNT(*) AS ?n) WHERE { ?t a lend:Tome ; lend:shelvedOn ?s } GROUP BY ?s`,
    )
    if (isParseFailure(result)) throw new Error(result.error)
    expect(result.grouped).toBe(true)
    expect(result.aggregateOutputs).toEqual(['n'])
  })
})

describe('the term gate', () => {
  it('rejects an undeclared predicate before execution, and issues nothing', async () => {
    const { runner, requests } = await harness({ routes: pagedStacks(2, 25) })

    const outcome = await runner.run(`${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:revenue ?r }`)

    expect(outcome.ok).toBe(false)
    expect(outcome.ranOn).toBeNull()
    // The assertion that matters is a count of requests, not a flag. A gate that rejected after
    // materialising the collection would set the same flag having already spent the traversal.
    expect(requests).toHaveLength(0)
    expect(outcome.requested).toBe(false)
  })

  it('rejects the same query when an endpoint is reachable, and sends nothing to it', async () => {
    /*
     * Design D7's insistence, and the reason the gate precedes the tier fork. A live endpoint given
     * an undeclared predicate does not error — it matches nothing and answers zero rows, which is a
     * silent wrong answer rather than a loud failure. Remote is where this is quietest.
     */
    const { runner, requests } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: {
        [`POST ${API}/sparql`]: () => ({
          text: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
        }),
      },
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:revenue ?r }`)

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
  })

  it('names a near match drawn from the same store', async () => {
    const { runner } = await harness()

    // Design D7's own illustration used `ns:revenue`, which turned out to be declared by the API it
    // was written about — it would have passed for the wrong reason. This is a typo of a real term.
    const outcome = await runner.run(`${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:headin ?h }`)

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/lend:headin is not declared/)
    expect(outcome.content).toMatch(/Did you mean lend:heading/)
  })

  it('says so plainly when nothing declared is close', async () => {
    const { runner } = await harness()
    const outcome = await runner.run(`${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:zzzzzzzzzz ?h }`)

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/Nothing declared is close to it/)
  })

  it('accepts the query language’s own vocabulary without the API declaring it', async () => {
    // `rdf:type` and `xsd:*` are the language the client reads in, not terms this API mints. A gate
    // that demanded the API declare them would reject every well-formed query.
    const { runner } = await harness()
    const outcome = await runner.run(
      `${PREFIXES}\nSELECT ?t WHERE { ?t rdf:type lend:Nonesuch . FILTER(?t > "1"^^xsd:integer) }`,
    )

    expect(outcome.content).toMatch(/lend:Nonesuch is not declared/)
    // Only the API's own invented term is named. The language's terms passed.
    expect(outcome.content).not.toMatch(/rdf:type is not declared|XMLSchema#integer> is not declared/)
  })

  it('does not treat a predicate the server serves as one the vocabulary declared', async () => {
    /*
     * The store holds retrieved data as well as documents, and a server serving a predicate it never
     * declared is a conformance gap. Reading the data graph's predicates as declarations would
     * launder that gap into a licence — so only schema documents and held subjects count.
     */
    const { runner, graph } = await harness()
    expect(graph.subjects()).toEqual([])

    const outcome = await runner.run(`${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:undeclared ?x }`)
    expect(outcome.content).toMatch(/lend:undeclared is not declared/)
  })
})

describe('the query tool on the surface', () => {
  /** The projected surface plus the client's own query tool, behind an executor that can route it. */
  async function surfaceHarness() {
    const contexts = createContextStore({
      fetchJson: async (url) => {
        throw new Error(`the network must not be reached, but ${url} was requested`)
      },
    })
    const graph = createSessionGraph()
    const findings = createFindings()
    const trace = createTrace()

    graph.ingestDocument(await quadsFromJsonLd(libraryVocab, contexts.load, `${API}/vocab`), GRAPHS.vocab)
    const model = buildCapabilityModel(graph)

    const projected = projectTools(model, {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      findings,
    })
    const surface = withQueryTool(projected)

    const asked: string[] = []
    const executor = createExecutor({
      http: createHttpClient({
        fetchImpl: (async () => new Response('nothing should be fetched', { status: 500 })) as unknown as typeof fetch,
      }),
      graph,
      contexts,
      findings,
      trace,
      surface,
      model,
      origin: API,
      entrypoint: null,
      query: {
        run: async (text: string) => {
          asked.push(text)
          return { ok: true, content: 'answered by the query runner', ranOn: 'local' as const, requested: true }
        },
      },
    })

    return { projected, surface, executor, asked }
  }

  it('adds exactly one tool, and leaves the projection untouched', async () => {
    // The projection has to stay a pure function of the vocabulary — that is what makes "point it at
    // another API and the toolset changes with no code" a checkable claim rather than a slogan.
    const { projected, surface } = await surfaceHarness()

    expect(surface.tools).toHaveLength(projected.tools.length + 1)
    expect(projected.byName(QUERY_TOOL_NAME)).toBeUndefined()
    expect(surface.byName(QUERY_TOOL_NAME)).toBeDefined()
    expect(surface.byName(QUERY_TOOL_NAME)?.strict).toBe(true)
  })

  it('keeps the surface sorted, so the prompt prefix stays byte-identical across connects', async () => {
    const { surface } = await surfaceHarness()
    const names = surface.tools.map((tool) => tool.name)
    expect(names).toEqual([...names].sort())
  })

  it('routes a call to the query runner instead of resolving an address', async () => {
    /*
     * Task 7.1. Everything else in the execution layer resolves an address from the vocabulary, and a
     * query has none — it acts on the API rather than on a resource. A tool that fell through to that
     * path would look for a class IRI of `''` and report the vocabulary as incomplete.
     */
    const { executor, asked } = await surfaceHarness()
    const query = `${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome }`

    const outcome = await executor.execute(QUERY_TOOL_NAME, { query })

    expect(outcome.ok).toBe(true)
    expect(outcome.content).toBe('answered by the query runner')
    expect(asked).toEqual([query])
  })

  it('says so rather than dispatching when no runner is configured', async () => {
    const { surface, executor: _unused } = await surfaceHarness()
    const contexts = createContextStore({ fetchJson: async () => ({}) })
    const graph = createSessionGraph()

    const executor = createExecutor({
      http: createHttpClient({
        fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      }),
      graph,
      contexts,
      findings: createFindings(),
      trace: createTrace(),
      surface,
      model: buildCapabilityModel(graph),
      origin: API,
      entrypoint: null,
    })

    const outcome = await executor.execute(QUERY_TOOL_NAME, { query: 'SELECT * WHERE { ?s ?p ?o }' })
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/no query runner is configured/)
    expect(outcome.requested).toBe(false)
  })
})

describe('scoping a query to what must be retrieved', () => {
  it('refuses a query that names no class, rather than answering from whatever is held', async () => {
    const { runner, requests } = await harness({ routes: pagedStacks(2, 25) })

    const outcome = await runner.run('SELECT ?s ?p ?o WHERE { ?s ?p ?o }')

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/names no class/)
    expect(outcome.content).toMatch(/type pattern/)
    expect(requests).toHaveLength(0)
  })

  it('refuses a class no collection declares as its members', async () => {
    // `lend:Stack` is the fixture's decoy: a real class with real operations, which singularising the
    // collection name lands on, and which no collection serves. Morphology would answer confidently.
    const { runner, requests } = await harness({ routes: pagedStacks(2, 25) })

    const outcome = await runner.run(`${PREFIXES}\nSELECT ?s WHERE { ?s a lend:Stack ; lend:aisle ?a }`)

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/no collection declares/)
    expect(requests).toHaveLength(0)
  })

  it('refuses when the collection exists but the vocabulary never says where it lives', async () => {
    // `lend:Ledger` declares members and publishes no form-style template, and there is no entry
    // point here. A URL built from the class name is the assumption this client will not make.
    const { runner, requests } = await harness()

    const outcome = await runner.run(`${PREFIXES}\nSELECT ?l WHERE { ?l a lend:Loan ; lend:dueOn ?d }`)

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/never states the IRI it lives at/)
    expect(requests).toHaveLength(0)
  })
})

describe('the sync gate — the endpoint is checked against the API before it is believed', () => {
  /*
   * Closing baseline §1.0a, and the failure is not hypothetical.
   *
   * This deployment advertised a live, CORS-clean, probe-answering SPARQL endpoint holding 10
   * contacts while the API's own collection declared 3,467. Asked how many contacts existed, the
   * query ran, the endpoint answered *without error*, and the number came back wrong by 346x with
   * nothing anywhere saying so. Reachable is not synchronised, and the probe establishes only the
   * first.
   *
   * Every assertion below is about the REQUEST BODIES rather than an outcome flag, because the gate
   * and the model's query POST to the same URL: a refusal has to prove the model's query never left,
   * and a count of requests cannot show that.
   */

  /** Answers the client's COUNT with `held`, and anything else as an empty result set. */
  function endpointHolding(held: number) {
    return (body: string | null) => {
      const query = decodeURIComponent((body ?? '').replace(/^query=/, ''))
      if (/COUNT\(DISTINCT/i.test(query)) {
        return {
          text: JSON.stringify({
            head: { vars: ['n'] },
            results: { bindings: [{ n: { type: 'literal', value: String(held) } }] },
          }),
        }
      }
      return { text: JSON.stringify({ head: { vars: ['x'] }, results: { bindings: [] } }) }
    }
  }

  const sparqlBodies = (requests: readonly { url: string; body: string | null }[]) =>
    requests
      .filter((request) => request.url === `${API}/sparql`)
      .map((request) => decodeURIComponent((request.body ?? '').replace(/^query=/, '')))

  /*
   * A DIVERGED endpoint (declared and held both known, unequal) no longer refuses — it degrades to
   * local execution over collections materialised from the API, with provenance
   * (deterministic-agent-surface). That behaviour executes a query, so it is pinned in
   * `query-local.test.ts` where Comunica's start-up is already paid; this file keeps every decision
   * that needs nothing executed. The property shared by both outcomes — the model's query never
   * reaches a stale endpoint — is asserted there too.
   */

  it('runs the query when the endpoint holds what the API declares', async () => {
    // The positive control. A gate that refused everything would pass the test above for the wrong
    // reason, and this is the only thing that distinguishes the two.
    const { runner, requests } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: { ...pagedStacks(300, 25), [`POST ${API}/sparql`]: endpointHolding(300) },
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?t a lend:Tome }`)

    expect(outcome.ok).toBe(true)
    expect(outcome.ranOn).toBe('remote')

    const sent = sparqlBodies(requests)
    expect(sent).toHaveLength(2)
    expect(sent.some((query) => /COUNT\(\*\)/.test(query))).toBe(true)
  })

  it('does not refuse a class no collection serves — there is no declared total to check', async () => {
    /*
     * `lend:Stack` is the fixture's decoy: a real class with real operations that no collection
     * declares as its members. Locally that is a refusal, because there would be nothing to
     * materialise. Remotely it is a legitimate question — the endpoint also holds the ontology and
     * the shapes graph — so the gate must not inherit the local path's refusal.
     */
    const { runner, requests } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: { [`POST ${API}/sparql`]: endpointHolding(0) },
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT ?s WHERE { ?s a lend:Stack }`)

    expect(outcome.ok).toBe(true)
    expect(outcome.ranOn).toBe('remote')
    // Nothing was checkable, so nothing was counted — one POST, the query itself.
    expect(sparqlBodies(requests)).toHaveLength(1)
  })

  it('discloses an unchecked class in the trace rather than counting it as verified', async () => {
    const { runner, trace } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: { [`POST ${API}/sparql`]: endpointHolding(0) },
    })

    await runner.run(`${PREFIXES}\nSELECT ?s WHERE { ?s a lend:Stack }`)

    const messages = trace.entries.map((entry) => entry.message).join('\n')
    expect(messages).toMatch(/served by no collection/)
    expect(messages).toMatch(/Not checked/)
  })

  it('refuses an aggregate whose set cannot be proven, and allows the same scope unaggregated', async () => {
    // A paged collection declaring no total: the API states no size, so there is nothing to compare
    // the endpoint against. An aggregate is one number carrying no trace of what it covered, so it
    // is refused; a row-returning query shows its own extent and is not.
    const sizeless: Record<string, Route> = {
      [`${API}/stacks`]: {
        '@context': LD_CONTEXT,
        '@id': `${API}/stacks`,
        '@type': 'Collection',
        member: [tome(1)],
        view: { '@id': `${API}/stacks/leaf/1`, '@type': 'PartialCollectionView', next: `${API}/stacks/leaf/2` },
      },
      [`POST ${API}/sparql`]: endpointHolding(1),
    }

    const aggregated = await harness({ sparqlEndpoint: `${API}/sparql`, routes: sizeless })
    const refused = await aggregated.runner.run(
      `${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?t a lend:Tome }`,
    )
    expect(refused.ok).toBe(false)
    expect(refused.content).toMatch(/declares no hydra:totalItems/)
    expect(sparqlBodies(aggregated.requests).some((q) => /COUNT\(\*\)/.test(q))).toBe(false)

    const listed = await harness({ sparqlEndpoint: `${API}/sparql`, routes: sizeless })
    const allowed = await listed.runner.run(`${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome }`)
    expect(allowed.ok).toBe(true)
    expect(allowed.ranOn).toBe('remote')
  })

  it('proves sync from an absent partial view, with no declared total', async () => {
    // The reference collections of the real API work exactly this way: no total, no view. Requiring
    // a declared total would refuse them permanently, and the local gate already knows better.
    const { runner } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: {
        [`${API}/stacks`]: {
          '@context': LD_CONTEXT,
          '@id': `${API}/stacks`,
          '@type': 'Collection',
          member: [tome(1), tome(2)],
        },
        [`POST ${API}/sparql`]: endpointHolding(2),
      },
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?t a lend:Tome }`)

    expect(outcome.ok).toBe(true)
    expect(outcome.ranOn).toBe('remote')
  })
})
