import type { Quad, Term } from 'n3'

import { NS, RDF } from '../rdf/terms'
import type { ProjectedTool, ToolBinding } from '../project/tools'

/**
 * Request payloads, and checking what came back (tasks 5.1 and 5.6).
 *
 * ## The payload is built from predicate IRIs
 *
 * A schema property name is a label the model reads; the predicate IRI is the identity. Every
 * projected tool pairs the two in `dispatch.bindings`, and this module uses only the IRI side. The
 * document that goes on the wire has absolute IRIs as its keys — which is valid JSON-LD needing no
 * context — so the name the model saw never reaches the server and cannot be mistaken for a term.
 *
 * ## Replacement is built from the current representation
 *
 * PUT replaces a resource; the vocabulary's own operation description says every writeable property
 * not supplied is cleared. So a partial change has to be sent as a whole representation: read the
 * current one, overlay what the caller asked to change, send the union. That is why design D4 makes
 * the pre-write read reach the origin unconditionally — merging into a stale copy silently reverts
 * every field someone else changed since, which is data loss rather than staleness.
 *
 * Nested nodes are carried through that merge intact. An address serialised as a nested object is a
 * blank node in the graph, and a merge that dropped it would clear the address on every unrelated
 * edit — the same data loss arriving by a quieter route.
 */

export type JsonLdNode = Record<string, unknown>

/** A value the caller asked to be written, keyed by the predicate it is a value for. */
export type RequestedValues = ReadonlyMap<string, unknown>

const XSD_STRING = `${NS.xsd}string`
const RDF_LANG_STRING = `${NS.rdf}langString`

/**
 * An RDF term as a JSON-LD value.
 *
 * Blank nodes are expanded recursively, because a nested node dropped from a replacement payload is a
 * field cleared. The visited set is a malformed-data backstop: a cyclic blank-node structure would
 * otherwise recurse until the stack ran out.
 */
function termToJsonLd(term: Term, quads: readonly Quad[], visited: readonly string[] = []): unknown {
  if (term.termType === 'NamedNode') return { '@id': term.value }

  if (term.termType === 'Literal') {
    const datatype = term.datatype?.value
    if (term.language) return { '@value': term.value, '@language': term.language }
    if (!datatype || datatype === XSD_STRING || datatype === RDF_LANG_STRING) return term.value
    return { '@value': term.value, '@type': datatype }
  }

  if (term.termType !== 'BlankNode' || visited.includes(term.value)) return null

  const node: JsonLdNode = {}
  for (const quad of quads.filter((held) => held.subject.equals(term))) {
    const value = termToJsonLd(quad.object, quads, [...visited, term.value])
    if (value === null) continue
    const key = quad.predicate.value === RDF.type ? '@type' : quad.predicate.value
    // `@type` takes an IRI directly rather than a node object.
    node[key] = key === '@type' ? quad.object.value : value
  }

  return Object.keys(node).length > 0 ? node : null
}

/**
 * The values a subject currently holds for a set of predicates.
 *
 * Read out of quads rather than out of the response JSON, so the shape the server chose to serialise
 * — compact term, full IRI, nested object, array of one — makes no difference to what is carried
 * forward. That is the invariant, applied where it pays: the merge cannot lose a field because the
 * server changed how it spells one.
 */
export function currentValues(
  quads: readonly Quad[],
  subject: string,
  predicates: readonly string[],
): Map<string, unknown> {
  const wanted = new Set(predicates)
  const values = new Map<string, unknown>()

  for (const quad of quads) {
    if (quad.subject.value !== subject || !wanted.has(quad.predicate.value)) continue
    const value = termToJsonLd(quad.object, quads)
    if (value === null) continue

    // A repeated predicate is a list, not an overwrite. Collapsing it would drop values.
    const held = values.get(quad.predicate.value)
    if (held === undefined) values.set(quad.predicate.value, value)
    else if (Array.isArray(held)) held.push(value)
    else values.set(quad.predicate.value, [held, value])
  }

  return values
}

/** The `rdf:type` a subject carries, if the graph states one. */
export function typeOf(quads: readonly Quad[], subject: string): string | null {
  const typed = quads.find((quad) => quad.subject.value === subject && quad.predicate.value === RDF.type)
  return typed ? typed.object.value : null
}

export interface PayloadOptions {
  /** The resource being acted on. Absent for a creation, which has no subject yet. */
  readonly subject: string | null
  /** `@type` for the document — the current representation's type, or what the operation expects. */
  readonly type: string | null
  /** Current values to merge under the caller's, keyed by predicate IRI. Empty for a creation. */
  readonly base?: ReadonlyMap<string, unknown>
}

export interface BuiltPayload {
  readonly document: JsonLdNode
  /** What the caller asked to write, keyed by predicate. The input to verification. */
  readonly requested: RequestedValues
}

/**
 * A supplied value under a binding, converted to predicate identity at every depth.
 *
 * The names inside a nested object are labels the model read, exactly as they are at the top
 * level. A nested field passed through under its label would reach the wire as a key the served
 * context never declared — the C9 class one level down — so the nested bindings the projection
 * retained convert each level to its predicate IRI.
 */
function convertValue(binding: ToolBinding, supplied: unknown): unknown {
  if (binding.isLink && typeof supplied === 'string') return { '@id': supplied }
  if (!binding.nested || supplied === null || typeof supplied !== 'object') return supplied
  if (Array.isArray(supplied)) return supplied.map((entry) => convertValue(binding, entry))

  const node: JsonLdNode = {}
  for (const [name, value] of Object.entries(supplied as Record<string, unknown>)) {
    if (value === undefined) continue
    const nested = binding.nested.find((candidate) => candidate.name === name)
    // An undeclared key cannot be mapped to a predicate; the gate refuses it before this runs, so
    // reaching here with one is a defect — carried as-is rather than silently dropped.
    if (!nested || nested.property === null) {
      node[name] = value
      continue
    }
    node[nested.property] = convertValue(nested, value)
  }
  return node
}

/**
 * Assemble the request document from a tool's bindings.
 *
 * Only bindings are consulted, so an input key the tool never declared cannot reach the wire — the
 * dispatch gate rejects one anyway, and this is the second half of that guarantee. The document is
 * keyed by predicate IRIs at every depth; `execute/frame` turns it into the exact wire JSON.
 */
export function buildPayload(
  tool: ProjectedTool,
  input: Readonly<Record<string, unknown>>,
  options: PayloadOptions,
): BuiltPayload {
  const document: JsonLdNode = {}
  if (options.subject) document['@id'] = options.subject
  if (options.type) document['@type'] = options.type

  for (const [predicate, value] of options.base ?? []) document[predicate] = value

  const requested = new Map<string, unknown>()
  for (const binding of tool.dispatch.bindings) {
    // The subject is not a predicate; it identifies the resource and is carried as `@id`.
    if (binding.property === null) continue

    const supplied = input[binding.name]
    if (supplied === undefined) continue

    const value = convertValue(binding, supplied)
    document[binding.property] = value
    requested.set(binding.property, value)
  }

  return { document, requested }
}

export interface WriteMismatch {
  readonly predicate: string
  readonly requested: string
  readonly returned: string | null
}

/** The comparable form of a JSON-LD value: an IRI, or a lexical value. */
function comparable(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    const node = value as JsonLdNode
    if (typeof node['@id'] === 'string') return node['@id']
    if (node['@value'] !== undefined) return String(node['@value'])
    return JSON.stringify(node)
  }
  return String(value)
}

/**
 * Two lexical forms that state the same value.
 *
 * The graph-level check compares terms, and a server is free to round-trip a literal in a
 * different lexical form — `2026-01-01T00:00:00` echoed as `2026-01-01T00:00:00Z`, `5.0` echoed
 * as `5`. Those are the same value differently spelled, and a check that failed them would report
 * a persistence failure the server did not commit. Anything neither numeric nor temporal falls
 * back to exact comparison — this normalises known-equal spellings, it does not approximate.
 */
function sameValue(sent: string, returned: string): boolean {
  if (sent === returned) return true

  const sentNumber = Number(sent)
  const returnedNumber = Number(returned)
  if (sent.trim() !== '' && returned.trim() !== '' && Number.isFinite(sentNumber) && Number.isFinite(returnedNumber)) {
    return sentNumber === returnedNumber
  }

  const sentInstant = Date.parse(sent)
  const returnedInstant = Date.parse(returned)
  if (Number.isFinite(sentInstant) && Number.isFinite(returnedInstant)) {
    if (sentInstant === returnedInstant) return true
    // A timezone-less xsd:dateTime is zone-indeterminate; a server that echoes it with a zone
    // attached is stating the same wall-clock value, not changing it. Comparing with the zone
    // stripped from both sides is what makes that equality visible.
    const zoneless = (value: string) => value.replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i, '')
    const bothZoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(sent) && /(Z|[+-]\d{2}:?\d{2})$/i.test(returned)
    return !bothZoned && zoneless(sent) === zoneless(returned)
  }

  return false
}

/**
 * Graph-level echo verification (design D6): write-graph ⊆ echo-graph.
 *
 * Both sides are quads, so the comparison is by predicate and value — whatever key the served
 * context spelled either under. Only the predicates in `requested` are checked: the merged base
 * came from the server and re-verifying it would flag the server's own normalisations. A nested
 * value echoes as a blank node whose label is a parse artefact, so for those the check is
 * presence — the predicate must come back carrying *something* — and absence is the failure worth
 * catching.
 */
export function verifyEchoGraph(
  written: readonly Quad[],
  echoed: readonly Quad[],
  subject: string | null,
  requested: RequestedValues,
): WriteMismatch[] {
  const mismatches: WriteMismatch[] = []

  // The written document's root: the named subject, or the lone blank/unnamed node of a creation.
  const isRoot = (quad: Quad) =>
    subject === null ? quad.subject.termType !== 'NamedNode' || quad.subject.value === '' : quad.subject.value === subject
  const echoRoots = new Set(
    subject === null ? echoed.map((quad) => quad.subject.value) : [subject],
  )

  for (const quad of written) {
    if (!isRoot(quad) || !requested.has(quad.predicate.value)) continue

    const returned = echoed.filter(
      (candidate) => echoRoots.has(candidate.subject.value) && candidate.predicate.value === quad.predicate.value,
    )

    if (quad.object.termType === 'BlankNode') {
      if (returned.length === 0) {
        mismatches.push({ predicate: quad.predicate.value, requested: '(a nested value)', returned: null })
      }
      continue
    }

    if (!returned.some((candidate) => sameValue(quad.object.value, candidate.object.value))) {
      mismatches.push({
        predicate: quad.predicate.value,
        requested: quad.object.value,
        returned: returned[0]?.object.value ?? null,
      })
    }
  }

  return mismatches
}

/**
 * Compare what came back against what was asked for (task 5.6).
 *
 * The proof of concept did this over JSON keys and it earned its place: this API's serialiser has
 * silently dropped fields on write, and without the check the model narrates a success that did not
 * happen. Done over quads it is stronger — a server that echoed the value under a differently spelled
 * key would still be seen to have persisted it, and one that dropped it is still seen to have dropped
 * it. Retained as the fallback for a write whose own graph could not be built (no served context and
 * an unparseable wire body is not a case, but a defensive path costs nothing); `verifyEchoGraph` is
 * the primary check.
 */
export function verifyEcho(
  requested: RequestedValues,
  echoed: readonly Quad[],
  subject: string,
): WriteMismatch[] {
  const mismatches: WriteMismatch[] = []

  for (const [predicate, value] of requested) {
    const expected = comparable(value)
    const returned = echoed
      .filter((quad) => quad.subject.value === subject && quad.predicate.value === predicate)
      .map((quad) => quad.object.value)

    // A nested node echoes as a blank node whose value is a parse-time label, so it cannot be compared
    // lexically. Its presence is what is checkable, and its absence is the failure worth catching.
    if (typeof value === 'object' && value !== null && (value as JsonLdNode)['@id'] === undefined) {
      if (returned.length === 0) {
        mismatches.push({ predicate, requested: expected, returned: null })
      }
      continue
    }

    if (!returned.includes(expected)) {
      mismatches.push({ predicate, requested: expected, returned: returned[0] ?? null })
    }
  }

  return mismatches
}
