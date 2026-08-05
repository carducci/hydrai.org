import { createServer, type Server as HttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createHydraMcpServer } from '../mcp/server'
import { createSessionStore } from '../mcp/session'
import { MCP_TOOLS } from '../mcp/tools'
import { ENVELOPE, ENVELOPE_TOOLS } from '../src/project/tools'
import { ORCHESTRATION } from '../src/agent/prompt'
import { QUERY_TOOL_NAME, queryTool } from '../src/query/tool'

/**
 * The MCP round-trip (tasks 3.3–3.5, 4.1, 4.2).
 *
 * A real SDK client talks to the real shell over the in-memory linked transport, and the shell
 * connects to a fixture-backed Hydra server over real HTTP — the same `library-vocab.json` the
 * runtime suite uses, so the pinned behaviour travels. The embedded server is fake-hydra's routes
 * plus a POST echo (the browser dev-aid has no reason to accept writes; this does, so the create
 * path is exercised offline). Everything runs in `npm test`, gated by nothing.
 */

const LEND = 'https://lending.example/ns#'
const STACKS_CLASS = `${LEND}Stacks`
const LD_CONTEXT = ['http://www.w3.org/ns/hydra/context.jsonld', { lend: LEND }]

const fixturePath = fileURLToPath(new URL('./fixtures/library-vocab.json', import.meta.url))

/** Boot the fixture-backed API on an ephemeral port; returns the origin and a stop handle. */
async function startFakeHydra(): Promise<{ origin: string; server: HttpServer; posted: unknown[] }> {
  // Placeholder — rewritten to the real origin once the OS assigns a port below.
  let origin = ''
  const posted: unknown[] = []

  const tome = (n: number) => ({
    '@id': `${origin}/tomes/${n}`,
    '@type': 'lend:Tome',
    'lend:heading': `Tome ${n}`,
    'lend:isbn': null,
    'lend:shelvedOn': null,
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    const path = url.pathname
    const send = (status: number, body: unknown, link?: string) => {
      response.writeHead(status, {
        'Content-Type': 'application/ld+json',
        ...(link ? { Link: link } : {}),
      })
      response.end(JSON.stringify(body))
    }

    if (path === '/Api/') {
      // The vocabulary is advertised relatively, so the round-trip also exercises the client's
      // RFC 8288 resolution (task 1.1) end-to-end through the MCP boundary.
      send(200, { '@context': LD_CONTEXT, '@id': `${origin}/Api/`, '@type': 'EntryPoint' },
        `</Api/Vocab>; rel="http://www.w3.org/ns/hydra/core#apiDocumentation"`)
      return
    }
    if (path === '/Api/Vocab') {
      const vocab = JSON.parse(readFileSync(fixturePath, 'utf8').replaceAll('https://lending.example/api', origin))
      send(200, vocab)
      return
    }
    // The stacks collection: its base, its search form, and its pagination form all list members.
    if (path === '/stacks' && request.method === 'GET') {
      send(200, { '@context': LD_CONTEXT, '@id': `${origin}/stacks`, '@type': 'Collection', totalItems: 3, member: [tome(1), tome(2), tome(3)] })
      return
    }
    if (path.startsWith('/stacks/leaf/')) {
      send(200, { '@context': LD_CONTEXT, '@id': `${origin}${path}`, '@type': 'Collection', totalItems: 3, member: [tome(1), tome(2), tome(3)] })
      return
    }
    if (path === '/stacks' && request.method === 'POST') {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        posted.push(JSON.parse(raw || '{}'))
        send(201, { ...JSON.parse(raw || '{}'), '@context': LD_CONTEXT, '@id': `${origin}/tomes/9`, '@type': 'lend:Tome' })
      })
      return
    }
    if (path.startsWith('/tomes/')) {
      const n = Number(path.slice('/tomes/'.length)) || 1
      send(200, { '@context': LD_CONTEXT, ...tome(n) })
      return
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end(`no route for ${path}`)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, server, posted }
}

/** A connected SDK client ↔ shell pair sharing one session store. */
async function connectPair(store = createSessionStore()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const { server } = createHydraMcpServer({ store, logSink: () => undefined, defaultToken: null })
  await server.connect(serverTransport)
  const client = new Client({ name: 'round-trip', version: '0' })
  await client.connect(clientTransport)
  return { client, server, store }
}

/** The MCP call-result shape we assert on — the SDK's return is a wider compat union. */
type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean }

/** Call a tool and narrow the SDK's compat-union return to {@link ToolResult}. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult
}

/** The text of a tool result. */
function textOf(result: ToolResult): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('\n')
}

describe('the MCP shell drives the runtime end to end', () => {
  let fake: { origin: string; server: HttpServer; posted: unknown[] }
  let client: Client
  let handle: string

  beforeAll(async () => {
    fake = await startFakeHydra()
    const pair = await connectPair()
    client = pair.client

    const connected = await call(client, 'connect', { entrypoint: `${fake.origin}/Api/` })
    const body = textOf(connected)
    const match = /pass as "session" to every other tool\): (\S+)/.exec(body)
    handle = match?.[1] ?? ''
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  })

  it('connect returns the collections index with addresses and write verbs, and a handle', async () => {
    const connected = await call(client, 'connect', { entrypoint: `${fake.origin}/Api/` })
    const body = textOf(connected)

    expect(body).toContain('Session handle')
    expect(handle).not.toEqual('')
    // Capability arrives as content: the collection, its address, and its create verb are all present
    // before any envelope call has been made.
    expect(body).toContain('COLLECTIONS')
    expect(body).toContain('Stacks')
    expect(body).toContain(`${fake.origin}/stacks`)
    expect(body.toLowerCase()).toContain('create')
    expect(connected.isError).toBeFalsy()
  })

  it('search_collection completes a listing', async () => {
    const result = await call(client, 'search_collection', { session: handle, collection: STACKS_CLASS })
    const body = textOf(result)
    expect(result.isError).toBeFalsy()
    // The listing hands back member identifiers and a count.
    expect(body).toContain('/tomes/')
    expect(body).toMatch(/\b3\b/)
  })

  it('follow opens one page', async () => {
    const result = await call(client, 'follow', { session: handle, iri: `${fake.origin}/stacks` })
    const body = textOf(result)
    expect(result.isError).toBeFalsy()
    expect(body).toContain('/tomes/')
  })

  it('invoke refuses an incomplete write with the full contract, and issues no request', async () => {
    const before = fake.posted.length
    const result = await call(client, 'invoke', { session: handle, affordance: 'post_Stacks', input: {} })
    const body = textOf(result)

    // A refusal is a result, never a protocol error — the call succeeds at the protocol layer.
    expect(result.isError).toBeFalsy()
    expect(body).toContain('heading') // the required field it named
    expect(fake.posted.length).toBe(before) // no request was issued
  })

  it('invoke creates once the contract is satisfied', async () => {
    const before = fake.posted.length
    const result = await call(client, 'invoke', { session: handle, affordance: 'post_Stacks', input: { heading: 'Accession One' } })
    expect(result.isError).toBeFalsy()
    expect(fake.posted.length).toBe(before + 1)
  })

  it('sparql answers locally when no endpoint is advertised', async () => {
    const result = await call(client, 'sparql', {
      session: handle,
      query: `PREFIX lend: <${LEND}>\nSELECT (COUNT(?t) AS ?n) WHERE { ?t a lend:Tome }`,
    })
    const body = textOf(result)
    expect(result.isError).toBeFalsy()
    // The aggregate returns the figure, computed locally over the session's materialised members —
    // the three the listing populated, plus any this session has since created (the create test runs
    // first against the shared session), so the count is at least three.
    const answer = Number(body.trim().split('\n').pop())
    expect(answer).toBeGreaterThanOrEqual(3)
    // Generous timeout: the first local query in a process pays Comunica's cold construction cost
    // (the D6 / task 5.1 measurement), which the query-local suite budgets the same way.
  }, 300_000)

  it('writes the operator trace to its sink with an elapsed/kind prefix (task 3.4)', async () => {
    const lines: string[] = []
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const { server } = createHydraMcpServer({ logSink: (line) => lines.push(line), defaultToken: null })
    await server.connect(serverTransport)
    const traced = new Client({ name: 'trace', version: '0' })
    await traced.connect(clientTransport)

    await call(traced, 'connect', { entrypoint: `${fake.origin}/Api/` })

    // Discovery logs reads and outcomes; every line carries the `[elapsed] kind: message` prefix.
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((line) => /^\[[-0-9.]+s?\] (info|http|success|warn): /.test(line))).toBe(true)
  })

  it('an envelope call with an unknown handle refuses toward reconnection, naming the entry point', async () => {
    const { client: fresh } = await connectPair()
    const result = await call(fresh, 'search_collection', { session: 'not-a-real-handle', collection: STACKS_CLASS })
    const body = textOf(result)
    expect(result.isError).toBeFalsy()
    expect(body.toLowerCase()).toContain('reconnect')
  })

  it('a lost handle that still decodes names the entry point to reconnect to', async () => {
    // Mint a session, then look it up in a store that never held it — the eviction case.
    const { client: fresh } = await connectPair()
    const connected = await call(fresh, 'connect', { entrypoint: `${fake.origin}/Api/` })
    const minted = /session" to every other tool\): (\S+)/.exec(textOf(connected))?.[1] ?? ''

    // A different pair, different store — the handle decodes but is unknown here.
    const { client: other } = await connectPair()
    const result = await call(other, 'follow', { session: minted, iri: `${fake.origin}/stacks` })
    const body = textOf(result)
    expect(body).toContain(`${fake.origin}/Api/`)
  })
})

describe('the tool surface is constant and cacheable (task 4.2)', () => {
  it('lists exactly six tools in a stable order, byte-identical across calls', async () => {
    const { client } = await connectPair()

    const first = await client.listTools()
    const second = await client.listTools()

    const names = first.tools.map((tool) => tool.name)
    expect(names).toEqual(['connect', 'follow', 'search_collection', 'get_resource', 'invoke', 'sparql'])
    expect(second.tools.map((tool) => tool.name)).toEqual(names)
    // Byte-identical: the schemas do not vary call to call.
    expect(JSON.stringify(second.tools)).toEqual(JSON.stringify(first.tools))
  })

  it('carries ttlMs and a private cacheScope on the list result', async () => {
    const { client } = await connectPair()
    const listed = (await client.listTools()) as unknown as { ttlMs?: number; cacheScope?: string }
    expect(listed.ttlMs).toBeGreaterThan(0)
    expect(listed.cacheScope).toBe('private')
  })

  it('requires session on the envelope five and never carries the strict flag or a format keyword', async () => {
    const { client } = await connectPair()
    const { tools } = await client.listTools()

    for (const tool of tools) {
      if (tool.name === 'connect') continue
      const required = (tool.inputSchema as { required?: string[] }).required ?? []
      expect(required).toContain('session')
    }

    // The Anthropic-only strict flag has no MCP equivalent and must not appear; no schema carries a
    // `format` keyword (the dotless-host trap, pinned on the runtime side).
    const wire = JSON.stringify(tools)
    expect(wire).not.toContain('"strict"')
    expect(wire).not.toContain('"format"')
  })

  it('sources every description from the runtime, so the two embeddings cannot drift (task 3.3)', () => {
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]))

    // The envelope five carry the runtime's own descriptions byte-for-byte — one source, imported.
    for (const runtime of ENVELOPE_TOOLS) {
      expect(byName.get(runtime.name)?.description).toBe(runtime.description)
    }
    expect(byName.get(QUERY_TOOL_NAME)?.description).toBe(queryTool().description)

    // connect carries the page's orchestration prose verbatim — the same constant buildSystem uses.
    expect(byName.get('connect')?.description).toContain(ORCHESTRATION)

    // And the runtime really does define the five names the shell reuses (a rename would surface here).
    expect([...byName.keys()].sort()).toEqual(
      ['connect', ENVELOPE.follow, ENVELOPE.getResource, ENVELOPE.invoke, ENVELOPE.searchCollection, QUERY_TOOL_NAME].sort(),
    )
  })

  it('advertises tools only — no deprecated logging, sampling, or roots (task 3.4)', async () => {
    const { client } = await connectPair()

    const capabilities = client.getServerCapabilities() as Record<string, unknown> | undefined
    expect(capabilities?.tools).toBeDefined()
    expect(capabilities?.logging).toBeUndefined()
    expect(capabilities?.sampling).toBeUndefined()
    expect(capabilities?.roots).toBeUndefined()

    // The initialize handshake stands in for 07-28's server/discover on the pinned SDK (design D2):
    // versions and identity are exchanged before any tool call.
    expect(client.getServerVersion()?.name).toBe('hydra-mcp-server')
  })
})
