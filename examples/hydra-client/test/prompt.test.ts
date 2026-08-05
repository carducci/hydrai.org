import { beforeAll, describe, expect, it } from 'vitest'

import { renderManifest, type Manifest } from '../src/agent/manifest'
import { ORCHESTRATION, buildSystem, markConversationCache, userTurn } from '../src/agent/prompt'
import { STRICT_TOOL_LIMIT, toolsForRequest } from '../src/agent/tools'
import { queryTool, withQueryTool } from '../src/query/tool'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { projectTools } from '../src/project/tools'
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
 * Prompt assembly and the ontology manifest (tasks 6.3 and 6.3b).
 *
 * The proof of concept put the current date and time at position 0 of the system prompt
 * (`index.html:1206-1208`) and set no `cache_control` anywhere. Both halves matter: the timestamp
 * made every prefix unique, and with no breakpoint there was nothing eligible to cache in the first
 * place. These tests pin the fix from both directions.
 */

async function modelFor(vocab: unknown, shapes: unknown | null, url: string) {
  const graph = createSessionGraph()
  const load = createContextStore({
    fetchJson: async (requested) => {
      throw new Error(`the network must not be reached, but ${requested} was requested`)
    },
  }).load

  graph.ingestDocument(await quadsFromJsonLd(vocab, load, url), GRAPHS.vocab)
  if (shapes) graph.ingestDocument(await quadsFromJsonLd(shapes, load, url), GRAPHS.shapes)

  const model = buildCapabilityModel(graph)
  const surface = projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings: createFindings(),
  })
  return {
    model,
    deps: {
      constraintsFor: (iri: string) => constraintsFor(graph, iri),
      primaryNamespace: primaryNamespace(model),
      surface,
    },
  }
}

describe('the stable prefix', () => {
  it('carries exactly one breakpoint, on its last block', () => {
    // Tools render ahead of system, so one marker here caches the tool definitions with it.
    const system = buildSystem()
    const marked = system.filter((block) => block.cache_control !== undefined)

    expect(marked).toHaveLength(1)
    expect(marked[0]).toBe(system[system.length - 1])
  })

  it('does not put the timestamp in the system prompt', () => {
    // The regression that matters: a timestamp anywhere in the prefix makes every request unique.
    const system = buildSystem()
    for (const block of system) {
      expect(block.text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  it('is byte-identical across turns that state different times', () => {
    const first = buildSystem()
    const second = buildSystem()
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    // …and the differing part is carried by the turn instead.
    const early = userTurn('hello', new Date('2026-01-01T00:00:00Z'))
    const late = userTurn('hello', new Date('2026-07-30T12:00:00Z'))
    expect(JSON.stringify(early)).not.toBe(JSON.stringify(late))
  })

  it('puts the timestamp in the new turn, ahead of what the user said', () => {
    const turn = userTurn('how many events?', new Date('2026-07-30T12:00:00Z'))
    const content = turn.content as { type: string; text: string }[]

    expect(content[0]?.text).toContain('2026-07-30T12:00:00')
    expect(content[1]?.text).toBe('how many events?')
    // Nothing in the new turn is cached — it is the volatile end of the prompt.
    expect(content.every((block) => !('cache_control' in block))).toBe(true)
  })
})

describe('the conversation breakpoint', () => {
  it('moves to the end of the settled history and leaves no stale marker behind', () => {
    // Four breakpoints per request is the whole budget; an abandoned marker is a wasted slot.
    const first = markConversationCache([
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
    ])
    const second = markConversationCache([
      ...first,
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    ])

    const marked = second.flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content.filter((block) => 'cache_control' in block && block.cache_control),
    )
    expect(marked).toHaveLength(1)
  })

  it('never marks a thinking block', () => {
    /*
     * Thinking blocks are echoed back exactly as received. Attaching a `cache_control` the model did
     * not send makes it a modified block, and the API rejects those — so the breakpoint has to skip
     * it rather than land wherever the turn happened to end.
     */
    const marked = markConversationCache([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig' }],
      },
    ])

    const block = (marked[0]?.content as { cache_control?: unknown }[])[0]
    expect(block?.cache_control).toBeUndefined()
  })

  it('is a no-op on an empty history, so the first turn is valid', () => {
    expect(markConversationCache([])).toEqual([])
  })
})

describe('shaping the surface for a request', () => {
  /**
   * The envelope surface (design D1): the wire tools are constant across APIs, always under the
   * strict cap, never deferred. The vocabulary that used to project 39 tools and the one that
   * projects 15 now produce the same request shape — what differs is what the *results* say.
   */
  async function surfaceFor(vocab: unknown, shapes: unknown | null, url: string) {
    const graph = createSessionGraph()
    const load = createContextStore({
      fetchJson: async (requested) => {
        throw new Error(`the network must not be reached, but ${requested} was requested`)
      },
    }).load

    graph.ingestDocument(await quadsFromJsonLd(vocab, load, url), GRAPHS.vocab)
    if (shapes) graph.ingestDocument(await quadsFromJsonLd(shapes, load, url), GRAPHS.shapes)

    return withQueryTool(
      projectTools(buildCapabilityModel(graph), {
        constraintsFor: (iri) => constraintsFor(graph, iri),
        constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
        findings: createFindings(),
      }),
    )
  }

  it('produces the same tool names for a small API and a large one', async () => {
    const library = toolsForRequest(
      await surfaceFor(libraryVocab, null, 'https://lending.example/api/vocab'),
    )
    const mago = toolsForRequest(
      await surfaceFor(magoVocab, magoShapes, 'http://example.test/Api/Vocab'),
    )

    const names = (request: typeof library) =>
      (request.tools as unknown as { name: string }[]).map((tool) => tool.name)

    expect(names(library)).toEqual(names(mago))
    expect(names(library)).toEqual([
      'follow',
      'search_collection',
      'get_resource',
      'invoke',
      'sparql',
    ])
  })

  it('always fits under the strict cap, with no search tool and nothing deferred', async () => {
    const surface = await surfaceFor(magoVocab, magoShapes, 'http://example.test/Api/Vocab')
    const request = toolsForRequest(surface)
    const tools = request.tools as unknown as Record<string, unknown>[]

    expect(request.count).toBeLessThanOrEqual(STRICT_TOOL_LIMIT)
    expect(tools).toHaveLength(request.count)
    expect(tools.every((tool) => !('defer_loading' in tool))).toBe(true)
    expect(tools.some((tool) => String(tool['type'] ?? '').startsWith('tool_search_tool_'))).toBe(false)
  })

  it('keeps strict where it is free, and only there', async () => {
    /*
     * Architecture note §8: never architect around keeping `strict`. The iri-only tools and the
     * query tool carry it for free. `search_collection.filters` and `invoke.input` are open
     * objects — a strict schema cannot carry one — so those two go without, and the dispatch gate
     * validates their contents on every call.
     */
    const surface = await surfaceFor(libraryVocab, null, 'https://lending.example/api/vocab')
    const tools = toolsForRequest(surface).tools as unknown as {
      name: string
      strict?: boolean
      input_schema: { properties?: Record<string, { additionalProperties?: unknown }> }
    }[]

    const strictNames = tools.filter((tool) => tool.strict).map((tool) => tool.name)
    expect(strictNames.sort()).toEqual(['follow', 'get_resource', 'sparql'])

    const open = tools.filter((tool) => !tool.strict).map((tool) => tool.name)
    expect(open.sort()).toEqual(['invoke', 'search_collection'])
  })

  it('sends no format keyword on the wire — the URI grammar forbade dotless hosts', async () => {
    /*
     * Measured live (2026-08-02): `format: 'uri'` under strict constrained decoding rejects
     * hosts without a dot, so against a deployment on localhost:1648 the model could not emit
     * the true IRI and was forced to hallucinate one — `localhost.com:1648`, then gibberish as
     * it retried. Validation lives in the URL parse and the gate; the keyword bought nothing
     * and cost the session.
     */
    const surface = await surfaceFor(libraryVocab, null, 'https://lending.example/api/vocab')
    expect(JSON.stringify(toolsForRequest(surface).tools)).not.toContain('"format"')
  })
})

describe('the ontology manifest', () => {
  let manifest: Manifest

  beforeAll(async () => {
    const { model, deps } = await modelFor(magoVocab, magoShapes, 'http://example.test/Api/Vocab')
    manifest = renderManifest(model, deps)
  })

  it('renders the class list and the property detail as separable sections', () => {
    /*
     * Task 6.3b's requirement, and the whole reason they are rendered apart: switching to
     * progressive disclosure later must be dropping a section, not restructuring the prompt.
     */
    const whole = buildSystem({ manifest })
    const disclosed = buildSystem({ manifest, includeProperties: false })

    expect(whole).toHaveLength(disclosed.length + 1)
    // The class list survives the drop unchanged — design D7 keeps it at every size.
    expect(disclosed.map((block) => block.text).join('\n')).toContain(manifest.classes)
    expect(disclosed.map((block) => block.text).join('\n')).not.toContain(manifest.properties)

    // And the breakpoint follows, rather than being left on a block that is no longer last.
    expect(disclosed[disclosed.length - 1]?.cache_control).toBeDefined()
    expect(disclosed.filter((block) => block.cache_control !== undefined)).toHaveLength(1)
  })

  it('describes classes with the prose the API published', () => {
    expect(manifest.classes).toMatch(/ns:Contact — /)
    expect(manifest.counts.classes).toBeGreaterThan(0)
  })

  it('carries every collection in the affordance index, with its filters and write support', () => {
    /*
     * Design D4: the premise that used to justify omitting collections — that the tool surface
     * carries them — is no longer true in either architecture. The envelope is constant, so the
     * index is the only place the model can learn a collection exists before the first call.
     */
    expect(manifest.affordances).toMatch(/ns:ContactCollection/)
    expect(manifest.affordances).toMatch(/members are ns:Contact/)
    // The declared filter variables ride the line — a listing the model never needed to pull.
    expect(manifest.affordances).toMatch(/filter by .*firstName/)
    // Write support states its meaning, not just its handle: measured live (2026-08-02), the
    // model read "member handles: put_Contact, delete_Contact" and still reported updates as
    // "likely" unsupported — a verb is capability, a bare handle is a name to decode.
    expect(manifest.affordances).toMatch(/create with post_ContactCollection/)
    expect(manifest.affordances).toMatch(/update with put_Contact/)
    expect(manifest.affordances).toMatch(/delete with delete_Contact/)
    // And the index says it is exhaustive — the claim that makes "no such affordance has shown
    // up yet" an answer the model cannot honestly give.
    expect(manifest.affordances).toMatch(/^COLLECTIONS — this index is complete/)
    expect(manifest.counts.collections).toBeGreaterThan(0)

    // CLASSES stays about the classes whose instances hold data — queries are written over those.
    expect(manifest.classes).not.toMatch(/ns:ContactCollection/)
    expect(manifest.classes).toMatch(/ns:Contact —/)
  })

  it('names every write handle the vocabulary declares — no GET required to learn a capability', async () => {
    /*
     * hydra:supportedOperation is enumerated at first discovery. A write that is declared there
     * but named nowhere in the map is a capability the model must conclude does not exist —
     * measured live: it reported the API as unable to update a contact while put_Contact sat in
     * the registry the whole time. The map is the connect-time projection of the whole declared
     * write surface; results only re-affirm it contextually.
     */
    const { model, deps } = await modelFor(magoVocab, magoShapes, 'http://example.test/Api/Vocab')
    const rendered = renderManifest(model, deps)
    const writes = deps.surface.tools.filter(
      (tool) =>
        tool.dispatch.kind === 'operation' &&
        !['GET', 'HEAD', 'OPTIONS'].includes(tool.dispatch.method.toUpperCase()),
    )
    expect(writes.length).toBeGreaterThan(0)
    for (const tool of writes) {
      expect(rendered.affordances, `${tool.name} must be named in the map`).toContain(tool.name)
    }
  })

  it('places the affordance index before the breakpoint, inside the always-kept block', () => {
    const disclosed = buildSystem({ manifest, includeProperties: false })
    const kept = disclosed.map((block) => block.text).join('\n')
    expect(kept).toContain(manifest.affordances)
    expect(disclosed[disclosed.length - 1]?.cache_control).toBeDefined()
  })

  it('renders the affordance index byte-identically across two renders', async () => {
    const { model, deps } = await modelFor(magoVocab, magoShapes, 'http://example.test/Api/Vocab')
    expect(renderManifest(model, deps).affordances).toBe(manifest.affordances)
  })

  it('carries a collection’s address when the caller can resolve one, and none otherwise', async () => {
    /*
     * Measured live (2026-08-02): with no address in the map, the model composed
     * `https://mago.co/Api/Contact` from the vocabulary namespace and spent a turn on the origin
     * veto. An address that can be copied is never composed. The callback is injected — the same
     * resolution dispatch uses, closed over by the caller — so this layer stays below the
     * executor; absent, the index renders exactly as before.
     */
    const { model, deps } = await modelFor(magoVocab, magoShapes, 'http://example.test/Api/Vocab')
    const located = renderManifest(model, {
      ...deps,
      locate: (classIri: string) =>
        classIri.endsWith('ContactCollection') ? 'http://example.test/Api/Contact/' : null,
    })

    expect(located.affordances).toMatch(
      /ns:ContactCollection[^\n]* at <http:\/\/example\.test\/Api\/Contact\/>/,
    )
    // A class the callback cannot resolve renders address-less, not with an invented one.
    expect(located.affordances).not.toMatch(/ns:CallCollection[^\n]* at </)
    // And the callback's absence is the old rendering, byte for byte.
    expect(renderManifest(model, deps).affordances).toBe(manifest.affordances)
  })

  it('carries the value sets the shapes graph declares', () => {
    // `sh:in` is the highest-value thing the shapes graph publishes for query authoring: it turns a
    // guess about a status value into a closed set.
    expect(manifest.properties).toMatch(/one of /)
  })

  it('compacts IRIs against the namespaces it declares', () => {
    expect(manifest.prefixes).toMatch(/PREFIX ns: +</)
    expect(manifest.prefixes).toMatch(/PREFIX xsd: +</)
  })

  it('renders an API it has never seen, with that API’s own namespace', async () => {
    const { model, deps } = await modelFor(libraryVocab, null, 'https://lending.example/api/vocab')
    const other = renderManifest(model, deps)

    expect(other.prefixes).toContain('https://lending.example/ns#')
    expect(other.classes).toMatch(/ns:Tome — A book held by the library\./)
    // `lend:Stacks` holds members, so it is a collection and stays out.
    expect(other.classes).not.toMatch(/ns:Stacks/)
  })
})

/**
 * Counting a declared-filter subset is a read, not a query (routing refinement 2026-08-03).
 *
 * The observed misroute: asked "how many active leads", the model wrote a `sparql` COUNT over the
 * whole Event collection — because the orchestration routed every count to `sparql` and the `sparql`
 * tool advertised "counts" as its job. With the endpoint down that COUNT degraded to a full local
 * materialisation, when `/Api/Event/Status/ActiveLead` — a published, EF-backed named view — declares
 * the total in one read. The prose now sends filter-bounded counts to `search_collection` and reserves
 * `sparql` for figures no single filter expresses.
 */
describe('a filter-bounded count is a read, not a query', () => {
  it('the orchestration sends counts a filter names to search_collection, not sparql', () => {
    expect(ORCHESTRATION).toContain('To count records a declared filter names')
    expect(ORCHESTRATION).toContain('read the total its result declares')
    // sparql is reserved for what a filter cannot express — not counting.
    expect(ORCHESTRATION).toContain('Reserve sparql for a figure no single filter expresses')
    // The old blanket steer is gone.
    expect(ORCHESTRATION).not.toContain('For a count, a total, or any question that reads across many records, write a sparql')
  })

  it('the sparql tool no longer advertises bare counting as its job', () => {
    const description = queryTool().description
    expect(description).toContain('no declared filter expresses')
    expect(description).toContain('counting how many match a declared filter, use\nsearch_collection')
    // "counts" is no longer listed among the sparql tool's own jobs.
    expect(description).not.toContain('totals, averages, counts, grouping')
  })
})
