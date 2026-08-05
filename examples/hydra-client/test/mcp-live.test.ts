import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createHydraMcpServer } from '../mcp/server'

/**
 * The MCP live smoke (task 4.3) — the executor-level 5.4 create/delete regression, now through the
 * MCP boundary and against a booted deployment.
 *
 * Skipped unless `HYDRA_LIVE=1`, because it needs a running app and mutates real data — it must never
 * be what fails in CI. It drives a real SDK client at the real shell over the in-memory transport;
 * only the deployment is live. The token comes from `HYDRA_MCP_TOKEN` (the shell's own variable) or
 * `HYDRA_LIVE_TOKEN` (shared with the connect suite), and is deliberately not in this file.
 *
 *   HYDRA_LIVE=1 HYDRA_MCP_TOKEN=<pat> npm test -- mcp-live
 *
 * It searches the **Call** collection specifically: Call is EF-backed and answers on a local boot,
 * where the Azure-Search-backed Contact/Company/Event collections 500 when Search is unreachable.
 * The create/delete round-trips a **Contact** (givenName/familyName are its only required writeable
 * fields), reads it back to echo-verify, and deletes it in a `finally` so a failed run leaves nothing
 * behind.
 */

const live = process.env['HYDRA_LIVE'] === '1'
const entrypoint = process.env['HYDRA_LIVE_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const token = process.env['HYDRA_MCP_TOKEN'] ?? process.env['HYDRA_LIVE_TOKEN'] ?? null

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean }

async function connectPair() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const { server } = createHydraMcpServer({ logSink: () => undefined, defaultToken: token })
  await server.connect(serverTransport)
  const client = new Client({ name: 'mcp-live-smoke', version: '0' })
  await client.connect(clientTransport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult
}

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('\n')
}

/** First capture group of `re` in `map`, or a loud failure that prints the map for the operator. */
function fromMap(map: string, re: RegExp, what: string): string {
  const match = re.exec(map)
  if (!match?.[1]) throw new Error(`Could not find ${what} in the connect map.\n\n${map}`)
  return match[1]
}

describe.skipIf(!live)('the MCP shell drives a booted deployment (task 4.3)', () => {
  let client: Client
  let handle = ''
  let map = ''

  beforeAll(async () => {
    client = await connectPair()
    const connected = await call(client, 'connect', { entrypoint, token: token ?? undefined })
    map = textOf(connected)
    handle = fromMap(map, /every other tool\): (\S+)/, 'the session handle')
  }, 120_000)

  afterAll(() => undefined)

  it('connect returns a handle and a map naming the Call and Contact collections', () => {
    expect(handle).not.toEqual('')
    expect(map).toContain('COLLECTIONS')
    expect(map).toMatch(/\bCall\b/)
    expect(map).toMatch(/\bContact\b/)
  })

  it('search_collection lists the EF-backed Call collection', async () => {
    // The Call collection's address, taken from the map rather than constructed.
    const callAddress = fromMap(map, /at <([^>]*\/Api\/Call\/?[^>]*)>/, 'the Call collection address')
    const result = await call(client, 'search_collection', { session: handle, collection: callAddress })

    expect(result.isError).toBeFalsy()
    // A listing states how many members it holds; a 500 from an unreachable backend would not.
    expect(textOf(result).toLowerCase()).toMatch(/member|item|result|total|\bcount\b/)
  })

  it('invoke refuses an empty Contact create with the contract, issuing no request (3.5, live)', async () => {
    const createHandle = fromMap(map, /create with (\w*[Cc]ontact\w*)/, 'a Contact create handle')
    const refused = await call(client, 'invoke', { session: handle, affordance: createHandle, input: {} })

    expect(refused.isError).toBeFalsy()
    // The required writeable fields are named back — a refusal is a result carrying the full contract.
    expect(textOf(refused)).toMatch(/givenName|familyName/)
  })

  it('creates a Contact, reads it back (echo-verified), then deletes it', async () => {
    const createHandle = fromMap(map, /create with (\w*[Cc]ontact\w*)/, 'a Contact create handle')
    const deleteHandle = fromMap(map, /delete with (delete_\w*[Cc]ontact\w*)/, 'a Contact delete handle')

    // Unique per run so the echo-verify cannot pass on a pre-existing record.
    const marker = `MCPSmoke${Date.now()}`

    const created = await call(client, 'invoke', {
      session: handle,
      affordance: createHandle,
      input: { givenName: 'MCP', familyName: marker },
    })
    expect(created.isError).toBeFalsy()

    const createdIri = /(https?:\/\/\S*\/Api\/Contact\/Id\/[0-9a-fA-F-]{36})/.exec(textOf(created))?.[1]
    expect(createdIri, `no created Contact IRI in:\n${textOf(created)}`).toBeTruthy()

    try {
      // Echo-verify: a fresh dereference of the new resource carries the value we wrote.
      const readBack = await call(client, 'get_resource', { session: handle, iri: createdIri! })
      expect(readBack.isError).toBeFalsy()
      expect(textOf(readBack)).toContain(marker)
    } finally {
      // Always clean up, even if the read-back assertion failed — no orphan contacts per run.
      const deleted = await call(client, 'invoke', {
        session: handle,
        affordance: deleteHandle,
        input: { id: createdIri! },
      })
      expect(deleted.isError).toBeFalsy()
    }

    // The record is gone: reading it again no longer carries the marker.
    const afterDelete = await call(client, 'get_resource', { session: handle, iri: createdIri! })
    expect(textOf(afterDelete)).not.toContain(marker)
  }, 120_000)
})
