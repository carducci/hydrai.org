import { DataFactory } from 'n3'
import { beforeAll, describe, expect, it } from 'vitest'

import { createExecutor } from '../src/execute/dispatch'
import { deriveFrame } from '../src/execute/frame'
import { verifyEchoGraph } from '../src/execute/payload'
import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS, NS } from '../src/rdf/terms'
import { projectTools, type ToolSurface } from '../src/project/tools'
import { buildPayload } from '../src/execute/payload'
import { createTrace } from '../src/trace'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  type CapabilityModel,
} from '../src/vocab/capability'

import magoShapes from './fixtures/mago-shapes.json'
import magoVocab from './fixtures/mago-vocab.json'

const { namedNode, literal, blankNode, quad } = DataFactory

/**
 * The framing write path (design D6, tasks 5.1-5.4).
 *
 * Keys are presentation; predicates are identity. The payload is assembled from predicate IRIs at
 * every depth, the frame comes from the SHACL shape, and the wire spelling comes from the served
 * `@context` — so the C9 class (a client hand-spelling keys the server never declared) dies
 * client-side by construction.
 */

function offlineContexts(extra: Record<string, unknown> = {}) {
  return createContextStore({
    fetchJson: async (url) => {
      if (url in extra) return extra[url]
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })
}

describe('frame derivation from the SHACL shape (task 5.1)', () => {
  let graph: SessionGraph

  beforeAll(async () => {
    graph = createSessionGraph()
    const load = offlineContexts().load
    graph.ingestDocument(await quadsFromJsonLd(magoVocab, load, 'http://localhost:1648/Api/Vocab'), GRAPHS.vocab)
    graph.ingestDocument(await quadsFromJsonLd(magoShapes, load, 'http://localhost:1648/Api/Shapes'), GRAPHS.shapes)
  })

  it('embeds every sh:node property, recursively', () => {
    const frame = deriveFrame('https://mago.co/ns#Contact', {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    })

    expect(frame['@type']).toBe('https://mago.co/ns#Contact')
    // Contact's shape nests its address through sh:node, so the frame embeds it.
    const embedded = Object.entries(frame).filter(
      ([key, value]) =>
        key !== '@type' && typeof value === 'object' && (value as Record<string, unknown>)['@embed'] === '@always',
    )
    expect(embedded.length).toBeGreaterThan(0)
  })

  it('guards a cyclic shape rather than recursing forever', async () => {
    const NSX = 'https://cycle.example/ns#'
    const shapes = {
      '@context': {
        sh: 'http://www.w3.org/ns/shacl#',
        ex: NSX,
        'sh:targetClass': { '@type': '@id' },
        'sh:path': { '@type': '@id' },
        'sh:node': { '@type': '@id' },
      },
      '@graph': [
        {
          '@id': 'ex:AShape',
          '@type': 'sh:NodeShape',
          'sh:targetClass': 'ex:A',
          'sh:property': [{ 'sh:path': 'ex:toB', 'sh:node': 'ex:BShape' }],
        },
        {
          '@id': 'ex:BShape',
          '@type': 'sh:NodeShape',
          'sh:property': [{ 'sh:path': 'ex:toA', 'sh:node': 'ex:AShape' }],
        },
      ],
    }

    const cyclic = createSessionGraph()
    cyclic.ingestDocument(
      await quadsFromJsonLd(shapes, offlineContexts().load, 'https://cycle.example/shapes'),
      GRAPHS.shapes,
    )

    const frame = deriveFrame(`${NSX}A`, {
      constraintsFor: (iri) => constraintsFor(cyclic, iri),
      constraintsOfShape: (iri) => constraintsOfShape(cyclic, iri),
    })

    // A embeds B, B embeds A once — and the revisit stops there instead of running out of stack.
    const toB = frame[`${NSX}toB`] as Record<string, unknown>
    expect(toB['@embed']).toBe('@always')
    const toA = toB[`${NSX}toA`] as Record<string, unknown>
    expect(toA['@embed']).toBe('@always')
    expect(toA[`${NSX}toB`]).toBeUndefined()
  })
})

describe('payloads are predicate-keyed at every depth (task 5.2)', () => {
  let surface: ToolSurface
  let model: CapabilityModel

  beforeAll(async () => {
    const graph = createSessionGraph()
    const load = offlineContexts().load
    graph.ingestDocument(await quadsFromJsonLd(magoVocab, load, 'http://localhost:1648/Api/Vocab'), GRAPHS.vocab)
    graph.ingestDocument(await quadsFromJsonLd(magoShapes, load, 'http://localhost:1648/Api/Shapes'), GRAPHS.shapes)
    model = buildCapabilityModel(graph)
    surface = projectTools(model, {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      findings: createFindings(),
    })
  })

  it('converts a nested object’s fields to their predicate IRIs', () => {
    const put = surface.tools.find(
      (tool) => tool.dispatch.classIri === 'https://mago.co/ns#Company' && tool.dispatch.method === 'PUT',
    )!
    const binding = put.dispatch.bindings.find((candidate) => candidate.nested)
    expect(binding).toBeDefined()

    const { document } = buildPayload(
      put,
      { id: 'https://example.test/Api/Company/Id/1', [binding!.name]: { postalCode: '90210' } },
      { subject: 'https://example.test/Api/Company/Id/1', type: 'https://mago.co/ns#Company' },
    )

    const nested = document[binding!.property!] as Record<string, unknown>
    // The nested key is the predicate, not the label the model saw — the C9 class one level down.
    expect(nested['postalCode']).toBeUndefined()
    expect(nested[`${NS.schema}postalCode`]).toBe('90210')
  })
})

describe('wire keys match the served context (tasks 5.2, 5.4 — the C9-class fixture)', () => {
  /**
   * The served context spells `schema:givenName` as `FirstName` and `schema:familyName` as
   * `LastName` — the exact mismatch class that broke writes: the model speaks `givenName` (the
   * predicate's local name), the server's wire format wants `FirstName`. Nothing in the client
   * knows either spelling; the compaction against the served context produces it.
   */
  const NSX = 'https://people.example/ns#'
  const API = 'https://people.example/api'
  const CONTEXT_URL = `${API}/context`
  const servedContext = {
    '@context': {
      FirstName: 'http://schema.org/givenName',
      LastName: 'http://schema.org/familyName',
    },
  }

  const vocab = {
    '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { ex: NSX, schema: 'http://schema.org/' }],
    '@id': `${API}/vocab`,
    '@type': 'ApiDocumentation',
    supportedClass: [
      {
        '@id': 'ex:Person',
        '@type': 'Class',
        supportedOperation: [
          { '@type': 'Operation', method: 'PUT', expects: 'ex:Person' },
        ],
        supportedProperty: [
          {
            '@type': 'SupportedProperty',
            property: 'schema:givenName',
            readable: true,
            writeable: true,
          },
          {
            '@type': 'SupportedProperty',
            property: 'schema:familyName',
            readable: true,
            writeable: true,
          },
        ],
      },
    ],
  }

  it('writes through the served context’s spelling, and verifies the echo at graph level', async () => {
    const PERSON = `${API}/people/1`
    const held = {
      '@context': CONTEXT_URL,
      '@id': PERSON,
      '@type': 'https://people.example/ns#Person',
      LastName: 'Lovelace',
    }

    const requests: { method: string; url: string; body: string | null }[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = (init?.body as string | undefined) ?? null
      requests.push({ method, url, body })
      if (url === PERSON && method === 'GET') {
        return new Response(JSON.stringify(held), {
          status: 200,
          headers: { 'Content-Type': 'application/ld+json' },
        })
      }
      if (url === PERSON && method === 'PUT') {
        // The server echoes what it persisted, in its own spelling.
        return new Response(JSON.stringify({ ...JSON.parse(body ?? '{}'), '@context': CONTEXT_URL }), {
          status: 200,
          headers: { 'Content-Type': 'application/ld+json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const contexts = offlineContexts({ [CONTEXT_URL]: servedContext })
    const graph = createSessionGraph()
    const findings = createFindings()
    const trace = createTrace()
    graph.ingestDocument(await quadsFromJsonLd(vocab, contexts.load, `${API}/vocab`), GRAPHS.vocab)

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
      origin: API,
      shapes: {
        constraintsFor: (iri) => constraintsFor(graph, iri),
        constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      },
    })

    const outcome = await executor.execute('invoke', {
      affordance: 'put_Person',
      input: { id: PERSON, givenName: 'Ada' },
    })

    // The model said `givenName`; the wire says `FirstName`, because the served context does.
    const sent = JSON.parse(requests.find((request) => request.method === 'PUT')?.body ?? '{}')
    expect(sent['FirstName']).toBe('Ada')
    expect(sent['givenName']).toBeUndefined()
    expect(sent['http://schema.org/givenName']).toBeUndefined()
    // The merge carried the untouched field forward, in the same spelling.
    expect(sent['LastName']).toBe('Lovelace')
    // And the graph-level echo check confirms the write through that spelling.
    expect(outcome.ok).toBe(true)
    expect(outcome.content).not.toMatch(/does not carry what was requested/)
  })
})

describe('echo verification at graph level (task 5.3)', () => {
  const SUBJECT = 'https://api.example/things/1'
  const DUE = 'https://api.example/ns#dueOn'

  it('passes a value the server round-trips in a different lexical form', () => {
    const written = [
      quad(namedNode(SUBJECT), namedNode(DUE), literal('2026-01-01T00:00:00')),
    ]
    const echoed = [
      quad(
        namedNode(SUBJECT),
        namedNode(DUE),
        literal('2026-01-01T00:00:00Z', namedNode(`${NS.xsd}dateTime`)),
      ),
    ]
    const requested = new Map<string, unknown>([[DUE, '2026-01-01T00:00:00']])

    // String comparison fails this; the graph-level check reads both as the same instant.
    expect(verifyEchoGraph(written, echoed, SUBJECT, requested)).toEqual([])
  })

  it('still fails a field the server dropped', () => {
    const written = [quad(namedNode(SUBJECT), namedNode(DUE), literal('2026-01-01'))]
    const requested = new Map<string, unknown>([[DUE, '2026-01-01']])

    const mismatches = verifyEchoGraph(written, [], SUBJECT, requested)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.predicate).toBe(DUE)
    expect(mismatches[0]?.returned).toBeNull()
  })

  it('checks a nested value by presence, and fails its absence', () => {
    const node = blankNode('b0')
    const ADDRESS = 'https://api.example/ns#address'
    const written = [
      quad(namedNode(SUBJECT), namedNode(ADDRESS), node),
      quad(node, namedNode(`${NS.schema}postalCode`), literal('90210')),
    ]
    const requested = new Map<string, unknown>([[ADDRESS, { postal: '90210' }]])

    expect(verifyEchoGraph(written, [], SUBJECT, requested)).toHaveLength(1)
    const echoed = [quad(namedNode(SUBJECT), namedNode(ADDRESS), blankNode('other'))]
    expect(verifyEchoGraph(written, echoed, SUBJECT, requested)).toEqual([])
  })

  it('only verifies what was requested, never the merged base', () => {
    const OTHER = 'https://api.example/ns#other'
    const written = [
      quad(namedNode(SUBJECT), namedNode(DUE), literal('2026-01-01')),
      quad(namedNode(SUBJECT), namedNode(OTHER), literal('carried forward')),
    ]
    const echoed = [quad(namedNode(SUBJECT), namedNode(DUE), literal('2026-01-01'))]
    const requested = new Map<string, unknown>([[DUE, '2026-01-01']])

    // OTHER came from the pre-write read; the server normalising it is not a persistence failure.
    expect(verifyEchoGraph(written, echoed, SUBJECT, requested)).toEqual([])
  })
})

/**
 * Task 5.4, the live half: the C9-class write driven through the new path against a real boot —
 * create through the collection, update through the resource, both verified by the graph-level
 * echo check against what the server actually persisted. (The through-the-agent form of this run
 * additionally needs ANTHROPIC_API_KEY; this exercises every layer below the model.)
 */
const live = process.env['HYDRA_LIVE'] === '1'
const liveEntry = process.env['HYDRA_LIVE_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const liveToken = process.env['HYDRA_LIVE_TOKEN'] ?? null

describe.skipIf(!live)('the framing write path against a live boot (task 5.4)', () => {
  it('creates and updates a contact through the served context, with the echo verified', async () => {
    const { createHttpClient: mkHttp } = await import('../src/http/client')
    const { discoverApi } = await import('../src/vocab/discover')

    const graph = createSessionGraph()
    const findings = createFindings()
    const trace = createTrace()
    const http = mkHttp({ token: liveToken })
    const contexts = createContextStore()

    const discovered = await discoverApi(liveEntry, { http, graph, contexts, findings, trace })
    const model = buildCapabilityModel(graph)
    const surface = projectTools(model, {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      findings,
    })
    const executor = createExecutor({
      http,
      graph,
      contexts,
      findings,
      trace,
      surface,
      model,
      origin: liveEntry,
      entrypoint: discovered.entrypoint ?? liveEntry,
      shapes: {
        constraintsFor: (iri) => constraintsFor(graph, iri),
        constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      },
    })

    // Prime the served context the way a session naturally would: read the collection first.
    await executor.execute('search_collection', { collection: 'https://mago.co/ns#Contact' })

    const stamp = Date.now().toString(36)
    const created = await executor.execute('invoke', {
      affordance: 'post_ContactCollection',
      input: { givenName: 'Framing', familyName: `Path-${stamp}` },
    })
    expect(created.ok, created.content).toBe(true)
    expect(created.content).not.toMatch(/does not carry what was requested/)

    const match = created.content.match(/@id: (\S+)/)
    expect(match, created.content.slice(0, 300)).toBeTruthy()
    const iri = match![1] as string

    // The update goes through the read-before-replace merge and the same framing; the echo check
    // passing is the server confirming the spelling the served context produced.
    const updated = await executor.execute('invoke', {
      affordance: 'put_Contact',
      input: { id: iri, jobTitle: 'Framed Writer' },
    })
    expect(updated.ok, updated.content).toBe(true)
    expect(updated.content).toMatch(/jobTitle: Framed Writer/)

    // Leave the database the way we found it.
    const removed = await executor.execute('invoke', {
      affordance: 'delete_Contact',
      input: { id: iri },
    })
    expect(removed.ok, removed.content).toBe(true)
  }, 120_000)
})
