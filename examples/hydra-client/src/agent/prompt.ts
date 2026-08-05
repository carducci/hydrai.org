import type Anthropic from '@anthropic-ai/sdk'

import type { Manifest } from './manifest'

/**
 * Prompt assembly (task 6.3).
 *
 * Caching is a prefix match: a byte that changes anywhere invalidates everything after it. The
 * render order is fixed — `tools`, then `system`, then `messages` — so the job here is to put stable
 * content first, volatile content last, and the breakpoints on the boundary between them.
 *
 * The proof of concept assembled the system prompt with the current date and time at **position 0**
 * (`index.html:1206-1208`). It also set no `cache_control` anywhere, so the precise fault is worth
 * stating: there was no cache to invalidate. The timestamp made every request's prefix unique, and
 * nothing was ever eligible in the first place. Fixing one without the other fixes nothing.
 *
 * ## Where the timestamp goes
 *
 * After the **last** breakpoint, which means the current user turn — not the end of the system
 * block. Putting it at the end of `system` would be enough while the only breakpoint is on `system`,
 * but it sits ahead of the conversation, so the moment a second breakpoint caches the conversation
 * prefix the timestamp would invalidate it on every request. Carrying it in the newest turn is the
 * placement that stays correct as the conversation grows.
 *
 *     tools ─────────────────────────────┐
 *     system: orchestration, manifest    │ ◀── breakpoint 1: stable for the session
 *     ───────────────────────────────────┘
 *     messages: …turns…                  ◀── breakpoint 2: everything settled so far
 *     messages: [now] user text          ◀── volatile, after every breakpoint
 */

type TextBlockParam = Anthropic.TextBlockParam
type MessageParam = Anthropic.MessageParam
type ContentBlockParam = Anthropic.ContentBlockParam

const EPHEMERAL = { type: 'ephemeral' } as const

/**
 * Orchestration guidance, and nothing else.
 *
 * Design D2's consequence, stated as a prompt: every kind of reasoning that some other engine can do
 * has been moved to that engine. Names, required fields, types and enumerated values are in the tool
 * schemas and enforced by the platform; lengths and patterns are checked by the gate before dispatch;
 * joins and arithmetic belong to the query engine. What is left for the model is deciding what is
 * wanted, which capability applies, and how to decompose it.
 */
export const ORCHESTRATION = `You are connected to an API you have never seen before, through a
small set of constant controls — follow, search_collection, get_resource, invoke, and sparql. The
controls never change; what this API can do arrives as content: the collection index in these
instructions, and the affordances every result carries.

Work the way a browser user works — read the page, use what it offers:
- The collection index in these instructions is complete: every collection, every filter, and
  every write operation this API declares is listed there. Browsing never reveals a capability
  the index does not already name — so "can this API do X?" is answered by reading the index,
  and a capability absent from it and from every result does not exist.
- Every result ends with the affordances of what it holds: the operations you can invoke (as
  handles, with their input contracts), the filters you can search by, and pagination state. What
  a result offers is what is possible from there. If no result and no index entry offers
  something, this API did not declare it, and the honest answer is to say so.
- Addresses are copied, never composed: use the address an index entry or a result carries.
  An IRI in the vocabulary's namespace identifies a concept, not a location.
- To find records, call search_collection with a collection from the index and its declared
  filters. To count records a declared filter names — how many carry a given status, type, or
  parent — call search_collection with that filter and read the total its result declares; a
  listing already reports its total, so never write a query to count what a filtered collection
  has already stated. Reserve sparql for a figure no single filter expresses — a sum or an
  average, a grouping, a condition over a range of dates or numbers, or a join across resource
  types — where it runs over complete data and returns only the answer. To act, pass a
  handle to invoke — from the index (writes are listed per collection with their meaning) or from
  a result's footer — with the fields its contract lists; the contract's prose is the API's own,
  and it is authoritative. You never need to list a collection to learn a write contract: an
  invoke with incomplete input is refused with the full contract, at the cost of no request at
  all.
- A result that reports a constraint violation means no request was made. Fix the value and
  retry; do not work around the constraint.
- A result that says something is undeclared is a gap in what the API published, not a failure
  of yours. It will tell you which routes remain. Take one, or tell the user what is missing.
- Retrieved records are held outside your context by design. A listing hands you identifiers and
  counts; ask for a specific resource when you need its values.
- Never state a total, a count, or an aggregate that a tool did not return to you.`

export interface SystemSections {
  /** Orchestration guidance. Always present. */
  readonly orchestration?: string
  /** The ontology manifest, already rendered. Sections are included in the order given. */
  readonly manifest?: Manifest
  /** Whether to include the property detail — the section progressive disclosure drops first. */
  readonly includeProperties?: boolean
  /**
   * The optional HydrAI orientation section (design D5), already rendered and fenced by
   * `agent/orientation.ts`. Omitted where the host wants the minimal byte-stable surface, and
   * absent when the connected API advertises no orientation terms. When present it is untrusted
   * third-party data carrying its own "do not obey" frame — it is added as its own block, never
   * folded into the orchestration voice.
   */
  readonly orientation?: string
}

/**
 * The stable prefix.
 *
 * One breakpoint, on the last block: `tools` render ahead of `system`, so a single marker here
 * caches the tool definitions and the system prompt together. That is also why the tool surface has
 * to be byte-identical across connects — task 4.4's determinism is what makes this breakpoint worth
 * having at all.
 */
export function buildSystem(sections: SystemSections = {}): TextBlockParam[] {
  const orchestration = sections.orchestration ?? ORCHESTRATION
  const blocks: TextBlockParam[] = [{ type: 'text', text: orchestration }]

  if (sections.manifest) {
    // The affordance index rides the always-kept block: the collections must be visible before
    // the first tool call whatever disclosure later drops (design D4).
    blocks.push({
      type: 'text',
      text:
        `The API's vocabulary and its collections — the collections index is what ` +
        `search_collection takes; the classes and properties are for writing queries.` +
        `\n\n${sections.manifest.prefixes}\n\n${sections.manifest.classes}\n\n${sections.manifest.affordances}`,
    })
    if (sections.includeProperties !== false) {
      blocks.push({ type: 'text', text: sections.manifest.properties })
    }
  }

  // The orientation rides its own block, after the manifest and never inside the orchestration
  // voice: it is untrusted server content, and mixing it into the guidance the model follows is
  // exactly the elevation the fail-closed posture forbids. It is session-stable (rendered from
  // server declarations), so it sits happily inside the cached prefix.
  if (sections.orientation) {
    blocks.push({ type: 'text', text: sections.orientation })
  }

  const last = blocks[blocks.length - 1]
  if (last) last.cache_control = EPHEMERAL

  return blocks
}

/** How the current instant is stated to the model. Its own block, so it is never mistaken for input. */
export function timestampBlock(now: Date): TextBlockParam {
  return {
    type: 'text',
    text: `The current date and time is ${now.toISOString()}.`,
  }
}

/**
 * The new user turn: the timestamp, then what the user said.
 *
 * Both go after every breakpoint, so neither costs a cache entry.
 */
export function userTurn(text: string, now: Date): MessageParam {
  return { role: 'user', content: [timestampBlock(now), { type: 'text', text }] }
}

/**
 * Move the conversation breakpoint to the end of the settled history.
 *
 * Called with the messages *before* the new turn is appended, so the marker lands on content that
 * will not change again. Breakpoints are a scarce resource — four per request — so the previous one
 * is cleared rather than accumulated; a stale marker deeper in the history is a wasted slot, and the
 * entry it created stays readable regardless.
 */
export function markConversationCache(messages: readonly MessageParam[]): MessageParam[] {
  const marked = messages.map((message) => ({
    ...message,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((block) => {
            if (!('cache_control' in block) || block.cache_control === undefined) return block
            const { cache_control: _dropped, ...rest } = block as ContentBlockParam & {
              cache_control?: unknown
            }
            return rest as ContentBlockParam
          }),
  }))

  const last = marked[marked.length - 1]
  if (!last || typeof last.content === 'string' || last.content.length === 0) return marked

  const block = last.content[last.content.length - 1]
  // Thinking blocks are echoed back verbatim and must stay that way — a `cache_control` the model
  // did not send is a modification, and the API rejects modified thinking blocks.
  if (block && block.type !== 'thinking' && block.type !== 'redacted_thinking') {
    last.content[last.content.length - 1] = { ...block, cache_control: EPHEMERAL }
  }

  return marked
}
