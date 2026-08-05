import type { SessionGraph } from '../rdf/session-graph'
import { RDF } from '../rdf/terms'
import type { ConstraintResidue, JsonSchema, ProjectedTool } from '../project/tools'
import type { ValueSetIndex } from '../render/affordances'

/**
 * The constraint gate (task 5.4, design D3).
 *
 * Two things are checked here, and the split between them is the design.
 *
 * The **residue** is what JSON Schema could not express — lengths, patterns, cardinalities, class
 * references — computed once at projection time and evaluated here.
 *
 * The **schema structure** is what JSON Schema *could* express — the enum a `sh:in` became, the
 * declared type, the required fields, the closed object. Strict structured outputs enforces those
 * platform-side, so when a tool is sent strict this half is a no-op: the input already conforms. But
 * a request may carry at most 20 strict tools and a real API projects more, so above that limit the
 * surface is sent **without** `strict` and the platform enforces nothing (baseline §3b P1). Then this
 * half is the only thing standing between a malformed call and the wire. Checking it here, always,
 * makes the gate the single enforcement truth and `strict` a latency optimisation on top rather than
 * a correctness dependency — the executor never has to know which mode a given request used.
 *
 * **There is no `validate` tool**, deliberately. A check the model chooses to run fails precisely when
 * the model is overconfident, which is the failure mode being removed. This runs on the dispatch path,
 * unconditionally, whether or not anything asked for it.
 *
 * Three outcomes, and keeping them distinct is the point:
 *
 * - **violation** — the published constraint is definitely broken. Refuse, quote the constraint.
 * - **unverified** — the constraint could not be evaluated from what the client holds. Disclosed, and
 *   never quietly counted as satisfied; a gate that reported "checked" for a check it did not perform
 *   would be worth less than no gate.
 * - **escalation** — the *vocabulary* is incomplete, so the value cannot be resolved at all (design
 *   D8). Not the caller's error, and answered with what would make it resolvable.
 */

export interface GateViolation {
  /** Where the value sits in the tool input, as a dotted path. */
  readonly path: string
  readonly predicate: string
  /** A SHACL residue kind, or `schema` for a structural check the platform would make under strict. */
  readonly kind: ConstraintResidue['kind'] | 'schema'
  readonly message: string
}

export interface GateUnverified {
  readonly path: string
  readonly predicate: string
  readonly kind: ConstraintResidue['kind']
  /** Why it could not be checked, stated rather than hidden. */
  readonly reason: string
}

export interface GateEscalation {
  readonly path: string
  readonly predicate: string
  readonly message: string
}

export interface GateResult {
  readonly violations: readonly GateViolation[]
  readonly unverified: readonly GateUnverified[]
  readonly escalations: readonly GateEscalation[]
  /** No violation, so a request may be issued. Escalations do not block; they accompany. */
  readonly passed: boolean
}

/** Resolve a dotted path — `primaryAddress.postalCode` — against the tool input. */
function valueAt(input: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = input
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Everything a value could be a string for. A number given for a string field still has a length. */
function asStrings(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(asStrings)
  if (typeof value === 'object') {
    const node = value as Record<string, unknown>
    if (typeof node['@id'] === 'string') return [node['@id']]
    if (node['@value'] !== undefined) return [String(node['@value'])]
    return []
  }
  return [String(value)]
}

export interface GateDeps {
  /** Consulted for `sh:class`: a reference can only be type-checked against what the client holds. */
  readonly graph?: SessionGraph
  /**
   * Live value sets (design D5): where a read-only reference collection serves a class in full,
   * its members are the property's value set and membership is enforced here. Absent, the check
   * degrades to the held-types path — it never guesses enumerability.
   */
  readonly valueSets?: ValueSetIndex
}

/**
 * SHACL patterns are XSD regular expressions, which JavaScript's engine accepts for the constructs
 * that appear in practice. An expression it rejects outright is reported as unevaluable rather than
 * silently passed — the client does not get to decide a published constraint was satisfied because it
 * could not read it.
 */
function matchesPattern(value: string, pattern: string): boolean | null {
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    try {
      return new RegExp(pattern).test(value)
    } catch {
      return null
    }
  }
}

/** Types the client holds for a subject, from anywhere it has read. */
function typesOf(graph: SessionGraph, iri: string): string[] {
  return [...new Set(graph.match(iri, RDF.type, null).map((quad) => quad.object.value))]
}

/** The JSON type of a value, in the vocabulary a schema's `type` uses. */
function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value === 'number' ? 'number' : typeof value
}

/**
 * Enforce what a strict schema would have — walked in parallel with the input.
 *
 * Only the structural guarantees strict actually makes: a closed object rejects an unknown key, a
 * required key must be present, an `enum` value must be in the set, and a declared `type` must match.
 * `format` is deliberately **not** enforced — the platform treats it as advisory even under strict, so
 * a gate that rejected on it would be stricter than the mode it stands in for and would refuse values
 * the API accepts.
 *
 * `integer` satisfies `number`; every other mismatch is a violation. An accepted call under strict
 * never reaches a failing branch here, because the input already conforms — which is what lets this
 * run unconditionally.
 */
function checkSchema(
  schema: JsonSchema,
  value: unknown,
  path: string,
  violate: (path: string, message: string) => void,
): void {
  if (value === undefined || value === null) return

  if (schema.enum && !schema.enum.includes(value as string)) {
    violate(
      path,
      `must be one of ${schema.enum.map((option) => `"${option}"`).join(', ')}; ` +
        `"${String(value)}" is not among them.`,
    )
    return
  }

  if (schema.type) {
    const actual = jsonType(value)
    const ok = actual === schema.type || (schema.type === 'number' && actual === 'integer')
    if (!ok) {
      violate(path, `must be ${schema.type}, but a ${actual} was supplied.`)
      return
    }
  }

  if (schema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    const node = value as Record<string, unknown>
    const properties = schema.properties ?? {}

    // additionalProperties is `false` on every object the projection emits (strict requires it), so a
    // key with no matching property is one the model invented — refused rather than sent, because the
    // server would ignore it and the call would look like it carried it.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(node)) {
        if (!(key in properties)) violate(path ? `${path}.${key}` : key, `is not a declared property.`)
      }
    }

    for (const required of schema.required ?? []) {
      if (node[required] === undefined || node[required] === null) {
        violate(path ? `${path}.${required}` : required, `is required and was not supplied.`)
      }
    }

    for (const [key, sub] of Object.entries(properties)) {
      if (key in node) checkSchema(sub, node[key], path ? `${path}.${key}` : key, violate)
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((element, index) => checkSchema(schema.items as JsonSchema, element, `${path}[${index}]`, violate))
  }
}

export function checkConstraints(
  tool: ProjectedTool,
  input: Readonly<Record<string, unknown>>,
  deps: GateDeps = {},
): GateResult {
  const violations: GateViolation[] = []
  const unverified: GateUnverified[] = []
  const escalations: GateEscalation[] = []

  // The schema half first: a value that is the wrong shape entirely should be reported as that,
  // before its residue is evaluated against it. Reuses the same violation channel, keyed on the
  // structural constraint rather than a SHACL one.
  checkSchema(tool.input_schema, input, '', (path, message) =>
    violations.push({ path, predicate: path, kind: 'schema', message: `${path} ${message}` }),
  )

  for (const residue of tool.dispatch.residue) {
    const value = valueAt(input, residue.schemaName)
    // An absent optional value violates nothing. Whether it is required is the schema's business, and
    // the platform has already answered it.
    if (value === undefined || value === null) continue

    const strings = asStrings(value)
    const violate = (message: string) =>
      violations.push({
        path: residue.schemaName,
        predicate: residue.property,
        kind: residue.kind,
        message,
      })
    const cannotCheck = (reason: string) =>
      unverified.push({
        path: residue.schemaName,
        predicate: residue.property,
        kind: residue.kind,
        reason,
      })

    switch (residue.kind) {
      case 'maxLength': {
        const limit = Number(residue.value)
        const over = strings.find((held) => [...held].length > limit)
        if (over !== undefined) {
          violate(`${residue.message} The supplied value is ${[...over].length} characters.`)
        }
        break
      }

      case 'minLength': {
        const limit = Number(residue.value)
        const under = strings.find((held) => [...held].length < limit)
        if (under !== undefined) {
          violate(`${residue.message} The supplied value is ${[...under].length} characters.`)
        }
        break
      }

      case 'maxCount': {
        const count = Array.isArray(value) ? value.length : 1
        if (count > Number(residue.value)) violate(`${residue.message} ${count} were supplied.`)
        break
      }

      case 'pattern': {
        const pattern = String(residue.value)
        for (const held of strings) {
          const result = matchesPattern(held, pattern)
          if (result === null) {
            cannotCheck(
              `<${residue.property}> publishes the pattern /${pattern}/, which this client could not ` +
                `compile. The value was not checked against it.`,
            )
            break
          }
          if (!result) {
            violate(`${residue.message} The supplied value is "${held}".`)
            break
          }
        }
        break
      }

      case 'class': {
        const required = String(residue.value)
        const served = deps.valueSets?.byClass(required)
        for (const held of strings) {
          // The reference collection serves this class in full, so membership settles the check —
          // a value outside the set is refused naming the set (design D5).
          if (served && served.length > 0) {
            if (!served.some((member) => member.iri === held)) {
              violate(
                `${residue.message} <${held}> is not among the served members of <${required}>: ` +
                  served
                    .map((member) => (member.label ? `<${member.iri}> (${member.label})` : `<${member.iri}>`))
                    .join(', ') +
                  `.`,
              )
            }
            continue
          }
          const types = deps.graph ? typesOf(deps.graph, held) : []
          if (types.length === 0) {
            cannotCheck(
              `<${residue.property}> must reference a resource of type <${required}>. Nothing is held ` +
                `about <${held}>, so its type could not be confirmed before the request.`,
            )
            continue
          }
          if (!types.includes(required)) {
            violate(
              `${residue.message} <${held}> is held as ${types.map((type) => `<${type}>`).join(', ')}.`,
            )
          }
        }
        break
      }

      case 'undeclaredLinkRange':
        // Not the caller's error. The vocabulary declares a link and never says what it points at, so
        // no client can resolve a value for it deterministically (design D8).
        escalations.push({
          path: residue.schemaName,
          predicate: residue.property,
          message: residue.message,
        })
        break

      case 'node':
      case 'unknownDatatype':
        cannotCheck(residue.message)
        break
    }
  }

  return { violations, unverified, escalations, passed: violations.length === 0 }
}

/** What the model is told when a constraint refuses the call. Quotes the constraint, never paraphrases. */
export function describeViolations(tool: ProjectedTool, result: GateResult): string {
  const lines = [
    `${tool.name} was not called: the values supplied violate constraints this API publishes. ` +
      `No request was issued.`,
    '',
  ]
  for (const violation of result.violations) lines.push(`- ${violation.path}: ${violation.message}`)

  if (result.unverified.length > 0) {
    lines.push('', 'Also published, and not checkable from what is held:')
    for (const held of result.unverified) lines.push(`- ${held.path}: ${held.reason}`)
  }

  return lines.join('\n')
}
