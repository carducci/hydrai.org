import { describe, expect, it } from 'vitest'

import { createHttpClient, parseLinkHeader } from '../src/http/client'

/**
 * The `Link` header is how the vocabulary is found (task 3.1), so parsing it is on the critical path
 * of every connect. The proof of concept never read a response header at all — `_fetch` returned
 * `r.json()` and discarded `r.headers` — which is why it constructed `base + 'Vocab'` while claiming
 * the server had advertised the URL.
 */
describe('parsing the Link header', () => {
  const APIDOC = 'http://www.w3.org/ns/hydra/core#apiDocumentation'

  it('reads the relation this API actually sends', () => {
    const links = parseLinkHeader(`<https://example.test/Api/Vocab>; rel="${APIDOC}"`)
    expect(links.get(APIDOC)).toBe('https://example.test/Api/Vocab')
  })

  it('reads several relations from one header', () => {
    const links = parseLinkHeader(
      `<https://example.test/Api/Vocab>; rel="${APIDOC}", <https://example.test/Api/>; rel="home"`,
    )
    expect(links.get(APIDOC)).toBe('https://example.test/Api/Vocab')
    expect(links.get('home')).toBe('https://example.test/Api/')
  })

  it('does not split a target that contains a comma', () => {
    // Splitting naively on commas corrupts the URL and the vocabulary becomes unreachable.
    const links = parseLinkHeader('<https://example.test/Api/Search?q=a,b>; rel="search"')
    expect(links.get('search')).toBe('https://example.test/Api/Search?q=a,b')
  })

  it('handles an unquoted rel and multiple space-separated relations', () => {
    const links = parseLinkHeader('<https://example.test/x>; rel=next')
    expect(links.get('next')).toBe('https://example.test/x')

    const multi = parseLinkHeader('<https://example.test/y>; rel="first prefetch"')
    expect(multi.get('first')).toBe('https://example.test/y')
    expect(multi.get('prefetch')).toBe('https://example.test/y')
  })

  it('keeps the first target when a relation repeats', () => {
    const links = parseLinkHeader('<https://example.test/a>; rel="next", <https://example.test/b>; rel="next"')
    expect(links.get('next')).toBe('https://example.test/a')
  })

  it('is empty rather than throwing when there is no header', () => {
    expect(parseLinkHeader(null).size).toBe(0)
    expect(parseLinkHeader('').size).toBe(0)
    expect(parseLinkHeader('garbage').size).toBe(0)
  })
})

function stubFetch(config: {
  status?: number
  body?: string
  headers?: Record<string, string>
  capture?: (url: string, init: RequestInit | undefined) => void
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    config.capture?.(String(url), init)
    return new Response(config.body ?? '{}', {
      status: config.status ?? 200,
      headers: config.headers ?? { 'Content-Type': 'application/ld+json' },
    })
  }) as unknown as typeof fetch
}

describe('the http client', () => {
  it('negotiates for JSON-LD and carries the bearer token', async () => {
    let seen: RequestInit | undefined
    const client = createHttpClient({
      token: 'a-token',
      fetchImpl: stubFetch({ capture: (_url, init) => void (seen = init) }),
    })

    await client.request('http://example.test/Api/')

    const headers = seen?.headers as Record<string, string>
    expect(headers['Accept']).toContain('application/ld+json')
    expect(headers['Authorization']).toBe('Bearer a-token')
  })

  it('sends no Authorization header when there is no token', async () => {
    let seen: RequestInit | undefined
    const client = createHttpClient({
      fetchImpl: stubFetch({ capture: (_url, init) => void (seen = init) }),
    })

    await client.request('http://example.test/Api/Vocab')

    expect((seen?.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('exposes response headers, not just the body', async () => {
    const client = createHttpClient({
      fetchImpl: stubFetch({
        headers: {
          'Content-Type': 'application/ld+json',
          Link: '<http://example.test/Api/Vocab>; rel="http://www.w3.org/ns/hydra/core#apiDocumentation"',
        },
      }),
    })

    const response = await client.request('http://example.test/Api/')

    expect(response.links.get('http://www.w3.org/ns/hydra/core#apiDocumentation')).toBe(
      'http://example.test/Api/Vocab',
    )
  })

  it('resolves a relative Link target against the response URL (RFC 8288 §3)', async () => {
    // The server only ever emitted absolute targets, so a relative one had never been exercised and
    // reached `fetch` verbatim. A `Link` target is a URI-reference; its meaning is the resolution
    // against the URL that carried it.
    const client = createHttpClient({
      fetchImpl: stubFetch({
        headers: {
          'Content-Type': 'application/ld+json',
          Link: '</Api/Vocab>; rel="http://www.w3.org/ns/hydra/core#apiDocumentation"',
        },
      }),
    })

    const response = await client.request('http://example.test/Api/')

    expect(response.links.get('http://www.w3.org/ns/hydra/core#apiDocumentation')).toBe(
      'http://example.test/Api/Vocab',
    )
  })

  it('leaves an absolute Link target unchanged and resolves a protocol-relative one', async () => {
    const client = createHttpClient({
      fetchImpl: stubFetch({
        headers: {
          'Content-Type': 'application/ld+json',
          Link:
            '<http://example.test/Api/Vocab>; rel="service-desc", ' +
            '<//cdn.example.test/ns>; rel="describedby"',
        },
      }),
    })

    const response = await client.request('http://example.test/Api/')

    expect(response.links.get('service-desc')).toBe('http://example.test/Api/Vocab')
    // A protocol-relative reference inherits the response's scheme.
    expect(response.links.get('describedby')).toBe('http://cdn.example.test/ns')
  })

  it('returns a non-2xx as a result by default', async () => {
    // A status the vocabulary declares is an outcome to report semantically, not an exception. The
    // 402 Payment Required this API declares is the motivating case.
    const client = createHttpClient({ fetchImpl: stubFetch({ status: 402, body: 'nope' }) })

    const response = await client.request('http://example.test/Api/Contact/')

    expect(response.ok).toBe(false)
    expect(response.status).toBe(402)
  })

  it('throws for a JSON-LD get, where a body is the whole point', async () => {
    const client = createHttpClient({ fetchImpl: stubFetch({ status: 404, body: 'gone' }) })
    await expect(client.getJsonLd('http://example.test/Api/Vocab')).rejects.toThrow(/HTTP 404/)
  })

  it('reports a non-JSON body with the content type it actually got', async () => {
    const client = createHttpClient({
      fetchImpl: stubFetch({ body: '<html>login</html>', headers: { 'Content-Type': 'text/html' } }),
    })

    await expect(client.getJsonLd('http://example.test/Api/Vocab')).rejects.toThrow(/text\/html/)
  })
})
