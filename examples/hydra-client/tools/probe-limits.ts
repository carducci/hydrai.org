import Anthropic from '@anthropic-ai/sdk'

import { DEFAULT_MODEL, readModelCapability, requestShapeFor } from '../src/agent/model'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createContextStore } from '../src/rdf/document-loader'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { projectTools } from '../src/project/tools'
import { buildCapabilityModel, constraintsFor, constraintsOfShape } from '../src/vocab/capability'

import magoShapes from '../test/fixtures/mago-shapes.json'
import magoVocab from '../test/fixtures/mago-vocab.json'

/**
 * Answer, by asking, the three questions this client cannot settle by reading.
 *
 *     ANTHROPIC_API_KEY=<key> npx vite-node tools/probe-limits.ts
 *
 * An operations script rather than a test: each question's answer becomes a code change and a test,
 * and until then a red suite would be reporting a service's behaviour as this code's defect.
 *
 * The three are baseline §3b P1, §3b P2 and task 3.4. P1 was answered once already — by inference
 * from the provider's own documentation, which said the strict grammar "builds from the full
 * toolset" and that deferral and strict "compose". A keyed run returned `Too many strict tools
 * (60)`, so that inference was wrong. Everything below therefore reports what came back rather than
 * what should have.
 */

const KEY = process.env['ANTHROPIC_API_KEY']
if (!KEY) throw new Error('ANTHROPIC_API_KEY is required')

const anthropic = new Anthropic({ apiKey: KEY, dangerouslyAllowBrowser: true })
const log = (line: string) => process.stdout.write(`${line}\n`)

const SEARCH_TOOL = {
  type: 'tool_search_tool_bm25_20251119',
  name: 'tool_search_tool_bm25',
} as const

/** The request's outcome, reduced to the thing being asked about. */
async function attempt(
  label: string,
  build: (model: string, shape: Record<string, unknown>) => Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message | null> {
  const capability = await readModelCapability(anthropic, DEFAULT_MODEL)
  const shape = requestShapeFor(capability) as Record<string, unknown>
  try {
    const response = await anthropic.messages.create(build(capability.id, shape))
    log(`  ${label}: ACCEPTED — stop_reason=${response.stop_reason}`)
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`  ${label}: REJECTED — ${message.replace(/\s+/g, ' ').slice(0, 240)}`)
    return null
  }
}

async function surface() {
  const contexts = createContextStore({
    fetchJson: async (url) => {
      throw new Error(`no network for documents, but ${url} was requested`)
    },
  })
  const graph = createSessionGraph()
  graph.ingestDocument(
    await quadsFromJsonLd(magoVocab, contexts.load, 'http://example.test/Api/Vocab'),
    GRAPHS.vocab,
  )
  graph.ingestDocument(
    await quadsFromJsonLd(magoShapes, contexts.load, 'http://example.test/Api/Shapes'),
    GRAPHS.shapes,
  )
  const model = buildCapabilityModel(graph)
  return projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings: createFindings(),
  })
}

const projected = (await surface()).definitions()
log(`Projected surface: ${projected.length} tools\n`)

// ---------------------------------------------------------------------------------------------
// P1 — does `defer_loading` exempt a tool from the strict cap?
// ---------------------------------------------------------------------------------------------
log('P1  Does defer_loading exempt a tool from the 20-strict cap?')

await attempt('all strict + deferred (what ships today)', (model, shape) => ({
  model,
  messages: [{ role: 'user', content: 'Reply with OK.' }],
  tools: [SEARCH_TOOL, ...projected.map((t) => ({ ...t, defer_loading: true }))] as Anthropic.ToolUnion[],
  ...shape,
}))

await attempt('deferred, strict dropped', (model, shape) => ({
  model,
  messages: [{ role: 'user', content: 'Reply with OK.' }],
  tools: [
    SEARCH_TOOL,
    ...projected.map(({ strict: _strict, ...rest }) => ({ ...rest, defer_loading: true })),
  ] as Anthropic.ToolUnion[],
  ...shape,
}))

await attempt('deferred, strict on the first 20 only', (model, shape) => ({
  model,
  messages: [{ role: 'user', content: 'Reply with OK.' }],
  tools: [
    SEARCH_TOOL,
    ...projected.map(({ strict: _strict, ...rest }, index) =>
      index < 19 ? { ...rest, strict: true, defer_loading: true } : { ...rest, defer_loading: true },
    ),
  ] as Anthropic.ToolUnion[],
  ...shape,
}))

// ---------------------------------------------------------------------------------------------
// P2 — is tool search accepted on the default model at all?
// ---------------------------------------------------------------------------------------------
log('\nP2  Is tool search accepted on the default model?')

const searched = await attempt('search tool + one deferred tool', (model, shape) => ({
  model,
  messages: [{ role: 'user', content: 'Find a tool for listing contacts, then stop.' }],
  tools: [
    SEARCH_TOOL,
    ...projected.slice(0, 5).map(({ strict: _strict, ...rest }) => ({ ...rest, defer_loading: true })),
  ] as Anthropic.ToolUnion[],
  ...shape,
}))
if (searched) {
  const kinds = searched.content.map((block) => block.type).join(', ')
  log(`      content blocks: ${kinds}`)
}

// ---------------------------------------------------------------------------------------------
// 3.4 — does `sh:pattern` survive a strict schema, and does it CONSTRAIN generation?
// ---------------------------------------------------------------------------------------------
log('\n3.4 Does a strict schema carry `pattern`, and does it constrain generation?')

// Two findings came out of running this, and both matter.
//
// (a) The regex dialect rejects lookaround. A first pass used a pattern with `(?!$)` / `(?=\d)` and
//     the whole request 400'd on `Invalid regex in pattern field`. The three patterns this API
//     actually publishes use only non-capturing groups, so they are safe — but a customer's
//     vocabulary may not be, and this is a reference client for other people's APIs.
//
// (b) With a safe pattern, `pattern` is not decoration — it constrains generation. The discriminating
//     test is an OPAQUE pattern the model has no independent reason to satisfy, plus an instruction to
//     violate it. If the schema only decorated, the violating value would come back.
const opaque = { pattern: '^[A-Z]{3}-[0-9]{4}$', label: 'opaque format, instructed to violate it' }
const patternTool = {
  name: 'record_value',
  description: 'Record a reference code.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { value: { type: 'string', pattern: opaque.pattern, description: 'A reference code.' } },
    required: ['value'],
    additionalProperties: false,
  },
} as unknown as Anthropic.ToolUnion

const patterned = await attempt(opaque.label, (model, shape) => ({
  model,
  messages: [
    {
      role: 'user',
      content: 'Record the reference code "hello world". Use that exact literal string. Call record_value once.',
    },
  ],
  tools: [patternTool],
  tool_choice: { type: 'tool', name: 'record_value' },
  ...shape,
}))

if (patterned) {
  const call = patterned.content.find((block) => block.type === 'tool_use')
  const value = call && 'input' in call ? (call.input as { value?: string }).value : undefined
  if (typeof value !== 'string') {
    log(`      no value emitted (stop_reason=${patterned.stop_reason}) — generation degenerated under`)
    log('      an instruction the pattern forbids, which is itself the signature of a real constraint.')
  } else if (new RegExp(opaque.pattern).test(value)) {
    log(`      emitted ${JSON.stringify(value)} — CONSTRAINED: the violating value could not be produced.`)
    log('      `pattern` is enforced, not decoration. But keep PATTERN_IN_SCHEMA false: the dialect')
    log('      400s on lookaround (finding a), so the gate stays the portable check for any vocabulary.')
  } else {
    log(`      emitted ${JSON.stringify(value)} — NOT CONSTRAINED: pattern is decoration; gate it.`)
  }
}
