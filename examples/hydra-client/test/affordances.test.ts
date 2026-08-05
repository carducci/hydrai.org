import { beforeAll, describe, expect, it } from 'vitest'

import { renderAffordanceBlock } from '../src/render/affordances'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS, HYDRA, NS } from '../src/rdf/terms'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  type CapabilityModel,
} from '../src/vocab/capability'
import { projectTools, type ToolSurface } from '../src/project/tools'

import libraryVocab from './fixtures/library-vocab.json'
import magoShapes from './fixtures/mago-shapes.json'
import magoVocab from './fixtures/mago-vocab.json'

/**
 * The page (design D2, D3): every result carries the affordances of what it holds, rendered from
 * the live response graph. These tests build the response documents a conformant server would
 * serve — a resource carrying `hydra:operation`, a collection carrying `hydra:search` and a view —
 * and assert that **every affordance the vocabulary declares renders as an affordance**. The tool
 * count is constant now; this counting discipline is where the fixture's 17 affordances live on.
 */

const LEND = 'https://lending.example/ns#'

function offlineContexts() {
  return createContextStore({
    fetchJson: async (url) => {
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })
}

interface Harness {
  readonly graph: SessionGraph
  readonly model: CapabilityModel
  readonly surface: ToolSurface
}

async function harness(documents: { vocab: unknown; shapes?: unknown }, url: string): Promise<Harness> {
  const graph = createSessionGraph()
  const load = offlineContexts().load
  graph.ingestDocument(await quadsFromJsonLd(documents.vocab, load, url), GRAPHS.vocab)
  if (documents.shapes) {
    graph.ingestDocument(await quadsFromJsonLd(documents.shapes, load, url), GRAPHS.shapes)
  }
  const model = buildCapabilityModel(graph)
  const surface = projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings: createFindings(),
  })
  return { graph, model, surface }
}

/**
 * The response a conformant server serves for one subject of one class: typed, carrying one
 * `hydra:operation` per declared operation and one `hydra:search` per declared template — exactly
 * what this API's Single* wrappers and HydraCollection emit. Expanded JSON-LD, so no context is
 * fetched.
 */
function liveResponseFor(
  subject: string,
  cls: { iri: string; operations: readonly { method: string }[]; templates: readonly { template: string; mappings: readonly { variable: string }[] }[] },
): Record<string, unknown> {
  return {
    '@id': subject,
    '@type': [cls.iri],
    [HYDRA.operation]: cls.operations.map((operation) => ({
      [HYDRA.method]: [{ '@value': operation.method }],
    })),
    [HYDRA.search]: cls.templates.map((template) => ({
      [HYDRA.template]: [{ '@value': template.template }],
      [HYDRA.mapping]: template.mappings.map((mapping) => ({
        [HYDRA.variable]: [{ '@value': mapping.variable }],
      })),
    })),
  }
}

async function ingestLive(graph: SessionGraph, document: Record<string, unknown>, url: string) {
  const quads = await quadsFromJsonLd(document, offlineContexts().load, url)
  graph.ingest(quads, { url, kind: 'dereferenced', fetchedAt: new Date() })
}

describe('every declared affordance renders as an affordance (library fixture)', () => {
  let library: Harness

  beforeAll(async () => {
    library = await harness({ vocab: libraryVocab }, 'https://lending.example/api/vocab')
  })

  it('renders all 17 declared affordances across the classes that declare them', async () => {
    let operationsRendered = 0
    let templatesRendered = 0

    for (const cls of library.model.classes) {
      const subject = `https://lending.example/api/live/${cls.iri.split('#')[1]}`
      await ingestLive(library.graph, liveResponseFor(subject, cls), subject)
      const block = renderAffordanceBlock(subject, {
        graph: library.graph,
        model: library.model,
        surface: library.surface,
      })

      for (const operation of cls.operations) {
        const method = operation.method.toUpperCase()
        // Reads render as envelope routes; writes render as handles. Either way it must be there.
        expect(block, `${method} on <${cls.iri}> must render`).toMatch(new RegExp(`\\b${method}\\b`))
        operationsRendered += 1
      }

      if (cls.templates.length > 0) {
        expect(block).toContain('filterable by')
        for (const template of cls.templates) {
          for (const mapping of template.mappings) {
            // Pagination controls are the client's business, not filters — they are deliberately
            // not advertised, and dispatch still accepts them.
            if (mapping.property === HYDRA.pageIndex) continue
            expect(block, `variable ${mapping.variable} must render`).toContain(mapping.variable)
          }
          templatesRendered += 1
        }
      }
    }

    // The fixture's counting discipline: 15 operations and 2 address forms, none dropped.
    expect(operationsRendered).toBe(15)
    expect(templatesRendered).toBe(2)
  })

  it('offers a write with the registry handle and its subject, and reads via the envelope', async () => {
    const subject = 'https://lending.example/api/tomes/7'
    const tome = library.model.byIri(`${LEND}Tome`)!
    await ingestLive(library.graph, liveResponseFor(subject, tome), subject)

    const surfaced: string[] = []
    const block = renderAffordanceBlock(subject, {
      graph: library.graph,
      model: library.model,
      surface: library.surface,
      onHandleSurfaced: (handle) => surfaced.push(handle),
    })

    expect(block).toContain('`put_Tome`')
    expect(block).toContain('`delete_Tome`')
    expect(block).toContain(`id: this resource's IRI — <${subject}>`)
    // GET is an affordance too — routed through the envelope, not given a handle.
    expect(block).toContain('`get_resource`')
    expect(surfaced.sort()).toEqual(['delete_Tome', 'put_Tome'])
  })

  it('teaches a collection its own filters and the call that applies them', async () => {
    const subject = 'https://lending.example/api/stacks'
    const stacks = library.model.byIri(`${LEND}Stacks`)!
    const document = {
      ...liveResponseFor(subject, stacks),
      [HYDRA.totalItems]: [{ '@value': 40 }],
      [HYDRA.view]: [
        {
          '@id': `${subject}?leaf=1`,
          [HYDRA.next]: [{ '@id': `${subject}?leaf=2` }],
        },
      ],
    }
    await ingestLive(library.graph, document, subject)

    const block = renderAffordanceBlock(subject, {
      graph: library.graph,
      model: library.model,
      surface: library.surface,
    })

    expect(block).toContain('search_collection')
    expect(block).toContain(`collection "${subject}"`)
    for (const variable of ['anything', 'heading', 'isbn']) expect(block).toContain(variable)
    // The pagination variable is a control, not a filter: accepted by dispatch, never advertised.
    expect(block).not.toMatch(/filterable by[^\n]*\bleaf\b/)
    expect(block).toContain('40 members declared')
    expect(block).toContain('further pages exist')
    // POST is declared on the collection, so the write handle rides the listing.
    expect(block).toContain('`post_Stacks`')
  })

  it('reports a live-only operation honestly instead of minting a handle for it', async () => {
    const subject = 'https://lending.example/api/tomes/9'
    const document = {
      '@id': subject,
      '@type': [`${LEND}Tome`],
      [HYDRA.operation]: [
        { [HYDRA.method]: [{ '@value': 'PATCH' }], [HYDRA.expects]: [{ '@id': `${LEND}Tome` }] },
      ],
    }
    await ingestLive(library.graph, document, subject)

    const block = renderAffordanceBlock(subject, {
      graph: library.graph,
      model: library.model,
      surface: library.surface,
    })

    expect(block).toContain('PATCH')
    expect(block).toContain('not described by the vocabulary')
    expect(block).not.toContain('patch_Tome')
  })

  it('renders nothing for a subject the response declared nothing about', () => {
    const block = renderAffordanceBlock('https://lending.example/api/nothing-here', {
      graph: library.graph,
      model: library.model,
      surface: library.surface,
    })
    expect(block).toBe('')
  })
})

describe('contracts in content (mago fixture, design D3)', () => {
  let mago: Harness

  beforeAll(async () => {
    mago = await harness({ vocab: magoVocab, shapes: magoShapes }, 'http://localhost:1648/Api/Vocab')
  })

  it('renders the input contract with constraints the gate will enforce', async () => {
    const contact = mago.model.classes.find((cls) => cls.iri.endsWith('#Contact'))!
    const subject = 'http://localhost:1648/Api/Contact/Id/abc'
    await ingestLive(mago.graph, liveResponseFor(subject, contact), subject)

    const block = renderAffordanceBlock(subject, {
      graph: mago.graph,
      model: mago.model,
      surface: mago.surface,
    })

    const put = mago.surface.tools.find(
      (tool) => tool.dispatch.classIri === contact.iri && tool.dispatch.method === 'PUT',
    )!
    expect(block).toContain(`\`${put.name}\``)
    // The server's own replace-semantics prose leads, verbatim (the task-4.2 rule carries over).
    expect(block).toContain(put.description.split('\n')[0]!.trim())
    // A published maxLength reaches the contract, so a refusal never cites an unshown rule.
    const length = put.dispatch.residue.find((entry) => entry.kind === 'maxLength')
    expect(length).toBeDefined()
    expect(block).toContain(`at most ${length!.value} characters`)
    // The merge rule is restated where it applies.
    expect(block).toContain('carried forward from the current representation')
  })

  it('renders a nested shape one level deep so the tree to send is visible', async () => {
    const contact = mago.model.classes.find((cls) => cls.iri.endsWith('#Contact'))!
    const put = mago.surface.tools.find(
      (tool) => tool.dispatch.classIri === contact.iri && tool.dispatch.method === 'PUT',
    )!
    const nested = Object.entries(put.input_schema.properties ?? {}).find(([, schema]) => schema.$ref)
    expect(nested).toBeDefined()

    const subject = 'http://localhost:1648/Api/Contact/Id/def'
    await ingestLive(mago.graph, liveResponseFor(subject, contact), subject)
    const block = renderAffordanceBlock(subject, {
      graph: mago.graph,
      model: mago.model,
      surface: mago.surface,
    })
    expect(block).toContain(`${nested![0]}: {`)
  })
})

describe('handle derivation (task 1.2)', () => {
  it('derives the same handles across two projections of the same vocabulary', async () => {
    const first = await harness({ vocab: libraryVocab }, 'https://lending.example/api/vocab')
    const second = await harness({ vocab: libraryVocab }, 'https://lending.example/api/vocab')
    expect(first.surface.tools.map((tool) => tool.name)).toEqual(
      second.surface.tools.map((tool) => tool.name),
    )
  })

  it('digest-suffixes a collision deterministically', async () => {
    // Two namespaces declaring the same local name and method: the handles must differ, and the
    // same input must yield the same pair on every projection.
    const vocab = {
      '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { a: 'https://a.example/ns#', b: 'https://b.example/ns#' }],
      '@id': 'https://example.test/api/vocab',
      '@type': 'ApiDocumentation',
      supportedClass: [
        {
          '@id': 'a:Thing',
          '@type': 'Class',
          supportedOperation: [{ '@type': 'Operation', method: 'PUT', expects: 'a:Thing' }],
          supportedProperty: [],
        },
        {
          '@id': 'b:Thing',
          '@type': 'Class',
          supportedOperation: [{ '@type': 'Operation', method: 'PUT', expects: 'b:Thing' }],
          supportedProperty: [],
        },
      ],
    }

    const first = await harness({ vocab }, 'https://example.test/api/vocab')
    const second = await harness({ vocab }, 'https://example.test/api/vocab')

    const handles = first.surface.tools.map((tool) => tool.name).sort()
    expect(handles).toHaveLength(2)
    expect(handles[0]).toBe('put_Thing')
    expect(handles[1]).toMatch(/^put_Thing_[a-z0-9]+$/)
    expect(second.surface.tools.map((tool) => tool.name).sort()).toEqual(handles)
  })
})

/** The renderer must accept blank nodes everywhere Hydra puts them — which is everywhere. */
describe('blank-node discipline', () => {
  it('reads operations and templates through blank nodes, never through labels', async () => {
    const { graph, model, surface } = await harness({ vocab: libraryVocab }, 'https://lending.example/api/vocab')
    const subject = 'https://lending.example/api/stacks'
    const stacks = model.byIri(`${LEND}Stacks`)!
    await ingestLive(graph, liveResponseFor(subject, stacks), subject)

    // Nothing in the rendered block may be a blank-node label leaking through.
    const block = renderAffordanceBlock(subject, { graph, model, surface })
    expect(block).not.toMatch(/_:|\bb\d+_/)
    expect(block.length).toBeGreaterThan(0)
  })
})

/** Guard: the hydra namespace constant is what the fixtures were built against. */
it('reads the same hydra namespace the fixtures use', () => {
  expect(HYDRA.operation).toBe(`${NS.hydra}operation`)
})
