import type { HttpClient } from '../http/client'
import { originMismatchMessage, rebaseOntoOrigin } from '../http/origin'
import { discoverContexts, type DocumentToWalk } from '../rdf/context-discovery'
import type { ContextStore } from '../rdf/document-loader'
import { FINDING_KINDS, type Findings } from '../rdf/findings'
import { ParseError, quadsFromJsonLd, serialisationOf, quadsFromTurtle } from '../rdf/ingest'
import type { SessionGraph } from '../rdf/session-graph'
import { GRAPHS, HYDRA, OWL, RDFS, SHACL, VOID } from '../rdf/terms'
import type { Trace } from '../trace'

/**
 * Connect-time discovery (tasks 3.1 and 3.2).
 *
 * The operator supplies one address — the entry point. Everything else is found by following what the
 * server says, and **no URL is constructed from a pattern at any point**. That closes finding F2: the
 * proof of concept built its vocabulary URL as `this.base + 'Vocab'` (`index.html:289`) while
 * `how-it-works.html:298` claimed the server had advertised it via a Link header, and `_fetch` threw
 * response headers away so it could not have read one.
 */

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

export interface DiscoveredApi {
  readonly entrypoint: string
  readonly vocabularyUrl: string
  /** Whether the advertised vocabulary IRI had to be rebased onto the connect origin. */
  readonly rebased: boolean
  readonly shapesUrl: string | null
  /**
   * The ontology the API advertises as defining its vocabulary, or `null` when it advertises none.
   *
   * Read from an `rdfs:isDefinedBy` / `owl:imports` / `void:vocabulary` reference on what the
   * vocabulary published. When present, the ontology was *declared* rather than found by
   * dereferencing a term IRI — which is what makes the inference tier discoverable to a client that
   * does not happen to strip fragments and dereference namespaces.
   */
  readonly ontologyUrl: string | null
  readonly sparqlEndpoint: string | null
  /** Advertised is not available. `null` when nothing was advertised to probe. */
  readonly sparqlReachable: boolean | null
  readonly contextsUnreachable: readonly string[]
  /**
   * Whether the API's own context documents are usable.
   *
   * `false` when a context was retrieved but is not valid JSON-LD. Functionally that is an absent
   * context — no conformant processor can expand anything referencing it — so the tier drops to T0
   * rather than the connect failing outright.
   */
  readonly contextUsable: boolean
}

export interface DiscoveryDeps {
  readonly http: HttpClient
  readonly graph: SessionGraph
  readonly contexts: ContextStore
  readonly findings: Findings
  readonly trace: Trace
}

/** Ingest a retrieved document into a named graph, choosing the parser from its content type. */
async function ingestInto(
  url: string,
  graphName: (typeof GRAPHS)[keyof typeof GRAPHS],
  deps: DiscoveryDeps,
): Promise<unknown> {
  const response = await deps.http.request(url, { throwOnError: true })
  const serialisation = serialisationOf(response.contentType)

  if (serialisation === 'turtle') {
    deps.graph.ingestDocument(quadsFromTurtle(response.body, url), graphName)
    return null
  }

  const document: unknown = JSON.parse(response.body)
  deps.graph.ingestDocument(await quadsFromJsonLd(document, deps.contexts.load, url), graphName)
  return document
}

export async function discoverApi(entrypointUrl: string, deps: DiscoveryDeps): Promise<DiscoveredApi> {
  const { http, graph, contexts, findings, trace } = deps

  // 1 ── The entry point. The one address the client is told.
  trace.log(`GET ${entrypointUrl}`, 'http')
  const entryResponse = await http.request(entrypointUrl, { throwOnError: true })
  const entryDocument: unknown = JSON.parse(entryResponse.body)

  // 2 ── The vocabulary, from the Link header. Never constructed.
  const advertised = entryResponse.links.get(HYDRA.apiDocumentation)
  if (!advertised) {
    throw new DiscoveryError(
      `<${entrypointUrl}> served no Link header with rel="${HYDRA.apiDocumentation}", so the ` +
        `vocabulary cannot be located. The client will not guess a URL: a constructed address is an ` +
        `assumption about this API that it has not published. Serving that header is the fix.`,
    )
  }

  const { url: vocabularyUrl, rebased } = rebaseOntoOrigin(advertised, entryResponse.url)
  if (rebased) {
    trace.log(
      `Link header advertised ${advertised}, which is a different origin than the one that served it. ` +
        `Following ${vocabularyUrl} instead — recorded as a finding.`,
      'warn',
    )
    findings.record({
      about: advertised,
      kind: FINDING_KINDS.originMismatch,
      message: originMismatchMessage(
        advertised,
        `origin ${new URL(entryResponse.url).origin}`,
        'The apiDocumentation Link header target',
      ),
    })
  } else {
    trace.log(`Vocabulary discovered from Link header: ${vocabularyUrl}`, 'success')
  }

  trace.log(`GET ${vocabularyUrl}`, 'http')
  const vocabDocument = await ingestInto(vocabularyUrl, GRAPHS.vocab, deps)

  // 3 ── Contexts referenced by what we now hold, fetched and cached before anything else expands.
  const walk: DocumentToWalk[] = [
    { url: entryResponse.url, document: entryDocument },
    { url: vocabularyUrl, document: vocabDocument },
  ]
  const contextResult = await discoverContexts(walk, {
    contexts,
    findings,
    onProgress: (message) => trace.log(message, 'info'),
  })

  /*
   * The entry point carries the live collection IRIs, so it goes in with the connect-time documents
   * rather than the data graph.
   *
   * It may not expand at all. A context document can be retrieved successfully and still be invalid
   * JSON-LD — this API's `/Api/Context` puts `rdfs:label` inside term definitions and nests `@graph`
   * inside `@context`, both of which a conformant processor rejects outright. That is functionally the
   * same as having no context: nothing referencing it can be expanded. So the tier drops to T0 and the
   * defect is named, rather than the connect failing and taking the working T0 surface down with it.
   *
   * This is not the silent partial expansion design D9 forbids. Nothing half-expanded enters the store:
   * the document is rejected whole, and the client says which document and why.
   */
  let contextUsable = true
  try {
    graph.ingestDocument(
      await quadsFromJsonLd(entryDocument, contexts.load, entryResponse.url),
      GRAPHS.context,
    )
  } catch (cause) {
    contextUsable = false
    const reason = cause instanceof ParseError ? cause.message : String(cause)
    trace.log(
      `The entry point could not be read as RDF — degrading to the vocabulary alone. ${reason}`,
      'error',
    )
    findings.record({
      about: entryResponse.url,
      kind: FINDING_KINDS.invalidContext,
      message:
        `<${entryResponse.url}> was retrieved but could not be expanded: ${reason} ` +
        `A context that is not valid JSON-LD cannot be used by any conformant client, so every ` +
        `representation referencing it is unreadable as RDF. Operating from the vocabulary alone.`,
    })
  }

  // 4 ── Probe what else is published. Each into its own named graph.
  const shapesUrl = firstObject(graph, SHACL.shapesGraph)
  if (shapesUrl) {
    trace.log(`GET ${shapesUrl} (SHACL shapes)`, 'http')
    try {
      await ingestInto(shapesUrl, GRAPHS.shapes, deps)
      trace.log('Shapes graph loaded — published constraints will be enforced', 'success')
    } catch (cause) {
      trace.log(`Shapes graph advertised but not retrievable: ${String(cause)}`, 'warn')
      findings.record({
        about: shapesUrl,
        kind: FINDING_KINDS.contextUnreachable,
        message: `The vocabulary advertises a shapes graph at <${shapesUrl}> that could not be retrieved.`,
      })
    }
  } else {
    trace.log('No shapes graph advertised — operating without published constraints', 'info')
  }

  // The ontology, if the vocabulary advertises it — the standards-first ways an API can say
  // "this is where my terms are defined" without a client having to dereference one to find out.
  const ontologyUrl =
    firstObject(graph, RDFS.isDefinedBy) ??
    firstObject(graph, OWL.imports) ??
    firstObject(graph, VOID.vocabulary)
  if (ontologyUrl) trace.log(`Ontology advertised by the vocabulary: ${ontologyUrl}`, 'success')

  const sparqlEndpoint = firstObject(graph, VOID.sparqlEndpoint)
  let sparqlReachable: boolean | null = null
  if (sparqlEndpoint) {
    sparqlReachable = await probeSparql(sparqlEndpoint, deps)
    trace.log(
      sparqlReachable
        ? `SPARQL endpoint reachable: ${sparqlEndpoint}`
        : `SPARQL endpoint advertised at ${sparqlEndpoint} but not answering — degrading`,
      sparqlReachable ? 'sparql' : 'warn',
    )
  }

  return {
    entrypoint: entryResponse.url,
    vocabularyUrl,
    rebased,
    shapesUrl,
    ontologyUrl,
    sparqlEndpoint,
    sparqlReachable,
    contextsUnreachable: contextResult.unreachable,
    contextUsable,
  }
}

/** First object of a predicate anywhere in the connect-time graphs. */
function firstObject(graph: SessionGraph, predicate: string): string | null {
  for (const graphName of [GRAPHS.vocab, GRAPHS.context, GRAPHS.shapes] as const) {
    const [found] = graph.match(null, predicate, null, graphName)
    if (found) return found.object.value
  }
  return null
}

/**
 * Ask the endpoint the cheapest possible question.
 *
 * Declared and available are different properties, and this deployment has demonstrated both states
 * within one session with the advertisement unchanged. An endpoint that does not answer must degrade
 * the tier rather than be trusted because the vocabulary mentioned it.
 */
async function probeSparql(endpoint: string, deps: DiscoveryDeps): Promise<boolean> {
  try {
    const response = await deps.http.request(endpoint, {
      method: 'POST',
      body: new URLSearchParams({ query: 'ASK {}' }).toString(),
      contentType: 'application/x-www-form-urlencoded',
      accept: 'application/sparql-results+json',
    })
    return response.ok
  } catch {
    return false
  }
}
