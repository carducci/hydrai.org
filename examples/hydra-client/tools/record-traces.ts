import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import Anthropic from '@anthropic-ai/sdk'

import { createAgent, type TurnResult } from '../src/agent/loop'
import { renderManifest, manifestPrefixes } from '../src/agent/manifest'
import { DEFAULT_MODEL, readModelCapability } from '../src/agent/model'
import { buildSystem } from '../src/agent/prompt'
import { createExecutor } from '../src/execute/dispatch'
import { locateClass } from '../src/execute/locate'
import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { createSessionGraph } from '../src/rdf/session-graph'
import { createTrace, formatElapsed } from '../src/trace'
import { projectTools } from '../src/project/tools'
import { createQueryRunner, type QueryOutcome } from '../src/query/engine'
import { withQueryTool } from '../src/query/tool'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  primaryNamespace,
} from '../src/vocab/capability'
import { discoverApi } from '../src/vocab/discover'

/**
 * Tasks 5.4 and 6.2 — live through-the-agent runs, each recorded as a markdown trace in the change
 * directory. One fresh session per scenario: connect, send the prompts, dump the full trace, every
 * outbound request (write bodies verbatim), every SPARQL issued, and the reply.
 *
 *     HYDRA_LIVE_TOKEN=<pat> ANTHROPIC_API_KEY=<key> npx vite-node tools/record-traces.ts
 *
 * The record is evidence for the change archive, so nothing is asserted here — what happened is
 * written down, including failures. The suite is where assertions live.
 */

const ENTRYPOINT = process.env['HYDRA_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const TOKEN = process.env['HYDRA_LIVE_TOKEN'] ?? null
const KEY = process.env['ANTHROPIC_API_KEY']
if (!KEY) throw new Error('ANTHROPIC_API_KEY is required')

const OUT_DIR = fileURLToPath(
  new URL(
    process.env['HYDRA_TRACE_DIR'] ?? '../../../../openspec/changes/deterministic-agent-surface/',
    import.meta.url,
  ),
)

interface Recorded {
  readonly method: string
  readonly url: string
  readonly body?: string
}

interface PromptRecord {
  readonly prompt: string
  readonly turn: TurnResult
  readonly requests: readonly Recorded[]
  readonly queries: readonly { query: string; outcome: QueryOutcome }[]
}

async function session(prompts: readonly string[]): Promise<{
  records: PromptRecord[]
  trace: ReturnType<typeof createTrace>
  modelId: string
}> {
  const graph = createSessionGraph()
  const findings = createFindings()
  const trace = createTrace()
  trace.start()

  const requests: Recorded[] = []
  const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const body =
      (method === 'PUT' || method === 'POST') && typeof init?.body === 'string'
        ? init.body
        : undefined
    requests.push({ method, url, ...(body ? { body } : {}) })
    return globalThis.fetch(input as string, init)
  }) as unknown as typeof fetch

  const http = createHttpClient({ fetchImpl: recordingFetch, ...(TOKEN ? { token: TOKEN } : {}) })
  const contexts = createContextStore({
    fetchJson: async (url) => {
      const response = await recordingFetch(url, {
        headers: { Accept: 'application/ld+json, application/json;q=0.9' },
      })
      if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
      return response.json()
    },
  })

  const discovered = await discoverApi(ENTRYPOINT, { http, graph, contexts, findings, trace })
  const model = buildCapabilityModel(graph)
  const endpoint = discovered.sparqlReachable ? discovered.sparqlEndpoint : null

  const surface = withQueryTool(
    projectTools(model, {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      findings,
    }),
  )
  // `surface` must reach the manifest: the write verbs render from the registry, and a manifest
  // rendered without it lists no writes at all — found live, when "what can you do?" kept
  // under-reporting writes that main.ts's page (which passes surface) would have named.
  const manifest = renderManifest(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    primaryNamespace: primaryNamespace(model),
    surface,
    locate: (classIri) => {
      const cls = model.byIri(classIri)
      return cls
        ? locateClass(cls, { graph, entrypoint: discovered.entrypoint ?? ENTRYPOINT }).url
        : null
    },
  })

  const issued: { query: string; outcome: QueryOutcome }[] = []
  const runner = createQueryRunner({
    graph,
    model,
    http,
    contexts,
    findings,
    trace,
    constraintsFor: (iri) => constraintsFor(graph, iri),
    origin: ENTRYPOINT,
    entrypoint: discovered.entrypoint ?? ENTRYPOINT,
    sparqlEndpoint: endpoint,
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
    origin: ENTRYPOINT,
    entrypoint: discovered.entrypoint ?? ENTRYPOINT,
    prefixes: manifestPrefixes({
      constraintsFor: (iri) => constraintsFor(graph, iri),
      primaryNamespace: primaryNamespace(model),
    }),
    query: {
      run: async (query: string) => {
        const outcome = await runner.run(query)
        issued.push({ query, outcome })
        return outcome
      },
    },
  })

  const anthropic = new Anthropic({ apiKey: KEY, dangerouslyAllowBrowser: true })
  const capability = await readModelCapability(anthropic, DEFAULT_MODEL)
  const agent = createAgent({
    anthropic,
    executor,
    surface,
    trace,
    model: capability,
    system: buildSystem({ manifest }),
  })

  const records: PromptRecord[] = []
  for (const prompt of prompts) {
    const requestsBefore = requests.length
    const issuedBefore = issued.length
    trace.log(`── prompt: ${prompt}`, 'step')
    const turn = await agent.send(prompt)
    records.push({
      prompt,
      turn,
      requests: requests.slice(requestsBefore),
      queries: issued.slice(issuedBefore),
    })
  }

  return { records, trace, modelId: capability.id }
}

function render(title: string, note: string, run: Awaited<ReturnType<typeof session>>): string {
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`Recorded ${new Date().toISOString()} against \`${ENTRYPOINT}\` (model \`${run.modelId}\`).`)
  lines.push('')
  if (note) {
    lines.push(note)
    lines.push('')
  }

  for (const record of run.records) {
    lines.push(`## Prompt: ${record.prompt}`)
    lines.push('')
    const { turn } = record
    lines.push(
      `${turn.toolCalls} tool call(s) over ${turn.iterations} iteration(s); ` +
        `usage in/out ${turn.usage.input}/${turn.usage.output}, cache read ${turn.usage.cacheRead}, ` +
        `cache creation ${turn.usage.cacheCreation}.`,
    )
    lines.push('')
    if (record.requests.length > 0) {
      lines.push('Outbound requests:')
      lines.push('')
      for (const request of record.requests) {
        lines.push(`- \`${request.method} ${request.url}\``)
        if (request.body) {
          lines.push('')
          lines.push('  ```json')
          for (const bodyLine of request.body.split('\n')) lines.push(`  ${bodyLine}`)
          lines.push('  ```')
          lines.push('')
        }
      }
      lines.push('')
    }
    for (const { query, outcome } of record.queries) {
      lines.push(`SPARQL (${outcome.ok ? 'ok' : 'refused'}${outcome.ranOn ? `, ran ${outcome.ranOn}` : ''}):`)
      lines.push('')
      lines.push('```sparql')
      lines.push(query.trim())
      lines.push('```')
      lines.push('')
    }
    lines.push('Reply:')
    lines.push('')
    for (const replyLine of record.turn.reply.split('\n')) lines.push(`> ${replyLine}`)
    lines.push('')
  }

  lines.push('## Trace')
  lines.push('')
  lines.push('```')
  for (const entry of run.trace.entries) {
    lines.push(`${formatElapsed(entry.elapsed).padStart(7)}  ${entry.kind.padEnd(7)}  ${entry.message}`)
  }
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

const log = (line: string) => process.stdout.write(`${line}\n`)

mkdirSync(OUT_DIR, { recursive: true })

log('── selective lookup (Contact — Azure-backed search, 500s on this boot) ──')
const lookupContact = await session(['Find contacts named Glenice Peel'])
writeFileSync(
  `${OUT_DIR}trace-selective-lookup.md`,
  render(
    'Trace: selective lookup via search_collection (Contact)',
    'Environmental note: Contact search is Azure Cognitive Search-backed and Azure is unreachable ' +
      'from this boot, so the server answers 500 to any `/Api/Contact?…` search. The routing ' +
      'decision — `search_collection` first, never materialise-and-grep — is the behaviour under ' +
      'record; the EF-backed Call lookup in `trace-selective-lookup-call.md` shows the same ' +
      'routing completing end to end.',
    lookupContact,
  ),
)
log(`   → trace-selective-lookup.md (${lookupContact.records[0]?.turn.toolCalls} tool calls)`)

log('── selective lookup (Call — EF-backed search, completes) ──')
const lookupCall = await session(['Find calls about lead generation'])
writeFileSync(
  `${OUT_DIR}trace-selective-lookup-call.md`,
  render(
    'Trace: selective lookup via search_collection (Call, end to end)',
    '',
    lookupCall,
  ),
)
log(`   → trace-selective-lookup-call.md (${lookupCall.records[0]?.turn.toolCalls} tool calls)`)

log('── aggregate (routes to sparql) ──')
const aggregate = await session([
  'How much did I make in 2023? Give me one figure, and say which field you totalled.',
])
writeFileSync(
  `${OUT_DIR}trace-aggregate.md`,
  render(
    'Trace: aggregate routed to sparql',
    'The seeded data ends 2023-11-11, so 2023 is the last year with any events — the question is ' +
      'phrased for it deliberately, to get a non-zero figure.',
    aggregate,
  ),
)
log(`   → trace-aggregate.md (${aggregate.records[0]?.turn.toolCalls} tool calls)`)

log('── write: create → update → delete, one conversation (task 5.4) ──')
const write = await session([
  'Add a contact named Tamsin Oduya, job title Sound Engineer, email tamsin.oduya@example.com',
  "Change Tamsin Oduya's job title to Production Manager",
  'Delete the contact Tamsin Oduya',
])
writeFileSync(
  `${OUT_DIR}trace-write.md`,
  render(
    'Trace: create, update, delete through the agent (task 5.4)',
    'One conversation, three turns. The update finds the contact by the IRI the create returned — ' +
      'record search being unavailable on this boot (Azure) does not block it. The delete is ' +
      'cleanup, and evidence in its own right.',
    write,
  ),
)
const writeMethods = write.records.flatMap((record) => record.requests.map((request) => request.method))
log(`   → trace-write.md (methods on the wire: ${writeMethods.join(', ')})`)

log('done.')
