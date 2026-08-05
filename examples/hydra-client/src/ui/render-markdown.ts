/**
 * Renders an agent reply's Markdown to sanitised HTML (change render-agent-reply-markdown).
 *
 * This is the security-load-bearing surface of the transcript. The input is untrusted on two
 * counts: it is model output, and a model that has just read a resource is repeating server data —
 * attacker-influenceable CRM field values — back. The client talks to a live CRM, so a script that
 * runs in the transcript runs in the customer's console.
 *
 * The whole defence lives here: `marked` turns Markdown into HTML (and passes any raw HTML in the
 * reply straight through, unexamined), then DOMPurify strips everything outside the allowlist below.
 * The invariant the transcript relies on — see ui/messages.ts — is that the ONLY value ever assigned
 * to a bubble's innerHTML is this function's return.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** The rendered subset. A tag absent here is dropped by DOMPurify (its text content is kept). */
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

/** `href` for links; `align` for GFM column alignment; `rel` so the rel we stamp below survives. */
const ALLOWED_ATTR = ['href', 'align', 'rel']

/** The only link schemes a reply may produce. Anything else has its href dropped, link text kept. */
const SAFE_LINK_SCHEME = /^(?:https?|mailto):/i

let hooksRegistered = false

/**
 * Registered once, on the shared DOMPurify singleton. Two hooks, both narrow:
 *  - the scheme policy is enforced here, in code, rather than through a custom ALLOWED_URI_REGEXP —
 *    that regexp is also applied to non-URI attributes like `align` and would silently strip a
 *    table's alignment. DOMPurify's own default URI filtering (which blocks javascript:/data:) still
 *    runs underneath this as a second line.
 *  - every surviving link is made target-safe.
 */
function registerHooks(): void {
  if (hooksRegistered) return
  hooksRegistered = true

  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'href' && !SAFE_LINK_SCHEME.test(data.attrValue.trim())) {
      data.keepAttr = false
    }
  })

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

/**
 * Markdown → sanitised HTML. `marked`'s GFM defaults (tables, autolinks) are used as-is; the
 * allowlist is the gate, so nothing the parser emits outside it can survive regardless of parser
 * settings. `async: false` keeps `parse` returning a string rather than a promise.
 */
export function renderMarkdown(markdown: string): string {
  registerHooks()
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })
}
