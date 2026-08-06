/**
 * The connection form: entrypoint, API bearer token, model API key.
 *
 * Persistence is `sessionStorage`, ported from the proof of concept — credentials do not outlive the
 * browser session. The key names are kept as they were so an open session survives the cutover.
 */

export interface ConnectionFormElements {
  readonly entrypoint: HTMLInputElement
  readonly apiToken: HTMLInputElement
  readonly modelKey: HTMLInputElement
  readonly status: HTMLElement
}

export interface Connection {
  readonly entrypoint: string
  readonly apiToken: string
  readonly modelKey: string
}

export type ConnectionStatus = 'idle' | 'connected' | 'error'

export interface ConnectionForm {
  read(): Connection
  save(): void
  clear(): void
  setStatus(text: string, status?: ConnectionStatus): void
}

const KEYS = {
  entrypoint: 'hd_entrypoint',
  apiToken: 'hd_crm_token',
  modelKey: 'hd_ai_key',
} as const

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function mountConnectionForm(els: ConnectionFormElements): ConnectionForm {
  /**
   * The entrypoint is the one address a generic client has to be told; everything past it is
   * discovered. On the standalone hydrai.org demo there is no same-origin API to assume, so the field
   * starts empty and the placeholder guides the operator to paste their own — this is a "bring your
   * own API" demo. (An embed served from an API's own origin can restore a `window.location.origin`
   * default; see UPSTREAM.md.)
   */
  const defaultEntrypoint = () => ''

  const store = storage()

  const restore = () => {
    try {
      els.entrypoint.value = store?.getItem(KEYS.entrypoint) || defaultEntrypoint()
      els.apiToken.value = store?.getItem(KEYS.apiToken) ?? ''
      els.modelKey.value = store?.getItem(KEYS.modelKey) ?? ''
    } catch {
      els.entrypoint.value = defaultEntrypoint()
    }
  }

  restore()

  return {
    read: () => ({
      entrypoint: els.entrypoint.value.trim(),
      apiToken: els.apiToken.value.trim(),
      modelKey: els.modelKey.value.trim(),
    }),

    save() {
      try {
        store?.setItem(KEYS.entrypoint, els.entrypoint.value)
        store?.setItem(KEYS.apiToken, els.apiToken.value)
        store?.setItem(KEYS.modelKey, els.modelKey.value)
      } catch {
        /* persistence is best-effort; a session that cannot store still connects */
      }
    },

    clear() {
      try {
        for (const key of Object.values(KEYS)) store?.removeItem(key)
      } catch {
        /* nothing to do */
      }
      els.entrypoint.value = defaultEntrypoint()
      els.apiToken.value = ''
      els.modelKey.value = ''
    },

    setStatus(text: string, status: ConnectionStatus = 'idle') {
      els.status.textContent = text
      els.status.className = status === 'idle' ? 'status' : `status ${status}`
    },
  }
}
