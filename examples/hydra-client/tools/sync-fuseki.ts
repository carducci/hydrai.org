import { Writer, type Quad } from 'n3'

import { materialise } from '../src/execute/collection'
import { locateClass } from '../src/execute/locate'
import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd, quadsFromTurtle } from '../src/rdf/ingest'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS, HYDRA } from '../src/rdf/terms'
import { createTrace } from '../src/trace'
import { buildCapabilityModel } from '../src/vocab/capability'
import { discoverApi } from '../src/vocab/discover'

/**
 * Re-load the SPARQL endpoint from the API it is supposed to mirror.
 *
 * An operations script, not part of the client. It exists because the endpoint drifted: it held 10
 * contacts where the API declared 3,468, answered every query without error, and returned a confident
 * number wrong by 346x. `query/sync.ts` is what stops that being believed; this is what fixes it.
 *
 *     HYDRA_LIVE_TOKEN=<pat> npx vite-node tools/sync-fuseki.ts
 *
 * **It reads through the client rather than around it**, and that is the point rather than
 * convenience. The same JSON-LD expansion, the same `hydra:next` traversal to completion with no page
 * ceiling, and — the one that matters — the same origin rebasing: this API publishes pagination links
 * and templates carrying its canonical production origin, so a hand-rolled loop following `next`
 * verbatim from a local boot would page its way through **production** and load that into your local
 * mirror. The proof of concept did exactly this and it is finding §1.4 in baseline.md.
 *
 * Destructive by design: `DROP ALL` then reload. The dataset is an in-memory container mirror, so the
 * API is the only source of truth and anything the reload does not carry was not the API's to begin
 * with. Ontology and shapes are reloaded too — they live in the same default graph, so clearing the
 * data would otherwise take them with it and drop the client from T3 to T1.
 */

const ENTRYPOINT = process.env['HYDRA_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const FUSEKI = process.env['FUSEKI_BASE'] ?? 'http://localhost:3030/mago'
const AUTH = process.env['FUSEKI_AUTH'] ?? 'admin:admin'
const TOKEN = process.env['HYDRA_LIVE_TOKEN'] ?? null
/** Members one collection may retrieve. Above the largest collection, so nothing is silently cut. */
const BUDGET = Number(process.env['SYNC_BUDGET'] ?? 50_000)

const basic = `Basic ${Buffer.from(AUTH).toString('base64')}`
const log = (line: string) => process.stdout.write(`${line}\n`)
const HYDRA_MEMBER = HYDRA.member

async function fuseki(path: string, body: string, contentType: string): Promise<void> {
  const response = await fetch(`${FUSEKI}${path}`, {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': contentType },
    body,
  })
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
}

/**
 * Quads as N-Triples, flattened into the default graph.
 *
 * The client keeps data, vocabulary, shapes and provenance in separate named graphs so no query
 * becomes a union. The endpoint holds one default graph — that is how it was, and a query with no
 * GRAPH clause reads the default graph — so the graph names are dropped on the way out rather than
 * reproduced.
 */
function toNTriples(quads: readonly Quad[]): Promise<string> {
  const writer = new Writer({ format: 'N-Triples' })
  for (const quad of quads) writer.addQuad(quad.subject, quad.predicate, quad.object)
  return new Promise((resolve, reject) => {
    writer.end((error, result: string) => (error ? reject(error) : resolve(result)))
  })
}

/** Posted in batches: one 20MB body is a timeout waiting to happen, and a failure mid-way is opaque. */
async function load(label: string, quads: readonly Quad[]): Promise<void> {
  const BATCH = 20_000
  for (let from = 0; from < quads.length; from += BATCH) {
    const slice = quads.slice(from, from + BATCH)
    await fuseki('/data?default', await toNTriples(slice), 'application/n-triples')
    log(`    ${label}: ${Math.min(from + BATCH, quads.length)}/${quads.length} triples`)
  }
}

async function main(): Promise<void> {
  if (!TOKEN) log('WARNING: no HYDRA_LIVE_TOKEN — collections require auth and will fail.\n')

  const graph = createSessionGraph()
  const findings = createFindings()
  const trace = createTrace()
  const contexts = createContextStore()
  const http = createHttpClient({ token: TOKEN })
  const deps = { http, graph, contexts, findings, trace, origin: ENTRYPOINT }

  log(`Discovering ${ENTRYPOINT} …`)
  const discovered = await discoverApi(ENTRYPOINT, { http, graph, contexts, findings, trace })
  const model = buildCapabilityModel(graph)
  log(`  ${model.classes.length} classes, ${model.collections.length} collections\n`)

  // The ontology, by dereferencing rather than by a constructed URL — stripping a fragment is what a
  // hash namespace means. Loaded because the endpoint's default graph held it and clearing takes it.
  log('Reading the ontology and shapes …')
  const ontologyUrl = new URL('/ns', ENTRYPOINT).toString()
  const ontology = await http.request(ontologyUrl, { accept: 'text/turtle', throwOnError: true })
  graph.ingestDocument(quadsFromTurtle(ontology.body, ontology.url), GRAPHS.ontology)
  log(`  ontology: ${graph.match(null, null, null, GRAPHS.ontology).length} triples`)

  if (discovered.shapesUrl) {
    const shapes = await http.request(discovered.shapesUrl, { throwOnError: true })
    graph.ingestDocument(
      await quadsFromJsonLd(JSON.parse(shapes.body), contexts.load, shapes.url),
      GRAPHS.shapes,
    )
    log(`  shapes:   ${graph.match(null, null, null, GRAPHS.shapes).length} triples`)
  }
  log('')

  log('Materialising every collection the API serves …')
  const collections = model.collections
    .map((cls) => ({ cls, url: locateClass(cls, { graph, entrypoint: ENTRYPOINT }).url }))
    .filter((entry): entry is { cls: typeof entry.cls; url: string } => entry.url !== null)

  for (const { cls, url } of collections) {
    const result = await materialise(url, deps, { budget: BUDGET })
    const held = graph.completenessOf(result.collection)
    log(
      `  ${cls.iri.split(/[#/]/).pop()?.padEnd(22)} ${String(held?.have ?? '?').padStart(6)} members` +
        `${result.complete ? '' : `  INCOMPLETE — ${result.refusal ?? ''}`}`,
    )
  }
  log('')

  /*
   * The mirror is what the API SERVES, which is narrower than what materialising touches.
   *
   * Two things have to come out, and both were in the first run of this script.
   *
   * Page scaffolding. Every page document carries `hydra:operation`, `hydra:search` and a
   * `PartialCollectionView`, so a 139-page traversal deposits 139 collection resources, 933 statuses,
   * 640 template mappings and 306 templates. That is affordance metadata restated per page, not data,
   * and none of it belongs in a store that exists to be aggregated over.
   *
   * Link targets. A resource referenced from another — a Call's parent, say — arrives carrying an
   * inline `@type` and nothing else. Loading those made the endpoint hold 3,471 Contacts against the
   * 3,468 the collection serves, and this API is **user-scoped**: those three are contacts this user's
   * collection does not serve. Aggregating over them answers about data the caller cannot see, which
   * is wrong in the opposite direction from a stale mirror and just as quiet. Equality with the
   * declared total is the right test, so the mirror has to be exactly the served set.
   *
   * So the export walks out from `hydra:member` rather than taking the data graph wholesale, and
   * follows blank nodes because a member's address is nested inside it.
   */
  const memberIris = new Set(
    graph.match(null, HYDRA_MEMBER, null, GRAPHS.data).map((quad) => quad.object.value),
  )

  const seen = new Set<string>()
  const data: Quad[] = []
  const walk = (subject: string, isBlank: boolean): void => {
    const key = `${isBlank ? '_:' : ''}${subject}`
    if (seen.has(key)) return
    seen.add(key)

    const quads = graph.match(isBlank ? { termType: 'BlankNode', value: subject } : subject, null, null, GRAPHS.data)
    for (const quad of quads) {
      data.push(quad)
      if (quad.object.termType === 'BlankNode') walk(quad.object.value, true)
    }
  }
  for (const iri of memberIris) walk(iri, false)

  const ontologyQuads = graph.match(null, null, null, GRAPHS.ontology)
  const shapeQuads = graph.match(null, null, null, GRAPHS.shapes)
  const total = data.length + ontologyQuads.length + shapeQuads.length
  log(
    `Exporting ${total} triples — ${data.length} data over ${memberIris.size} members ` +
      `(from ${graph.match(null, null, null, GRAPHS.data).length} materialised), ` +
      `${ontologyQuads.length} ontology, ${shapeQuads.length} shapes.\n`,
  )

  log('DROP ALL on the endpoint …')
  await fuseki('/update', 'update=' + encodeURIComponent('DROP ALL'), 'application/x-www-form-urlencoded')

  log('Loading …')
  await load('ontology', ontologyQuads)
  await load('shapes', shapeQuads)
  await load('data', data)

  log('\nDone.')
}

await main()
