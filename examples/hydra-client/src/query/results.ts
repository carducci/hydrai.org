/**
 * Query results, and how much of one reaches the model.
 *
 * The spec's rule is that retrieved data stays in the client and only answers derived from it reach
 * the model's context. An aggregate honours that by construction — one row. A `SELECT ?x WHERE { … }`
 * over a materialised collection does not, and would put the whole collection in the context by the
 * back door, undoing the reason it was held outside it.
 *
 * So rows are disclosed under a budget, the same shape as a collection listing: show some, and always
 * say how many were not shown. A budget that truncates silently would be the cap this client replaced.
 */

export interface QueryRows {
  readonly variables: readonly string[]
  readonly rows: readonly Record<string, string>[]
  /** Whether `rows` is all of them. Set by the renderer, never by an engine. */
  readonly truncated: boolean
}

/** Rows shown to the model before the rest are counted rather than listed. */
export const DEFAULT_ROW_DISCLOSURE = 50

/** One cell, short enough that a long literal cannot crowd out the answer. */
function cell(value: string | undefined, limit = 120): string {
  if (value === undefined) return ''
  const flattened = value.replace(/\s+/g, ' ')
  return flattened.length > limit ? `${flattened.slice(0, limit - 1)}…` : flattened
}

export function renderRows(result: QueryRows, disclose = DEFAULT_ROW_DISCLOSURE): string {
  if (result.rows.length === 0) {
    return (
      'The query ran and matched nothing. Every term in it is declared by this API, so this is an ' +
      'empty result rather than a mistyped one — the data held does not satisfy the pattern.'
    )
  }

  const shown = result.rows.slice(0, disclose)
  const header = result.variables.join(' | ')
  const lines = [
    `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}.`,
    '',
    header,
    result.variables.map((name) => '-'.repeat(Math.max(3, name.length))).join('-|-'),
  ]

  for (const row of shown) {
    lines.push(result.variables.map((name) => cell(row[name])).join(' | '))
  }

  if (result.rows.length > shown.length) {
    lines.push(
      '',
      `…and ${result.rows.length - shown.length} more rows, not listed. If you need a figure over ` +
        `all of them, ask for it as an aggregate — the data is held here, and an aggregate returns ` +
        `the answer rather than the records.`,
    )
  }

  return lines.join('\n')
}
