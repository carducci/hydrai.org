/**
 * The chat input (task 1.6, and half of design D12).
 *
 * It is a `<textarea>` rather than an `<input>` for two reasons. Autogrow needs one; and a textarea
 * carries no implicit-submission semantics, which is what stops a password manager treating every
 * Enter keypress as a login attempt.
 */

export interface ChatInputElements {
  readonly textarea: HTMLTextAreaElement
  readonly send: HTMLButtonElement
}

export interface ChatInputOptions extends ChatInputElements {
  /** Rows to grow to before the field starts scrolling instead. */
  readonly maxRows?: number
  onSubmit(text: string): void
}

export interface ChatInput {
  value(): string
  clear(): void
  setEnabled(enabled: boolean): void
  focus(): void
  dispose(): void
}

export function mountChatInput(options: ChatInputOptions): ChatInput {
  const { textarea, send, onSubmit } = options
  const maxRows = options.maxRows ?? 4

  function autogrow(): void {
    const style = getComputedStyle(textarea)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    const ceiling = lineHeight * maxRows + padding + borders

    // Collapse first, or scrollHeight only ever reports the current height and the field never shrinks.
    textarea.style.height = 'auto'

    // `box-sizing: border-box` is set globally and scrollHeight excludes the border, so add it back.
    const wanted = textarea.scrollHeight + borders
    textarea.style.height = `${Math.min(wanted, ceiling)}px`
    textarea.style.overflowY = wanted > ceiling ? 'auto' : 'hidden'
  }

  function submit(): void {
    const text = textarea.value.trim()
    if (!text || textarea.disabled) return
    onSubmit(text)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    // Shift+Enter inserts a newline. An IME composing a character also owns Enter.
    if (event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit()
  }

  const onInput = () => autogrow()
  const onSendClick = () => submit()

  textarea.addEventListener('keydown', onKeyDown)
  textarea.addEventListener('input', onInput)
  send.addEventListener('click', onSendClick)

  autogrow()

  return {
    value: () => textarea.value,

    clear() {
      textarea.value = ''
      autogrow()
    },

    setEnabled(enabled: boolean) {
      textarea.disabled = !enabled
      send.disabled = !enabled
    },

    focus() {
      textarea.focus()
    },

    dispose() {
      textarea.removeEventListener('keydown', onKeyDown)
      textarea.removeEventListener('input', onInput)
      send.removeEventListener('click', onSendClick)
    },
  }
}
