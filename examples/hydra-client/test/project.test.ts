import { beforeAll, describe, expect, it } from 'vitest'

import { createContextStore } from '../src/rdf/document-loader'
import { createFindings, FINDING_KINDS, type Findings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS, HYDRA } from '../src/rdf/terms'
import { buildCapabilityModel, constraintsFor, constraintsOfShape } from '../src/vocab/capability'
import { PATTERN_IN_SCHEMA, projectTools, type JsonSchema, type ToolSurface } from '../src/project/tools'
import { toolsForRequest } from '../src/agent/tools'
import { withQueryTool } from '../src/query/tool'

import libraryVocab from './fixtures/library-vocab.json'
import magoShapes from './fixtures/mago-shapes.json'
import magoVocab from './fixtures/mago-vocab.json'

const LEND = 'https://lending.example/ns#'

function offlineContexts() {
  return createContextStore({
    fetchJson: async (url) => {
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })
}

async function surfaceFor(
  documents: { vocab: unknown; shapes?: unknown },
  url: string,
): Promise<{ surface: ToolSurface; graph: SessionGraph; findings: Findings }> {
  const graph = createSessionGraph()
  const load = offlineContexts().load
  graph.ingestDocument(await quadsFromJsonLd(documents.vocab, load, url), GRAPHS.vocab)
  if (documents.shapes) {
    graph.ingestDocument(await quadsFromJsonLd(documents.shapes, load, url), GRAPHS.shapes)
  }

  const findings = createFindings()
  const surface = projectTools(buildCapabilityModel(graph), {
    constraintsFor: (classIri) => constraintsFor(graph, classIri),
    constraintsOfShape: (shapeIri) => constraintsOfShape(graph, shapeIri),
    findings,
  })
  return { surface, graph, findings }
}

/** Walk every object node in a schema, including `$defs`. */
function objectNodes(schema: JsonSchema, found: JsonSchema[] = []): JsonSchema[] {
  if (schema.type === 'object') found.push(schema)
  for (const child of Object.values(schema.properties ?? {})) objectNodes(child, found)
  for (const child of Object.values(schema.$defs ?? {})) objectNodes(child, found)
  return found
}

/**
 * The genericity proof, carried one layer up (tasks 4.1-4.5, design D1 and D11).
 *
 * `library-vocab.json` describes an API that does not exist. If it projects a usable toolset with no
 * code change, the projection function is the generic artifact the proposal claims it is.
 */
describe('projecting an API the source has never seen', () => {
  let surface: ToolSurface

  beforeAll(async () => {
    surface = (await surfaceFor({ vocab: libraryVocab }, 'https://lending.example/api/vocab')).surface
  })

  it('produces one tool per declared operation, and one per collection queried', () => {
    // 7 classes: Ledger(2) Loan(3) Patron(2) Roster(2) Stack(1) Stacks(2) Tome(3) = 15 operations.
    // Stacks' GET is absorbed into the tool that queries it, leaving 14; its 2 templates fold into
    // that one tool. Nothing published is unreachable — 17 affordances, 15 names.
    expect(surface.tools).toHaveLength(15)
    expect(surface.tools.filter((t) => t.dispatch.kind === 'operation')).toHaveLength(14)
    expect(surface.tools.filter((t) => t.dispatch.kind === 'template')).toHaveLength(1)

    // The count that matters is that no declared template was dropped on the way in.
    const forms = surface.tools.flatMap((t) => t.dispatch.templates)
    expect(forms).toHaveLength(2)
  })

  it('names tools from the declared method and the declaring class', () => {
    const names = surface.tools.map((t) => t.name)
    expect(names).toContain('put_Tome')
    expect(names).toContain('delete_Tome')
    expect(names).toContain('post_Stacks')

    // The POST is declared on the collection and dispatches against it, so it is named for the
    // collection — not for lend:Tome, which is merely what it expects.
    expect(surface.byName('post_Stacks')?.dispatch.classIri).toBe(`${LEND}Stacks`)
    expect(surface.byName('post_Stacks')?.dispatch.expects).toBe(`${LEND}Tome`)
  })

  it('names a folded tool from what its variables bind to, not from the label', () => {
    // The pagination template's variable is "leaf" and its label says "Page through the stacks";
    // neither is consulted. hydra:pageIndex is.
    //
    // Stacks publishes both a pagination and a free-text template, and they fold into one tool: they
    // are two addresses for querying one collection, not two capabilities. The name reports the most
    // the tool can do, so free-text wins over paging — still derived from the bindings, still with no
    // table to maintain.
    const folded = surface.byName('search_Stacks')
    expect(folded).toBeDefined()
    expect(surface.byName('list_Stacks')).toBeUndefined()

    const kinds = folded?.dispatch.templates.map((form) => form.kind)
    expect(kinds).toContain('pagination')
    expect(kinds).toContain('freetext')

    // Both addresses survive the fold — folding must not drop one.
    expect(folded?.dispatch.templates.map((form) => form.template)).toContain(
      'https://lending.example/api/stacks/leaf/{leaf}',
    )
  })

  it('absorbs a collection GET into the tool that queries it', () => {
    // The folded tool takes no required input, so calling it with nothing supplied *is* the plain
    // GET. Emitting both published two names for one request and gave the model nothing to choose
    // between them on.
    expect(surface.byName('get_Stacks')).toBeUndefined()
    expect(surface.byName('search_Stacks')?.input_schema.required).toEqual([])

    // Only GET is absorbed. POST on the same collection is a different act and stays.
    expect(surface.byName('post_Stacks')).toBeDefined()
  })

  it('emits names matching the required pattern', () => {
    for (const tool of surface.tools) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('emits a strict-conformant schema for every tool', () => {
    for (const tool of surface.tools) {
      expect(tool.strict).toBe(true)
      // Strict structured outputs requires additionalProperties: false and a required array on
      // every object — nested ones included.
      for (const node of objectNodes(tool.input_schema)) {
        expect(node.additionalProperties).toBe(false)
        expect(Array.isArray(node.required)).toBe(true)
      }
    }
  })

  it('asks for a subject IRI on a resource operation and not on a collection', () => {
    const put = surface.byName('put_Tome')
    expect(put?.dispatch.needsSubject).toBe(true)
    expect(put?.input_schema.properties?.id?.format).toBe('uri')
    expect(put?.input_schema.required).toContain('id')

    // A collection's own IRI comes from discovery, so there is nothing for the model to supply.
    const post = surface.byName('post_Stacks')
    expect(post?.dispatch.needsSubject).toBe(false)
    expect(post?.input_schema.properties?.id).toBeUndefined()
  })

  it('projects only writeable properties into a write body', () => {
    // hydra:member is readable and not writeable, so a POST body must not offer it.
    const post = surface.byName('post_Stacks')
    const names = Object.keys(post?.input_schema.properties ?? {})
    expect(names).toContain('heading')
    expect(names).toContain('isbn')
    expect(names).not.toContain('member')
  })

  it('carries a required declaration into required[]', () => {
    const post = surface.byName('post_Stacks')
    expect(post?.input_schema.required).toContain('heading')
    expect(post?.input_schema.required).not.toContain('isbn')
  })

  it('keeps the vocabulary’s description verbatim (task 4.2)', () => {
    const put = surface.byName('put_Tome')
    const declared =
      'Replaces the entire tome. Every writeable property not supplied is cleared, so read the ' +
      'current representation first and send it back in full with your changes applied.'

    // Verbatim and leading — this paragraph is what stops a model mangling an update, so it must
    // reach the model unparaphrased.
    expect(put?.description).toContain(declared)
    expect(put?.description.startsWith(declared)).toBe(true)
  })

  it('reports a declared outcome by its declared meaning', () => {
    // A 402 becomes a described outcome rather than a status code plus a slice of the body.
    const put = surface.byName('put_Loan')
    expect(put?.description).toMatch(/402/)
    expect(put?.description).toMatch(/fines/)
    expect(put?.dispatch.possibleStatus.map((s) => s.code)).toEqual([402, 423])
  })

  it('binds every schema property to its predicate IRI', () => {
    // The name is a label for the model; the IRI is the identity the payload is built from.
    const post = surface.byName('post_Stacks')
    const byName = new Map(post?.dispatch.bindings.map((b) => [b.name, b.property]))
    expect(byName.get('heading')).toBe(`${LEND}heading`)
    expect(byName.get('isbn')).toBe(`${LEND}isbn`)
    // The subject is not a predicate.
    expect(surface.byName('put_Tome')?.dispatch.bindings.find((b) => b.name === 'id')?.property).toBeNull()
  })

  it('binds template variables to their properties', () => {
    const search = surface.byName('search_Stacks')
    const byName = new Map(search?.dispatch.bindings.map((b) => [b.name, b.property]))
    expect(byName.get('anything')).toBe(HYDRA.freetextQuery)
    expect(byName.get('heading')).toBe(`${LEND}heading`)

    // A page index is an ordinal whatever the vocabulary named the variable.
    expect(surface.byName('search_Stacks')?.input_schema.properties?.leaf?.type).toBe('integer')
  })

  it('keeps an undeclared Link range as a field and records it, rather than dropping it', () => {
    // Design D8, and the concrete defect the POC had at index.html:608. lend:guarantor is a Link
    // with no range; the field must survive into the schema so the task can still be attempted.
    const put = surface.byName('put_Loan')
    expect(Object.keys(put?.input_schema.properties ?? {})).toContain('guarantor')
    expect(put?.input_schema.properties?.guarantor?.format).toBe('uri')

    const escalation = put?.dispatch.residue.find((r) => r.kind === 'undeclaredLinkRange')
    expect(escalation?.property).toBe(`${LEND}guarantor`)
    expect(escalation?.message).toMatch(/no declared range/)
  })

  it('records an undeclared Link range as a conformance finding', async () => {
    const { findings } = await surfaceFor({ vocab: libraryVocab }, 'https://lending.example/api/vocab')
    const kinds = findings.all().map((f) => f.kind)
    expect(kinds).toContain(FINDING_KINDS.undeclaredLinkRange)
  })

  it('is byte-identical across two projections of the same vocabulary (task 4.4)', async () => {
    const again = await surfaceFor({ vocab: libraryVocab }, 'https://lending.example/api/vocab')

    // The wire form is what sits at prompt-prefix position 0; any reordering invalidates the whole
    // cache on every request.
    expect(JSON.stringify(again.surface.definitions())).toBe(JSON.stringify(surface.definitions()))
    // And the dispatch map with it, so a reconnect resolves the same names to the same requests.
    expect(JSON.stringify(again.surface.tools)).toBe(JSON.stringify(surface.tools))
  })

  it('yields exactly one new tool when the vocabulary declares one more operation (task 4.5)', async () => {
    // Deliberately typed loosely rather than as `typeof libraryVocab`: the point of the test is to
    // add a declaration the fixture's inferred shape does not have.
    const extended = JSON.parse(JSON.stringify(libraryVocab)) as {
      supportedClass: { '@id': string; supportedOperation: unknown[] }[]
    }
    const tome = extended.supportedClass.find((cls) => cls['@id'] === 'lend:Tome')!
    tome.supportedOperation.push({
      '@type': 'Operation',
      title: 'Amend a tome',
      method: 'PATCH',
      expects: 'lend:Tome',
      returns: 'lend:Tome',
    })

    const after = (await surfaceFor({ vocab: extended }, 'https://lending.example/api/vocab')).surface

    expect(after.tools).toHaveLength(surface.tools.length + 1)
    expect(after.byName('patch_Tome')).toBeDefined()

    // A method the client has no mapping table for still names itself correctly, because the name
    // comes from what the server declared. And nothing else moved.
    const before = new Set(surface.tools.map((t) => t.name))
    const added = after.tools.filter((t) => !before.has(t.name)).map((t) => t.name)
    expect(added).toEqual(['patch_Tome'])
    expect(JSON.stringify(after.tools.filter((t) => before.has(t.name)))).toBe(JSON.stringify(surface.tools))
  })
})

describe('the same projection against the real vocabulary and shapes', () => {
  let surface: ToolSurface

  beforeAll(async () => {
    surface = (
      await surfaceFor({ vocab: magoVocab, shapes: magoShapes }, 'http://localhost:1648/Api/Vocab')
    ).surface
  })

  it('projects a tool surface from the live documents', () => {
    expect(surface.tools.length).toBeGreaterThan(30)
    for (const tool of surface.tools) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(new Set(surface.tools.map((t) => t.name)).size).toBe(surface.tools.length)
  })

  it('turns sh:in into an enum the model cannot deviate from (design D3)', () => {
    const enums = surface.tools.flatMap((tool) =>
      Object.entries(tool.input_schema.properties ?? {})
        .filter(([, schema]) => Array.isArray(schema.enum))
        .map(([name, schema]) => ({ name, values: schema.enum! })),
    )

    // The highest-value row in the D3 table: a prose hint becomes a fixed set.
    expect(enums.length).toBeGreaterThan(0)
    expect(enums.every((entry) => entry.values.length > 1)).toBe(true)
  })

  it('maps declared datatypes to types and formats', () => {
    const schemas = surface.tools.flatMap((tool) => Object.values(tool.input_schema.properties ?? {}))
    expect(schemas.some((s) => s.type === 'string' && s.format === 'date-time')).toBe(true)
    expect(schemas.some((s) => s.type === 'boolean')).toBe(true)
    expect(schemas.some((s) => s.type === 'number')).toBe(true)
    expect(schemas.some((s) => s.type === 'string' && s.format === 'uri')).toBe(true)
    expect(schemas.some((s) => s.type === 'string' && s.format === 'duration')).toBe(true)
  })

  it('resolves sh:node into $defs, including a shape with no target class', () => {
    // ns:UserRefShape declares no sh:targetClass, so it is reachable only through sh:node — which is
    // why the projection needs a shape-by-IRI read and not just constraintsFor.
    const withDefs = surface.tools.filter((tool) => tool.input_schema.$defs)
    expect(withDefs.length).toBeGreaterThan(0)

    const defNames = new Set(withDefs.flatMap((tool) => Object.keys(tool.input_schema.$defs!)))
    expect(defNames).toContain('PostalAddressShape')

    const nested = withDefs.find((tool) => tool.input_schema.$defs?.PostalAddressShape)!
    const postal = nested.input_schema.$defs!.PostalAddressShape!
    expect(postal.type).toBe('object')
    expect(Object.keys(postal.properties ?? {}).length).toBeGreaterThan(0)

    // Something must actually point at it, or the $defs entry is dead weight.
    const refs = Object.values(nested.input_schema.properties ?? {}).filter((s) => s.$ref)
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every((s) => s.$ref!.startsWith('#/$defs/'))).toBe(true)
  })

  it('records the constraints JSON Schema cannot carry, as the gate’s input (task 4.3)', () => {
    const kinds = new Set(surface.residue.map((entry) => entry.kind))

    // Every one of these is a real published constraint that a strict schema cannot express, so it
    // has to be checked before dispatch instead. This list is what stage 5 gates on.
    expect(kinds).toContain('maxLength')
    expect(kinds).toContain('class')
    expect(kinds).toContain('pattern')

    for (const entry of surface.residue) {
      expect(entry.property).toBeTruthy()
      expect(entry.message.length).toBeGreaterThan(0)
    }
  })

  it('leaves cardinality out of the residue, because this API only ever declares 1', () => {
    /*
     * Measured, not assumed: all 182 `sh:maxCount` declarations in this shapes graph are `1`, and
     * all 11 `sh:minCount` are `1`. A maxCount of 1 is already what a non-array schema says and a
     * minCount of 1 is `required[]`, so cardinality here is fully expressible and gates nothing.
     *
     * Design D3's "array constraints unsupported" row is still correct as a rule — the test below
     * proves a genuine plurality does gate — it just never fires against this vocabulary. Asserting
     * it fired would have been asserting a defect this API does not have.
     */
    expect([...new Set(surface.residue.map((entry) => entry.kind))]).not.toContain('maxCount')
  })

  it('never emits a JSON Schema keyword strict mode rejects', () => {
    // maxLength/minLength/maxCount/minimum are documented as unsupported. Emitting one would be
    // rejected at the API boundary, taking every tool down with it.
    const forbidden = ['maxLength', 'minLength', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems']
    const seen = JSON.stringify(surface.definitions())
    for (const keyword of forbidden) expect(seen).not.toContain(`"${keyword}"`)
  })

  it('gates sh:pattern rather than emitting it, until task 3.4 measures it', () => {
    // Design D3 left this open and 3.4 has not run. `pattern` is documented as neither supported
    // nor unsupported, so the gate is the side that is correct under either answer.
    expect(PATTERN_IN_SCHEMA).toBe(false)

    const patterns = surface.residue.filter((entry) => entry.kind === 'pattern')
    expect(patterns.length).toBeGreaterThan(0)
    expect(JSON.stringify(surface.definitions())).not.toContain('"pattern"')
  })

  it('is byte-identical across two projections of the live documents', async () => {
    const again = await surfaceFor(
      { vocab: magoVocab, shapes: magoShapes },
      'http://localhost:1648/Api/Vocab',
    )
    expect(JSON.stringify(again.surface.tools)).toBe(JSON.stringify(surface.tools))
  })
})

/**
 * The envelope invariant (task 2.4): the wire surface is constant, and every declared affordance
 * stays reachable through it — operations by handle via `invoke`, templates via
 * `search_collection`, reads via `follow`/`get_resource`. The registry the tests above pin is what
 * makes that reachability checkable: a record that exists, byName-resolvable, is an affordance
 * `invoke` can dispatch.
 */
describe('every affordance is reachable through the constant envelope', () => {
  it('library fixture: 17 affordances behind a constant tool count', async () => {
    const { surface } = await surfaceFor({ vocab: libraryVocab }, 'https://lending.example/api/vocab')
    const wire = toolsForRequest(withQueryTool(surface))

    // The wire count is constant — five, regardless of what the vocabulary declares.
    expect(wire.count).toBe(5)

    // Every registry record resolves by its handle, which is exactly what `invoke` does.
    for (const record of surface.tools) {
      expect(surface.byName(record.name)).toBe(record)
    }

    // 14 operation records (the folded collection GET is absorbed by search_collection), 1 folded
    // template record carrying both declared address forms: 15 + 2 = 17 affordances reachable.
    expect(surface.tools.filter((tool) => tool.dispatch.kind === 'operation')).toHaveLength(14)
    const forms = surface.tools.flatMap((tool) => tool.dispatch.templates)
    expect(forms).toHaveLength(2)
  })

  it('the same five names against the real vocabulary', async () => {
    const { surface } = await surfaceFor(
      { vocab: magoVocab, shapes: magoShapes },
      'http://localhost:1648/Api/Vocab',
    )
    const wire = toolsForRequest(withQueryTool(surface))
    expect((wire.tools as unknown as { name: string }[]).map((tool) => tool.name)).toEqual([
      'follow',
      'search_collection',
      'get_resource',
      'invoke',
      'sparql',
    ])
  })
})

/**
 * A cardinality constraint this API happens never to publish.
 *
 * Both real documents declare `sh:maxCount` only as `1`, which a non-array schema already says. That
 * makes the D3 "array constraints unsupported" row unexercised against them — so it is exercised
 * here instead, against a shape written for the purpose. A rule covered only by an
 * assert-it-did-not-fire is a rule with no test.
 */
describe('a cardinality constraint no schema can express', () => {
  const NAMESPACE = 'https://example.test/ns#'

  const vocab = {
    '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { ex: NAMESPACE }],
    '@id': 'https://example.test/api/vocab',
    '@type': 'ApiDocumentation',
    supportedClass: [
      {
        '@id': 'ex:Thing',
        '@type': 'Class',
        title: 'Thing',
        supportedOperation: [
          { '@type': 'Operation', title: 'Replace a thing', method: 'PUT', expects: 'ex:Thing' },
        ],
        supportedProperty: [
          {
            '@type': 'SupportedProperty',
            property: 'ex:tag',
            title: 'tag',
            readable: true,
            writeable: true,
            required: false,
          },
        ],
      },
    ],
  }

  const shapes = {
    '@context': {
      sh: 'http://www.w3.org/ns/shacl#',
      ex: NAMESPACE,
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      'sh:targetClass': { '@type': '@id' },
      'sh:path': { '@type': '@id' },
      'sh:datatype': { '@type': '@id' },
    },
    '@id': 'ex:ThingShape',
    '@type': 'sh:NodeShape',
    'sh:targetClass': 'ex:Thing',
    'sh:property': [{ 'sh:path': 'ex:tag', 'sh:datatype': 'xsd:string', 'sh:maxCount': 3 }],
  }

  it('gates a genuine plurality rather than emitting it', async () => {
    const { surface } = await surfaceFor({ vocab, shapes }, 'https://example.test/api/vocab')

    const gated = surface.residue.find((entry) => entry.kind === 'maxCount')
    expect(gated?.property).toBe(`${NAMESPACE}tag`)
    expect(gated?.value).toBe(3)
    expect(gated?.message).toMatch(/at most 3 values/)

    // And it stays out of what the model sees, because the schema cannot say it.
    expect(JSON.stringify(surface.definitions())).not.toContain('maxCount')
  })
})
