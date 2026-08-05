import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { createSessionGraph } from '../src/rdf/session-graph'
import { createTrace } from '../src/trace'
import { discoverApi, type DiscoveredApi } from '../src/vocab/discover'

/**
 * Finding F2, closed by the one observation that discriminates (task 8.3).
 *
 * The proof of concept built its vocabulary URL as `this.base + 'Vocab'` (`index.html:289`) while
 * `how-it-works.html:298` claimed the server had advertised it via a `Link` header. Two checks
 * already bear on that and **neither one settles it**:
 *
 *   - the source carries no such concatenation — but absence of the old defect is not presence of the
 *     mechanism claimed in its place;
 *   - `live-connect.test.ts` connects to the real deployment — but that deployment genuinely serves
 *     its vocabulary at `/Api/Vocab`, so a client that constructed the URL would pass that test.
 *
 * So this one advertises the vocabulary at a path **no construction could produce**, and serves 404
 * at the path the proof of concept would have built. Finding it is only possible by reading the
 * header. Over real HTTP against a real server, because a stubbed `fetch` would be asserting that the
 * client reads a header this file handed it.
 */

const PORT = 4311
const ORIGIN = `http://127.0.0.1:${PORT}`

/** Nothing derives this from the entry point. Reading the header is the only way to it. */
const VOCAB_PATH = '/x9f3q/documents/7c1e-apidoc'

/** What `base + 'Vocab'` produces. Served as 404 so a constructing client fails loudly. */
const CONSTRUCTED_PATH = '/Api/Vocab'

const NS = 'https://unrelated.example/ns#'

const vocabulary = {
  '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { ns: NS }],
  '@id': `${ORIGIN}${VOCAB_PATH}`,
  '@type': 'ApiDocumentation',
  supportedClass: [
    {
      '@id': `${NS}Widget`,
      '@type': 'Class',
      title: 'Widget',
      supportedOperation: [{ '@type': 'Operation', method: 'GET', returns: `${NS}Widget` }],
    },
  ],
}

const entrypoint = {
  '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { ns: NS }],
  '@id': `${ORIGIN}/Api/`,
  '@type': 'EntryPoint',
}

describe('the vocabulary URL comes from the Link header (finding F2)', () => {
  let server: Server
  let discovered: DiscoveredApi
  /** Every path the client asked for, in order. The observation is in here. */
  const requested: string[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', ORIGIN).pathname
      requested.push(path)

      if (path === '/Api/') {
        response.writeHead(200, {
          'Content-Type': 'application/ld+json',
          Link: `<${ORIGIN}${VOCAB_PATH}>; rel="http://www.w3.org/ns/hydra/core#apiDocumentation"`,
        })
        response.end(JSON.stringify(entrypoint))
        return
      }

      if (path === VOCAB_PATH) {
        response.writeHead(200, { 'Content-Type': 'application/ld+json' })
        response.end(JSON.stringify(vocabulary))
        return
      }

      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no route for ${path}`)
    })

    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))

    const trace = createTrace()
    trace.start()

    discovered = await discoverApi(`${ORIGIN}/Api/`, {
      http: createHttpClient({ token: null }),
      graph: createSessionGraph(),
      contexts: createContextStore(),
      findings: createFindings(),
      trace,
    })
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('finds a vocabulary that no URL pattern could have reached', () => {
    expect(discovered.vocabularyUrl).toBe(`${ORIGIN}${VOCAB_PATH}`)
    expect(requested).toContain(VOCAB_PATH)
  })

  it('never asks for the URL the proof of concept would have constructed', () => {
    expect(requested).not.toContain(CONSTRUCTED_PATH)
  })

  it('reads the header before it can know where to go, so the entry point is fetched first', () => {
    expect(requested[0]).toBe('/Api/')
    expect(requested.indexOf('/Api/')).toBeLessThan(requested.indexOf(VOCAB_PATH))
  })
})

/**
 * The vocabulary Link may be a relative URI-reference (task 1.1).
 *
 * RFC 8288 §3 defines a `Link` target as a URI-reference resolved against the response URL, and the
 * Mago origin is about to start advertising the ApiDocumentation relatively (one static `Web.config`
 * header serving three hostnames can only be relative). The client had only ever seen absolute
 * targets, so this is the standing pin that the relative form discovers the same vocabulary — on the
 * session's own origin, never anywhere else. Over real HTTP, because the property under test is that
 * the transport resolves against the URL a stub would otherwise have to assert for it.
 */
describe('a relative apiDocumentation Link resolves against the response URL (task 1.1)', () => {
  const RELATIVE_PORT = 4312
  const RELATIVE_ORIGIN = `http://127.0.0.1:${RELATIVE_PORT}`
  const RELATIVE_VOCAB_PATH = '/Api/Vocab'

  let server: Server
  let discovered: DiscoveredApi
  const requested: string[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', RELATIVE_ORIGIN).pathname
      requested.push(path)

      if (path === '/Api/') {
        response.writeHead(200, {
          'Content-Type': 'application/ld+json',
          // Relative — no origin, no scheme. Only resolution against the response URL reaches it.
          Link: `</Api/Vocab>; rel="http://www.w3.org/ns/hydra/core#apiDocumentation"`,
        })
        response.end(
          JSON.stringify({
            '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { ns: NS }],
            '@id': `${RELATIVE_ORIGIN}/Api/`,
            '@type': 'EntryPoint',
          }),
        )
        return
      }

      if (path === RELATIVE_VOCAB_PATH) {
        response.writeHead(200, { 'Content-Type': 'application/ld+json' })
        response.end(
          JSON.stringify({
            '@context': ['http://www.w3.org/ns/hydra/context.jsonld', { ns: NS }],
            '@id': `${RELATIVE_ORIGIN}${RELATIVE_VOCAB_PATH}`,
            '@type': 'ApiDocumentation',
            // The ontology, advertised (full IRI so the key survives expansion regardless of the
            // Hydra context's rdfs mapping). Discovery reads it instead of dereferencing a term IRI.
            'http://www.w3.org/2000/01/rdf-schema#isDefinedBy': { '@id': `${RELATIVE_ORIGIN}/ns` },
            supportedClass: [
              {
                '@id': `${NS}Widget`,
                '@type': 'Class',
                title: 'Widget',
                supportedOperation: [{ '@type': 'Operation', method: 'GET', returns: `${NS}Widget` }],
              },
            ],
          }),
        )
        return
      }

      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no route for ${path}`)
    })

    await new Promise<void>((resolve) => server.listen(RELATIVE_PORT, '127.0.0.1', resolve))

    const trace = createTrace()
    trace.start()

    discovered = await discoverApi(`${RELATIVE_ORIGIN}/Api/`, {
      http: createHttpClient({ token: null }),
      graph: createSessionGraph(),
      contexts: createContextStore(),
      findings: createFindings(),
      trace,
    })
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('resolves the relative target onto the session origin', () => {
    expect(discovered.vocabularyUrl).toBe(`${RELATIVE_ORIGIN}${RELATIVE_VOCAB_PATH}`)
    expect(discovered.rebased).toBe(false)
    expect(requested).toContain(RELATIVE_VOCAB_PATH)
  })

  it('reads the ontology the vocabulary advertises, rather than inferring it from a term IRI', () => {
    expect(discovered.ontologyUrl).toBe(`${RELATIVE_ORIGIN}/ns`)
  })
})
