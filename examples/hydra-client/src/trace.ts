/**
 * The agent trace.
 *
 * Every layer logs into this; only `ui/` renders it. That split is what task 1.7 needs — the trace
 * can be collapsed without logging stopping, because collapsing is a property of the view and the
 * entries live here. It is also what keeps the runtime embeddable in something that is not this page.
 *
 * Design D4 requires that a store hit never silently substitutes for a fetch: every one emits a line
 * naming its source and age. That makes this a correctness surface, not decoration.
 */

export type TraceKind =
  | 'info'
  | 'step'
  | 'http'
  | 'sparql'
  | 'success'
  | 'error'
  | 'warn'
  | 'think'

export interface TraceEntry {
  /** Seconds since the current run started, or `null` if nothing has started yet. */
  readonly elapsed: number | null
  readonly kind: TraceKind
  readonly message: string
}

export interface Trace {
  /** Begin a run. Elapsed times on subsequent entries are relative to this moment. */
  start(): void
  log(message: string, kind?: TraceKind): void
  clear(): void
  readonly entries: readonly TraceEntry[]
  /**
   * Notified on any change to `entries`. Carries no payload: entries only ever append or reset, so a
   * view reconciles by comparing its rendered count against `entries.length` and rebuilds when that
   * count has gone backwards. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

export interface TraceOptions {
  /** Injectable so tests do not depend on wall-clock time. */
  now?: () => number
}

/** Formats an entry's elapsed time the way the proof of concept did: `1.4s`, or `--` before a run. */
export function formatElapsed(elapsed: number | null): string {
  return elapsed === null ? '--' : `${elapsed.toFixed(1)}s`
}

export function createTrace(options: TraceOptions = {}): Trace {
  const now = options.now ?? (() => Date.now())
  const entries: TraceEntry[] = []
  const listeners = new Set<() => void>()
  let startedAt: number | null = null

  const announce = () => {
    for (const listener of listeners) listener()
  }

  return {
    start() {
      startedAt = now()
    },

    log(message: string, kind: TraceKind = 'info') {
      entries.push({
        elapsed: startedAt === null ? null : (now() - startedAt) / 1000,
        kind,
        message,
      })
      announce()
    },

    clear() {
      entries.length = 0
      startedAt = null
      announce()
    },

    get entries() {
      return entries
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
