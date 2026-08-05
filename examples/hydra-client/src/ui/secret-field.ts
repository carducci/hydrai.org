/**
 * Credential fields (design D12).
 *
 * Reported symptom: 1Password offers to save credentials on every message send. The page held two
 * `<input type="password">` fields and sent chat with Enter in a text field; no `<form>` is involved,
 * but managers do not need one — the heuristic is *user pressed Enter while credential fields exist in
 * the DOM*, which fires on every message.
 *
 * `autocomplete="off"` is unreliable by design, so the fix removes the signal rather than requesting
 * an exemption: the fields are plain text inputs masked with CSS, and this module provides the reveal
 * toggle that makes that usable. The vendor opt-out attributes in the markup are cheap insurance on
 * top, not the load-bearing part.
 */

export interface SecretFields {
  /** Re-masks every field. Call when credentials are cleared. */
  maskAll(): void
  dispose(): void
}

const MASKED = 'masked'

export function mountSecretFields(root: ParentNode = document): SecretFields {
  const toggles = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-reveal]'))
  const wired: Array<{ button: HTMLButtonElement; handler: () => void }> = []

  function apply(button: HTMLButtonElement, input: HTMLInputElement, masked: boolean): void {
    input.classList.toggle(MASKED, masked)
    button.setAttribute('aria-pressed', String(!masked))
    button.textContent = masked ? 'show' : 'hide'

    const label = button.getAttribute('aria-label')
    if (label) {
      button.setAttribute('aria-label', label.replace(/^(Show|Hide)\b/, masked ? 'Show' : 'Hide'))
    }
  }

  for (const button of toggles) {
    const id = button.dataset.reveal
    const input = id ? root.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`) : null
    if (!input) continue

    const handler = () => apply(button, input, !input.classList.contains(MASKED))
    button.addEventListener('click', handler)
    wired.push({ button, handler })

    apply(button, input, input.classList.contains(MASKED))
  }

  return {
    maskAll() {
      for (const { button } of wired) {
        const id = button.dataset.reveal
        const input = id ? root.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`) : null
        if (input) apply(button, input, true)
      }
    },

    dispose() {
      for (const { button, handler } of wired) button.removeEventListener('click', handler)
    },
  }
}
