/**
 * The chat transcript (task 7.7).
 *
 * Deliberately thin. What the agent produced is already in the trace, with its sources and its ages;
 * this is the conversation, and it holds the question and the answer and nothing else.
 *
 * Both sides of this transcript are untrusted: a reply is model output, and a model that has just
 * read a resource is repeating server data back. So the ONLY value ever assigned to a bubble's
 * `innerHTML` is the return of `renderMarkdown` — Markdown parsed and sanitised against a strict
 * allowlist (see render-markdown.ts) — and only for an agent's reply. User text and our own failure
 * notices are set through `textContent`, never rendered.
 */

import { renderMarkdown } from './render-markdown'

export type Speaker = 'user' | 'agent'

export interface MessagesElements {
  readonly list: HTMLElement
  /** The "connect to start" placeholder, hidden once there is anything to show. */
  readonly empty: HTMLElement
}

export interface Messages {
  add(speaker: Speaker, text: string): void
  /** A placeholder that can be replaced in place, for a turn that is still running. */
  pending(text: string): { settle(text: string): void; fail(text: string): void }
  clear(): void
}

const AVATAR: Record<Speaker, string> = { user: 'YOU', agent: 'AI' }

export function mountMessages(els: MessagesElements): Messages {
  /**
   * Fills a bubble. An agent's reply is rendered from Markdown (`rendered: true`); everything else —
   * user text, the "thinking…" placeholder, a failure notice — is set as plain text.
   */
  function setBubble(bubble: HTMLElement, text: string, rendered: boolean): void {
    if (rendered) bubble.innerHTML = renderMarkdown(text)
    else bubble.textContent = text
  }

  function row(speaker: Speaker, text: string, extra = '', rendered = false): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = `msg-row ${speaker}`

    const avatar = document.createElement('div')
    avatar.className = `avatar ${speaker}`
    avatar.textContent = AVATAR[speaker]

    const bubble = document.createElement('div')
    bubble.className = extra ? `bubble ${speaker} ${extra}` : `bubble ${speaker}`
    setBubble(bubble, text, rendered)

    wrapper.appendChild(avatar)
    wrapper.appendChild(bubble)
    return wrapper
  }

  function append(node: HTMLElement): HTMLElement {
    els.empty.hidden = true
    els.list.appendChild(node)
    // The newest turn is the one being read; scrolling is what makes a long trace usable.
    els.list.scrollTop = els.list.scrollHeight
    return node
  }

  return {
    add(speaker, text) {
      // An agent's reply is Markdown; a user's message is their own literal text.
      append(row(speaker, text, '', speaker === 'agent'))
    },

    pending(text) {
      // The placeholder ("thinking…") is our own plain text, not yet a reply.
      const node = append(row('agent', text, 'thinking'))
      const bubble = node.querySelector('.bubble')

      const replace = (next: string, className: string, rendered: boolean) => {
        if (!(bubble instanceof HTMLElement)) return
        setBubble(bubble, next, rendered)
        bubble.className = className
        els.list.scrollTop = els.list.scrollHeight
      }

      return {
        // The settled reply is the agent's answer — the one place Markdown is rendered.
        settle: (next) => replace(next, 'bubble agent', true),
        // A failure is a turn that happened, so it stays in the transcript rather than vanishing.
        // It is our own message, set as plain text.
        fail: (next) => replace(next, 'bubble agent thinking', false),
      }
    },

    clear() {
      while (els.list.firstChild) els.list.removeChild(els.list.firstChild)
      els.list.appendChild(els.empty)
      els.empty.hidden = false
    },
  }
}
