import hydraContext from './contexts/hydra-context.json'

/**
 * The JSON-LD document loader (design D9).
 *
 *     bundled → session cache → network → FAIL LOUDLY
 *
 * `jsonld.js` fetches remote `@context` documents during expansion. On the connect path against a
 * Hydra API that means a request to `w3.org` from the browser, and the W3C copy of the Hydra context
 * serves **no** `Access-Control-Allow-Origin` header — so bundling it is a requirement, not an
 * optimisation.
 *
 * Failure must be loud. A JSON-LD processor that cannot fetch a context does not fail by default: it
 * drops the terms that context would have mapped and returns a smaller, entirely valid-looking graph.
 * That is silent loss at the semantic layer, and it presents later as "the vocabulary does not declare
 * X" — a bug that looks like a missing feature. So every failure here throws a named error carrying
 * the document's identity, and expansion is abandoned rather than completed.
 */

/** Thrown when a context cannot be resolved. Named so callers can report it precisely. */
export class ContextFetchError extends Error {
  readonly url: string
  readonly cause?: unknown

  constructor(url: string, reason: string, cause?: unknown) {
    super(
      `Could not load the JSON-LD context <${url}>: ${reason}. ` +
        `Expansion was abandoned rather than continued, because a missing context silently drops ` +
        `the terms it would have mapped. If this document is served by the API, it must be readable ` +
        `cross-origin (CORS) for a browser-based client.`,
    )
    this.name = 'ContextFetchError'
    this.url = url
    if (cause !== undefined) this.cause = cause
  }
}

export interface RemoteDocument {
  contextUrl: null
  document: unknown
  documentUrl: string
}

export type DocumentLoader = (url: string) => Promise<RemoteDocument>

/**
 * Scheme- and trailing-slash-insensitive key.
 *
 * A publisher may reference the Hydra context as `http://` or `https://` — this API uses `http://`
 * while the canonical URL is `https://` — and both denote the same document. Matching on scheme alone
 * would send one of them to the network for no reason.
 */
function cacheKey(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/**
 * Contexts baked in at build time. Standard vocabularies only — a customer's own contexts are
 * discovered at runtime and cached in-session, never bundled.
 *
 * `schema.org` is deliberately absent despite being listed in D9. Nothing on this API's connect path
 * references it as a *context document* (the served `/Api/Context` maps `schema:` as a prefix
 * instead), its full context is close to a megabyte, and unlike `w3.org` it is served CORS-enabled so
 * the network tier resolves it correctly. Add it here the first time a document actually needs it.
 */
const BUNDLED: ReadonlyArray<readonly [string, unknown]> = [
  ['http://www.w3.org/ns/hydra/context.jsonld', hydraContext],
]

export interface DocumentLoaderOptions {
  /** Injected so tests need no network, and so the http layer owns real fetching. */
  fetchJson?: (url: string) => Promise<unknown>
  /** Set false to make any non-bundled, non-cached context a hard error. */
  allowNetwork?: boolean
}

export interface ContextStore {
  readonly load: DocumentLoader
  /** Seed the session cache — used by runtime context discovery (task 2.4). */
  prime(url: string, document: unknown): void
  /** Which contexts have been resolved, and how. Surfaced in the trace and the tier report. */
  resolutions(): ReadonlyMap<string, 'bundled' | 'cached' | 'network'>
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/ld+json, application/json;q=0.9' },
  })
  if (!response.ok) throw new ContextFetchError(url, `the server answered HTTP ${response.status}`)
  return response.json()
}

export function createContextStore(options: DocumentLoaderOptions = {}): ContextStore {
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const allowNetwork = options.allowNetwork ?? true

  const bundled = new Map(BUNDLED.map(([url, doc]) => [cacheKey(url), doc]))
  const cached = new Map<string, unknown>()
  const resolutions = new Map<string, 'bundled' | 'cached' | 'network'>()

  const load: DocumentLoader = async (url: string) => {
    const key = cacheKey(url)

    const fromBundle = bundled.get(key)
    if (fromBundle !== undefined) {
      resolutions.set(url, 'bundled')
      return { contextUrl: null, document: fromBundle, documentUrl: url }
    }

    const fromCache = cached.get(key)
    if (fromCache !== undefined) {
      resolutions.set(url, 'cached')
      return { contextUrl: null, document: fromCache, documentUrl: url }
    }

    if (!allowNetwork) {
      throw new ContextFetchError(url, 'it is not bundled and network loading is disabled')
    }

    let document: unknown
    try {
      document = await fetchJson(url)
    } catch (cause) {
      if (cause instanceof ContextFetchError) throw cause
      // A cross-origin rejection is indistinguishable from a network error in `fetch`, so name both
      // possibilities rather than guessing which one happened.
      throw new ContextFetchError(
        url,
        'the request failed — the document is unreachable, or it is served without CORS headers',
        cause,
      )
    }

    cached.set(key, document)
    resolutions.set(url, 'network')
    return { contextUrl: null, document, documentUrl: url }
  }

  return {
    load,
    prime(url: string, document: unknown) {
      cached.set(cacheKey(url), document)
    },
    resolutions: () => resolutions,
  }
}
