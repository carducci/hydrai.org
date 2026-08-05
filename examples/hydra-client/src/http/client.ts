/**
 * The transport layer.
 *
 * The bottom of the stack: fetching, bearer auth, content negotiation, and reading `Link` headers.
 * Everything above works in IRIs and quads. Nothing here knows what a vocabulary or a collection is.
 *
 * Response headers are part of the interface, not an afterthought. The proof of concept's `_fetch`
 * returned `r.json()` and discarded `r.headers` entirely, which is why it could never have discovered
 * the vocabulary from the `Link` header it claimed to read.
 */

export const LD_JSON = 'application/ld+json'

export interface HttpResponse {
  /** The URL the response actually came from, after any redirects. */
  readonly url: string
  readonly status: number
  readonly ok: boolean
  readonly contentType: string | null
  /** Link relations, keyed by `rel`, each target resolved to an absolute IRI against {@link url}. */
  readonly links: ReadonlyMap<string, string>
  readonly body: string
}

export class HttpError extends Error {
  readonly status: number
  readonly url: string
  readonly body: string

  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} from <${url}>`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
  }
}

export interface RequestOptions {
  readonly method?: string
  readonly body?: string
  readonly accept?: string
  readonly contentType?: string
  /** Throw on a non-2xx instead of returning it. Off by default: a declared status is a result. */
  readonly throwOnError?: boolean
}

export interface HttpClient {
  request(url: string, options?: RequestOptions): Promise<HttpResponse>
  /** Convenience for the common case: a JSON-LD GET whose body is parsed. */
  getJsonLd(url: string): Promise<{ response: HttpResponse; document: unknown }>
  setToken(token: string | null): void
}

/**
 * Parse an HTTP `Link` header into `rel → target`.
 *
 * Targets are angle-bracketed, so splitting on commas has to respect the brackets — a target may
 * legitimately contain one. Only the first occurrence of a given `rel` is kept.
 */
export function parseLinkHeader(value: string | null): Map<string, string> {
  const links = new Map<string, string>()
  if (!value) return links

  // Split on commas that are not inside angle brackets.
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '<') depth++
    else if (char === '>') depth--
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)

  for (const part of parts) {
    const target = /<([^>]*)>/.exec(part)?.[1]
    if (!target) continue
    for (const rel of /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(part)?.[1]?.trim().split(/\s+/) ?? []) {
      if (!links.has(rel)) links.set(rel, target)
    }
  }

  return links
}

/**
 * Resolve parsed `Link` targets against the URL that carried them (RFC 8288 §3).
 *
 * A `Link` target is a URI-reference — it may be relative, and the web defines its meaning as the
 * result of resolving it against the response URL (RFC 3986). The transport is the only layer that
 * holds that URL, so resolution belongs here: every consumer of `links` then reads absolute IRIs and
 * none has to re-derive a base. This closes a real conformance gap — the client had only ever been
 * exercised against absolute targets because the server only ever emitted them, so a relative
 * `Link: </Api/Vocab>` reached `fetch` verbatim and threw. Relative and absolute forms now discover
 * equivalently. A cross-origin *absolute* target is left absolute for the origin layer to rebase; a
 * relative one resolves onto the response's own origin and needs no rebase.
 */
function resolveLinks(links: Map<string, string>, responseUrl: string): Map<string, string> {
  const resolved = new Map<string, string>()
  for (const [rel, target] of links) {
    try {
      resolved.set(rel, new URL(target, responseUrl).href)
    } catch {
      // The response URL was not absolute (only reachable via a synthetic base in a test). There is
      // no base to resolve against, so the raw target is the most faithful thing to carry forward.
      resolved.set(rel, target)
    }
  }
  return resolved
}

export interface HttpClientOptions {
  readonly token?: string | null
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch
  readonly onRequest?: (method: string, url: string) => void
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  let token = options.token ?? null
  const doFetch = options.fetchImpl ?? fetch

  async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const method = opts.method ?? 'GET'
    const headers: Record<string, string> = { Accept: opts.accept ?? `${LD_JSON}, application/json;q=0.9` }
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (opts.contentType) headers['Content-Type'] = opts.contentType

    options.onRequest?.(method, url)

    const init: RequestInit = { method, headers }
    if (opts.body !== undefined) init.body = opts.body

    const response = await doFetch(url, init)
    const body = await response.text()

    const responseUrl = response.url || url
    const result: HttpResponse = {
      url: responseUrl,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('Content-Type'),
      links: resolveLinks(parseLinkHeader(response.headers.get('Link')), responseUrl),
      body,
    }

    if (!result.ok && opts.throwOnError) throw new HttpError(result.url, result.status, body)
    return result
  }

  return {
    request,

    async getJsonLd(url: string) {
      const response = await request(url, { throwOnError: true })
      let document: unknown
      try {
        document = JSON.parse(response.body)
      } catch (cause) {
        throw new Error(
          `<${url}> answered ${response.status} but the body is not JSON ` +
            `(Content-Type: ${response.contentType ?? 'absent'})`,
          { cause },
        )
      }
      return { response, document }
    },

    setToken(next: string | null) {
      token = next
    },
  }
}
