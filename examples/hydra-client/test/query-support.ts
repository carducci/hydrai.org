import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings, type Findings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { projectTools } from '../src/project/tools'
import { createQueryRunner, type QueryRunner } from '../src/query/engine'
import { createTrace, type Trace } from '../src/trace'
import { buildCapabilityModel, constraintsFor, constraintsOfShape } from '../src/vocab/capability'

import libraryVocab from './fixtures/library-vocab.json'

/**
 * Shared setup for the stage-7 suites.
 *
 * Split out because the query tests are split, and the split is not cosmetic: everything that can be
 * decided without executing a query lives in `query.test.ts` and runs in milliseconds, while
 * `query-local.test.ts` pays Comunica's start-up once. Keeping one harness means the two halves are
 * demonstrably testing the same client.
 *
 * Not named `*.test.ts`, so the runner does not collect it as a suite.
 */

export const LEND = 'https://lending.example/ns#'
export const API = 'https://lending.example/api'
export const LD_CONTEXT = ['http://www.w3.org/ns/hydra/context.jsonld', { lend: LEND }]

export const PREFIXES = `PREFIX lend: <${LEND}>
PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>`

export interface Recorded {
  readonly method: string
  readonly url: string
  /**
   * The request body.
   *
   * Carried because the sync gate and the model's own query POST to the *same* endpoint URL, so a
   * count of requests cannot tell them apart — and "the query never ran" is exactly what a refusal
   * has to be able to prove.
   */
  readonly body: string | null
}

export type Route =
  | Record<string, unknown>
  | ((body: string | null) => { status?: number; document?: unknown; text?: string })

function server(routes: Record<string, Route>) {
  const requests: Recorded[] = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ method, url, body: (init?.body as string | undefined) ?? null })

    const route = routes[`${method} ${url}`] ?? routes[url]
    if (route === undefined) return new Response(`no route for ${method} ${url}`, { status: 404 })

    const reply =
      typeof route === 'function' ? route((init?.body as string | undefined) ?? null) : { document: route }

    if (reply.text !== undefined) {
      return new Response(reply.text, {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      })
    }
    return new Response(JSON.stringify(reply.document ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/ld+json' },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, requests }
}

export interface Harness {
  readonly runner: QueryRunner
  readonly graph: SessionGraph
  readonly findings: Findings
  readonly trace: Trace
  readonly requests: readonly Recorded[]
}

export async function harness(
  options: {
    vocab?: unknown
    routes?: Record<string, Route>
    sparqlEndpoint?: string
    budget?: number
  } = {},
): Promise<Harness> {
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

  const model = buildCapabilityModel(graph)
  const surface = projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings,
  })

  const runner = createQueryRunner({
    graph,
    model,
    http: createHttpClient({ fetchImpl }),
    contexts,
    findings,
    trace,
    constraintsFor: (iri) => constraintsFor(graph, iri),
    origin: API,
    entrypoint: null,
    sparqlEndpoint: options.sparqlEndpoint ?? null,
    prefixes: new Map([['lend', LEND]]),
    surface,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  })

  return { runner, graph, findings, trace, requests }
}

export const tome = (n: number, extra: Record<string, unknown> = {}) => ({
  '@id': `${API}/tomes/${n}`,
  '@type': 'lend:Tome',
  'lend:heading': `Tome ${n}`,
  'lend:isbn': null,
  'lend:shelvedOn': null,
  ...extra,
})

/** A collection served over as many pages as it takes, each linking to the next. */
export function pagedStacks(
  total: number,
  pageSize: number,
  member: (n: number) => Record<string, unknown> = tome,
): Record<string, Route> {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const routes: Record<string, Route> = {}

  for (let page = 1; page <= pages; page += 1) {
    const from = (page - 1) * pageSize
    const members = Array.from({ length: Math.min(pageSize, total - from) }, (_, i) => member(from + i + 1))
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

/**
 * A vocabulary with a numeric field, because `library-vocab.json` has none and a `SUM` needs one.
 *
 * Built the same way as the fixture: a collection, a member class, and the `hydra:member` range that
 * associates them. Nothing here is a shortcut for the client — it reads this exactly as it reads any
 * other vocabulary, and the form-style template is the only statement of where the collection lives.
 */
export const finesVocab = {
  '@context': LD_CONTEXT,
  '@id': `${API}/vocab`,
  '@type': 'ApiDocumentation',
  supportedClass: [
    {
      '@id': 'lend:Fine',
      '@type': 'Class',
      supportedProperty: [
        { '@type': 'SupportedProperty', property: 'lend:amount', readable: true, writeable: false },
        { '@type': 'SupportedProperty', property: 'lend:waived', readable: true, writeable: false },
      ],
      supportedOperation: [{ '@type': 'Operation', method: 'GET' }],
    },
    {
      '@id': 'lend:Fines',
      '@type': 'Class',
      supportedProperty: [
        { '@type': 'SupportedProperty', property: 'hydra:member', range: 'lend:Fine', readable: true },
      ],
      supportedOperation: [{ '@type': 'Operation', method: 'GET' }],
      search: {
        '@type': 'IriTemplate',
        template: `${API}/stacks{?anything}`,
        mapping: [{ '@type': 'IriTemplateMapping', variable: 'anything', property: 'lend:amount' }],
      },
    },
  ],
}

export const fine = (n: number, extra: Record<string, unknown> = {}) => ({
  '@id': `${API}/fines/${n}`,
  '@type': 'lend:Fine',
  'lend:amount': n,
  'lend:waived': null,
  ...extra,
})

/**
 * A vocabulary whose collection publishes a **status path view** alongside its plain listing, for
 * filter pushdown (design D1). `lend:status` is an enum-valued Link, and the collection declares both
 * a query form (its base) and `…/gigs/status/{status}` — the covering view an equality on the status
 * pushes into. `knownStatus` declares the enum individuals so the term gate accepts them in a query.
 */
export const gigsVocab = {
  '@context': LD_CONTEXT,
  '@id': `${API}/vocab`,
  '@type': 'ApiDocumentation',
  'lend:knownStatus': [{ '@id': 'lend:BookedGig' }, { '@id': 'lend:PastGig' }],
  supportedClass: [
    {
      '@id': 'lend:Gig',
      '@type': 'Class',
      supportedProperty: [
        { '@type': 'SupportedProperty', property: 'lend:fee', readable: true, writeable: false },
        { '@type': 'SupportedProperty', property: 'lend:label', readable: true, writeable: false },
        {
          '@type': 'SupportedProperty',
          property: { '@id': 'lend:status', '@type': 'Link' },
          range: 'lend:GigStatus',
          readable: true,
          writeable: false,
        },
      ],
      supportedOperation: [{ '@type': 'Operation', method: 'GET' }],
    },
    {
      '@id': 'lend:Gigs',
      '@type': 'Class',
      supportedProperty: [
        { '@type': 'SupportedProperty', property: 'hydra:member', range: 'lend:Gig', readable: true },
      ],
      supportedOperation: [{ '@type': 'Operation', method: 'GET' }],
      search: [
        {
          '@type': 'IriTemplate',
          template: `${API}/gigs{?fee,label}`,
          mapping: [
            { '@type': 'IriTemplateMapping', variable: 'fee', property: 'lend:fee' },
            { '@type': 'IriTemplateMapping', variable: 'label', property: 'lend:label' },
          ],
        },
        {
          '@type': 'IriTemplate',
          template: `${API}/gigs/status/{status}`,
          mapping: [{ '@type': 'IriTemplateMapping', variable: 'status', property: 'lend:status' }],
        },
      ],
    },
  ],
}

export const gig = (feeAndId: number, status: string, extra: Record<string, unknown> = {}) => ({
  '@id': `${API}/gigs/${feeAndId}`,
  '@type': 'lend:Gig',
  'lend:fee': feeAndId,
  'lend:label': `Gig ${feeAndId}`,
  'lend:status': { '@id': `lend:${status}` },
  ...extra,
})

/** A complete single-page gig collection (no partial view, so it is provably whole). */
export function gigCollection(id: string, members: Record<string, unknown>[]): Record<string, unknown> {
  return {
    '@context': LD_CONTEXT,
    '@id': id,
    '@type': 'Collection',
    totalItems: members.length,
    member: members,
  }
}
