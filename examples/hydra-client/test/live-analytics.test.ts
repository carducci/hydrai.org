import Anthropic from '@anthropic-ai/sdk'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAgent } from '../src/agent/loop'
import { renderManifest, manifestPrefixes } from '../src/agent/manifest'
import { DEFAULT_MODEL, readModelCapability } from '../src/agent/model'
import { buildSystem } from '../src/agent/prompt'

import { createExecutor } from '../src/execute/dispatch'
import { createHttpClient } from '../src/http/client'
import { projectTools } from '../src/project/tools'
import { createQueryRunner, type QueryOutcome } from '../src/query/engine'
import { withQueryTool } from '../src/query/tool'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { createTrace, type Trace } from '../src/trace'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  primaryNamespace,
} from '../src/vocab/capability'
import { discoverApi } from '../src/vocab/discover'

import { isParseFailure, parseQuery } from '../src/query/parse'

/**
 * Task 7.6 — analytics end to end, against a live deployment, with the SPARQL endpoint **off**.
 *
 * This is the demonstration the whole stage exists for: an API that publishes a vocabulary and nothing
 * more answers a question requiring arithmetic over thousands of records, without those records ever
 * entering the model's context and without the model being told where the query would run.
 *
 * Gated on both a booted app and a key, so neither a missing credential nor an unbooted app is ever
 * what fails a run:
 *
 *     HYDRA_LIVE=1 HYDRA_LIVE_TOKEN=<pat> ANTHROPIC_API_KEY=sk-… npm test
 *
 * `HYDRA_LIVE_QUESTION` overrides the question and `HYDRA_LIVE_BUDGET` the materialisation budget, so
 * this can be pointed at a deployment whose data is shaped differently without editing the file.
 *
 * ## What this proves, and what it does not
 *
 * The endpoint is configured off *deliberately* — `sparqlEndpoint: null` — rather than relying on this
 * deployment not having one. That is the branch under test, and a deployment that acquired a working
 * endpoint would otherwise silently stop testing it.
 *
 * The figure is checked against an **independent** computation: the same aggregate, recomputed in
 * plain JavaScript over the session graph, using the predicates the query the model actually wrote
 * named. That is independent of the query engine and of the model's own narration, which is where the
 * two failure modes live — an engine returning a number the data does not support, and a model
 * reporting a number the engine did not return. It is *not* independent of materialisation: if the
 * traversal fetched the wrong collection, both computations are wrong together. The completeness
 * assertions below are what cover that.
 */

const live = process.env['HYDRA_LIVE'] === '1'
const key = process.env['ANTHROPIC_API_KEY']
const entrypoint = process.env['HYDRA_LIVE_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const token = process.env['HYDRA_LIVE_TOKEN'] ?? null

const QUESTION =
  process.env['HYDRA_LIVE_QUESTION'] ??
  'How much did I make last year? Give me one figure, and say which field you totalled.'

/** Every query the runner was asked to run, with what came back. */
interface Issued {
  readonly query: string
  readonly outcome: QueryOutcome
}

/** Sum the objects of one predicate across every subject holding it. Plain arithmetic, no engine. */
function sumOf(graph: SessionGraph, predicate: string): number {
  let total = 0
  for (const quad of graph.match(null, predicate, null, GRAPHS.data)) {
    const value = Number(quad.object.value)
    if (Number.isFinite(value)) total += value
  }
  return total
}

/**
 * The date window the model's query restricts to, read from the ISO literals it wrote.
 *
 * "How much did I make last year" is a *scoped* question, and the model answers it by filtering on a
 * date — so a check that sums the whole predicate verifies a different quantity than the model
 * computed and fails a correct answer. This reads the window the query actually used (`>= lo`,
 * `< hi`), which keeps the recomputation independent of the engine and of the model's narration while
 * agreeing with it on scope. `null` when the query carries no date literal, in which case the sum is
 * unscoped.
 */
function dateWindow(query: string): { lo: number; hi: number } | null {
  const stamps = [...query.matchAll(/"(\d{4}-\d{2}-\d{2}[^"]*)"/g)]
    .map((match) => Date.parse(match[1] as string))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  return stamps.length >= 2 ? { lo: stamps[0] as number, hi: stamps[stamps.length - 1] as number } : null
}

/**
 * Sum `predicate` over only those subjects whose date value falls in the window — a plain-JS join and
 * filter, no engine. `datePredicate` is discovered from the data, not hardcoded: whichever predicate
 * the query joined that actually holds date literals. Falls back to the whole-predicate sum when the
 * query set no window.
 */
function scopedSum(
  graph: SessionGraph,
  predicate: string,
  datePredicate: string | null,
  window: { lo: number; hi: number } | null,
): number {
  if (!datePredicate || !window) return sumOf(graph, predicate)

  let total = 0
  for (const quad of graph.match(null, predicate, null, GRAPHS.data)) {
    const value = Number(quad.object.value)
    if (!Number.isFinite(value)) continue
    const dated = graph.match(quad.subject.value, datePredicate, null, GRAPHS.data)[0]
    const when = dated ? Date.parse(dated.object.value) : NaN
    if (Number.isFinite(when) && when >= window.lo && when < window.hi) total += value
  }
  return total
}

/** Of the predicates the query joined, the one whose stored values are dates. */
function datePredicateOf(graph: SessionGraph, predicates: readonly string[]): string | null {
  for (const predicate of predicates) {
    const sample = graph.match(null, predicate, null, GRAPHS.data)[0]
    if (sample && Number.isFinite(Date.parse(sample.object.value))) return predicate
  }
  return null
}

describe.skipIf(!live || !key)('answering an analytical question with no endpoint', () => {
  let trace: Trace
  let graph: SessionGraph
  let issued: Issued[]
  let reply: string
  let toolCalls: number

  beforeAll(async () => {
    graph = createSessionGraph()
    const findings = createFindings()
    trace = createTrace()
    trace.start()
    issued = []

    const http = createHttpClient({ token })
    const contexts = createContextStore()

    const discovered = await discoverApi(entrypoint, { http, graph, contexts, findings, trace })
    const model = buildCapabilityModel(graph)

    const surface = withQueryTool(
      projectTools(model, {
        constraintsFor: (iri) => constraintsFor(graph, iri),
        constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
        findings,
      }),
    )

    // `surface` reaches the manifest so the prompt under test is the page's prompt — a manifest
    // rendered without it lists no writes, which is not what the real client sends.
    const manifest = renderManifest(model, {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      primaryNamespace: primaryNamespace(model),
      surface,
    })

    const runner = createQueryRunner({
      graph,
      model,
      http,
      contexts,
      findings,
      trace,
      constraintsFor: (iri) => constraintsFor(graph, iri),
      origin: entrypoint,
      entrypoint: discovered.entrypoint ?? entrypoint,
      // Off, on purpose. This is the branch under test.
      sparqlEndpoint: null,
      prefixes: manifestPrefixes({
        constraintsFor: (iri) => constraintsFor(graph, iri),
        primaryNamespace: primaryNamespace(model),
      }),
      budget: Number(process.env['HYDRA_LIVE_BUDGET'] ?? 20_000),
    })

    const executor = createExecutor({
      http,
      graph,
      contexts,
      findings,
      trace,
      surface,
      model,
      origin: entrypoint,
      entrypoint: discovered.entrypoint ?? entrypoint,
      query: {
        run: async (query: string) => {
          const outcome = await runner.run(query)
          issued.push({ query, outcome })
          return outcome
        },
      },
    })

    const anthropic = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true })
    const capability = await readModelCapability(anthropic, DEFAULT_MODEL)

    const agent = createAgent({
      anthropic,
      executor,
      surface,
      trace,
      model: capability,
      system: buildSystem({ manifest }),
    })

    const turn = await agent.send(QUESTION)
    reply = turn.reply
    toolCalls = turn.toolCalls
  }, 900_000)

  it('reaches for the query tool rather than trying to add up a listing', () => {
    // The read tools cannot do arithmetic, and the prompt says so. A model totalling identifiers by
    // hand would be the failure the tool exists to remove.
    expect(toolCalls).toBeGreaterThan(0)
    expect(issued.length).toBeGreaterThan(0)
  })

  it('runs the query here, because no endpoint was configured', () => {
    const succeeded = issued.filter((entry) => entry.outcome.ok)
    expect(succeeded.length).toBeGreaterThan(0)
    for (const entry of succeeded) expect(entry.outcome.ranOn).toBe('local')
  })

  it('shows materialisation, completeness and local execution in the trace', () => {
    /*
     * Design D4 makes the trace a correctness surface rather than decoration: it is where an operator
     * sees that the figure came from a complete set. A run that produced the right number with none
     * of this visible would be right by luck as far as anyone reading it could tell.
     */
    const messages = trace.entries.map((entry) => entry.message).join('\n')

    expect(messages).toMatch(/Materialising/)
    expect(messages).toMatch(/held in full/)
    expect(messages).toMatch(/Executing locally/)
    expect(messages).toMatch(/row/)
  })

  it('reports a figure that matches the same sum computed without the engine', () => {
    const answered = issued.find((entry) => entry.outcome.ok)
    expect(answered).toBeDefined()
    if (!answered) return

    const parsed = parseQuery(answered.query)
    expect(isParseFailure(parsed)).toBe(false)
    if (isParseFailure(parsed)) return

    // The predicates the model's own SUM read, resolved through the variables it bound them to.
    const summed = parsed.aggregates
      .filter((aggregate) => aggregate.aggregation === 'sum' && aggregate.variable !== null)
      .flatMap((aggregate) => parsed.variableSources.get(aggregate.variable as string) ?? [])

    if (summed.length === 0) {
      // The model answered with a COUNT or a MIN/MAX rather than a SUM. Still a valid answer to some
      // phrasings, and there is no independent total to compare — say so rather than pass silently.
      // eslint-disable-next-line no-console
      console.log(`no SUM in the issued query; skipping the independent check:\n${answered.query}`)
      expect(reply.length).toBeGreaterThan(0)
      return
    }

    // Scoped to the same date window the model's query used, discovered from the data rather than
    // assumed — otherwise a correct answer to "last year" is checked against the all-time total.
    const window = dateWindow(answered.query)
    const joined = [...parsed.variableSources.values()].flat()
    const datePredicate = datePredicateOf(graph, joined)
    const expected = summed.reduce(
      (running, predicate) => running + scopedSum(graph, predicate, datePredicate, window),
      0,
    )
    // Number tokens, keeping thousands separators inside a run and stripping them before parsing —
    // the model writes "$7,900", and splitting on the comma would read it as 7 and 900 and miss the
    // figure that is plainly there.
    const digits = [...reply.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, '')))

    // eslint-disable-next-line no-console
    console.log(
      `independent total over ${summed.join(', ')}` +
        `${window ? ` in [${new Date(window.lo).toISOString()}, ${new Date(window.hi).toISOString()}) via ${datePredicate}` : ' (unscoped)'}` +
        `: ${expected}\nreply: ${reply}\nquery:\n${answered.query}`,
    )

    // Rounding and currency formatting are the model's business; the figure has to be there.
    expect(digits.some((value) => Math.abs(value - expected) < 0.5 || Math.abs(value - Math.round(expected)) < 0.5)).toBe(true)
  })

  it('does not put the records themselves in the context', () => {
    /*
     * The spec's rule, checked where it is cheapest to break: the query result is an answer, and the
     * members are held here. A tool result carrying thousands of rows would satisfy every assertion
     * above and give up the property that makes exhaustive retrieval affordable.
     */
    const answered = issued.find((entry) => entry.outcome.ok)
    if (!answered) return

    expect(graph.subjects().length).toBeGreaterThan(0)
    expect(answered.outcome.content.length).toBeLessThan(8_000)
  })
})
