import { formatElapsed, type Trace } from '../trace'

/**
 * Renders the trace, and lets it be collapsed (task 1.7).
 *
 * Collapsing is a property of this view, not of the trace: entries keep arriving into the model while
 * the body is hidden, and expanding shows everything recorded in the meantime. Default is expanded —
 * the trace is what makes the machinery visible, which is the whole point of the page.
 */

const COLLAPSED_KEY = 'hydraclient.trace.collapsed'

export interface TraceViewElements {
  readonly main: HTMLElement
  readonly toggle: HTMLElement
  readonly body: HTMLElement
  readonly dot: HTMLElement
  readonly count: HTMLElement
}

export interface TraceView {
  /** Drives the pulsing dot in the trace header. */
  setActive(active: boolean): void
  collapsed(): boolean
  setCollapsed(collapsed: boolean): void
  dispose(): void
}

/** sessionStorage throws in sandboxed and private contexts; the preference is not worth failing over. */
function readPreference(storage: Storage | null): boolean {
  try {
    return storage?.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function writePreference(storage: Storage | null, collapsed: boolean): void {
  try {
    storage?.setItem(COLLAPSED_KEY, String(collapsed))
  } catch {
    /* preference is best-effort */
  }
}

export function mountTraceView(
  trace: Trace,
  els: TraceViewElements,
  storage: Storage | null = typeof sessionStorage === 'undefined' ? null : sessionStorage,
): TraceView {
  let rendered = 0
  let isCollapsed = readPreference(storage)

  function lineFor(elapsed: number | null, kind: string, message: string): HTMLElement {
    const line = document.createElement('div')
    line.className = `trace-line ${kind}`

    const ts = document.createElement('span')
    ts.className = 'trace-ts'
    ts.textContent = formatElapsed(elapsed)

    const msg = document.createElement('span')
    msg.className = 'trace-msg'
    msg.textContent = message

    line.append(ts, msg)
    return line
  }

  function reconcile(): void {
    const entries = trace.entries

    // Entries only append or reset. A count that went backwards means a reset.
    if (entries.length < rendered) {
      els.body.replaceChildren()
      rendered = 0
    }

    if (entries.length > rendered) {
      const batch = document.createDocumentFragment()
      for (let i = rendered; i < entries.length; i++) {
        const entry = entries[i]
        if (entry) batch.append(lineFor(entry.elapsed, entry.kind, entry.message))
      }
      els.body.append(batch)
      rendered = entries.length
      // Only chase the tail when it is on screen; scrollHeight is meaningless on a hidden element.
      if (!isCollapsed) els.body.scrollTop = els.body.scrollHeight
    }

    updateCount()
  }

  function updateCount(): void {
    // The count is orientation for a collapsed trace — how much happened while it was hidden.
    const total = trace.entries.length
    const show = isCollapsed && total > 0
    els.count.hidden = !show
    els.count.textContent = show ? `${total} ${total === 1 ? 'line' : 'lines'}` : ''
  }

  function applyCollapsed(): void {
    els.main.classList.toggle('trace-collapsed', isCollapsed)
    els.toggle.setAttribute('aria-expanded', String(!isCollapsed))
    updateCount()
    if (!isCollapsed) els.body.scrollTop = els.body.scrollHeight
  }

  function setCollapsed(next: boolean): void {
    isCollapsed = next
    writePreference(storage, next)
    applyCollapsed()
  }

  const onToggle = () => setCollapsed(!isCollapsed)
  els.toggle.addEventListener('click', onToggle)

  const unsubscribe = trace.subscribe(reconcile)

  applyCollapsed()
  reconcile()

  return {
    setActive(active: boolean) {
      els.dot.className = active ? 'trace-dot active' : 'trace-dot'
    },
    collapsed: () => isCollapsed,
    setCollapsed,
    dispose() {
      unsubscribe()
      els.toggle.removeEventListener('click', onToggle)
    },
  }
}
