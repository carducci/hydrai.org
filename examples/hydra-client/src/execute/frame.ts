import jsonld from 'jsonld'

import type { DocumentLoader } from '../rdf/document-loader'
import type { PropertyConstraints } from '../vocab/capability'

/**
 * The framing write path (design D6).
 *
 * Root cause of the C9 write-failure class: treating JSON keys as identity. Keys are presentation;
 * predicates are identity. So an outgoing write is assembled as a graph keyed by predicate IRIs
 * (`execute/payload`), and this module turns that graph into the exact wire JSON: compacted against
 * the **served** `@context` of the target class, with tree shape applied from a frame derived from
 * the SHACL shape (`sh:node` nesting ↔ `@embed`). Key spelling and nesting are thereby correct by
 * construction — whatever the served context calls a predicate is what goes on the wire, and the
 * client never hand-assembles a wire key.
 *
 * Where no served context is known, the predicate-IRI document goes as it is: absolute IRIs as keys
 * are valid JSON-LD needing no context, which is exactly what the client sent before this path
 * existed. The feature degrades; it never invents a context.
 */

export interface FrameDeps {
  /** Constraints for a class, keyed by predicate IRI. */
  readonly constraintsFor: (classIri: string) => Map<string, PropertyConstraints>
  /** Constraints of a shape addressed by its own IRI — how `sh:node` nesting is resolved. */
  readonly constraintsOfShape: (shapeIri: string) => Map<string, PropertyConstraints>
}

/**
 * Derive the JSON-LD frame for a class from its SHACL shape.
 *
 * Every property shaped by `sh:node` frames as an embedded node (`@embed: @always`), recursively.
 * The visited list is the cycle guard, per the nested-schema precedent: a shape that reaches an
 * ancestor stops embedding there rather than recursing forever — framing a cycle is not
 * expressible, and the un-embedded reference is the honest rendering of it.
 */
export function deriveFrame(classIri: string, deps: FrameDeps): Record<string, unknown> {
  const frame: Record<string, unknown> = { '@type': classIri }
  embedNodes(deps.constraintsFor(classIri), frame, deps, [])
  return frame
}

function embedNodes(
  constraints: Map<string, PropertyConstraints>,
  into: Record<string, unknown>,
  deps: FrameDeps,
  visitedShapes: readonly string[],
): void {
  for (const [predicate, constraint] of constraints) {
    if (!constraint.node || visitedShapes.includes(constraint.node)) continue
    const nested: Record<string, unknown> = { '@embed': '@always' }
    embedNodes(deps.constraintsOfShape(constraint.node), nested, deps, [...visitedShapes, constraint.node])
    into[predicate] = nested
  }
}

/** Whether a frame carries any embedding beyond the type match — a bare frame buys nothing. */
function framesAnything(frame: Record<string, unknown>): boolean {
  return Object.keys(frame).some((key) => key !== '@type' && key !== '@embed')
}

export interface WireOptions {
  /** The `@context` the server served for this kind of resource — URL, object, or array. */
  readonly context: unknown
  /** The frame derived from the target class's shape, where the class has one. */
  readonly frame?: Record<string, unknown> | null
  readonly loader: DocumentLoader
}

/**
 * Turn a predicate-IRI document into the exact wire JSON.
 *
 * Framing needs a `@type` in the document to match on; a document without one (an operation whose
 * expected class is undeclared) skips the frame and compacts alone — the tree it already has is
 * kept, only the spelling changes.
 */
export async function toWire(
  document: Record<string, unknown>,
  options: WireOptions,
): Promise<Record<string, unknown>> {
  if (options.context === null || options.context === undefined) return document

  const loader = options.loader as never
  const context = options.context as never

  if (options.frame && framesAnything(options.frame) && typeof document['@type'] === 'string') {
    // The published typings under-declare frame()'s options; the call shape is the documented one.
    const frame = jsonld.frame as unknown as (
      input: unknown,
      frame: unknown,
      options: unknown,
    ) => Promise<Record<string, unknown>>
    return frame(
      document,
      { ...options.frame, '@context': options.context },
      { documentLoader: options.loader, omitGraph: true },
    )
  }

  const compacted = await jsonld.compact(document as jsonld.JsonLdDocument, context, {
    documentLoader: loader,
  })
  return compacted as Record<string, unknown>
}
