import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { engineLoaded, resetEngine } from '../src/query/local'

import {
  API,
  PREFIXES,
  finesVocab,
  fine,
  gig,
  gigCollection,
  gigsVocab,
  harness,
  pagedStacks,
} from './query-support'

/**
 * Local execution and the completeness gate (stage 7, tasks 7.3, 7.4 and 7.5).
 *
 * The failure being tested for **returns a number**. An aggregate over part of a collection, or over
 * a field the members do not carry, produces a total that is wrong and looks exactly like one that is
 * right — design D5's "cap truncates and returns partial data that looks complete", arriving through
 * arithmetic rather than through the model.
 *
 * ## Why this is its own file
 *
 * Comunica loads several hundred modules and assembles its actor graph on first construction.
 * Measured here at **roughly 72 seconds** — 31s to import, 41s to construct, then tens of
 * milliseconds per query. That is an artefact of this machine rather than of the engine: `node_modules`
 * sits on the Windows mount and every one of those files crosses the filesystem boundary. It is still
 * the cost a developer pays, so it is isolated here — the gates in `query.test.ts` decide everything
 * they can decide without executing, and run in milliseconds.
 *
 * The warm-up below makes the cost explicit rather than letting it land on whichever test runs first
 * and read as that test being slow.
 */

beforeAll(async () => {
  // Warms the module cache and the actor graph. None of the client's own state is touched, so
  // `engineLoaded()` still reports only whether the client itself reached for the engine.
  const { QueryEngine } = await import('@comunica/query-sparql-rdfjs')
  new QueryEngine()
}, 300_000)

beforeEach(() => {
  resetEngine()
})

describe('the completeness gate', () => {
  it('refuses an aggregate over a set it cannot finish retrieving', async () => {
    /*
     * The collection declares 300 members and the budget allows 10. A cap would have summed the
     * first page and returned a number; a budget refuses and says why, which is the distinction
     * design D5 is built on.
     */
    const { runner } = await harness({
      vocab: finesVocab,
      routes: pagedStacks(300, 25, fine),
      budget: 10,
    })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (SUM(?a) AS ?total) WHERE { ?f a lend:Fine ; lend:amount ?a }`,
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/does not hold in full|exceeds the budget/)
    // No figure reached the caller, which is the property under test. A partial total is the failure.
    expect(outcome.content).not.toMatch(/\browsb?\b|\b\d+ rows?\b/)
  })

  it('returns the right number once the whole set is held', async () => {
    // 1..40 sums to 820, and the collection spans two pages — so the figure is only right if the
    // traversal ran to completion and the aggregate saw both.
    const { runner } = await harness({ vocab: finesVocab, routes: pagedStacks(40, 25, fine) })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (SUM(?a) AS ?total) WHERE { ?f a lend:Fine ; lend:amount ?a }`,
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.ranOn).toBe('local')
    expect(outcome.content).toMatch(/820/)
  })

  it('refuses an aggregate over a field the members never carry', async () => {
    /*
     * Design D5's "remaining thorn". `lend:waived` is declared readable and never serialised — not
     * even as null — so every held record is missing it and `SUM` would total nothing and report a
     * confident zero.
     */
    const { runner } = await harness({
      vocab: finesVocab,
      routes: pagedStacks(4, 25, (n) => {
        const { 'lend:waived': _dropped, ...rest } = fine(n)
        return rest
      }),
    })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (SUM(?w) AS ?total) WHERE { ?f a lend:Fine ; lend:waived ?w }`,
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/never serialises/)
    expect(outcome.content).toMatch(/lend:waived/)
  })

  it('does not hold a null against a field the members do mention', async () => {
    /*
     * Task 3.5's finding, and it is load-bearing here. `lend:waived` is null in every member, so it
     * yields no triple and is absent from the graph — but the server mentions the key, and the
     * mention is the proof it serves the field. Refusing on graph absence alone would refuse
     * aggregation over most real collections: one live member had 21 of 36 fields empty.
     */
    const { runner } = await harness({ vocab: finesVocab, routes: pagedStacks(4, 25, fine) })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (SUM(?a) AS ?total) WHERE { ?f a lend:Fine ; lend:amount ?a }`,
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.content).toMatch(/10\b/)
  })

  it('counts a complete set without needing any field to be served', async () => {
    // `COUNT(*)` reads no field, so an unserved one is not its problem. A gate keyed on the
    // collection rather than on the fields the query touches would refuse this.
    const { runner } = await harness({
      vocab: finesVocab,
      routes: pagedStacks(7, 25, (n) => {
        const { 'lend:waived': _dropped, ...rest } = fine(n)
        return rest
      }),
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?f a lend:Fine }`)

    expect(outcome.ok).toBe(true)
    expect(outcome.content).toMatch(/\b7\b/)
  })

  it('maps a member class to its collection through the declared member range', async () => {
    // Not by stemming a collection name, which is what the library fixture's decoy punishes.
    const { runner, trace } = await harness({ vocab: finesVocab, routes: pagedStacks(2, 25, fine) })
    await runner.run(`${PREFIXES}\nSELECT ?f WHERE { ?f a lend:Fine ; lend:amount ?a }`)

    expect(trace.entries.some((entry) => entry.message.includes('lend:Fines'))).toBe(true)
  })
})

describe('filter pushdown and the unbound-aggregate guard (Increment C)', () => {
  /** The status view and the whole collection, so a test can assert which one was fetched. */
  function gigRoutes(booked: Record<string, unknown>[], all: Record<string, unknown>[]) {
    return {
      [`${API}/gigs/status/BookedGig`]: gigCollection(`${API}/gigs/status/BookedGig`, booked),
      [`${API}/gigs`]: gigCollection(`${API}/gigs`, all),
    }
  }

  it('materialises only the covering view for a filtered aggregate (tasks 3.2, 3.6)', async () => {
    const { runner, requests } = await harness({
      vocab: gigsVocab,
      routes: gigRoutes(
        [gig(10, 'BookedGig'), gig(30, 'BookedGig')],
        [gig(10, 'BookedGig'), gig(30, 'BookedGig'), gig(50, 'PastGig')],
      ),
    })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (AVG(?fee) AS ?avg) WHERE { ?g a lend:Gig ; lend:status lend:BookedGig ; lend:fee ?fee }`,
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.content).toMatch(/\b20\b/) // (10 + 30) / 2
    // The status view was fetched; the whole collection was not.
    expect(requests.some((request) => request.url === `${API}/gigs/status/BookedGig`)).toBe(true)
    expect(requests.filter((request) => request.url === `${API}/gigs`)).toHaveLength(0)
  })

  it('walks the whole collection for the same aggregate without a filter (task 3.6)', async () => {
    const { runner, requests } = await harness({
      vocab: gigsVocab,
      routes: gigRoutes(
        [gig(10, 'BookedGig')],
        [gig(10, 'BookedGig'), gig(30, 'BookedGig'), gig(50, 'PastGig')],
      ),
    })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (AVG(?fee) AS ?avg) WHERE { ?g a lend:Gig ; lend:fee ?fee }`,
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.content).toMatch(/\b30\b/) // (10 + 30 + 50) / 3
    expect(requests.some((request) => request.url === `${API}/gigs`)).toBe(true)
  })

  it('does not push a text (literal) equality down — it falls through to the whole collection (task 3.3)', async () => {
    const { runner, requests } = await harness({
      vocab: gigsVocab,
      routes: gigRoutes([], [gig(10, 'BookedGig'), gig(30, 'BookedGig'), gig(50, 'PastGig')]),
    })

    // A literal equality is analyzer-matched server-side, not equality-matched, so it is not pushed.
    const outcome = await runner.run(
      `${PREFIXES}\nSELECT ?g WHERE { ?g a lend:Gig ; lend:label "Gig 10" }`,
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.content).toMatch(/gigs\/10/)
    expect(requests.some((request) => request.url === `${API}/gigs`)).toBe(true)
    expect(requests.some((request) => request.url.includes('/gigs/status/'))).toBe(false)
  })

  it('completeness-gates the filtered view against its own total (task 3.4)', async () => {
    const { runner, requests } = await harness({
      vocab: gigsVocab,
      routes: {
        // A partial view with neither a declared total nor a proof it is whole: not provably complete.
        [`${API}/gigs/status/BookedGig`]: {
          '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { lend: 'https://lending.example/ns#' }],
          '@id': `${API}/gigs/status/BookedGig`,
          '@type': 'Collection',
          member: [gig(10, 'BookedGig')],
          view: { '@id': `${API}/gigs/status/BookedGig`, '@type': 'PartialCollectionView' },
        },
        [`${API}/gigs`]: gigCollection(`${API}/gigs`, [gig(10, 'BookedGig')]),
      },
    })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (AVG(?fee) AS ?avg) WHERE { ?g a lend:Gig ; lend:status lend:BookedGig ; lend:fee ?fee }`,
    )

    // The view was materialised (pushdown ran), and the completeness gate refused it on its own total.
    expect(requests.some((request) => request.url === `${API}/gigs/status/BookedGig`)).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/hold in full|not provably complete|unstated number/)
  })

  it('reports an unbound aggregate over a complete set as no-value, not a zero (task 3.5)', async () => {
    /*
     * Design D2's owned defect. The set is complete and the field is served (mentioned as null), so
     * the completeness gate passes — but no member carries a fee value, so MIN(?fee) binds nothing and
     * renders as a single row with an empty cell, indistinguishable from a real answer. This reports
     * the absence instead of presenting it as a confident result.
     */
    const nulled = (id: number) => ({
      '@id': `${API}/gigs/${id}`,
      '@type': 'lend:Gig',
      'lend:fee': null,
      'lend:label': `Gig ${id}`,
      'lend:status': { '@id': 'lend:BookedGig' },
    })
    const { runner } = await harness({
      vocab: gigsVocab,
      routes: gigRoutes([nulled(10), nulled(30)], [nulled(10), nulled(30)]),
    })

    // The booked gigs match, so the set is non-empty and complete; the fee is optional and never
    // binds, so MIN yields unbound — the empty cell D2 must not present as ok.
    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (MIN(?fee) AS ?low) WHERE { ?g a lend:Gig ; lend:status lend:BookedGig OPTIONAL { ?g lend:fee ?fee } }`,
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/no value|not a zero/i)
  })
})

describe('routing between local and remote', () => {
  it('never loads the local engine when an endpoint answers', async () => {
    /*
     * Task 7.3's requirement, asserted rather than intended. The engine is several hundred modules;
     * a T3 session loading it in order not to use it would pay for a capability it has a better
     * version of.
     */
    const { runner, requests } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      // 820 members, and the endpoint agrees it holds 820 — so the sync gate passes and the query
      // reaches the endpoint. Only page 1 is ever read; the other 32 pages are never requested.
      routes: {
        ...pagedStacks(820, 25),
        [`POST ${API}/sparql`]: () => ({
          text: JSON.stringify({
            head: { vars: ['total'] },
            results: { bindings: [{ total: { type: 'literal', value: '820' } }] },
          }),
        }),
      },
    })

    const outcome = await runner.run(
      `${PREFIXES}\nSELECT (SUM(?a) AS ?total) WHERE { ?t a lend:Tome ; lend:isbn ?a }`,
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.ranOn).toBe('remote')
    expect(outcome.content).toMatch(/820/)
    expect(engineLoaded()).toBe(false)

    /*
     * Nothing was MATERIALISED — but this is no longer zero requests, and the difference is the
     * sync gate (baseline §1.0a). It reads exactly one page to learn what the API declares, then
     * compares that against the endpoint's own count. One page is a cross-check; 33 would be the
     * traversal this branch exists to avoid, so the assertion is that it stayed at one.
     */
    const collectionReads = requests.filter((request) => request.url.includes('/stacks'))
    expect(collectionReads).toHaveLength(1)
    expect(collectionReads[0]?.url).toBe(`${API}/stacks`)
  })

  it('reports an endpoint failure rather than quietly answering from what it holds', async () => {
    /*
     * A silent fallback would mean two runs of one query answering from different datasets — the
     * endpoint's whole store, or this client's materialised subset — with nothing in the result
     * saying which one it was.
     */
    const { runner } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: { [`POST ${API}/sparql`]: () => ({ status: 500, text: 'engine is down' }) },
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT ?t WHERE { ?t a lend:Tome ; lend:heading ?h }`)

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/answered 500/)
    expect(outcome.content).toMatch(/not re-run locally/)
    expect(engineLoaded()).toBe(false)
  })

  it('loads the engine when there is no endpoint, and says the query ran here', async () => {
    // The other half of the assertion above: `engineLoaded()` staying false has to be capable of
    // being true, or it proves nothing.
    const { runner } = await harness({ vocab: finesVocab, routes: pagedStacks(3, 25, fine) })

    const outcome = await runner.run(`${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?f a lend:Fine }`)

    expect(outcome.ranOn).toBe('local')
    expect(engineLoaded()).toBe(true)
  })
})

describe('a stale endpoint degrades to local execution (deterministic-agent-surface)', () => {
  /*
   * The 2026-08-02 live traces: the advertised endpoint held 3,471 contacts while the API declared
   * 3,475, the sync gate refused, and the model improvised — one session page-walked the collection
   * by hand, another answered a count from a listing. The refusal was honest; the architecture has a
   * better honest answer. The sync check produced positive proof that the endpoint's copy differs
   * from the API, and the local path materialises the scoped collections FROM THE API ITSELF,
   * completeness-gated — so the local answer is the authoritative one, and the result says which
   * dataset answered. Contrast the remote-execution-failure tests above, which stay refusals:
   * there, nothing establishes which dataset would have answered.
   */

  const bindings = (variable: string, value: string | number) =>
    JSON.stringify({
      head: { vars: [variable] },
      results: { bindings: [{ [variable]: { type: 'literal', value: String(value) } }] },
    })

  const sparqlBodies = (requests: readonly { url: string; body: string | null }[]) =>
    requests
      .filter((request) => request.url === `${API}/sparql`)
      .map((request) => decodeURIComponent((request.body ?? '').replace(/^query=/, '')))

  it('answers from the API’s own collections when the endpoint is out of step, and says so', async () => {
    const { runner, requests } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: {
        ...pagedStacks(300, 25),
        [`POST ${API}/sparql`]: (body) =>
          /COUNT\(DISTINCT/i.test(decodeURIComponent(body ?? ''))
            ? { text: bindings('n', 10) }
            : { text: bindings('x', 0) },
      },
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?t a lend:Tome }`)

    expect(outcome.ok).toBe(true)
    expect(outcome.ranOn).toBe('local')
    expect(outcome.content).toMatch(/Computed locally/)
    expect(outcome.content).toMatch(/declares 300/)
    expect(outcome.content).toMatch(/holds 10/)
    expect(outcome.content).toMatch(/\b300\b/)

    // The model’s query still never reached the stale endpoint — only the sync probe did.
    const sent = sparqlBodies(requests)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/COUNT\(DISTINCT/)
  })

  it('does not re-run a remote execution failure locally, even with the sync check passed', async () => {
    // The inverse pin design D1 calls for: a future refactor that "unifies" the two branches has to
    // break this test to do it.
    const { runner } = await harness({
      sparqlEndpoint: `${API}/sparql`,
      routes: {
        ...pagedStacks(300, 25),
        [`POST ${API}/sparql`]: (body) =>
          /COUNT\(DISTINCT/i.test(decodeURIComponent(body ?? ''))
            ? { text: bindings('n', 300) }
            : { status: 500, text: 'the endpoint fell over mid-query' },
      },
    })

    const outcome = await runner.run(`${PREFIXES}\nSELECT (COUNT(*) AS ?n) WHERE { ?t a lend:Tome }`)

    expect(outcome.ok).toBe(false)
    expect(outcome.ranOn).toBeNull()
    expect(outcome.content).toMatch(/not re-run locally/)
    expect(engineLoaded()).toBe(false)
  })
})
