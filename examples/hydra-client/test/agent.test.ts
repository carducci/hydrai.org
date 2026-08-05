import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'

import { createAgent, type Agent } from '../src/agent/loop'
import { readModelCapability, requestShapeFor, type ModelCapability } from '../src/agent/model'
import { buildSystem } from '../src/agent/prompt'
import { createExecutor } from '../src/execute/dispatch'
import { queryTool } from '../src/query/tool'
import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { projectTools } from '../src/project/tools'
import { createTrace, type Trace } from '../src/trace'
import { buildCapabilityModel, constraintsFor, constraintsOfShape } from '../src/vocab/capability'

import libraryVocab from './fixtures/library-vocab.json'

/**
 * The agent loop (tasks 6.1, 6.5, 6.6, 6.7).
 *
 * Every assertion here is about the shape of what goes on the wire, because that is where this
 * stage's mistakes are invisible from the outside. Splitting tool results across messages does not
 * error — it quietly trains the model out of parallel calls. A timestamp in the system prompt does
 * not error — it silently costs the entire cache. Sending back a thinking block you rebuilt from its
 * summary looks identical until the API rejects it.
 *
 * So the model is faked at the transport, the SDK builds the request for real, and the tests read
 * the request bodies.
 */

const LEND = 'https://lending.example/ns#'
const API = 'https://lending.example/api'
const LD_CONTEXT = ['http://www.w3.org/ns/hydra/context.jsonld', { lend: LEND }]

interface MessageStub {
  readonly content: unknown[]
  readonly stop_reason: string
  readonly stop_details?: unknown
  readonly cacheRead?: number
}

/** A canned assistant message, in the shape the API actually returns. */
function reply(stub: MessageStub) {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: stub.content,
    stop_reason: stub.stop_reason,
    stop_sequence: null,
    ...(stub.stop_details === undefined ? {} : { stop_details: stub.stop_details }),
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: stub.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
    },
  }
}

const text = (value: string) => ({ type: 'text', text: value })
const thinking = (value: string, signature: string) => ({ type: 'thinking', thinking: value, signature })
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
})

interface Fake {
  readonly anthropic: Anthropic
  /** Every request body the SDK sent, parsed. */
  readonly sent: Record<string, unknown>[]
}

/** A model that answers from a queue, and records exactly what it was asked. */
function fakeModel(queue: MessageStub[], routes: Record<string, unknown> = {}): Fake {
  const sent: Record<string, unknown>[] = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (route !== undefined) {
      return new Response(JSON.stringify(route), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    sent.push(JSON.parse((init?.body as string) ?? '{}'))
    const next = queue.shift()
    if (!next) throw new Error('the model was called more times than the test expected')

    return new Response(JSON.stringify(reply(next)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return {
    anthropic: new Anthropic({ apiKey: 'test', fetch: fetchImpl, dangerouslyAllowBrowser: true }),
    sent,
  }
}

const TOME = `${API}/tomes/1`
const tomeDocument = {
  '@context': LD_CONTEXT,
  '@id': TOME,
  '@type': 'lend:Tome',
  'lend:heading': 'Dune',
  'lend:isbn': '978-0000000000',
}

interface Harness {
  readonly agent: Agent
  readonly sent: Record<string, unknown>[]
  readonly apiRequests: string[]
  readonly trace: Trace
}

async function harness(
  queue: MessageStub[],
  options: { freshForMs?: number; maxIterations?: number; model?: Partial<ModelCapability> } = {},
): Promise<Harness> {
  const apiRequests: string[] = []
  const apiFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    apiRequests.push(`${init?.method ?? 'GET'} ${url}`)
    const body = url === TOME ? tomeDocument : { '@context': LD_CONTEXT, '@id': url }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/ld+json' },
    })
  }) as unknown as typeof fetch

  const contexts = createContextStore({
    fetchJson: async (url) => {
      throw new Error(`the network must not be reached, but ${url} was requested`)
    },
  })
  const graph = createSessionGraph()
  const findings = createFindings()
  const trace = createTrace()

  graph.ingestDocument(
    await quadsFromJsonLd(libraryVocab, contexts.load, `${API}/vocab`),
    GRAPHS.vocab,
  )

  const model = buildCapabilityModel(graph)
  const surface = projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings,
  })

  const executor = createExecutor({
    http: createHttpClient({ fetchImpl: apiFetch }),
    graph,
    contexts,
    findings,
    trace,
    surface,
    model,
    origin: API,
    ...(options.freshForMs === undefined ? {} : { freshForMs: options.freshForMs }),
  })

  const fake = fakeModel(queue)
  const agent = createAgent({
    anthropic: fake.anthropic,
    executor,
    surface,
    trace,
    model: {
      id: 'claude-sonnet-5',
      displayName: 'Sonnet 5',
      maxOutputTokens: 64_000,
      adaptiveThinking: true,
      effort: true,
      ...options.model,
    },
    system: buildSystem(),
    now: () => new Date('2026-07-30T12:00:00Z'),
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
  })

  return { agent, sent: fake.sent, apiRequests, trace }
}

describe('the tool-use loop', () => {
  it('returns every result from one turn in a single user message', async () => {
    /*
     * Task 6.1's load-bearing rule. Splitting these across messages is not an error — it reads to the
     * model as a turn in which it made one call, so it stops making several. The failure is a model
     * that quietly becomes serial, which no exception will ever tell you about.
     */
    const { agent, sent } = await harness([
      {
        content: [
          toolUse('a', 'follow', { iri: TOME }),
          toolUse('b', 'follow', { iri: `${API}/tomes/2` }),
        ],
        stop_reason: 'tool_use',
      },
      { content: [text('Both are on the shelf.')], stop_reason: 'end_turn' },
    ])

    const turn = await agent.send('check both tomes')

    expect(turn.toolCalls).toBe(2)
    const messages = sent[1]?.messages as { role: string; content: { type: string }[] }[]
    const results = messages.filter((message) =>
      message.content.some?.((block) => block.type === 'tool_result'),
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.content).toHaveLength(2)
    expect(results[0]?.role).toBe('user')
  })

  it('returns a failed tool as a result rather than dropping it', async () => {
    // A dropped result leaves a tool_use with no answer, which the API rejects — and it would hide
    // the refusal the constraint gate exists to deliver.
    const { agent, sent } = await harness([
      {
        content: [
          toolUse('a', 'invoke', {
            affordance: 'put_Loan',
            input: { id: `${API}/loans/1`, guarantor: `${API}/patrons/3` },
          }),
        ],
        stop_reason: 'tool_use',
      },
      { content: [text('I need an identifier for the guarantor first.')], stop_reason: 'end_turn' },
    ])

    await agent.send('set the guarantor')

    const messages = sent[1]?.messages as { content: { type: string; is_error?: boolean }[] }[]
    const result = messages.flatMap((m) => m.content).find((block) => block.type === 'tool_result')
    expect(result?.is_error).toBe(true)
  })

  it('stops on a backstop rather than reporting progress as an answer', async () => {
    const { agent } = await harness(
      [
        { content: [toolUse('a', 'follow', { iri: TOME })], stop_reason: 'tool_use' },
        { content: [toolUse('b', 'follow', { iri: TOME })], stop_reason: 'tool_use' },
      ],
      { maxIterations: 2 },
    )

    const turn = await agent.send('loop forever')

    expect(turn.iterations).toBe(2)
    expect(turn.reply).toMatch(/progress, not a result/)
  })
})

describe('loop integrity', () => {
  it('answers a tool_use even when the executor throws, keeping the history valid', async () => {
    /*
     * The live failure this pins: an exception escaping a tool handler left a tool_use in the
     * history with no tool_result, and the API rejected that request and every one after it —
     * the conversation was poisoned, not just the turn. The loop is the last line: whatever a
     * handler does, every tool_use is answered.
     */
    const fake = fakeModel([
      { content: [toolUse('a', 'follow', { iri: TOME })], stop_reason: 'tool_use' },
      { content: [text('recovered')], stop_reason: 'end_turn' },
      { content: [text('still alive')], stop_reason: 'end_turn' },
    ])
    const throwing = {
      execute: async () => {
        throw new Error('boom')
      },
      decideRead: () => ({ source: 'origin' as const, reason: '', ageMs: null }),
    }

    const agent = createAgent({
      anthropic: fake.anthropic,
      executor: throwing,
      surface: { tools: [], residue: [], byName: () => undefined, definitions: () => [] },
      trace: createTrace(),
      model: {
        id: 'claude-sonnet-5',
        displayName: 'Sonnet 5',
        maxOutputTokens: 64_000,
        adaptiveThinking: false,
        effort: false,
      },
      system: buildSystem(),
      now: () => new Date('2026-08-02T12:00:00Z'),
    })

    const turn = await agent.send('read the tome')
    expect(turn.reply).toBe('recovered')

    // The failure travelled as a tool_result, so the history the next request carries is valid.
    const messages = fake.sent[1]?.messages as { role: string; content: { type: string; is_error?: boolean; content?: string }[] }[]
    const result = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result')
    expect(result?.is_error).toBe(true)
    expect(result?.content).toMatch(/failed inside the client/)

    // And the conversation is not poisoned: the next turn goes through.
    const next = await agent.send('are you still there?')
    expect(next.reply).toBe('still alive')
  })
})

describe('thinking blocks', () => {
  it('asks for summarized thinking, and only where the model accepts it', async () => {
    // The default is `omitted`: blocks still arrive, with empty text. A trace rendering that would
    // show the machinery pausing with nothing to say.
    const supported = await harness([{ content: [text('done')], stop_reason: 'end_turn' }])
    await supported.agent.send('hello')
    expect(supported.sent[0]?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })

    /*
     * And the reason it is conditional: the point of the model selector is to swap to a smaller
     * model and watch the task still complete. Sending a thinking config a model does not accept
     * fails the request outright, which would break the demonstration rather than downgrade it.
     */
    const smaller = await harness([{ content: [text('done')], stop_reason: 'end_turn' }], {
      model: { adaptiveThinking: false },
    })
    await smaller.agent.send('hello')
    expect(smaller.sent[0]?.thinking).toBeUndefined()
  })

  it('echoes the raw block back unchanged, and never the rendered summary', async () => {
    /*
     * Task 6.5. Reconstructing a thinking block from what was displayed produces a block the model
     * did not write, and the API rejects modified thinking — so the raw block is what goes back.
     */
    const block = thinking('I should read the tome first.', 'sig-abc')
    const { agent, sent, trace } = await harness([
      { content: [block, toolUse('a', 'follow', { iri: TOME })], stop_reason: 'tool_use' },
      { content: [text('It is Dune.')], stop_reason: 'end_turn' },
    ])

    await agent.send('what is tome 1?')

    const messages = sent[1]?.messages as { role: string; content: unknown[] }[]
    const assistant = messages.find((message) => message.role === 'assistant')
    expect(assistant?.content[0]).toEqual(block)

    // …and it is surfaced in the trace as its own kind, rather than mixed into the reply.
    expect(trace.entries.some((entry) => entry.kind === 'think')).toBe(true)
  })
})

describe('stop reasons', () => {
  it('reports a decline without reaching into the content', async () => {
    // A declined request answers 200 with no content at all, so anything that reads the first block
    // unconditionally breaks here instead of reporting what happened.
    const { agent } = await harness([
      { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } },
    ])

    const turn = await agent.send('something declined')

    expect(turn.stopReason).toBe('refusal')
    expect(turn.reply).toMatch(/declined this request \(cyber\)/)
  })

  it('reports a truncated reply as truncated', async () => {
    const { agent } = await harness([
      { content: [text('The first half of an answer')], stop_reason: 'max_tokens' },
    ])

    const turn = await agent.send('write at length')
    expect(turn.reply).toMatch(/cut off at the output limit/)
  })

  it('resumes a paused turn by re-sending, without inventing a user message', async () => {
    const { agent, sent } = await harness([
      { content: [text('working')], stop_reason: 'pause_turn' },
      { content: [text('done')], stop_reason: 'end_turn' },
    ])

    const turn = await agent.send('long job')

    expect(turn.iterations).toBe(2)
    const messages = sent[1]?.messages as { role: string }[]
    expect(messages[messages.length - 1]?.role).toBe('assistant')
  })
})

describe('what goes on the wire', () => {
  it('caches tools and system together, and puts the time after the breakpoint', async () => {
    const { agent, sent } = await harness([
      { content: [text('hi')], stop_reason: 'end_turn' },
    ])

    await agent.send('hello')

    const system = sent[0]?.system as { text: string; cache_control?: unknown }[]
    expect(system.filter((block) => block.cache_control !== undefined)).toHaveLength(1)
    expect(system[system.length - 1]?.cache_control).toBeDefined()

    // The POC's defect, pinned from the wire side: no timestamp anywhere in the cached prefix.
    for (const block of system) expect(block.text).not.toMatch(/2026-07-30/)
    const messages = sent[0]?.messages as { content: { text: string }[] }[]
    expect(messages[0]?.content[0]?.text).toMatch(/2026-07-30/)

    // Tools render ahead of system, so they are inside the same cached prefix.
    expect((sent[0]?.tools as unknown[]).length).toBeGreaterThan(0)
  })

  it('sends the constant envelope, in its fixed order, with nothing deferred', async () => {
    const { agent, sent } = await harness([{ content: [text('hi')], stop_reason: 'end_turn' }])
    await agent.send('hello')

    const tools = sent[0]?.tools as { name: string; strict?: boolean; defer_loading?: boolean }[]
    // The surface is constant across APIs — the order is fixed, so the cached prefix never moves.
    expect(tools.map((tool) => tool.name)).toEqual([
      'follow',
      'search_collection',
      'get_resource',
      'invoke',
    ])
    expect(tools.every((tool) => tool.defer_loading === undefined)).toBe(true)
    // Strict where free (architecture note §8): iri-only tools carry it, open-object tools do not.
    expect(tools.filter((tool) => tool.strict).map((tool) => tool.name)).toEqual([
      'follow',
      'get_resource',
    ])
  })
})

describe('session memory across turns', () => {
  it('answers a second turn from what the first turn found, and says so', async () => {
    /*
     * Task 6.7, and the point of task 6.6: holding retrieved data is what makes multi-step work
     * possible. The disclosure is not decoration — design D4 forbids the store silently substituting
     * for a fetch, so a served-from-store answer has to name its source and its age.
     */
    const { agent, sent, apiRequests, trace } = await harness(
      [
        { content: [toolUse('a', 'follow', { iri: TOME })], stop_reason: 'tool_use' },
        { content: [text('It is Dune.')], stop_reason: 'end_turn' },
        { content: [toolUse('b', 'follow', { iri: TOME })], stop_reason: 'tool_use' },
        { content: [text('Still Dune.')], stop_reason: 'end_turn' },
      ],
      { freshForMs: 60_000 },
    )

    await agent.send('what is tome 1 called?')
    const first = apiRequests.length

    await agent.send('and its heading again?')

    expect(first).toBe(1)
    expect(apiRequests).toHaveLength(1)
    expect(trace.entries.some((entry) => /Served <.*> from the store/.test(entry.message))).toBe(true)

    // The second turn carries the first turn's history, so "again" has something to refer to.
    const lastRequest = sent[sent.length - 1]?.messages as unknown[]
    expect(lastRequest.length).toBeGreaterThan(4)
  })
})

describe('model capability', () => {
  it('reads what the model accepts rather than assuming it', async () => {
    const fake = fakeModel([], {
      'https://api.anthropic.com/v1/models/claude-sonnet-5': {
        id: 'claude-sonnet-5',
        display_name: 'Claude Sonnet 5',
        max_tokens: 128_000,
        capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: true } },
      },
    })

    const capability = await readModelCapability(fake.anthropic, 'claude-sonnet-5')

    expect(capability).toMatchObject({ adaptiveThinking: true, effort: true, maxOutputTokens: 128_000 })
    // The configured cap still wins where it is lower — it is sized for a non-streaming request.
    expect(requestShapeFor(capability).max_tokens).toBe(16_000)
  })

  it('falls back to the shape every model accepts when the lookup fails', async () => {
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const anthropic = new Anthropic({
      apiKey: 'test',
      fetch: failing,
      maxRetries: 0,
      dangerouslyAllowBrowser: true,
    })

    const capability = await readModelCapability(anthropic, 'some-model-this-file-never-heard-of')

    expect(capability.adaptiveThinking).toBe(false)
    expect(requestShapeFor(capability).thinking).toBeUndefined()
  })
})

describe('effort scales to the task', () => {
  const capable: ModelCapability = {
    id: 'claude-sonnet-5',
    displayName: 'Sonnet 5',
    maxOutputTokens: 64_000,
    adaptiveThinking: false,
    effort: true,
  }

  it('carries the requested effort only where the model accepts the control', () => {
    // Task 1.1: emitted as output_config.effort for an effort-capable model…
    expect(requestShapeFor(capable, 'low').output_config).toEqual({ effort: 'low' })
    expect(requestShapeFor(capable, 'high').output_config).toEqual({ effort: 'high' })

    // …omitted for one without it, exactly like the thinking config.
    expect(requestShapeFor({ ...capable, effort: false }, 'high').output_config).toBeUndefined()

    // …and omitted when no effort is asked for, unchanged from before.
    expect(requestShapeFor(capable).output_config).toBeUndefined()
  })

  it('runs an ordinary routing turn at low effort', async () => {
    // Task 1.2: nothing hard happened, so the request carries the model's lower effort.
    const { agent, sent } = await harness([{ content: [text('done')], stop_reason: 'end_turn' }])
    await agent.send('hello')
    expect(sent[0]?.output_config).toEqual({ effort: 'low' })
  })

  it('raises the turn after a refused query to high effort, then reverts', async () => {
    /*
     * Task 1.3 / design D4. A query the gate refused makes the *next* turn — the one that reworks it —
     * worth more reasoning; the turn after is ordinary again. Built with a query tool on the surface
     * and an executor that refuses it, so the escalation is exercised end to end.
     */
    const query = queryTool()
    const surface = {
      tools: [query],
      residue: [],
      byName: (name: string) => (name === query.name ? query : undefined),
      definitions: () => [],
    }
    const executor = {
      execute: async (name: string) =>
        name === query.name
          ? { ok: false, content: 'Refused — an undeclared term.', status: null, requested: false }
          : { ok: true, content: 'ok', status: 200, requested: true },
      decideRead: () => ({ source: 'origin' as const, reason: '', ageMs: null }),
    }

    const fake = fakeModel([
      { content: [toolUse('a', query.name, { query: 'SELECT ...' })], stop_reason: 'tool_use' },
      { content: [text('revised')], stop_reason: 'end_turn' },
      { content: [text('ordinary')], stop_reason: 'end_turn' },
    ])
    const trace = createTrace()
    const agent = createAgent({
      anthropic: fake.anthropic,
      executor,
      surface,
      trace,
      model: capable,
      system: buildSystem(),
      now: () => new Date('2026-08-05T12:00:00Z'),
    })

    await agent.send('average fee on booked gigs')

    // The query turn is low; the revision turn that follows it is high.
    expect(fake.sent[0]?.output_config).toEqual({ effort: 'low' })
    expect(fake.sent[1]?.output_config).toEqual({ effort: 'high' })
    expect(trace.entries.some((entry) => /high effort/.test(entry.message))).toBe(true)

    // A later, unrelated turn is back to low — the escalation lasted exactly one turn.
    await agent.send('anything else')
    expect(fake.sent[2]?.output_config).toEqual({ effort: 'low' })
  })

  it('omits effort entirely for a model without the control', async () => {
    const { agent, sent } = await harness([{ content: [text('done')], stop_reason: 'end_turn' }], {
      model: { effort: false },
    })
    await agent.send('hello')
    expect(sent[0]?.output_config).toBeUndefined()
  })
})
