import { randomUUID } from 'node:crypto'

import { manifestPrefixes, renderManifest } from '../src/agent/manifest'
import { createExecutor, type Executor } from '../src/execute/dispatch'
import { locateClass } from '../src/execute/locate'
import { createHttpClient } from '../src/http/client'
import { projectTools } from '../src/project/tools'
import { createQueryRunner } from '../src/query/engine'
import { withQueryTool } from '../src/query/tool'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { createSessionGraph } from '../src/rdf/session-graph'
import type { Trace } from '../src/trace'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  primaryNamespace,
} from '../src/vocab/capability'
import { discoverApi } from '../src/vocab/discover'
import { assessTier, probeOntology } from '../src/vocab/tiers'
import { materialiseValueSets } from '../src/vocab/value-sets'

/**
 * The Hydra session, behind a server-minted handle (design D3, SEP-2567).
 *
 * `connect` runs the same sequence `main.ts` runs — discover ▶ capability model ▶ tool surface ▶
 * value sets ▶ executor — and everything below the page composes unchanged, because none of it
 * touches the DOM and none of it knows about Anthropic. What the page does with a key (the tool_use
 * loop, prompt assembly, model probing) is exactly what MCP makes the *client's* job, so it is absent
 * here. The result is a warm session an `Executor` acts on, plus the rendered map that is delivered to
 * the model as content.
 */

/** A composed, live session. Held in the store keyed by {@link Session.handle}. */
export interface Session {
  /** The opaque server-minted handle the client passes back on every envelope tool. */
  readonly handle: string
  /** The entry point discovery ran against — decodable from the handle for a lost-session refusal. */
  readonly entrypoint: string
  /** Whether a bearer token was in play. The token value itself is never held here. */
  readonly tokenPresent: boolean
  /** The dispatcher every envelope tool routes to. */
  readonly executor: Executor
  /**
   * Capability as content (design D4): the rendered affordance map (prefixes, classes, the
   * collections index with addresses and write verbs, properties), the tier report, and the SPARQL
   * endpoint disposition — the same bytes the page renders into its system prompt.
   */
  readonly map: string
  /** Wall-clock of the last use, for the store's idle-TTL eviction. */
  lastUsedAt: number
}

/**
 * The handle carries the entry point and token-presence — never the token.
 *
 * Encoded (not encrypted) so that a call presenting an *evicted* handle can still be refused toward
 * recovery by name: the store no longer holds the session, but the entry point to reconnect to is
 * recoverable from the handle itself. A random suffix keeps two connects to the same entry point
 * distinct.
 */
interface HandleClaims {
  readonly e: string
  readonly t: boolean
}

function mintHandle(entrypoint: string, tokenPresent: boolean): string {
  const claims: HandleClaims = { e: entrypoint, t: tokenPresent }
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `${encoded}.${randomUUID()}`
}

/** The entry point a handle was minted for, or null if it does not decode. */
export function entrypointOf(handle: string): string | null {
  const encoded = handle.split('.')[0]
  if (!encoded) return null
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as HandleClaims
    return typeof claims.e === 'string' ? claims.e : null
  } catch {
    return null
  }
}

/**
 * Compose a session against an entry point, exactly as the page's connect does.
 *
 * The token is read here and passed only to the transport; it is never returned, logged, or embedded
 * in the handle. Discovery costs four fetches (entry point, vocabulary, contexts, and the reference
 * collections) — the cost the lost-session refusal quotes.
 */
export async function composeSession(
  entrypoint: string,
  token: string | null,
  trace: Trace,
): Promise<Session> {
  const graph = createSessionGraph()
  const findings = createFindings()
  const contexts = createContextStore()
  const http = createHttpClient({ token: token || null, onRequest: () => undefined })

  const discovered = await discoverApi(entrypoint, { http, graph, contexts, findings, trace })

  const model = buildCapabilityModel(graph)
  const namespace = primaryNamespace(model)
  trace.log(
    `${model.classes.length} classes, ${model.collections.length} collections, ` +
      `${model.classes.reduce((n, c) => n + c.operations.length, 0)} operations declared`,
    'success',
  )

  const ontology = await probeOntology(namespace, { http, findings, connectOrigin: entrypoint })

  const assessment = assessTier(graph, discovered, {
    ontology: ontology.available,
    contextResolved: discovered.contextsUnreachable.length === 0 && discovered.contextUsable,
    ontologyAdvertised: discovered.ontologyUrl !== null,
  })
  trace.log(`Capability tier: ${assessment.tier}`, 'info')
  for (const caveat of assessment.caveats) trace.log(caveat, 'warn')

  const constraints = (iri: string) => constraintsFor(graph, iri)
  const surface = withQueryTool(
    projectTools(model, {
      constraintsFor: constraints,
      constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      findings,
    }),
  )

  const valueSets = await materialiseValueSets(
    model,
    { http, graph, contexts, findings, trace, origin: entrypoint },
    { entrypoint: discovered.entrypoint },
  )

  const locate = (classIri: string): string | null => {
    const cls = model.byIri(classIri)
    return cls ? locateClass(cls, { graph, entrypoint: discovered.entrypoint }).url : null
  }
  const manifestDeps = {
    constraintsFor: constraints,
    primaryNamespace: namespace,
    valueSets,
    surface,
    locate,
  }
  const manifest = renderManifest(model, manifestDeps)

  const endpoint = discovered.sparqlReachable ? discovered.sparqlEndpoint : null
  const executor = createExecutor({
    http,
    graph,
    contexts,
    findings,
    trace,
    surface,
    model,
    origin: entrypoint,
    entrypoint: discovered.entrypoint,
    valueSets,
    prefixes: manifestPrefixes(manifestDeps),
    shapes: { constraintsFor: constraints, constraintsOfShape: (iri) => constraintsOfShape(graph, iri) },
    query: createQueryRunner({
      graph,
      model,
      http,
      contexts,
      findings,
      trace,
      constraintsFor: constraints,
      origin: entrypoint,
      entrypoint: discovered.entrypoint,
      sparqlEndpoint: endpoint,
      prefixes: manifestPrefixes(manifestDeps),
    }),
  })

  const endpointDisposition = endpoint
    ? `SPARQL runs on the advertised endpoint <${endpoint}>.`
    : discovered.sparqlEndpoint
      ? `A SPARQL endpoint was advertised at <${discovered.sparqlEndpoint}> but did not answer; ` +
        `queries run locally over materialised collections.`
      : `No SPARQL endpoint is advertised; queries run locally over materialised collections.`

  const map = [
    `Capability tier: ${assessment.tier}.`,
    ...(assessment.caveats.length > 0 ? [`Caveats: ${assessment.caveats.join(' ')}`] : []),
    endpointDisposition,
    '',
    `The API's vocabulary and its collections — the collections index is what search_collection ` +
      `takes; the classes and properties are for writing queries.`,
    '',
    manifest.prefixes,
    '',
    manifest.classes,
    '',
    manifest.affordances,
    '',
    manifest.properties,
  ].join('\n')

  return {
    handle: mintHandle(entrypoint, Boolean(token)),
    entrypoint,
    tokenPresent: Boolean(token),
    executor,
    map,
    lastUsedAt: Date.now(),
  }
}

/**
 * A bounded, idle-evicting store of live sessions (design D3).
 *
 * Semantically a warm-path cache of the API's own state — which is what the session graph always was:
 * provenance-tracked copies of served documents. The 07-28 stateless model guarantees no instance
 * affinity, so a miss is always a legitimate outcome, handled by the shell as a refusal toward
 * reconnection rather than an error. On stdio (one process, one client) eviction is near-academic;
 * the bound exists so a long-lived server that connects to many entry points cannot grow without
 * limit.
 */
export interface SessionStore {
  put(session: Session): void
  get(handle: string): Session | undefined
  readonly size: number
}

export interface SessionStoreOptions {
  /** Most sessions held at once. The least-recently-used is evicted past this. */
  readonly maxSessions?: number
  /** A session untouched for longer than this is evicted on the next access. */
  readonly idleTtlMs?: number
  /** Injectable so tests do not depend on wall-clock time. */
  readonly now?: () => number
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const maxSessions = options.maxSessions ?? 32
  const idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000
  const now = options.now ?? (() => Date.now())

  // A Map preserves insertion order, which is the LRU order once re-insertion moves a touched key
  // to the end. That is the whole eviction mechanism — no separate bookkeeping to drift.
  const sessions = new Map<string, Session>()

  const evictExpired = () => {
    const cutoff = now() - idleTtlMs
    for (const [handle, session] of sessions) {
      if (session.lastUsedAt < cutoff) sessions.delete(handle)
    }
  }

  return {
    put(session) {
      evictExpired()
      sessions.set(session.handle, session)
      while (sessions.size > maxSessions) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
    },

    get(handle) {
      evictExpired()
      const session = sessions.get(handle)
      if (!session) return undefined
      // Touch: move to the end (most-recently-used) and reset the idle clock.
      session.lastUsedAt = now()
      sessions.delete(handle)
      sessions.set(handle, session)
      return session
    },

    get size() {
      return sessions.size
    },
  }
}
