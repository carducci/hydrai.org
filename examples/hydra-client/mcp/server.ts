import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createTrace, formatElapsed, type Trace } from '../src/trace'

import {
  composeSession,
  createSessionStore,
  entrypointOf,
  type SessionStore,
} from './session'
import {
  CONNECT,
  ENVELOPE_TOOL_NAMES,
  LIST_CACHE_SCOPE,
  LIST_TTL_MS,
  MCP_TOOLS,
  SESSION_ARG,
} from './tools'

/**
 * The MCP server: composition and protocol translation only (spec: "not a fork").
 *
 * It holds no capability of its own. `connect` composes a runtime session and mints a handle; the
 * envelope five look the handle up and hand the call — with the handle stripped back off — to that
 * session's `Executor`, which is the same gate the page dispatches through. Where the page's tool_use
 * loop reads `ToolOutcome.content`, this reads the identical field and puts it on an MCP result.
 *
 * Two rules are load-bearing and both come straight from the runtime's doctrine:
 *  - **Refusals are results.** No tool result is ever marked `isError`. A refusal (bad constraint,
 *    unknown filter, lost handle, budget, foreign origin) reaches the model as ordinary content
 *    carrying the full contract. An MCP client that saw `isError` would retry blindly — the exact
 *    loop-poisoning the executor's never-throw rule exists to prevent.
 *  - **The trace is operator-facing.** Every entry goes to stderr with its elapsed/kind prefix,
 *    visible in any client's server-log view with zero protocol footprint. (The pinned SDK predates
 *    the 07-28 per-request `notifications/message` channel, which needs the deprecated Logging
 *    capability we deliberately do not advertise — so stderr is the whole trace surface. Recorded in
 *    design D2/D5.)
 */

export interface HydraMcpServer {
  readonly server: Server
  readonly store: SessionStore
  readonly trace: Trace
}

export interface HydraMcpServerOptions {
  readonly store?: SessionStore
  readonly trace?: Trace
  /** The token used when a `connect` call supplies none. Defaults to `HYDRA_MCP_TOKEN`. */
  readonly defaultToken?: string | null
  /** Where the operator trace is written. Defaults to stderr; injectable for tests. */
  readonly logSink?: (line: string) => void
}

/** A tool result carrying text. Never `isError` — refusals are results (design D7). */
function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

/** Mirror newly-appended trace entries to the operator sink, resetting the cursor on a clear(). */
function pipeTrace(trace: Trace, sink: (line: string) => void): void {
  let written = 0
  trace.subscribe(() => {
    const entries = trace.entries
    if (entries.length < written) written = 0
    for (; written < entries.length; written += 1) {
      const entry = entries[written]
      if (entry) sink(`[${formatElapsed(entry.elapsed)}] ${entry.kind}: ${entry.message}`)
    }
  })
}

export function createHydraMcpServer(options: HydraMcpServerOptions = {}): HydraMcpServer {
  const store = options.store ?? createSessionStore()
  const trace = options.trace ?? createTrace()
  const defaultToken =
    options.defaultToken !== undefined ? options.defaultToken : process.env['HYDRA_MCP_TOKEN'] ?? null
  const sink = options.logSink ?? ((line: string) => process.stderr.write(`${line}\n`))

  pipeTrace(trace, sink)

  const server = new Server(
    { name: 'hydra-mcp-server', version: '0.0.0' },
    // Tools only. Logging, Sampling and Roots are deprecated in 07-28 and simply not advertised.
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Constant order, constant schemas — byte-identical every call, which is what makes the list a
    // cache hit. ttlMs / cacheScope ride as passthrough fields (design D2).
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ttlMs: LIST_TTL_MS,
    cacheScope: LIST_CACHE_SCOPE,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    if (name === CONNECT) return connect(args)
    if (ENVELOPE_TOOL_NAMES.includes(name)) return dispatch(name, args)

    return text(
      `There is no tool called ${name}. The tools are ${[CONNECT, ...ENVELOPE_TOOL_NAMES].join(', ')}.`,
    )
  })

  async function connect(args: Record<string, unknown>) {
    const entrypoint = typeof args['entrypoint'] === 'string' ? args['entrypoint'].trim() : ''
    if (!entrypoint) {
      return text('connect requires an "entrypoint" — the absolute IRI of the API entry point.')
    }

    // Argument beats environment for multi-API use; the value is never echoed or held past the fetch.
    const token = (typeof args['token'] === 'string' && args['token']) || defaultToken

    try {
      trace.start()
      trace.log(`connect ${entrypoint}`, 'info')
      const session = await composeSession(entrypoint, token, trace)
      store.put(session)
      return text(
        `Session handle (pass as "${SESSION_ARG}" to every other tool): ${session.handle}\n\n` +
          session.map,
      )
    } catch (cause) {
      // A failed connect is a result, not a protocol error: the same reason writes never throw.
      const reason = cause instanceof Error ? cause.message : String(cause)
      trace.log(reason, 'error')
      return text(
        `Could not connect to <${entrypoint}>: ${reason}\n\n` +
          `No session was created. Check the entry-point IRI and that the API is reachable.`,
      )
    }
  }

  async function dispatch(name: string, args: Record<string, unknown>) {
    const handle = typeof args[SESSION_ARG] === 'string' ? (args[SESSION_ARG] as string) : ''
    const session = handle ? store.get(handle) : undefined

    if (!session) {
      // A lost handle refuses toward recovery, naming the entry point where the handle still decodes.
      const known = handle ? entrypointOf(handle) : null
      return text(
        `No live session for that handle` +
          (known ? ` — it was minted for <${known}>` : '') +
          `. Reconnect with connect` +
          (known ? ` { "entrypoint": "${known}" }` : '') +
          `; discovery is all it costs — four fetches (the entry point, the vocabulary, its ` +
          `contexts, and the reference collections). No request was issued.`,
      )
    }

    // The executor never learned about `session`; strip it before the call so it sees only the
    // runtime's own wire shape.
    const { [SESSION_ARG]: _handle, ...rest } = args
    const outcome = await session.executor.execute(name, rest)
    // isError stays unset whatever `outcome.ok` says — a refusal is a result, not a failure.
    return text(outcome.content)
  }

  return { server, store, trace }
}
