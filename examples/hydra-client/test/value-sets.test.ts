import { beforeAll, describe, expect, it } from 'vitest'

import { renderManifest } from '../src/agent/manifest'
import { createExecutor, type Executor } from '../src/execute/dispatch'
import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings, type Findings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS, NS } from '../src/rdf/terms'
import { projectTools, type ToolSurface } from '../src/project/tools'
import type { ValueSetIndex } from '../src/render/affordances'
import { createTrace, type Trace } from '../src/trace'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  type CapabilityModel,
} from '../src/vocab/capability'
import { discoverApi } from '../src/vocab/discover'
import { materialiseValueSets, referenceCollections } from '../src/vocab/value-sets'

import magoContext from './fixtures/mago-context.json'
import magoEntrypoint from './fixtures/mago-entrypoint.json'
import magoShapes from './fixtures/mago-shapes.json'
import magoVocab from './fixtures/mago-vocab.json'

/**
 * Live enums (design D5): where a property declares `sh:class` naming a class whose instances a
 * read-only collection serves in full, the members are the property's value set — in the map, in
 * the contracts, and at the gate. Where either half of that is missing, everything degrades to a
 * plain IRI reference. Never guessed: read-only is read from the vocabulary, completeness from the
 * response (the no-view proof).
 */

const ORIGIN = 'http://localhost:1648'
const ENTRY = `${ORIGIN}/Api/`
const MAGO = 'https://mago.co/ns#'
const SALUTATIONS = `${ORIGIN}/Api/Salutation/`

const salutation = (id: string, label: string) => ({
  '@id': `${ORIGIN}/Api/Salutation/Id/${id}`,
  '@type': [`${MAGO}Salutation`],
  [`${NS.schema}name`]: [{ '@value': label }],
})

/** Complete by the no-view proof: every member on one page, no PartialCollectionView. */
const salutationCollection = {
  '@id': SALUTATIONS,
  '@type': ['http://www.w3.org/ns/hydra/core#Collection'],
  'http://www.w3.org/ns/hydra/core#member': [
    salutation('2', 'Mrs.'),
    salutation('1', 'Mr.'),
    salutation('3', 'Dr.'),
  ],
}

interface Harness {
  readonly graph: SessionGraph
  readonly model: CapabilityModel
  readonly surface: ToolSurface
  readonly findings: Findings
  readonly trace: Trace
  readonly valueSets: ValueSetIndex
  readonly executor: Executor
  readonly requests: string[]
  readonly routes: Record<string, unknown>
}

async function harness(overrides: { routes?: Record<string, unknown> } = {}): Promise<Harness> {
  const requests: string[] = []
  const routes: Record<string, unknown> = {
    [SALUTATIONS]: salutationCollection,
    ...overrides.routes,
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    const route = routes[url] ?? routes[`${init?.method ?? 'GET'} ${url}`]
    if (route === undefined) return new Response(`no route for ${url}`, { status: 404 })
    const reply = typeof route === 'function' ? (route as (body: string | null) => unknown)((init?.body as string) ?? null) : route
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'Content-Type': 'application/ld+json' },
    })
  }) as unknown as typeof fetch

  const contexts = createContextStore({
    // The served context is a fixture; anything else reaching the network is a test failure.
    fetchJson: async (url) => {
      if (url === `${ENTRY}Context`) return magoContext
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })
  const graph = createSessionGraph()
  const findings = createFindings()
  const trace = createTrace()

  graph.ingestDocument(await quadsFromJsonLd(magoVocab, contexts.load, `${ENTRY}Vocab`), GRAPHS.vocab)
  graph.ingestDocument(await quadsFromJsonLd(magoShapes, contexts.load, `${ENTRY}Shapes`), GRAPHS.shapes)
  graph.ingestDocument(await quadsFromJsonLd(magoEntrypoint, contexts.load, ENTRY), GRAPHS.context)

  const model = buildCapabilityModel(graph)
  const surface = projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings,
  })

  const http = createHttpClient({ fetchImpl })
  const collectionDeps = { http, graph, contexts, findings, trace, origin: ENTRY }
  const valueSets = await materialiseValueSets(model, collectionDeps, { entrypoint: ENTRY })

  const executor = createExecutor({
    http,
    graph,
    contexts,
    findings,
    trace,
    surface,
    model,
    origin: ENTRY,
    entrypoint: ENTRY,
    valueSets,
  })

  return { graph, model, surface, findings, trace, valueSets, executor, requests, routes }
}

describe('materialising reference collections at connect (task 4.1)', () => {
  let connected: Harness

  beforeAll(async () => {
    connected = await harness()
  })

  it('classifies exactly the read-only collections with a declared member class as references', () => {
    const references = referenceCollections(connected.model).map((cls) => cls.iri)
    // The five enum collections qualify; Contact/Company/Event/Call collections declare POST.
    for (const name of ['LeadSource', 'Salutation', 'AudienceType', 'ShowType', 'CompanyType']) {
      expect(references).toContain(`${MAGO}${name}Collection`)
    }
    expect(references).not.toContain(`${MAGO}ContactCollection`)
  })

  it('indexes a complete collection’s members by the class they instantiate, sorted', () => {
    const set = connected.valueSets.byClass(`${MAGO}Salutation`)
    expect(set).toBeDefined()
    expect(set!.map((member) => member.iri)).toEqual(
      [1, 2, 3].map((id) => `${ORIGIN}/Api/Salutation/Id/${id}`),
    )
    // Labels come from the served members, so a refusal can name something readable.
    expect(set!.find((member) => member.iri.endsWith('/Id/1'))?.label).toBe('Mr.')
  })

  it('declares no value set for a class whose collection could not be materialised', () => {
    // The fake server serves only the Salutation collection; the others 404 and degrade.
    expect(connected.valueSets.byClass(`${MAGO}LeadSource`)).toBeUndefined()
  })

  it('declares no value set for an incomplete collection, whatever it declares', async () => {
    const partial = await harness({
      routes: {
        [SALUTATIONS]: {
          ...salutationCollection,
          'http://www.w3.org/ns/hydra/core#view': [
            {
              '@id': `${SALUTATIONS}Page/1`,
              '@type': ['http://www.w3.org/ns/hydra/core#PartialCollectionView'],
            },
          ],
        },
      },
    })
    // Partial with no next link: incomplete, and membership must not be enforced against it.
    expect(partial.valueSets.byClass(`${MAGO}Salutation`)).toBeUndefined()
  })
})

describe('value sets reach every consumer (task 4.2)', () => {
  let connected: Harness

  beforeAll(async () => {
    connected = await harness()
  })

  it('renders reference-collection members inline in the map', () => {
    const manifest = renderManifest(connected.model, {
      constraintsFor: (iri) => constraintsFor(connected.graph, iri),
      primaryNamespace: MAGO,
      valueSets: connected.valueSets,
    })

    expect(manifest.affordances).toMatch(/ns:SalutationCollection/)
    expect(manifest.affordances).toMatch(/serves the full set: .*Mr\./)
    expect(manifest.affordances).toMatch(/Salutation\/Id\/2/)
  })

  it('renders the value set in a write contract, and enforces membership at the gate', async () => {
    const CONTACT = `${ORIGIN}/Api/Contact/Id/1`
    const outcome = await connected.executor.execute('invoke', {
      affordance: 'put_Contact',
      input: { id: CONTACT, salutation: `${ORIGIN}/Api/Salutation/Id/99` },
    })

    // Refused before the wire, naming the served members (design D5's scenario verbatim).
    expect(outcome.ok).toBe(false)
    expect(outcome.requested).toBe(false)
    expect(outcome.content).toMatch(/not among the served members/)
    expect(outcome.content).toContain(`${ORIGIN}/Api/Salutation/Id/1`)
    expect(outcome.content).toContain('Mr.')
  })

  it('lets a served member through the gate', async () => {
    const CONTACT = `${ORIGIN}/Api/Contact/Id/1`
    const held = {
      '@context': 'http://www.w3.org/ns/hydra/context.jsonld',
      '@id': CONTACT,
      '@type': `${MAGO}Contact`,
      'http://schema.org/familyName': 'Lovelace',
    }
    const fresh = await harness({
      routes: {
        [CONTACT]: held,
        [`PUT ${CONTACT}`]: (body: string | null) => JSON.parse(body ?? '{}'),
      },
    })

    const outcome = await fresh.executor.execute('invoke', {
      affordance: 'put_Contact',
      input: { id: CONTACT, salutation: `${ORIGIN}/Api/Salutation/Id/1` },
    })

    // A gate that refused everything would pass the test above for the wrong reason.
    expect(outcome.requested).toBe(true)
    expect(fresh.requests.filter((line) => line.startsWith('PUT'))).toHaveLength(1)
  })

  it('degrades to a plain IRI reference where no value set exists, and never guesses', async () => {
    // `company` declares sh:class ns:Company — a class whose collection is writable, so it is no
    // reference set. The gate falls back to the held-types check and discloses what it could not
    // verify, exactly as before this change.
    const CONTACT = `${ORIGIN}/Api/Contact/Id/1`
    const held = {
      '@context': 'http://www.w3.org/ns/hydra/context.jsonld',
      '@id': CONTACT,
      '@type': `${MAGO}Contact`,
      'http://schema.org/familyName': 'Lovelace',
    }
    const fresh = await harness({
      routes: {
        [CONTACT]: held,
        [`PUT ${CONTACT}`]: (body: string | null) => JSON.parse(body ?? '{}'),
      },
    })

    await fresh.executor.execute('invoke', {
      affordance: 'put_Contact',
      input: { id: CONTACT, company: `${ORIGIN}/Api/Company/Id/7` },
    })

    expect(
      fresh.trace.entries.some((entry) => /Not checked before dispatch — company/.test(entry.message)),
    ).toBe(true)
  })
})

/**
 * Task 4.3 — against a live boot with `declare-reference-collection-classes` landed, the five
 * reference properties surface their live members. Gated the same way as every live suite:
 *
 *     HYDRA_LIVE=1 HYDRA_LIVE_TOKEN=<pat> npm test
 */
const live = process.env['HYDRA_LIVE'] === '1'
const liveEntry = process.env['HYDRA_LIVE_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const liveToken = process.env['HYDRA_LIVE_TOKEN'] ?? null

describe.skipIf(!live)('reference collections against a live boot (task 4.3)', () => {
  it('surfaces live members for all five reference classes', async () => {
    const graph = createSessionGraph()
    const findings = createFindings()
    const trace = createTrace()
    const http = createHttpClient({ token: liveToken })
    const contexts = createContextStore()

    const discovered = await discoverApi(liveEntry, { http, graph, contexts, findings, trace })
    const model = buildCapabilityModel(graph)
    const valueSets = await materialiseValueSets(
      model,
      { http, graph, contexts, findings, trace, origin: liveEntry },
      { entrypoint: discovered.entrypoint ?? liveEntry },
    )

    for (const name of ['LeadSource', 'Salutation', 'AudienceType', 'ShowType', 'CompanyType']) {
      const set = valueSets.byClass(`${MAGO}${name}`)
      expect(set, `${name} must carry a live value set`).toBeDefined()
      expect(set!.length).toBeGreaterThan(0)
      // Members are the live rows: every one has the API's IRI shape and most carry labels.
      for (const member of set!) expect(member.iri).toMatch(new RegExp(`/Api/${name}/Id/`, 'i'))
    }
  }, 120_000)
})
