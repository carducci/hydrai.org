import type Anthropic from '@anthropic-ai/sdk'

import type { Executor } from '../execute/dispatch'
import type { ToolSurface } from '../project/tools'
import type { Trace } from '../trace'

import { requestShapeFor, type Effort, type ModelCapability } from './model'
import { markConversationCache, userTurn } from './prompt'
import { toolsForRequest } from './tools'

/**
 * The agent loop (tasks 6.1, 6.5, 6.6).
 *
 * Native tool use, driven by `stop_reason`. The proof of concept did not have one: it asked the model
 * to emit a JSON document describing steps it wanted taken, parsed that document, ran the steps, and
 * asked again — a protocol invented on top of a protocol that already existed. Everything that
 * protocol carried is carried here by the API's own mechanics, and the two consequences are worth
 * naming: a tool call is validated against a strict schema before the client ever sees it, and
 * parallel calls come back in one turn instead of being serialised through a hand-written format.
 */

type MessageParam = Anthropic.MessageParam
type ToolUseBlock = Anthropic.ToolUseBlock
type ToolResultBlockParam = Anthropic.ToolResultBlockParam

export interface TurnUsage {
  readonly input: number
  readonly output: number
  /** Tokens served from the cache. Zero across repeated turns means the prefix is being invalidated. */
  readonly cacheRead: number
  readonly cacheCreation: number
}

export interface TurnResult {
  readonly reply: string
  /** Model requests made for this turn — one, plus one per round of tool calls. */
  readonly iterations: number
  readonly toolCalls: number
  readonly usage: TurnUsage
  readonly stopReason: string | null
}

export interface AgentDeps {
  readonly anthropic: Anthropic
  readonly executor: Executor
  readonly surface: ToolSurface
  readonly trace: Trace
  readonly model: ModelCapability
  readonly system: readonly Anthropic.TextBlockParam[]
  /** Injectable so tests do not depend on wall-clock time. */
  readonly now?: () => Date
  /**
   * A backstop, not a budget.
   *
   * Retrieval is bounded by the execution layer's own budget (design D5); this only stops a model
   * that has stopped making progress, and hitting it is reported rather than passed off as an answer.
   */
  readonly maxIterations?: number
}

export interface Agent {
  send(text: string): Promise<TurnResult>
  /**
   * The conversation so far, including every raw content block the model produced.
   *
   * Kept across turns, which is half of what task 6.6 needs: the other half is that the session graph
   * outlives the turn too, so a later turn can refer to a resource an earlier one found without
   * re-fetching it.
   */
  readonly history: readonly MessageParam[]
}

/** Every text block of a response, joined. Thinking is reported separately and is never the reply. */
function replyText(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function createAgent(deps: AgentDeps): Agent {
  const now = deps.now ?? (() => new Date())
  const maxIterations = deps.maxIterations ?? 12
  let history: MessageParam[] = []

  /*
   * The wire form: the constant envelope plus the query tool, byte-identical across connects and
   * across APIs. Tools render ahead of everything else, so constancy here is what makes the cached
   * prefix worth having — and there is nothing to defer, because the surface no longer grows with
   * the vocabulary.
   */
  const { tools } = toolsForRequest(deps.surface)

  /*
   * Effort scales to the task (design D4).
   *
   * Every turn runs at low effort — routing which envelope tool to call, and reading a result's
   * affordances, do not need deep deliberation. Composing a correct query does, so a query the model
   * authored that a gate refuses or that fails to execute raises the *following* turn — the one that
   * reworks it — to high, then reverts. The flag is closure-scoped, not per-`send`, because a query
   * can fail as the last thing a turn does and be revised only after the user replies.
   */
  const queryToolName = deps.surface.tools.find((tool) => tool.dispatch.kind === 'query')?.name ?? null
  let escalateNextTurn = false

  /** Report what the model produced, before deciding what to do about it. */
  function narrate(content: readonly Anthropic.ContentBlock[]): void {
    for (const block of content) {
      if (block.type === 'thinking' && block.thinking.trim().length > 0) {
        deps.trace.log(block.thinking, 'think')
      } else if (block.type === 'text' && block.text.trim().length > 0) {
        deps.trace.log(block.text, 'step')
      }
    }
  }

  async function runTools(uses: readonly ToolUseBlock[]): Promise<ToolResultBlockParam[]> {
    const results: ToolResultBlockParam[] = []

    /*
     * Sequential, deliberately.
     *
     * The API supports running these concurrently and it would be faster. The trace is a correctness
     * surface here — design D4 requires every store hit to disclose its source and age — and four
     * interleaved traversals produce a log nobody can audit. What actually affects the model is the
     * shape of the reply, not the order of execution, and that is preserved below.
     */
    for (const use of uses) {
      /*
       * Every `tool_use` gets a `tool_result`, whatever happens executing it.
       *
       * The executor contracts never to throw, but this loop is the last line: an exception
       * escaping here leaves a `tool_use` in the history with no answer, and the API rejects that
       * request and every one after it — the conversation is poisoned, not just the turn. Caught
       * per use, so one failing call cannot orphan its siblings either.
       */
      let outcome: { content: string; ok: boolean }
      try {
        outcome = await deps.executor.execute(use.name, (use.input ?? {}) as Record<string, unknown>)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        deps.trace.log(`${use.name} threw past the executor: ${reason}`, 'error')
        outcome = {
          ok: false,
          content: `${use.name} failed inside the client (${reason}). Try a different route to the answer.`,
        }
      }
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.content,
        // A failure is a result, not an omission. Dropping it would leave a tool_use with no answer,
        // which the API rejects — and would hide the refusal the gate exists to deliver.
        is_error: !outcome.ok,
      })
    }

    return results
  }

  return {
    get history() {
      return history
    },

    async send(text: string): Promise<TurnResult> {
      // The breakpoint moves to the end of the settled history *before* the new turn is appended, so
      // it lands on content that will not change again.
      history = markConversationCache(history)
      history.push(userTurn(text, now()))

      let iterations = 0
      let toolCalls = 0
      let reply = ''
      let stopReason: string | null = null
      const usage: { input: number; output: number; cacheRead: number; cacheCreation: number } = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      }

      while (iterations < maxIterations) {
        iterations += 1

        // Low unless a query was just refused; consumed here so the escalation lasts exactly one turn.
        const effort: Effort = escalateNextTurn ? 'high' : 'low'
        escalateNextTurn = false

        const response = await deps.anthropic.messages.create({
          model: deps.model.id,
          system: deps.system as Anthropic.TextBlockParam[],
          messages: history,
          tools,
          ...requestShapeFor(deps.model, effort),
        })

        usage.input += response.usage.input_tokens
        usage.output += response.usage.output_tokens
        usage.cacheRead += response.usage.cache_read_input_tokens ?? 0
        usage.cacheCreation += response.usage.cache_creation_input_tokens ?? 0
        stopReason = response.stop_reason

        /*
         * Read the stop reason before trusting the content.
         *
         * A declined request answers 200 with no content at all, so anything that reaches for the
         * first block unconditionally breaks here rather than reporting what happened.
         */
        if (response.stop_reason === 'refusal') {
          const detail = (response as unknown as { stop_details?: { category?: string | null } })
            .stop_details
          reply =
            `The model declined this request${detail?.category ? ` (${detail.category})` : ''}. ` +
            `Nothing was sent to the API.`
          deps.trace.log(reply, 'error')
          break
        }

        narrate(response.content)

        /*
         * The assistant turn goes back verbatim — thinking blocks included, unedited.
         *
         * Reconstructing a thinking block from the summary that was displayed produces a block the
         * model did not write, and the API rejects modified thinking. Task 6.5's rule is not a
         * preference: the raw blocks are the ones that go back.
         */
        if (response.content.length > 0) {
          history.push({ role: 'assistant', content: response.content })
        }

        if (response.stop_reason === 'pause_turn') {
          // A server-side tool ran out of its own iterations mid-turn. Re-sending resumes it; the
          // assistant turn is already on the history, which is the whole signal the server needs.
          deps.trace.log('The turn paused server-side and is being resumed.', 'info')
          continue
        }

        if (response.stop_reason !== 'tool_use') {
          reply = replyText(response.content)
          if (response.stop_reason === 'max_tokens') {
            deps.trace.log(
              'The reply hit the output limit and is incomplete — reporting it as truncated ' +
                'rather than as an answer.',
              'warn',
            )
            reply = `${reply}\n\n(This reply was cut off at the output limit.)`.trim()
          }
          break
        }

        /*
         * Client tools only.
         *
         * A turn that discovered tools also carries `server_tool_use` and its result. Those ran on
         * the server and are already answered — returning a `tool_result` for one is rejected — so
         * they stay in the history untouched and are filtered out here.
         */
        const uses = response.content.filter(
          (block): block is ToolUseBlock => block.type === 'tool_use',
        )
        toolCalls += uses.length

        if (uses.length === 0) {
          // Nothing of ours to answer. Re-send so the turn continues; pushing an empty user message
          // would be rejected, and inventing text would put words in the user's mouth.
          continue
        }

        const results = await runTools(uses)

        /*
         * A query the model authored that a gate refused or that failed to execute makes the next
         * turn — the one that reworks it — worth more reasoning (design D4). Only where the model
         * accepts the effort control, so the trace never claims an escalation that had no effect.
         */
        if (deps.model.effort && queryToolName !== null) {
          const queryFailed = uses.some(
            (use) =>
              use.name === queryToolName &&
              results.find((result) => result.tool_use_id === use.id)?.is_error === true,
          )
          if (queryFailed) {
            escalateNextTurn = true
            deps.trace.log(
              'A query was refused; raising the next turn to high effort to revise it.',
              'info',
            )
          }
        }

        /*
         * Every result from one assistant turn goes back in a **single** user message.
         *
         * Splitting them across messages reads, to the model, as a turn in which it made one call —
         * so it stops making several. The cost of getting this wrong is not an error; it is a model
         * that quietly becomes serial.
         */
        history.push({ role: 'user', content: results })
      }

      if (iterations >= maxIterations && stopReason === 'tool_use') {
        reply =
          `Stopped after ${maxIterations} rounds of tool calls without reaching an answer. ` +
          `What is above is progress, not a result.`
        deps.trace.log(reply, 'warn')
      }

      return { reply, iterations, toolCalls, usage, stopReason }
    },
  }
}
