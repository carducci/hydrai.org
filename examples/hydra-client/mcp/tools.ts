import { ENVELOPE, ENVELOPE_TOOLS, type JsonSchema } from '../src/project/tools'
import { ORCHESTRATION } from '../src/agent/prompt'
import { QUERY_TOOL_NAME, queryTool } from '../src/query/tool'

/**
 * The six tools (design D7): the constant envelope, translated — not redesigned — plus `connect`.
 *
 * Three deltas from the runtime wire schemas, and no more:
 *  1. a required `session` string on the envelope five (SEP-2567's handle-as-argument, verbatim);
 *  2. the Anthropic-only `strict` flag dropped — there is no MCP equivalent, and the SHACL/dispatch
 *     gate is the validator regardless (project/tools §8's position);
 *  3. `connect` added, which the page never needed because the page connects itself.
 *
 * Capability arrives as content, so the prose that steers orchestration is carried in the
 * descriptions — the only server-authored text guaranteed to reach the model on every MCP client.
 * Crucially it is **imported**, not re-authored: the envelope five and `sparql` reuse the runtime's
 * own descriptions byte-for-byte, and `connect` carries the page's `ORCHESTRATION` constant verbatim.
 * One source, both embeddings — they cannot drift, and a test pins that provenance.
 */

export const CONNECT = 'connect'
/** The handle argument threaded onto every envelope tool. */
export const SESSION_ARG = 'session'

export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  /** MCP names this `inputSchema` (camelCase), where the runtime names it `input_schema`. */
  readonly inputSchema: JsonSchema
}

const SESSION_PROPERTY: JsonSchema = {
  type: 'string',
  description:
    'The session handle returned by connect. Every read, search, write, and query runs against ' +
    'the API that handle was connected to.',
}

/** The runtime envelope schema, with `session` required and `strict` irrelevant (never carried). */
function withSession(schema: JsonSchema): JsonSchema {
  // structuredClone so the runtime's shared, frozen-in-spirit schemas are never mutated in place.
  const cloned = structuredClone(schema) as JsonSchema & {
    properties?: Record<string, JsonSchema>
    required?: string[]
  }
  const properties = { [SESSION_ARG]: SESSION_PROPERTY, ...(cloned.properties ?? {}) }
  // session leads `required`, and the list stays sorted so the surface is byte-identical every call.
  const required = [...new Set([SESSION_ARG, ...(cloned.required ?? [])])].sort()
  return { ...cloned, properties, required }
}

const query = queryTool()

/**
 * The tools in a fixed order (design D2 / the 07-28 determinism recommendation).
 *
 * `connect` first, then the reads, the write, and the query — a stable reading order. The order and
 * every schema are constant for the life of the process, which is what makes `tools/list` a cache hit
 * on every client that keys off it. The envelope descriptions come straight from `ENVELOPE_TOOLS`
 * (keyed by name so a runtime reorder cannot silently repoint them) and `sparql`'s from `queryTool`.
 */
const envelopeByName = new Map(ENVELOPE_TOOLS.map((tool) => [tool.name, tool]))
const envelope = (name: string): (typeof ENVELOPE_TOOLS)[number] => {
  const tool = envelopeByName.get(name)
  if (!tool) throw new Error(`The runtime no longer defines an envelope tool named ${name}.`)
  return tool
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: CONNECT,
    description:
      `Connect to a Hydra API by its entry-point IRI and read what it can do. Discovery reads the ` +
      `API's own published documents — vocabulary, contexts, shapes, reference collections — and ` +
      `returns a session handle plus the capability map: the collection index (with addresses and ` +
      `write verbs), the classes and properties for writing queries, the capability tier, and where ` +
      `SPARQL runs. Pass the handle to every other tool. A token may be supplied here or, ` +
      `preferably, in the HYDRA_MCP_TOKEN environment variable so it never transits the client.\n\n` +
      ORCHESTRATION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entrypoint: {
          type: 'string',
          description: 'The absolute IRI of the API entry point to connect to.',
        },
        token: {
          type: 'string',
          description:
            'Optional bearer token. Prefer HYDRA_MCP_TOKEN in the environment — an argument transits ' +
            'the client, where the environment variable does not.',
        },
      },
      required: ['entrypoint'],
    },
  },
  {
    name: ENVELOPE.follow,
    description: envelope(ENVELOPE.follow).description,
    inputSchema: withSession(envelope(ENVELOPE.follow).input_schema),
  },
  {
    name: ENVELOPE.searchCollection,
    description: envelope(ENVELOPE.searchCollection).description,
    inputSchema: withSession(envelope(ENVELOPE.searchCollection).input_schema),
  },
  {
    name: ENVELOPE.getResource,
    description: envelope(ENVELOPE.getResource).description,
    inputSchema: withSession(envelope(ENVELOPE.getResource).input_schema),
  },
  {
    name: ENVELOPE.invoke,
    description: envelope(ENVELOPE.invoke).description,
    inputSchema: withSession(envelope(ENVELOPE.invoke).input_schema),
  },
  {
    name: QUERY_TOOL_NAME,
    description: query.description,
    inputSchema: withSession(query.input_schema),
  },
]

/** The envelope tool names — the five that take a session and route to the executor. */
export const ENVELOPE_TOOL_NAMES: readonly string[] = [
  ENVELOPE.follow,
  ENVELOPE.searchCollection,
  ENVELOPE.getResource,
  ENVELOPE.invoke,
  QUERY_TOOL_NAME,
]

/**
 * `tools/list` cache metadata (design D2).
 *
 * The surface is constant for the life of the process, so a generous TTL is honest. `private` is the
 * conservative scope: the *list* is not auth-dependent, but the *results* of the tools are, and no
 * intermediary should cache anything keyed off it. Carried as passthrough fields on the list result
 * — the pinned SDK predates the formal `CacheableResult` type but preserves extra result keys.
 */
export const LIST_TTL_MS = 5 * 60 * 1000
export const LIST_CACHE_SCOPE = 'private'
