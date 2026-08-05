import type Anthropic from '@anthropic-ai/sdk'

/**
 * Model configuration (task 6.2).
 *
 * The client refuses to hardcode what an *API* can do; it should not hardcode what a *model* can do
 * either. Capabilities are read from the models endpoint at connect time and the request is shaped
 * from what comes back — so pointing the selector at a model this file has never heard of produces a
 * valid request rather than a 400.
 *
 * That is not decoration. Adaptive thinking and the effort parameter are not universal: a smaller
 * model may accept neither, and sending either one to a model that does not support it fails the
 * request outright. Since the point of the selector is to swap to a smaller model and watch the task
 * still complete, a hardcoded request shape would break the demonstration it exists to give.
 */

/** What the selector offers. Order is the order shown. */
export const MODEL_CHOICES = [
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    note: 'The default. Strong on agentic work at a moderate price.',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    note: 'The most capable tier — for the hardest multi-step work.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    note: 'The smallest and fastest. Watching a task still complete here is the demonstration.',
  },
] as const

export const DEFAULT_MODEL = 'claude-sonnet-5'

/**
 * Output cap for a non-streaming request.
 *
 * Sized to stay under the SDK's HTTP timeout rather than to bound the answer: a tool-use turn is a
 * few hundred tokens of tool input, and the data never comes back through the model at all. Clamped
 * against whatever the model actually accepts.
 */
export const MAX_TOKENS = 16_000

export interface ModelCapability {
  readonly id: string
  readonly displayName: string
  /** The largest `max_tokens` this model accepts. */
  readonly maxOutputTokens: number
  /** Whether `thinking: { type: 'adaptive' }` is accepted. Sending it otherwise fails the request. */
  readonly adaptiveThinking: boolean
  /** Whether `output_config.effort` is accepted. */
  readonly effort: boolean
}

/** Walk a nested capability object without asserting a shape the API may extend. */
function supported(capabilities: unknown, path: readonly string[]): boolean {
  let node: unknown = capabilities
  for (const key of path) {
    if (node === null || typeof node !== 'object') return false
    node = (node as Record<string, unknown>)[key]
  }
  if (node === null || typeof node !== 'object') return false
  return (node as Record<string, unknown>)['supported'] === true
}

/**
 * Read a model's capabilities from the API.
 *
 * Falls back to the most conservative request shape if the lookup fails — no thinking, no effort,
 * the configured token cap. A degraded read must not take the model down with it, and every model
 * accepts the conservative shape.
 */
export async function readModelCapability(
  anthropic: Anthropic,
  id: string,
): Promise<ModelCapability> {
  try {
    const model = await anthropic.models.retrieve(id)
    const capabilities = (model as unknown as { capabilities?: unknown }).capabilities

    return {
      id: model.id,
      displayName: model.display_name,
      maxOutputTokens: (model as unknown as { max_tokens?: number }).max_tokens ?? MAX_TOKENS,
      adaptiveThinking: supported(capabilities, ['thinking', 'types', 'adaptive']),
      effort: supported(capabilities, ['effort']),
    }
  } catch {
    return {
      id,
      displayName: id,
      maxOutputTokens: MAX_TOKENS,
      adaptiveThinking: false,
      effort: false,
    }
  }
}

/**
 * The reasoning-effort setting a turn asks for.
 *
 * Only the two the client actually chooses between: `low` for ordinary routing turns, `high` for the
 * one turn that reworks a query a gate refused. The API accepts more (`medium`, `xhigh`, `max`); the
 * client has no use for them, so the type says so rather than inviting a caller to reach for one.
 */
export type Effort = 'low' | 'high'

/**
 * The parts of the request that depend on the model rather than on the conversation.
 *
 * `effort` is emitted only where the model reports accepting the control, exactly like the thinking
 * config: sending either to a model that does not support it fails the request outright, and the
 * point of the selector is to swap to a smaller model and watch the task still complete. A model
 * without effort support runs at its default, unaffected.
 */
export function requestShapeFor(
  model: ModelCapability,
  effort?: Effort,
): {
  max_tokens: number
  thinking?: { type: 'adaptive'; display: 'summarized' }
  output_config?: { effort: Effort }
} {
  const max_tokens = Math.min(MAX_TOKENS, model.maxOutputTokens)

  const shape: {
    max_tokens: number
    thinking?: { type: 'adaptive'; display: 'summarized' }
    output_config?: { effort: Effort }
  } = { max_tokens }

  if (effort !== undefined && model.effort) shape.output_config = { effort }

  if (model.adaptiveThinking) {
    /*
     * `display` is opted into explicitly, and has to be.
     *
     * The default is `omitted`: thinking blocks still arrive, but their text is empty. A trace that
     * rendered the default would show the machinery pausing with nothing to say, which is the opposite
     * of what the trace is for.
     */
    shape.thinking = { type: 'adaptive', display: 'summarized' }
  }

  return shape
}
