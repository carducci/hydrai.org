/**
 * RFC 6570 URI Template expansion (task 5.1).
 *
 * The proof of concept implemented one operator — form-style query, `{?a,b}` — and worked around
 * everything else by deleting unbound path segments with a regex (`index.html:484`, `:572`). That is
 * not expansion; it is a repair for expansion that did not happen, and it produces a different URL
 * than the specification defines. A generic client consumes whatever template a server publishes, so
 * the operators are implemented rather than the ones this API happens to use.
 *
 * Two properties matter more than completeness:
 *
 * - **A supplied value the template cannot carry is reported, never dropped.** Silently discarding it
 *   is design D8's failure: the caller asked for something and it did not happen.
 * - **Nothing here invents a URL.** Expansion is a function of the published template and the bound
 *   values. Where a variable is unbound the specification says what the result is, and that is what
 *   comes back.
 */

export type TemplateValue = string | number | boolean | readonly (string | number)[] | null | undefined

interface Variable {
  readonly name: string
  readonly explode: boolean
  /** `:n` — take the first n characters of the value. */
  readonly prefix: number | null
}

interface Expression {
  readonly operator: string
  readonly variables: readonly Variable[]
}

interface OperatorRules {
  readonly first: string
  readonly separator: string
  /** Emit `name=value` rather than the bare value. */
  readonly named: boolean
  /** What follows a name whose value is empty. */
  readonly ifEmpty: string
  /** Reserved characters pass through unencoded. */
  readonly allowReserved: boolean
}

const OPERATORS: Readonly<Record<string, OperatorRules>> = {
  '': { first: '', separator: ',', named: false, ifEmpty: '', allowReserved: false },
  '+': { first: '', separator: ',', named: false, ifEmpty: '', allowReserved: true },
  '#': { first: '#', separator: ',', named: false, ifEmpty: '', allowReserved: true },
  '.': { first: '.', separator: '.', named: false, ifEmpty: '', allowReserved: false },
  '/': { first: '/', separator: '/', named: false, ifEmpty: '', allowReserved: false },
  ';': { first: ';', separator: ';', named: true, ifEmpty: '', allowReserved: false },
  '?': { first: '?', separator: '&', named: true, ifEmpty: '=', allowReserved: false },
  '&': { first: '&', separator: '&', named: true, ifEmpty: '=', allowReserved: false },
}

const UNRESERVED = /[A-Za-z0-9\-._~]/
const RESERVED = /[:/?#[\]@!$&'()*+,;=]/

function percentEncode(character: string): string {
  return [...new TextEncoder().encode(character)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('')
}

/**
 * Encode a value for substitution.
 *
 * `encodeURIComponent` is close but not correct: it leaves `!'()*` unescaped, and those are reserved
 * rather than unreserved. Getting that wrong produces URLs that differ from what the template means.
 */
function encode(value: string, allowReserved: boolean): string {
  let out = ''
  // Iterating code points rather than code units keeps astral characters intact through the encoder.
  const characters = [...value]

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!

    if (UNRESERVED.test(character)) {
      out += character
      continue
    }

    if (allowReserved) {
      // An already-percent-encoded triple is passed through as-is, per the specification: it is a
      // pct-encoded sequence, not three characters needing encoding.
      if (character === '%' && /^[0-9A-Fa-f]{2}$/.test(characters.slice(index + 1, index + 3).join(''))) {
        out += characters.slice(index, index + 3).join('')
        index += 2
        continue
      }
      if (RESERVED.test(character)) {
        out += character
        continue
      }
    }

    out += percentEncode(character)
  }

  return out
}

/**
 * The operator characters.
 *
 * Unambiguous rather than inferred: a variable name may contain a dot but may not begin with one, so
 * a leading operator character is always an operator.
 */
const OPERATOR_CHARS = '+#./;?&'

/** Parse `name`, `name*` or `name:3`. */
function parseVariable(spec: string): Variable | null {
  const match = /^([A-Za-z0-9_%]+(?:\.[A-Za-z0-9_%]+)*)(?:(\*)|:(\d{1,4}))?$/.exec(spec.trim())
  if (!match) return null
  return {
    name: match[1]!,
    explode: match[2] === '*',
    prefix: match[3] === undefined ? null : Number(match[3]),
  }
}

/** Split a template into its expressions. Literal text between them is untouched. */
function expressionsOf(template: string): Map<string, Expression> {
  const found = new Map<string, Expression>()

  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    const body = match[1] ?? ''
    const operator = body.length > 0 && OPERATOR_CHARS.includes(body[0]!) ? body[0]! : ''
    const list = operator === '' ? body : body.slice(1)

    const variables = list
      .split(',')
      .map(parseVariable)
      .filter((variable): variable is Variable => variable !== null)

    found.set(match[0], { operator, variables })
  }

  return found
}

export interface Expansion {
  readonly url: string
  /** Every variable the template declares, in declaration order. */
  readonly variables: readonly string[]
  /** Declared variables that had no value, so the specification expanded them to nothing. */
  readonly unbound: readonly string[]
  /**
   * Supplied names the template declares no variable for.
   *
   * Never silently dropped: a value the caller asked to be carried and that the template cannot carry
   * is a gap to report, not an inconvenience to swallow.
   */
  readonly unused: readonly string[]
}

function isEmpty(value: TemplateValue): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return value === ''
}

function asList(value: TemplateValue): string[] {
  if (Array.isArray(value)) return value.map(String)
  return [String(value)]
}

/** Expand one expression against the bound values. */
function expandExpression(expression: Expression, values: Readonly<Record<string, TemplateValue>>): string {
  const rules = OPERATORS[expression.operator] ?? OPERATORS['']!
  const parts: string[] = []

  for (const variable of expression.variables) {
    const value = values[variable.name]
    if (value === undefined || value === null) continue

    const items = asList(value)
    if (items.length === 0) continue

    if (!Array.isArray(value)) {
      const single = variable.prefix === null ? items[0]! : items[0]!.slice(0, variable.prefix)
      const encoded = encode(single, rules.allowReserved)
      parts.push(rules.named ? `${variable.name}${single === '' ? rules.ifEmpty : `=${encoded}`}` : encoded)
      continue
    }

    // A list. Exploded, each item stands alone; otherwise they join with commas under one name.
    const encoded = items.map((item) => encode(item, rules.allowReserved))
    if (variable.explode) {
      for (const item of encoded) parts.push(rules.named ? `${variable.name}=${item}` : item)
    } else {
      const joined = encoded.join(',')
      parts.push(rules.named ? `${variable.name}${joined === '' ? rules.ifEmpty : `=${joined}`}` : joined)
    }
  }

  return parts.length === 0 ? '' : rules.first + parts.join(rules.separator)
}

/** Every variable name a template declares. */
export function templateVariables(template: string): string[] {
  const names: string[] = []
  for (const expression of expressionsOf(template).values()) {
    for (const variable of expression.variables) {
      if (!names.includes(variable.name)) names.push(variable.name)
    }
  }
  return names
}

/**
 * Expand a template against a set of values.
 *
 * Unbound variables expand to nothing, which is what the specification says and is why a form-style
 * template with nothing bound yields exactly its literal prefix. That property is load-bearing: it is
 * how a collection's own IRI is obtained from a published search template without constructing one.
 */
export function expandTemplate(
  template: string,
  values: Readonly<Record<string, TemplateValue>> = {},
): Expansion {
  const expressions = expressionsOf(template)

  let url = template
  for (const [literal, expression] of expressions) {
    url = url.split(literal).join(expandExpression(expression, values))
  }

  const variables = templateVariables(template)
  const unbound = variables.filter((name) => isEmpty(values[name]))
  const unused = Object.keys(values).filter(
    (name) => !variables.includes(name) && !isEmpty(values[name]),
  )

  return { url, variables, unbound, unused }
}

/**
 * Whether every expression in a template is form-style query expansion.
 *
 * Such a template expands, with nothing bound, to its literal prefix — an unconstrained view of the
 * resource it searches, which is that resource's own IRI. A template with a path expression does not
 * have that property: `…/Page/{page}` with `page` unbound yields `…/Page/`, which identifies nothing.
 * The distinction is what keeps collection lookup a reading of the template rather than a guess.
 */
export function isQueryOnlyTemplate(template: string): boolean {
  const expressions = [...expressionsOf(template).values()]
  return expressions.length > 0 && expressions.every((expression) => expression.operator === '?' || expression.operator === '&')
}
