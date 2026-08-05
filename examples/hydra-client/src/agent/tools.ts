import type Anthropic from '@anthropic-ai/sdk'

import { ENVELOPE_TOOLS } from '../project/tools'
import type { ToolSurface } from '../project/tools'

/**
 * The wire form of the tool surface (design D1).
 *
 * The envelope tools plus the client's query tool — constant for every Hydra API. The deferral
 * and BM25 search machinery that used to live here is deleted, not parameterised: the surface no
 * longer grows with the vocabulary, so there is nothing to defer. Capability arrives as content —
 * the affordance index in the prompt and the affordance block on every result — and the registry
 * of per-affordance records stays behind `invoke`, never on the wire.
 *
 * What this module still owns is the invariant the old machinery existed to satisfy: a request
 * carries at most 20 strict tools (measured; exceeding it is rejected, not degraded). The
 * envelope is designed to sit far under that permanently, so the check here is an assertion that
 * the design holds, not a branch that handles it failing.
 */

/** Tools marked `strict` in one request. Exceeding it is rejected, not degraded. */
export const STRICT_TOOL_LIMIT = 20

export interface RequestTools {
  readonly tools: Anthropic.ToolUnion[]
  /** How many tools went on the wire. */
  readonly count: number
}

/**
 * Shape the surface for a request.
 *
 * The registry (`surface`) contributes exactly one wire tool: the client's own query tool, under
 * whatever name it claimed. Everything the vocabulary declared is reachable through the envelope,
 * so nothing else is sent.
 */
export function toolsForRequest(surface: ToolSurface): RequestTools {
  const query = surface.tools.find((tool) => tool.dispatch.kind === 'query')

  const definitions = [
    ...ENVELOPE_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      ...(tool.strict ? { strict: true as const } : {}),
    })),
    ...(query
      ? [
          {
            name: query.name,
            description: query.description,
            input_schema: query.input_schema,
            strict: true as const,
          },
        ]
      : []),
  ]

  // The invariants the envelope exists to guarantee, asserted rather than handled: the surface
  // never exceeds the strict cap, and nothing on it defers.
  const strictCount = definitions.filter((tool) => 'strict' in tool && tool.strict).length
  if (definitions.length > STRICT_TOOL_LIMIT || strictCount > STRICT_TOOL_LIMIT) {
    throw new Error(
      `The envelope surface produced ${definitions.length} tools (${strictCount} strict), which ` +
        `exceeds the limit of ${STRICT_TOOL_LIMIT}. The envelope is designed to be constant; this ` +
        `is a defect, not a condition to degrade around.`,
    )
  }
  if (definitions.some((tool) => 'defer_loading' in tool)) {
    throw new Error('No tool on the envelope surface may defer; deferral was deleted, not disabled.')
  }

  return {
    tools: definitions as unknown as Anthropic.ToolUnion[],
    count: definitions.length,
  }
}
