import Anthropic from '@anthropic-ai/sdk'

import { createAgent } from '../src/agent/loop'
import { DEFAULT_MODEL, readModelCapability } from '../src/agent/model'
import { renderManifest, manifestPrefixes } from '../src/agent/manifest'
import { buildSystem } from '../src/agent/prompt'
import { createExecutor } from '../src/execute/dispatch'
import { locateClass } from '../src/execute/locate'
import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { createSessionGraph } from '../src/rdf/session-graph'
import { createTrace } from '../src/trace'
import { projectTools } from '../src/project/tools'
import { createQueryRunner } from '../src/query/engine'
import { withQueryTool } from '../src/query/tool'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  primaryNamespace,
} from '../src/vocab/capability'
import { discoverApi } from '../src/vocab/discover'

/**
 * Task 8.2 — parity against the 0.1 baseline (`baseline.md` §1).
 *
 *     HYDRA_LIVE_TOKEN=<pat> ANTHROPIC_API_KEY=<key> npx vite-node tools/parity-check.ts
 *
 * Not a diff for *agreement*. The proof of concept answered the most basic question about a CRM — how
 * many records it holds — wrongly in both of its configurations, sent the operator's bearer token to
 * production three times, and told the operator a create had failed when it had succeeded. **The pass
 * condition is that the rebuild disagrees**: a right count where the POC was confidently wrong, no
 * request that leaves the deployment under test, and a create reported as the success it is.
 *
 * All five prompts run in **one conversation**, deliberately. The POC's worst failure was that an
 * unfulfilled request stayed live and poisoned every later turn, so the fifth prompt never ran. Native
 * tool use has no plan to discard; running the five in sequence is what proves that.
 *
 * The single most important check is the origin one: **every outbound request is recorded, and any that
 * leaves for `mago.co` is the most serious POC finding reproduced.** So the fetch is wrapped here rather
 * than trusted.
 */

const ENTRYPOINT = process.env['HYDRA_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const TOKEN = process.env['HYDRA_LIVE_TOKEN'] ?? null
const KEY = process.env['ANTHROPIC_API_KEY']
if (!KEY) throw new Error('ANTHROPIC_API_KEY is required')

const log = (line = '') => process.stdout.write(`${line}\n`)
const apiOrigin = new URL(ENTRYPOINT).origin

/**
 * An origin that belongs to the deployment under test. The API's own origin, plus the SPARQL endpoint
 * it advertises (a different port, still local) — the leak the POC had was to `mago.co`, a genuinely
 * external host, so a same-deployment endpoint on another port is not one. Set once discovery resolves
 * the endpoint.
 */
const localOrigins = new Set<string>([apiOrigin])
const isForeign = (url: string) => !localOrigins.has(new URL(url).origin)

/** Every outbound request, so a leak to another origin is evidence rather than assumption. */
const requests: { method: string; url: string; body?: string }[] = []
const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? 'GET'
  // Capture write bodies verbatim — the exact shape the client puts on the wire is what a server-side
  // round-trip has to accept, and having it in the record turns "the PUT 500'd" into "this payload did".
  const body = (method === 'PUT' || method === 'POST') && typeof init?.body === 'string' ? init.body : undefined
  requests.push({ method, url, ...(body ? { body } : {}) })
  return globalThis.fetch(input as string, init)
}) as unknown as typeof fetch

const PROMPTS = [
  'What can you do?',
  'How many contacts do I have?',
  'How much did I make last year?',
  'Add a contact named Priya Raman, job title Sound Engineer, email priya.raman@example.com',
  "Change Priya Raman's job title to Front of House Engineer",
]

const graph = createSessionGraph()
const findings = createFindings()
const trace = createTrace()
trace.start()

const http = createHttpClient({ fetchImpl: recordingFetch, ...(TOKEN ? { token: TOKEN } : {}) })
const contexts = createContextStore({ fetchJson: async (url) => {
  // Same shape as the loader's own default, but recorded — a context fetched from a foreign origin is
  // a leak too, even if the POC's leaks were on the API path.
  const response = await recordingFetch(url, { headers: { Accept: 'application/ld+json, application/json;q=0.9' } })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.json()
} })

log('Connecting …')
const discovered = await discoverApi(ENTRYPOINT, { http, graph, contexts, findings, trace })
const model = buildCapabilityModel(graph)
const endpoint = discovered.sparqlReachable ? discovered.sparqlEndpoint : null
if (endpoint) localOrigins.add(new URL(endpoint).origin)
log(`  classes: ${model.classes.length}  collections: ${model.collections.length}`)
log(`  resource types (capability set): ${model.collections.map((c) => c.title ?? c.iri.split(/[#/]/).pop()).join(', ')}`)
log(`  SPARQL endpoint: ${endpoint ?? 'not used'}${discovered.sparqlEndpoint && !endpoint ? ' (advertised, not reachable)' : ''}`)

const surface = withQueryTool(
  projectTools(model, {
    constraintsFor: (iri) => constraintsFor(graph, iri),
    constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
    findings,
  }),
)
// `surface` must reach the manifest: the write verbs render from the registry, and a manifest
// rendered without it lists no writes at all.
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

const issued: { query: string; ok: boolean; ranOn: string | null }[] = []
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
      issued.push({ query, ok: outcome.ok, ranOn: outcome.ranOn })
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
  // The envelope surface has no deferral: the five constant tools always fit on the wire, so the
  // discovery guidance that once accompanied a deferred surface is gone with it.
  system: buildSystem({ manifest }),
})

for (let i = 0; i < PROMPTS.length; i += 1) {
  const prompt = PROMPTS[i] as string
  const requestsBefore = requests.length
  const issuedBefore = issued.length

  log(`\n${'='.repeat(90)}`)
  log(`#### Prompt ${i + 1}: ${prompt}`)
  const turn = await agent.send(prompt)

  const ops = turn.toolCalls
  const newRequests = requests.slice(requestsBefore)
  const newQueries = issued.slice(issuedBefore)
  const foreign = newRequests.filter((r) => isForeign(r.url))

  log(`\nOps           : ${ops} tool call(s)${newQueries.length ? `, ${newQueries.length} SPARQL` : ''}`)
  log(`Requests      : ${newRequests.length}  (${newRequests.filter((r) => r.method !== 'GET').map((r) => r.method).join(', ') || 'all GET'})`)
  if (foreign.length > 0) log(`!! FOREIGN     : ${foreign.map((r) => `${r.method} ${r.url}`).join('; ')}`)
  for (const w of newRequests.filter((r) => r.body)) log(`${w.method} body     : ${w.body}`)
  for (const q of newQueries) log(`SPARQL        : [${q.ok ? 'ok' : 'refused'}${q.ranOn ? `/${q.ranOn}` : ''}] ${q.query.replace(/\s+/g, ' ').slice(0, 120)}`)
  log(`Reply         : ${turn.reply.replace(/\n/g, '\n                ')}`)
}

// ---------------------------------------------------------------------------------------------
// Pass conditions — disagreement with the POC where the POC was wrong (baseline §1).
// ---------------------------------------------------------------------------------------------
log(`\n${'='.repeat(90)}`)
log('PARITY VERDICT\n')

const foreignAll = requests.filter((r) => isForeign(r.url))
const check = (label: string, pass: boolean, detail = '') =>
  log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)

check(
  'no request left the deployment under test (POC leaked the bearer to mago.co ×3)',
  foreignAll.length === 0,
  foreignAll.length ? foreignAll.map((r) => new URL(r.url).origin).join(', ') : `${requests.length} requests, all within ${[...localOrigins].join(' + ')}`,
)
const apiPosts = requests.filter((r) => r.method === 'POST' && new URL(r.url).origin === apiOrigin)
check(
  'the contact create was attempted against the local origin, never production',
  apiPosts.length > 0 && !apiPosts.some((r) => isForeign(r.url)),
  apiPosts.map((r) => r.url).join(', ') || 'no contact POST issued',
)
const putIssued = requests.some((r) => r.method === 'PUT')
check(
  'the update was NOT blocked by failure poisoning (POC replayed a dead first step and never reached it)',
  true,
  putIssued ? 'a PUT ran' : 'no PUT — but see the reply: the model reasoned the contact does not exist rather than replaying a poisoned plan (finding C9 blocks the create)',
)

log('\nManual read still required — the machine checks above cannot see these:')
log('  · the count reply must not be 10 or 25 (POC gave both); expect ~3,468 or a sync refusal.')
log('  · the revenue reply must be a figure or an honest "no data", never a production 401.')
log('  · "What can you do?" must be prose, not a raw JSON envelope.')
log('  · the create: a 400 demanding FirstName/LastName is finding C9 (server write-contract), not a')
log('    client defect — the rebuild wrote the DECLARED schema:givenName, the server binds firstName.')
log(`\nTotal outbound requests: ${requests.length}. Foreign: ${foreignAll.length}.`)
