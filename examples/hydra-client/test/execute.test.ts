import { describe, expect, it } from 'vitest'

import { createExecutor, type Executor } from '../src/execute/dispatch'
import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings, FINDING_KINDS, type Findings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { projectTools } from '../src/project/tools'
import { createTrace, type Trace } from '../src/trace'
import { manifestPrefixes } from '../src/agent/manifest'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  primaryNamespace,
} from '../src/vocab/capability'

import libraryVocab from './fixtures/library-vocab.json'
import magoShapes from './fixtures/mago-shapes.json'
import magoVocab from './fixtures/mago-vocab.json'

/**
 * The execution layer (tasks 5.1-5.8).
 *
 * Everything here runs against a fake server, because the properties being asserted are properties of
 * the client: that a refused call issues no request, that a pre-write read reaches the origin whatever
 * is held, that traversal has no ceiling, that a field the vocabulary cannot resolve is escalated
 * rather than dropped. Each of those is a defect the implementation this replaces actually had.
 *
 * `library-vocab.json` carries most of it, and deliberately: it describes an API that does not exist,
 * so a dispatch path that works against it is one that read the vocabulary rather than remembering
 * this deployment.
 */

const LEND = 'https://lending.example/ns#'
const API = 'https://lending.example/api'
/** The envelope names collections by IRI — class IRI or published URL, never a tool name. */
const STACKS = `${LEND}Stacks`
const ROSTER = `${LEND}Roster`
const LD_CONTEXT = ['http://www.w3.org/ns/hydra/context.jsonld', { lend: LEND }]

interface Recorded {
  readonly method: string
  readonly url: string
  readonly body: string | null
}

interface Reply {
  readonly status?: number
  readonly document?: unknown
  readonly text?: string
}

type Handler = (body: string | null) => Reply
type Route = Handler | Record<string, unknown>

function server(routes: Record<string, Route>) {
  const requests: Recorded[] = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = (init?.body as string | undefined) ?? null
    requests.push({ method, url, body })

    const route = routes[`${method} ${url}`] ?? routes[url]
    if (route === undefined) {
      return new Response(`no route for ${method} ${url}`, { status: 404 })
    }

    const reply: Reply = typeof route === 'function' ? route(body) : { document: route }
    if (reply.text !== undefined) return new Response(reply.text, { status: reply.status ?? 200 })
    return new Response(JSON.stringify(reply.document ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/ld+json' },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, requests }
}

interface Harness {
  readonly executor: Executor
  readonly graph: SessionGraph
  readonly findings: Findings
  readonly trace: Trace
  readonly requests: readonly Recorded[]
}

async function harness(options: {
  vocab?: unknown
  shapes?: unknown
  entrypoint?: { url: string; document: unknown }
  routes?: Record<string, Route>
  budget?: number
  freshForMs?: number
  origin?: string
  /** Wire the manifest's own prefix table into intake, exactly as `main.ts` does. */
  prefixes?: boolean
}): Promise<Harness> {
  const { fetchImpl, requests } = server(options.routes ?? {})
  const contexts = createContextStore({
    fetchJson: async (url) => {
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })

  const graph = createSessionGraph()
  const findings = createFindings()
  const trace = createTrace()

  graph.ingestDocument(
    await quadsFromJsonLd(options.vocab ?? libraryVocab, contexts.load, `${API}/vocab`),
    GRAPHS.vocab,
  )
  if (options.shapes) {
    graph.ingestDocument(
      await quadsFromJsonLd(options.shapes, contexts.load, `${API}/shapes`),
      GRAPHS.shapes,
    )
  }
  if (options.entrypoint) {
    graph.ingestDocument(
      await quadsFromJsonLd(options.entrypoint.document, contexts.load, options.entrypoint.url),
      GRAPHS.context,
    )
  }

  const model = buildCapabilityModel(graph)
  const surface = projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings,
  })

  const executor = createExecutor({
    http: createHttpClient({ fetchImpl }),
    graph,
    contexts,
    findings,
    trace,
    surface,
    model,
    origin: options.origin ?? API,
    entrypoint: options.entrypoint?.url ?? null,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.freshForMs === undefined ? {} : { freshForMs: options.freshForMs }),
    ...(options.prefixes
      ? {
          prefixes: manifestPrefixes({
            constraintsFor: (iri) => constraintsFor(graph, iri),
            primaryNamespace: primaryNamespace(model),
          }),
        }
      : {}),
  })

  return { executor, graph, findings, trace, requests }
}

const tome = (n: number) => ({
  '@id': `${API}/tomes/${n}`,
  '@type': 'lend:Tome',
  'lend:heading': `Tome ${n}`,
})

/** A collection served over as many pages as it takes, each linking to the next. */
function pagedStacks(total: number, pageSize: number): Record<string, Route> {
  const pages = Math.ceil(total / pageSize)
  const routes: Record<string, Route> = {}

  for (let page = 1; page <= pages; page += 1) {
    const from = (page - 1) * pageSize
    const members = Array.from({ length: Math.min(pageSize, total - from) }, (_, i) => tome(from + i + 1))
    const url = page === 1 ? `${API}/stacks` : `${API}/stacks/leaf/${page}`

    routes[url] = {
      '@context': LD_CONTEXT,
      '@id': `${API}/stacks`,
      '@type': 'Collection',
      totalItems: total,
      member: members,
      view: {
        '@id': `${API}/stacks/leaf/${page}`,
        '@type': 'PartialCollectionView',
        ...(page < pages ? { next: `${API}/stacks/leaf/${page + 1}` } : {}),
      },
    }
  }

  return routes
}

describe('locating what an operation acts on', () => {
  it('reads a collection’s IRI out of a published form-style template', async () => {
    // Task 5.1. Not `base + '/' + localName`: RFC 6570 defines expansion with nothing bound as the
    // template's literal prefix, so the template is a statement of the address rather than a pattern.
    const { executor, requests } = await harness({ routes: pagedStacks(2, 25) })

    await executor.execute("search_collection", { collection: STACKS })
    expect(requests[0]?.url).toBe(`${API}/stacks`)
  })

  it('prefers an entry point link whose declared range names the class', async () => {
    const vocab = {
      '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { lend: LEND }],
      '@id': `${API}/vocab`,
      '@type': 'ApiDocumentation',
      supportedClass: [
        {
          '@id': 'lend:Home',
          '@type': 'Class',
          supportedProperty: [
            { '@type': 'SupportedProperty', property: 'lend:everything', range: 'lend:Stacks' },
          ],
        },
        {
          '@id': 'lend:Stacks',
          '@type': 'Class',
          supportedOperation: [{ '@type': 'Operation', method: 'GET', returns: 'lend:Stacks' }],
          supportedProperty: [
            { '@type': 'SupportedProperty', property: 'hydra:member', range: 'lend:Tome' },
          ],
          // A search template also exists, and must lose: a declared range is an exact statement
          // where a template prefix is a reading of one.
          search: [
            {
              '@type': 'IriTemplate',
              template: `${API}/wrong{?q}`,
              mapping: [
                { '@type': 'IriTemplateMapping', variable: 'q', property: 'hydra:freetextQuery' },
              ],
            },
          ],
        },
      ],
    }

    const { executor, requests } = await harness({
      vocab,
      entrypoint: {
        url: `${API}/`,
        document: {
          '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { lend: LEND }],
          '@id': `${API}/`,
          'lend:everything': { '@id': `${API}/everything` },
        },
      },
      routes: {
        [`${API}/everything`]: {
          '@context': LD_CONTEXT,
          '@id': `${API}/everything`,
          '@type': 'Collection',
          member: [tome(1)],
        },
      },
    })

    await executor.execute("search_collection", { collection: STACKS })
    expect(requests[0]?.url).toBe(`${API}/everything`)
  })

  it('refuses honestly when the vocabulary never says where a class lives', async () => {
    // `lend:Roster` declares operations, publishes no template, and is named by no entry point link.
    // The one thing that must not happen is a URL derived from the class name.
    const { executor, requests } = await harness({})

    const outcome = await executor.execute("follow", { iri: ROSTER })

    expect(outcome.ok).toBe(false)
    expect(outcome.requested).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/never states the IRI it lives at/)
    expect(outcome.content).toMatch(/naming convention/)
  })

  it('keeps a request on the deployment it connected to', async () => {
    /*
     * This API publishes its query templates under a canonical origin while answering on another, so a
     * client expanding one verbatim from a local boot sends authenticated requests — writes included —
     * to a different installation. Rebased, disclosed and recorded (design D8).
     */
    const { executor, findings, requests, trace } = await harness({
      origin: 'http://localhost:9999',
      routes: {
        'http://localhost:9999/api/stacks': {
          '@context': LD_CONTEXT,
          '@id': 'http://localhost:9999/api/stacks',
          '@type': 'Collection',
          member: [tome(1)],
        },
      },
    })

    await executor.execute("search_collection", { collection: STACKS })

    expect(requests[0]?.url).toBe('http://localhost:9999/api/stacks')
    expect(findings.all().some((f) => f.kind === FINDING_KINDS.originMismatch)).toBe(true)
    expect(trace.entries.some((entry) => entry.kind === 'warn' && /different origin/.test(entry.message))).toBe(true)
  })
})

describe('traversing a collection', () => {
  it('follows hydra:next to completion, with no page ceiling', async () => {
    /*
     * Task 5.2, closing the third mismatch from 0.2. `index.html:500` stopped after ten pages and
     * returned 250 of 3,467 members as the collection. Twelve pages here is past that ceiling by
     * construction, so a reintroduced cap fails rather than passes quietly.
     */
    const { executor, graph, requests } = await harness({ routes: pagedStacks(300, 25) })

    const outcome = await executor.execute("search_collection", { collection: STACKS })

    expect(requests).toHaveLength(12)
    expect(requests.map((request) => request.url)).toEqual([
      `${API}/stacks`,
      ...Array.from({ length: 11 }, (_, i) => `${API}/stacks/leaf/${i + 2}`),
    ])
    expect(graph.completenessOf(`${API}/stacks`)).toMatchObject({ have: 300, total: 300, complete: true })
    expect(outcome.ok).toBe(true)
    expect(outcome.content).toMatch(/300 members held of 300 declared/)
  })

  it('never constructs a page URL when a collection stops linking', async () => {
    // `index.html:487` built `base + '/Page/' + n` as a fallback. Reported as a gap instead.
    const { executor, findings, requests } = await harness({
      routes: {
        [`${API}/stacks`]: {
          '@context': LD_CONTEXT,
          '@id': `${API}/stacks`,
          '@type': 'Collection',
          totalItems: 300,
          member: [tome(1)],
          view: { '@id': `${API}/stacks/leaf/1`, '@type': 'PartialCollectionView' },
        },
      },
    })

    const outcome = await executor.execute("search_collection", { collection: STACKS })

    expect(requests).toHaveLength(1)
    expect(requests.every((request) => !request.url.includes('/leaf/'))).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/NOT complete/)
    expect(findings.all().some((f) => f.kind === FINDING_KINDS.undeclaredPagination)).toBe(true)
  })

  it('proves completeness from an absent partial view, with no declared total', async () => {
    // The reference collections of the real API work exactly this way: no total, no view. Requiring a
    // declared total would refuse aggregation over them permanently.
    const { executor, graph, requests } = await harness({
      routes: {
        [`${API}/stacks`]: {
          '@context': LD_CONTEXT,
          '@id': `${API}/stacks`,
          '@type': 'Collection',
          member: [tome(1), tome(2)],
        },
      },
    })

    const outcome = await executor.execute("search_collection", { collection: STACKS })

    expect(requests).toHaveLength(1)
    expect(graph.completenessOf(`${API}/stacks`)?.complete).toBe(true)
    expect(outcome.content).toMatch(/The set is complete/)
  })

  it('expands a pagination template rather than assuming a page URL', async () => {
    const { executor, requests } = await harness({ routes: pagedStacks(300, 25) })

    // The template's variable is `leaf`, and the tool's schema is derived from it.
    await executor.execute("search_collection", { collection: STACKS, filters: { leaf: 3 } })
    expect(requests[0]?.url).toBe(`${API}/stacks/leaf/3`)
  })

  it('refuses a filter value no template declares, before any request', async () => {
    // Silently ignoring it would hand back a result that looks filtered (design D8). `nonsense` is a
    // variable no address form of this collection carries, so the schema gate catches it — the folded
    // tool's schema is the union of its templates' variables, closed to anything else, exactly as a
    // strict schema would be.
    const { executor, requests } = await harness({ routes: pagedStacks(2, 25) })

    const outcome = await executor.execute("search_collection", { collection: STACKS, filters: { anything: "dune", nonsense: "x" } })

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/declares no filter named nonsense/)
    expect(outcome.content).toMatch(/Declared filters: anything, heading, isbn, leaf/)
  })

  it('refuses a combination no single address form carries, before any request', async () => {
    // The other half of folding: `leaf` (pagination, a path segment) and `anything` (free-text, a
    // query parameter) are each declared, so the schema admits both — but they live in different
    // templates and no published form carries them together. Caught at dispatch, not by the schema,
    // and still with no request rather than a listing that looks filtered when it was not.
    const { executor, requests } = await harness({ routes: pagedStacks(2, 25) })

    const outcome = await executor.execute("search_collection", { collection: STACKS, filters: { leaf: 2, anything: "dune" } })

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/No address form this API publishes for <.*Stacks> carries/)
  })
})

describe('budgets, not caps', () => {
  it('refuses a traversal it cannot afford, and says what it would cost', async () => {
    // Task 5.3. One page is what it costs to learn the cost of the rest; nothing beyond that is spent
    // and nothing partial is presented as the whole.
    const { executor, requests } = await harness({ routes: pagedStacks(300, 25), budget: 100 })

    const outcome = await executor.execute("search_collection", { collection: STACKS })

    expect(requests).toHaveLength(1)
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/holds 300 members and the budget/)
    expect(outcome.content).toMatch(/NOT complete/)
  })

  it('refuses when the cost cannot be known in advance', async () => {
    const { executor, graph, requests } = await harness({
      routes: {
        [`${API}/stacks`]: {
          '@context': LD_CONTEXT,
          '@id': `${API}/stacks`,
          '@type': 'Collection',
          member: [tome(1)],
          // Partial, and no total: the collection says it is incomplete and will not say by how much.
          view: {
            '@id': `${API}/stacks/leaf/1`,
            '@type': 'PartialCollectionView',
            next: `${API}/stacks/leaf/2`,
          },
        },
      },
    })

    const outcome = await executor.execute("search_collection", { collection: STACKS })

    expect(requests).toHaveLength(1)
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/cost of completing it is unknown before starting/)
    expect(graph.planFor(`${API}/stacks`, { budget: 10 }).withinBudget).toBe(false)
  })
})

describe('the read policy', () => {
  const LOAN = `${API}/loans/1`
  const loanDocument = {
    '@context': LD_CONTEXT,
    '@id': LOAN,
    '@type': 'lend:Loan',
    'lend:dueOn': '2026-01-01',
    'lend:borrower': { '@id': `${API}/patrons/7` },
  }

  it('answers a repeated read from the store, and says that it did', async () => {
    const { executor, requests, trace } = await harness({
      freshForMs: 60_000,
      routes: { [LOAN]: loanDocument },
    })

    await executor.execute("follow", { iri: LOAN })
    const second = await executor.execute("follow", { iri: LOAN })

    expect(requests).toHaveLength(1)
    expect(second.requested).toBe(false)
    expect(second.content).toMatch(/held locally/)
    // Design D4: the store never silently substitutes for a fetch.
    expect(trace.entries.some((entry) => /Served <.*> from the store/.test(entry.message))).toBe(true)
  })

  it('never serves a pre-write read from the store, however fresh it is', async () => {
    /*
     * Task 5.8's first assertion, and the rule with no exception. A replacement built from a held copy
     * reverts every field another client changed since — data loss, not staleness, and the
     * read-before-write is the only concurrency control available.
     */
    const { executor, requests } = await harness({
      freshForMs: 60_000,
      routes: {
        [LOAN]: loanDocument,
        [`PUT ${LOAN}`]: (body) => ({ document: { ...JSON.parse(body ?? '{}'), '@context': LD_CONTEXT } }),
      },
    })

    await executor.execute("follow", { iri: LOAN })
    expect(executor.decideRead('value', LOAN).source).toBe('store')
    expect(executor.decideRead('pre-write', LOAN).source).toBe('origin')

    await executor.execute("invoke", { affordance: "put_Loan", input: { id: LOAN, dueOn: '2026-02-01' } })

    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'PUT'])
  })

  it('re-reads a value known only from a listing, because absence in one means nothing', async () => {
    const { executor, requests } = await harness({
      freshForMs: 60_000,
      routes: {
        ...pagedStacks(2, 25),
        [`${API}/tomes/1`]: { '@context': LD_CONTEXT, ...tome(1) },
      },
    })

    await executor.execute("search_collection", { collection: STACKS })
    expect(executor.decideRead('value', `${API}/tomes/1`).source).toBe('origin')
    // Identity is a different question, and the store answers it: an IRI does not go stale.
    expect(executor.decideRead('identity', `${API}/tomes/1`).source).toBe('store')

    await executor.execute('follow', { iri: `${API}/tomes/1` })
    expect(requests.at(-1)?.url).toBe(`${API}/tomes/1`)
  })
})

describe('reusing complete collection members', () => {
  /**
   * Design D3 / Increment B. A listing that serialises every field a dereference would is proof enough
   * to answer a later value read from the store, instead of re-dereferencing each member one by one.
   * The proof is the same member-serialisation assessment the completeness gate already trusts.
   */

  /** A single-page Stacks whose members serialise every readable field lend:Tome declares. */
  function completeStacks(count: number): Record<string, Route> {
    const members = Array.from({ length: count }, (_, i) => ({
      '@id': `${API}/tomes/${i + 1}`,
      '@type': 'lend:Tome',
      'lend:heading': `Tome ${i + 1}`,
      'lend:isbn': `978-000000000${i}`,
      'lend:shelvedOn': { '@id': `${API}/stack/${i + 1}` },
    }))
    return {
      // No hydra:view, so the collection is not partial — the single page held every member.
      [`${API}/stacks`]: {
        '@context': LD_CONTEXT,
        '@id': `${API}/stacks`,
        '@type': 'Collection',
        totalItems: count,
        member: members,
      },
    }
  }

  it('records a member-serialisation assessment when a collection is listed (task 2.2)', async () => {
    const { executor, graph } = await harness({ routes: completeStacks(2) })
    await executor.execute('search_collection', { collection: STACKS })

    const completeness = graph.completenessOf(`${API}/stacks`)
    expect(completeness?.aggregationReady).toBe(true)
    expect(completeness?.unserved).toEqual([])
  })

  it('marks a fully-serialised collection’s members complete, and leaves abbreviated ones alone (task 2.3)', async () => {
    const complete = await harness({ routes: completeStacks(2) })
    await complete.executor.execute('search_collection', { collection: STACKS })
    expect(complete.graph.provenanceOf(`${API}/tomes/1`)?.kind).toBe('member-complete')

    // pagedStacks members carry only heading — isbn and shelvedOn are unserved, so no promotion.
    const abbreviated = await harness({ routes: pagedStacks(2, 25) })
    await abbreviated.executor.execute('search_collection', { collection: STACKS })
    expect(abbreviated.graph.provenanceOf(`${API}/tomes/1`)?.kind).toBe('collection-member')
    expect(abbreviated.graph.completenessOf(`${API}/stacks`)?.aggregationReady).toBe(false)
  })

  it('serves a value read of a member-complete subject from the store, announced (task 2.4)', async () => {
    const { executor, requests, trace } = await harness({ routes: completeStacks(3) })
    await executor.execute('search_collection', { collection: STACKS })
    const afterListing = requests.length

    // decideRead now returns the store for a member-complete value read within the member window.
    expect(executor.decideRead('value', `${API}/tomes/1`).source).toBe('store')

    const outcome = await executor.execute('get_resource', { iri: `${API}/tomes/1` })
    expect(outcome.ok).toBe(true)
    expect(outcome.requested).toBe(false)
    expect(requests.length).toBe(afterListing)
    expect(trace.entries.some((entry) => /Served <.*tomes\/1> from the store/.test(entry.message))).toBe(
      true,
    )
  })

  it('still reaches the origin for a value read of an abbreviated listing’s member (task 2.4)', async () => {
    const { executor, requests } = await harness({
      routes: { ...pagedStacks(2, 25), [`${API}/tomes/1`]: { '@context': LD_CONTEXT, ...tome(1) } },
    })
    await executor.execute('search_collection', { collection: STACKS })
    const afterListing = requests.length

    expect(executor.decideRead('value', `${API}/tomes/1`).source).toBe('origin')
    const outcome = await executor.execute('get_resource', { iri: `${API}/tomes/1` })
    expect(outcome.requested).toBe(true)
    expect(requests.length).toBe(afterListing + 1)
  })

  it('never serves the pre-write read from a complete listing (task 2.5)', async () => {
    /*
     * The read-before-write invariant has no exception, complete listing or not: a replacement built
     * from a held copy reverts every field another client changed since. decideRead('pre-write') stays
     * origin, and the PUT flow still issues its own GET first.
     */
    const { executor, requests } = await harness({
      routes: {
        ...completeStacks(2),
        [`${API}/tomes/1`]: {
          '@context': LD_CONTEXT,
          '@id': `${API}/tomes/1`,
          '@type': 'lend:Tome',
          'lend:heading': 'Tome 1',
          'lend:isbn': '978-0000000000',
        },
        [`PUT ${API}/tomes/1`]: (body) => ({
          document: { ...JSON.parse(body ?? '{}'), '@context': LD_CONTEXT },
        }),
      },
    })
    await executor.execute('search_collection', { collection: STACKS })
    const afterListing = requests.length

    // The value read is served from the store, but the pre-write read is not.
    expect(executor.decideRead('value', `${API}/tomes/1`).source).toBe('store')
    expect(executor.decideRead('pre-write', `${API}/tomes/1`).source).toBe('origin')

    await executor.execute('invoke', {
      affordance: 'put_Tome',
      input: { id: `${API}/tomes/1`, heading: 'New heading' },
    })

    const afterWrite = requests.slice(afterListing).map((request) => request.method)
    expect(afterWrite).toEqual(['GET', 'PUT'])
  })

  it('lists then reads several members with zero extra requests (task 2.6)', async () => {
    const { executor, requests } = await harness({ routes: completeStacks(3) })
    await executor.execute('search_collection', { collection: STACKS })
    const afterListing = requests.length

    for (const n of [1, 2, 3]) {
      const outcome = await executor.execute('get_resource', { iri: `${API}/tomes/${n}` })
      expect(outcome.requested).toBe(false)
    }
    // Every member answered from the store: not one additional HTTP request.
    expect(requests.length).toBe(afterListing)
  })

  it('promotes members reached by follow as well as by search (task 2.4)', async () => {
    // The follow (openListing) path assesses and promotes exactly as the search (traverse) path does.
    const { executor, graph } = await harness({ routes: completeStacks(2) })
    await executor.execute('follow', { iri: STACKS })
    expect(graph.provenanceOf(`${API}/tomes/1`)?.kind).toBe('member-complete')
  })
})

describe('writing', () => {
  const TOME = `${API}/tomes/1`
  const held = {
    '@context': LD_CONTEXT,
    '@id': TOME,
    '@type': 'lend:Tome',
    'lend:heading': 'Old heading',
    'lend:isbn': '978-0000000000',
  }

  it('spells the wire keys as the served context does, never as the name the model saw', async () => {
    /*
     * Design D6: the payload is assembled from predicate IRIs, then compacted against the
     * `@context` the server itself served on the pre-write read — so whatever that context calls
     * `lend:heading` is what goes on the wire, by construction. The name the model saw never
     * reaches the server.
     */
    const { executor, requests } = await harness({
      routes: {
        [TOME]: held,
        [`PUT ${TOME}`]: (body) => ({ document: { ...JSON.parse(body ?? '{}'), '@context': LD_CONTEXT } }),
      },
    })

    await executor.execute("invoke", { affordance: "put_Tome", input: { id: TOME, heading: 'New heading' } })

    const sent = JSON.parse(requests.at(-1)?.body ?? '{}')
    // The served context compacts the predicate to its own spelling — and carries the context, so
    // the document still means the same graph.
    expect(sent['lend:heading']).toBe('New heading')
    expect(sent['@context']).toBeDefined()
    expect(sent['heading']).toBeUndefined()
  })

  it('builds a replacement from the current representation, so an untouched field survives', async () => {
    // The vocabulary's own PUT description says every writeable property not supplied is cleared. A
    // partial change therefore has to be sent as a whole representation.
    const { executor, requests } = await harness({
      routes: {
        [TOME]: held,
        [`PUT ${TOME}`]: (body) => ({ document: { ...JSON.parse(body ?? '{}'), '@context': LD_CONTEXT } }),
      },
    })

    await executor.execute("invoke", { affordance: "put_Tome", input: { id: TOME, heading: 'New heading' } })

    const sent = JSON.parse(requests.at(-1)?.body ?? '{}')
    expect(sent['lend:isbn'] ?? sent[`${LEND}isbn`]).toBe('978-0000000000')
    expect(sent['@id']).toBe(TOME)
  })

  it('reports a write the server accepted and did not persist', async () => {
    /*
     * Task 5.6. Everything else says it worked — the status is a success — so a caller left to narrate
     * from that reports a change that did not happen. This API's serialiser has dropped fields on
     * write before.
     */
    const { executor } = await harness({
      routes: {
        [TOME]: held,
        [`PUT ${TOME}`]: () => ({ document: held }),
      },
    })

    const outcome = await executor.execute("invoke", { affordance: "put_Tome", input: { id: TOME, heading: 'New heading' } })

    expect(outcome.ok).toBe(false)
    expect(outcome.content).toMatch(/does not carry what was requested/)
    expect(outcome.content).toContain(`${LEND}heading`)
    expect(outcome.content).toMatch(/server-side failure to persist/)
  })

  it('replaces what it holds from the representation the write echoed', async () => {
    const { executor, graph } = await harness({
      routes: {
        [TOME]: held,
        [`PUT ${TOME}`]: (body) => ({ document: { ...JSON.parse(body ?? '{}'), '@context': LD_CONTEXT } }),
      },
    })

    await executor.execute("invoke", { affordance: "put_Tome", input: { id: TOME, heading: 'New heading' } })

    const headings = graph
      .describe(TOME)
      .filter((quad) => quad.predicate.value === `${LEND}heading`)
      .map((quad) => quad.object.value)
    expect(headings).toEqual(['New heading'])
  })

  it('reports a declared status by its declared meaning, not as a slice of the body', async () => {
    const LOAN = `${API}/loans/1`
    const { executor } = await harness({
      routes: {
        [LOAN]: { '@context': LD_CONTEXT, '@id': LOAN, '@type': 'lend:Loan', 'lend:dueOn': '2026-01-01' },
        [`PUT ${LOAN}`]: () => ({ status: 402, text: '{"error":"nope"}' }),
      },
    })

    const outcome = await executor.execute("invoke", { affordance: "put_Loan", input: { id: LOAN, dueOn: '2026-02-01' } })

    expect(outcome.status).toBe(402)
    expect(outcome.content).toMatch(/Outstanding fines must be settled/)
    expect(outcome.content).not.toMatch(/nope/)
  })

  it('creates through the collection the operation is declared on', async () => {
    const created = `${API}/tomes/9`
    const { executor, requests } = await harness({
      routes: {
        [`POST ${API}/stacks`]: (body) => ({
          status: 201,
          document: { ...JSON.parse(body ?? '{}'), '@context': LD_CONTEXT, '@id': created },
        }),
      },
    })

    const outcome = await executor.execute("invoke", { affordance: "post_Stacks", input: { heading: 'A new tome' } })

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([`POST ${API}/stacks`])
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe(201)
    // The type comes from what the operation declares it expects, not from the tool's name.
    expect(JSON.parse(requests[0]?.body ?? '{}')['@type']).toBe(`${LEND}Tome`)
  })
})

describe('the envelope: capability arrives as content', () => {
  const TOME = `${API}/tomes/1`
  // What a conformant server serves: the resource, carrying its own operations.
  const tomeWithOperations = {
    '@context': LD_CONTEXT,
    '@id': TOME,
    '@type': 'lend:Tome',
    'lend:heading': 'Dune',
    operation: [
      { '@type': 'Operation', method: 'PUT' },
      { '@type': 'Operation', method: 'DELETE' },
    ],
  }

  it('a dereference carries the affordances of what it holds, with handles and contracts', async () => {
    const { executor } = await harness({ routes: { [TOME]: tomeWithOperations } })

    const outcome = await executor.execute('follow', { iri: TOME })

    expect(outcome.ok).toBe(true)
    expect(outcome.content).toContain('Affordances of what this result holds')
    expect(outcome.content).toContain('`put_Tome`')
    expect(outcome.content).toContain('`delete_Tome`')
    expect(outcome.content).toContain(`id: this resource's IRI — <${TOME}>`)
  })

  it('a listing teaches the filters that would have avoided it', async () => {
    const { executor } = await harness({ routes: pagedStacks(2, 25) })

    const outcome = await executor.execute('search_collection', { collection: STACKS })

    expect(outcome.content).toContain('filterable by')
    expect(outcome.content).toContain('search_collection')
    for (const variable of ['anything', 'heading', 'isbn']) {
      expect(outcome.content).toContain(variable)
    }
    // The pagination variable is a control, not a filter — accepted by dispatch, never advertised.
    expect(outcome.content).not.toMatch(/filterable by[^\n]*\bleaf\b/)
  })

  it('refuses an unknown handle before the wire, naming what was actually surfaced', async () => {
    const { executor, requests } = await harness({ routes: { [TOME]: tomeWithOperations } })

    // A guess that embeds a declared class's name is answered from the registry — a wrong handle
    // costs one turn, not a discovery walk (the live 2026-08-02 flail). Still not a registry dump:
    // only the class the guess itself named.
    const early = await executor.execute('invoke', { affordance: 'replace_Tome', input: {} })
    expect(early.ok).toBe(false)
    expect(early.requested).toBe(false)
    expect(early.content).toMatch(/Nearest by name/)
    expect(early.content).toMatch(/delete_Tome, get_Tome, put_Tome/)

    await executor.execute('follow', { iri: TOME })
    const requestsBefore = requests.length

    // A guess embedding no declared class falls back to what this conversation actually surfaced.
    const outcome = await executor.execute('invoke', { affordance: 'update_record', input: {} })
    expect(outcome.ok).toBe(false)
    expect(outcome.requested).toBe(false)
    expect(requests).toHaveLength(requestsBefore)
    expect(outcome.content).toMatch(/Handles surfaced so far: delete_Tome, put_Tome/)
  })

  it('a follow that lands on an undeclared collection still renders as a listing', async () => {
    // Runtime-discovered collections ride the same renderer: nothing about this URL is in the
    // vocabulary, and the member listing is still the honest rendering.
    const CURATED = `${API}/curated/new-arrivals`
    const { executor } = await harness({
      routes: {
        [CURATED]: {
          '@context': LD_CONTEXT,
          '@id': CURATED,
          '@type': 'Collection',
          member: [tome(1), tome(2)],
        },
      },
    })

    const outcome = await executor.execute('follow', { iri: CURATED })

    expect(outcome.ok).toBe(true)
    // One page, and for a collection served whole in one page that is also the complete set.
    expect(outcome.content).toMatch(/one page held — 2 members\. The set is complete\./)
  })

  it('refuses an incomplete invoke with the full contract, costing no request', async () => {
    // The live failure this pins: the model materialised 3,477 contacts across 140 pages to learn
    // a POST contract. The cheap route is an invoke — its refusal carries the whole contract.
    const { executor, requests } = await harness({
      vocab: (await import('./fixtures/mago-vocab.json')).default,
      shapes: (await import('./fixtures/mago-shapes.json')).default,
      origin: 'https://example.test',
    })

    const outcome = await executor.execute('invoke', {
      affordance: 'post_ContactCollection',
      input: { givenName: 'Ada' },
    })

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/familyName is required/)
    expect(outcome.content).toMatch(/The full contract for `post_ContactCollection`/)
    expect(outcome.content).toMatch(/familyName/)
    expect(outcome.content).toMatch(/givenName/)
  })

  it('suggests the session-origin spelling for a mistyped host', async () => {
    // The live flail: the model regenerated `localhost.1648` (dot for colon) for eight rounds. The
    // refusal now carries the copyable correction.
    const { executor, requests } = await harness({})

    const outcome = await executor.execute('follow', {
      iri: 'https://lending.exmaple/api/tomes/1',
    })

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toContain('Did you mean <https://lending.example/api/tomes/1>?')
  })

  it('reports an operation whose method the served context dropped, instead of hiding it', async () => {
    // The live Contact listing declares POST, but the served context maps neither `method` nor a
    // @vocab, so expansion drops the key and the operation arrives verb-less. Silence here is how
    // a model concludes a declared capability does not exist.
    const CURATED = `${API}/curated/verbless`
    const { executor, findings } = await harness({
      routes: {
        [CURATED]: {
          '@context': LD_CONTEXT,
          '@id': CURATED,
          '@type': 'Collection',
          member: [tome(1)],
          operation: [{ '@type': 'Operation', title: 'Create a new member' }],
        },
      },
    })

    const outcome = await executor.execute('follow', { iri: CURATED })

    expect(outcome.content).toMatch(/declared operations could not be read/)
    expect(outcome.content).toMatch(/conformance finding/)
    expect(findings.all().some((f) => f.kind === FINDING_KINDS.unprojectableOperation)).toBe(true)
  })

  it('accepts an IRI exactly as its own renderings spell one — wrapped and punctuated', async () => {
    /*
     * Results and refusals render IRIs as <http://…> and handles as `name`. A model that copies
     * what it was shown supplies the wrapping too; refusing that punishes careful reading, and the
     * live session it burned looked like a hang while the model regenerated ever-worse spellings.
     */
    const { executor, requests, trace } = await harness({ routes: { [TOME]: tomeWithOperations } })

    const followed = await executor.execute('follow', { iri: `<${TOME}>` })
    expect(followed.ok).toBe(true)
    expect(requests.at(-1)?.url).toBe(TOME)

    // A backticked handle resolves too — proven by the refusal carrying that handle's contract.
    const refused = await executor.execute('invoke', { affordance: '`put_Tome`', input: {} })
    expect(refused.content).toMatch(/The full contract for `put_Tome`/)

    // And the refusal is in the trace: a turn of refused calls must never read as a hang.
    expect(trace.entries.some((entry) => /^Refused — /.test(entry.message))).toBe(true)
  })

  it('a resource whose declared operations are garbled still offers its type’s handles', async () => {
    /*
     * The live create→update failure: the created contact came back with GET/PUT/DELETE declared,
     * but the served context drops the method key, so the footer showed only the conformance note
     * and the model rightly concluded no update was published. The response declared operations —
     * only their verbs are unreadable — so the vocabulary's declarations for the resource's own
     * type stand in, labelled as such.
     */
    const { executor } = await harness({
      routes: {
        [TOME]: {
          '@context': LD_CONTEXT,
          '@id': TOME,
          '@type': 'lend:Tome',
          'lend:heading': 'Dune',
          operation: [{ '@type': 'Operation', title: 'garbled by the context' }],
        },
      },
    })

    const outcome = await executor.execute('follow', { iri: TOME })

    expect(outcome.content).toMatch(/declared operations could not be read/)
    expect(outcome.content).toMatch(/From the vocabulary's declarations for this resource's type/)
    expect(outcome.content).toContain('`put_Tome`')
    expect(outcome.content).toContain('`delete_Tome`')

    // And the surfaced handles resolve: the update dispatches from here with no further discovery.
    const refused = await executor.execute('invoke', { affordance: 'patch_Tome', input: { id: TOME } })
    expect(refused.content).toMatch(/the declared handles are: delete_Tome, get_Tome, put_Tome/)
  })

  it('returns a 500 mid-traversal as an outcome, never as an exception', async () => {
    /*
     * The live failure this pins: the Azure-backed search route 500s on a local boot, materialise
     * threw, the exception escaped the executor, and the model's tool_use was left unanswered —
     * which the API rejects on that request and every request after it. A failed request is a
     * result.
     */
    const url = `${API}/stacks?anything=dune`
    const { executor } = await harness({
      routes: { [url]: () => ({ status: 500, text: '{"error":"search backend down"}' }) },
    })

    const outcome = await executor.execute('search_collection', {
      collection: STACKS,
      filters: { anything: 'dune' },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.requested).toBe(true)
    expect(outcome.status).toBe(500)
    expect(outcome.content).toMatch(/HTTP 500/)
    expect(outcome.content).toMatch(/try a different published route|different route/i)
  })

  it('rejects a name that is not on the envelope, naming the envelope', async () => {
    const { executor, requests } = await harness({})

    const outcome = await executor.execute('get_Tome', { id: TOME })

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/follow, search_collection, get_resource, invoke/)
  })

  it('accepts a collection in the compact spelling the map itself renders (live 2026-08-02)', async () => {
    /*
     * The live trace this pins: the map renders collections compactly (`ns:ContactCollection`),
     * the model copied that spelling into search_collection, and intake refused it as undeclared —
     * the model even remarked that "other collections in the list appear to use the same prefix
     * notation". A page whose own renderings are not acceptable as inputs is the angle-bracket
     * defect again, one layer up.
     */
    const { executor, requests } = await harness({ routes: pagedStacks(3, 25), prefixes: true })

    const outcome = await executor.execute('search_collection', { collection: 'ns:Stacks' })

    expect(outcome.ok).toBe(true)
    expect(requests.map((request) => request.url)).toContain(`${API}/stacks`)
  })

  it('follows a compact collection reference to its listing', async () => {
    const { executor, requests } = await harness({ routes: pagedStacks(3, 25), prefixes: true })

    const outcome = await executor.execute('follow', { iri: 'ns:Stacks' })

    expect(outcome.ok).toBe(true)
    expect(requests.map((request) => request.url)).toContain(`${API}/stacks`)
  })

  it('follow opens one page of a large collection; holding the set stays a deliberate call', async () => {
    /*
     * Measured 2026-08-02, twice in one evening: a model that chose to "look at" a 3,476-member
     * collection before acting paid a 140-request walk for an affordance block the map already
     * carried. Follow is navigation — a browser opens a page, it does not download the set — so
     * one request, the partiality stated against the declared total, and the deliberate call
     * taught. search_collection keeps traversal-to-completion (pinned above); the query path
     * keeps its completeness gate. Completeness lives where completeness is claimed.
     */
    const { executor, requests } = await harness({ routes: pagedStacks(300, 25), prefixes: true })

    const outcome = await executor.execute('follow', { iri: 'ns:Stacks' })

    expect(outcome.ok).toBe(true)
    expect(requests).toHaveLength(1)
    expect(outcome.content).toMatch(/NOT complete — this was navigation, not retrieval/)
    expect(outcome.content).toMatch(/of 300 declared/)
    expect(outcome.content).toMatch(/search_collection/)

    // And the same collection, asked for deliberately, is still held in full.
    const retrieved = await executor.execute('search_collection', { collection: 'ns:Stacks' })
    expect(retrieved.ok).toBe(true)
    expect(retrieved.content).toMatch(/300 members held of 300 declared/)
  })

  it('leaves a compact name unexpanded when no table was supplied', async () => {
    // Absent the option nothing changes: the compact form is refused as undeclared, as before.
    const { executor, requests } = await harness({ routes: pagedStacks(3, 25) })

    const outcome = await executor.execute('search_collection', { collection: 'ns:Stacks' })

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
  })

  it('answers a guessed handle with the declared handles of the class it embeds (live 2026-08-02)', async () => {
    /*
     * The live trace this pins: the model invoked "ns:ContactCollection.create" — no such handle —
     * and the refusal pointed at the collection index, which the model did not reconsult; it spent
     * seven more calls (and a full materialisation) rediscovering what the registry knew at
     * connect. The registry is complete at connect, so a guess that embeds a declared class's name
     * is answered with that class's actual handles.
     */
    const { executor, requests } = await harness({ prefixes: true })

    const outcome = await executor.execute('invoke', { affordance: 'ns:Stacks.create', input: {} })

    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toContain('Nearest by name')
    expect(outcome.content).toContain(`<${STACKS}> declares:`)
    expect(outcome.content).toContain('post_Stacks')
  })
})

describe('routing the motivating failure: upcoming booked gigs (live 2026-08-01)', () => {
  /**
   * The live trace this pins: the model asked for status + a date window — exactly the published
   * `/Status/{status}/ByDate/From/{fromDate}/To/{toDate}/Page/{page}` form — and dispatch refused
   * it because `{page}` was unsupplied. The fallback then hit the Azure-backed query endpoint,
   * which the local environment cannot serve. The published path form was one correct dispatch
   * away the whole time.
   *
   * Pipeline status is filtered through the `/Api/Event/Status/{status}` named views, whose variable
   * is `status`. There is no query-string `eventStatus` filter — it was removed from the Event search
   * registry — so `status` is the single name the client offers for filtering Event by pipeline
   * status.
   */
  const EVENTS = 'https://mago.co/ns#EventCollection'
  const ORIGIN = 'https://example.test'

  const listing = (url: string) => ({
    '@context': 'http://www.w3.org/ns/hydra/context.jsonld',
    '@id': url,
    '@type': 'Collection',
    member: [],
  })

  async function magoEvents(routes: Record<string, Route>) {
    return harness({ vocab: magoVocab, shapes: magoShapes, origin: ORIGIN, routes })
  }

  it('routes a status and date window to the path form that names them', async () => {
    // The vocabulary declares the page-less forms too, so the exact ask needs no page at all.
    const url = `${ORIGIN}/Api/Event/Status/BookedGig/ByDate/From/2026-08-01/To/2027-08-01`
    const { executor, requests } = await magoEvents({ [url]: listing(url) })

    const outcome = await executor.execute('search_collection', {
      collection: EVENTS,
      filters: { status: 'BookedGig', fromDate: '2026-08-01', toDate: '2027-08-01' },
    })

    // `status` and the date window are carried by a single published path form, so one dispatch
    // reaches it — no fallback to the Azure-backed query endpoint the local environment cannot serve.
    expect(requests.map((request) => request.url)).toEqual([url])
    expect(outcome.requested).toBe(true)
    // And the listing's footer carries the API's own prose about the variables — the declared
    // lexical form included, so the model never has to invent one.
    expect(outcome.content).toContain('yyyy-MM-dd')
  })

  it('refuses a value that cannot travel in a path segment, quoting the declared form', async () => {
    // The second live run sent dateTimes into the date-window path segments — colons in a path,
    // which the server's request validation rejects with a 400 every time. The refusal quotes the
    // mapping's own rdfs:comment, which is where "yyyy-MM-dd" was declared all along.
    const { executor, requests } = await magoEvents({})

    const outcome = await executor.execute('search_collection', {
      collection: EVENTS,
      filters: {
        status: 'BookedGig',
        fromDate: '2026-08-02T00:00:00Z',
        toDate: '2030-12-31T00:00:00Z',
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.requested).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/cannot travel in the \{fromDate\} path segment/)
    expect(outcome.content).toContain('yyyy-MM-dd')
    expect(outcome.content).toMatch(/sparql/)
  })

  it('routes a supplied page to the paged form of the same combination', async () => {
    const url = `${ORIGIN}/Api/Event/Status/BookedGig/Page/2`
    const { executor, requests } = await magoEvents({ [url]: listing(url) })

    await executor.execute('search_collection', {
      collection: EVENTS,
      filters: { status: 'BookedGig', page: 2 },
    })

    expect(requests.map((request) => request.url)).toEqual([url])
  })

  it('expands an enum IRI value as its shared key, never an IRI inside an IRI', async () => {
    const url = `${ORIGIN}/Api/Event/Status/BookedGig`
    const { executor, requests } = await magoEvents({ [url]: listing(url) })

    await executor.execute('search_collection', {
      collection: EVENTS,
      filters: { status: 'https://mago.co/ns#BookedGig' },
    })

    // The fragment is the key the vocabulary and the route share; embedding the full IRI in the
    // request IRI is never the published pattern (and real servers 400 it in a path segment).
    expect(requests.map((request) => request.url)).toEqual([url])
    expect(requests[0]?.url).not.toMatch(/%3A|%2F/)
  })

  it('still refuses a combination no address form carries, even through translation', async () => {
    const { executor, requests } = await magoEvents({})

    const outcome = await executor.execute('search_collection', {
      collection: EVENTS,
      filters: { q: 'gala', fromDate: '2026-08-01' },
    })

    // Free text lives in the query form, the date window in the path forms; no single form
    // carries both predicates, and translation must not manufacture one.
    expect(outcome.ok).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/No address form this API publishes/)
  })
})

describe('preferring an exact-filter form over a freetext one', () => {
  /*
   * A `hydra:freetextQuery` form advertises analyzer-based, relevance-ranked matching; an exact-filter
   * form binds each variable to a concrete predicate. A structured filter — a role to match, not a
   * phrase to rank — belongs on the exact-filter form. Dispatch ranks a freetext form last among the
   * forms that all satisfy the request, and the signal is `hydra:freetextQuery` itself, so the
   * preference is a reading of the advertised vocabulary rather than a rule about any one API.
   *
   * Against Mago the named status route already wins on fewest-variables, so this isolates the tie-break
   * on its own terms: two query forms binding the same predicate, tied on hostility (both query-only)
   * and on variable count (two each), where the older comparator fell through to the template string and
   * — because `find` sorts before `roleFilter` — chose the freetext form. The kind tie-break now decides
   * it first.
   */
  const vocab = {
    '@context': LD_CONTEXT,
    '@id': `${API}/vocab`,
    '@type': 'ApiDocumentation',
    supportedClass: [
      {
        '@id': 'lend:Roster',
        '@type': 'Class',
        supportedOperation: [{ '@type': 'Operation', method: 'GET', returns: 'lend:Roster' }],
        supportedProperty: [{ '@type': 'SupportedProperty', property: 'hydra:member', range: 'lend:Patron' }],
        search: [
          {
            '@type': 'IriTemplate',
            // Freetext form: sorts first by template string ('find' < 'roleFilter'), so the older
            // comparator's final tie-break would have chosen it.
            template: `${API}/roster{?find,role}`,
            mapping: [
              { '@type': 'IriTemplateMapping', variable: 'find', property: 'hydra:freetextQuery' },
              { '@type': 'IriTemplateMapping', variable: 'role', property: 'lend:role' },
            ],
          },
          {
            '@type': 'IriTemplate',
            // Exact-filter form: binds the same predicate under a different name, so a supplied `role`
            // reaches it by predicate translation, not by spelling.
            template: `${API}/roster{?roleFilter,extra}`,
            mapping: [
              { '@type': 'IriTemplateMapping', variable: 'roleFilter', property: 'lend:role' },
              { '@type': 'IriTemplateMapping', variable: 'extra', property: 'lend:extra' },
            ],
          },
        ],
      },
    ],
  }

  it('routes a structured filter to the exact-filter form, not the freetext one', async () => {
    const filtered = `${API}/roster?roleFilter=Editor`
    const { executor, requests } = await harness({
      vocab,
      routes: {
        [filtered]: {
          '@context': LD_CONTEXT,
          '@id': filtered,
          '@type': 'Collection',
          member: [],
        },
      },
    })

    const outcome = await executor.execute('search_collection', {
      collection: ROSTER,
      filters: { role: 'Editor' },
    })

    // The exact-filter form carried `role` (as `roleFilter`, by predicate). The freetext form, which
    // fits the request just as well and would have won the template-string tie-break, is not chosen.
    expect(requests.map((request) => request.url)).toEqual([filtered])
    expect(requests[0]?.url).not.toContain('?role=')
    expect(outcome.requested).toBe(true)
  })
})

describe('the constraint gate', () => {
  it('escalates a link the vocabulary cannot resolve, and issues no request', async () => {
    /*
     * Task 5.7 and the spec's "an unresolvable reference does not end the task". `lend:guarantor` is
     * the fixture's deliberate gap: a Link with no declared range. The proof of concept omitted such a
     * field with a warning (`index.html:608`) and the caller's request quietly did not happen.
     */
    const LOAN = `${API}/loans/1`
    const { executor, findings, requests } = await harness({ routes: {} })

    const outcome = await executor.execute("invoke", { affordance: "put_Loan", input: {
      id: LOAN,
      dueOn: '2026-02-01',
      guarantor: 'https://lending.example/api/patrons/3',
    } })

    expect(outcome.ok).toBe(false)
    expect(outcome.requested).toBe(false)
    expect(requests).toHaveLength(0)
    expect(outcome.content).toMatch(/was not dropped/)
    expect(outcome.content).toMatch(/Routes that remain/)
    expect(findings.all().some((f) => f.kind === FINDING_KINDS.undeclaredLinkRange)).toBe(true)
  })

  it('puts its findings in the store, where they are exportable as a report', async () => {
    const { executor, graph } = await harness({ routes: {} })

    await executor.execute("invoke", { affordance: "put_Loan", input: {
      id: `${API}/loans/1`,
      guarantor: 'https://lending.example/api/patrons/3',
    } })

    expect(graph.match(null, null, null, GRAPHS.findings).length).toBeGreaterThan(0)
  })

  describe('against constraints the real API publishes', () => {
    const CALL = 'https://example.test/Api/Call/Id/1'

    async function magoHarness(routes: Record<string, Route> = {}) {
      return harness({
        vocab: magoVocab,
        shapes: magoShapes,
        origin: 'https://example.test',
        routes,
      })
    }

    it('refuses a value that breaks a published pattern, and issues no request', async () => {
      // `sh:pattern` is gate-enforced rather than schema-enforced while task 3.4 is open, so this is
      // the only thing standing between the value and the wire.
      const { executor, requests } = await magoHarness()

      const outcome = await executor.execute("invoke", { affordance: "put_Call", input: { id: CALL, duration: '45 minutes' } })

      expect(outcome.ok).toBe(false)
      expect(outcome.requested).toBe(false)
      expect(requests).toHaveLength(0)
      expect(outcome.content).toMatch(/must match/)
      expect(outcome.content).toMatch(/No request was issued/)
    })

    it('lets a value that satisfies the same pattern through', async () => {
      const { executor, requests } = await magoHarness({
        [CALL]: { '@context': 'http://www.w3.org/ns/hydra/context.jsonld', '@id': CALL },
        [`PUT ${CALL}`]: (body) => ({ document: JSON.parse(body ?? '{}') }),
      })

      await executor.execute("invoke", { affordance: "put_Call", input: { id: CALL, duration: 'PT45M' } })

      // A gate that refused everything would pass the test above for the wrong reason.
      expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT'])
    })

    it('checks a constraint on a nested object, which the schema could not carry either', async () => {
      /*
       * `schema:postalCode` inside a company's billing address publishes `sh:maxLength 20`. Nested
       * residue was being computed and discarded before this stage needed it, so the constraint was
       * enforced in neither the schema nor the gate — published, and checked nowhere.
       */
      const COMPANY = 'https://example.test/Api/Company/Id/1'
      const { executor, requests } = await magoHarness()

      const outcome = await executor.execute("invoke", { affordance: "put_Company", input: {
        id: COMPANY,
        billingAddress: { postalCode: 'X'.repeat(40) },
      } })

      expect(outcome.ok).toBe(false)
      expect(requests).toHaveLength(0)
      expect(outcome.content).toMatch(/billingAddress\.postalCode/)
      expect(outcome.content).toMatch(/at most 20 characters/)
    })

    it('discloses a constraint it could not evaluate rather than counting it as met', async () => {
      // `sh:class` needs the referenced resource's type, and nothing is held about this one. Reporting
      // "checked" for a check that did not happen would be worth less than no gate at all.
      const COMPANY = 'https://example.test/Api/Company/Id/1'
      const { executor, trace } = await magoHarness({
        [COMPANY]: { '@context': 'http://www.w3.org/ns/hydra/context.jsonld', '@id': COMPANY },
        [`PUT ${COMPANY}`]: (body) => ({ document: JSON.parse(body ?? '{}') }),
      })

      await executor.execute("invoke", { affordance: "put_Company", input: {
        id: COMPANY,
        companyType: 'https://example.test/Api/CompanyType/Id/9',
      } })

      expect(
        trace.entries.some((entry) => /Not checked before dispatch — companyType/.test(entry.message)),
      ).toBe(true)
    })

    it('finds every template variable bound to a property', async () => {
      /*
       * This assertion has flipped twice, and the history is the point.
       *
       * The gate was built against a vocabulary that published its mappings under the compact key
       * `hydra:property`, which inherits none of the `@type: @vocab` carried by the Hydra term
       * `property`. Every mapping therefore bound to a *literal* — `"hydra:pageIndex"` rather than the
       * IRI — so nothing connected a variable to what it filtered or to the constraints published for
       * it. This test pinned that as conformance finding C5, and asserted the finding was raised.
       *
       * The server fixed 49 of the 50 mappings, and for a while this test pinned the survivor: the
       * entry point's user-lookup template bound `userId` to `"@id"` — a JSON-LD keyword, which
       * `@vocab` expansion drops — deliberately on the server, but deliberate is still unbound to a
       * client: nothing connected that variable to a property, so the template could not be
       * classified and no published constraint reached its value.
       *
       * The server then closed that too: `userId` now binds to `schema:identifier`, the GUID the
       * User also emits as `identifier`. So the count is zero, and zero is now load-bearing — any
       * finding appearing here fails the suite and gets read rather than absorbed.
       */
      const { findings } = await magoHarness()

      expect(findings.all().filter((f) => f.kind === FINDING_KINDS.unboundTemplateVariable)).toEqual([])
    })
  })

  describe('the gate is the validator for invoke payloads', () => {
    // `invoke.input` is an open object — per-affordance contracts cannot live in a strict schema —
    // so the gate is the only thing between a malformed payload and the wire, on every call. Each
    // of these is a call the retained per-affordance schema forbids — refused here, before any
    // request, exactly as a strict schema would have refused it.
    const CONTACT = 'https://example.test/Api/Contact/Id/1'

    async function magoGate(routes: Record<string, Route> = {}) {
      return harness({ vocab: magoVocab, shapes: magoShapes, origin: 'https://example.test', routes })
    }

    it('refuses a value outside a declared enum, and issues no request', async () => {
      const { executor, requests } = await magoGate()

      const outcome = await executor.execute("invoke", { affordance: "put_Contact", input: {
        id: CONTACT,
        gdprConsentType: 'https://mago.co/ns#NotAConsentBasis',
      } })

      expect(outcome.ok).toBe(false)
      expect(requests).toHaveLength(0)
      expect(outcome.content).toMatch(/must be one of/)
    })

    it('refuses a property the schema does not declare, and issues no request', async () => {
      const { executor, requests } = await magoGate()

      const outcome = await executor.execute("invoke", { affordance: "put_Contact", input: { id: CONTACT, nonsense: 'x' } })

      expect(outcome.ok).toBe(false)
      expect(requests).toHaveLength(0)
      expect(outcome.content).toMatch(/nonsense is not a declared property/)
    })

    it('refuses a create missing a required field, and issues no request', async () => {
      // A create has no current representation to merge from, so a mandatory field is genuinely
      // required of the model — `familyName` is `sh:minCount 1` on Contact.
      const { executor, requests } = await magoGate()

      const outcome = await executor.execute("invoke", { affordance: "post_ContactCollection", input: { givenName: 'Ada' } })

      expect(outcome.ok).toBe(false)
      expect(requests).toHaveLength(0)
      expect(outcome.content).toMatch(/familyName is required/)
    })

    it('does not require of a replace what it requires of a create, because the pre-write read carries it', async () => {
      // The heart of the GET/PUT logic. `familyName` is mandatory on Contact, and the create above was
      // refused without it — but a PUT is a full replace assembled from a pre-write read with the
      // model's change overlaid, so the model need not restate a field it is not changing. The read
      // carries `familyName` forward; nothing is cleared, and the request goes out.
      const held = {
        '@context': 'http://www.w3.org/ns/hydra/context.jsonld',
        '@id': CONTACT,
        '@type': 'https://mago.co/ns#Contact',
        'http://schema.org/familyName': 'Lovelace',
        'http://schema.org/givenName': 'Ada',
      }
      const { executor, requests } = await magoGate({
        [CONTACT]: held,
        [`PUT ${CONTACT}`]: (body) => ({ document: JSON.parse(body ?? '{}') }),
      })

      await executor.execute("invoke", { affordance: "put_Contact", input: {
        id: CONTACT,
        gdprConsentType: 'https://mago.co/ns#GDPRLegitimateInterest',
      } })

      // GET first (the pre-write read), then the PUT — and the replacement carries `familyName` though
      // the model never mentioned it, which is the property a naive delta-PUT would have cleared.
      expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT'])
      expect(requests.find((request) => request.method === 'PUT')?.body).toContain('Lovelace')
    })
  })
})
