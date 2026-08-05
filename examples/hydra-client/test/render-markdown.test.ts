// @vitest-environment jsdom
//
// DOMPurify needs a DOM. The suite's default environment is `node` (vite.config.ts); this one file
// overrides to jsdom rather than changing the global environment, since only this test renders.

import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../src/ui/render-markdown'

/** Parse rendered HTML into a detached element so we can query it as DOM. */
function render(md: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(md)
  return host
}

describe('renderMarkdown — the safe subset renders', () => {
  it('renders bold, lists, and fenced code', () => {
    const bold = render('This is **bold**.')
    expect(bold.querySelector('strong')?.textContent).toBe('bold')

    const list = render('- one\n- two')
    expect(list.querySelectorAll('ul > li')).toHaveLength(2)

    const fence = render('```\nx = 1\n```')
    expect(fence.querySelector('pre > code')?.textContent).toContain('x = 1')
  })

  it('renders a GFM table and honours column alignment', () => {
    const el = render('| Name | Email |\n|:-----|------:|\n| Jane | jane@acme.co |')
    const table = el.querySelector('table')
    expect(table).not.toBeNull()
    const headers = table!.querySelectorAll('th')
    expect(headers).toHaveLength(2)
    expect(headers[0]?.getAttribute('align')).toBe('left')
    expect(headers[1]?.getAttribute('align')).toBe('right')
  })
})

describe('renderMarkdown — the rendering admits no injection', () => {
  it('drops a <script> element', () => {
    const el = render('before <script>window.__pwned = 1</script> after')
    expect(el.querySelector('script')).toBeNull()
    expect(el.innerHTML).not.toContain('__pwned')
  })

  it('drops a tag carrying an event handler', () => {
    const el = render('hi <img src=x onerror="window.__pwned = 1">')
    expect(el.querySelector('img')).toBeNull()
    expect(el.innerHTML.toLowerCase()).not.toContain('onerror')
  })

  it('strips an onclick attribute from an otherwise-allowed element', () => {
    const el = render('<a href="https://a.co" onclick="window.__pwned = 1">x</a>')
    const a = el.querySelector('a')
    expect(a?.hasAttribute('onclick')).toBe(false)
  })

  it('refuses a javascript: link scheme', () => {
    const el = render('[click](javascript:window.__pwned=1)')
    const a = el.querySelector('a')
    // the link text stays, but it carries no dangerous href
    expect(a?.textContent).toBe('click')
    expect(a?.hasAttribute('href')).toBe(false)
  })

  it('refuses a data: link scheme', () => {
    const el = render('[click](data:text/html,<script>alert(1)</script>)')
    expect(el.querySelector('a')?.hasAttribute('href')).toBe(false)
  })

  it('does not honour raw inline HTML as live DOM', () => {
    const el = render('a paragraph with <b>raw</b> and <div>block</div> markup')
    // disallowed tags are removed; their text content survives
    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('div')).toBeNull()
    expect(el.textContent).toContain('raw')
  })
})

describe('renderMarkdown — safe links are preserved and hardened', () => {
  it('keeps http/https/mailto links and stamps rel', () => {
    const https = render('[site](https://example.com)')
    const a = https.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')

    const mail = render('[mail](mailto:jane@acme.co)')
    expect(mail.querySelector('a')?.getAttribute('href')).toBe('mailto:jane@acme.co')
  })
})
