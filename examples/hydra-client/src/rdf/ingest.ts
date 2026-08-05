import jsonld from 'jsonld'
import { Parser, type Quad } from 'n3'

import { ContextFetchError, type DocumentLoader } from './document-loader'

/**
 * The only two doors into the store (task 2.2).
 *
 * Everything the client retrieves becomes quads here and is addressed by absolute IRI from this point
 * on. That is the invariant the whole design rests on — *above the graph layer there is no JSON* —
 * and it is what makes the proof of concept's central bug class impossible rather than fixed. A term
 * served as `sh:shapesGraph` and the same term served as `http://www.w3.org/ns/shacl#shapesGraph` are
 * one term after expansion, so no lookup can miss one by matching the spelling of the other.
 */

/** Thrown when a document is retrieved but cannot be read as RDF. */
export class ParseError extends Error {
  readonly sourceUrl: string

  constructor(sourceUrl: string, reason: string, options?: { cause?: unknown }) {
    super(`<${sourceUrl}> was retrieved but could not be parsed as RDF: ${reason}`, options)
    this.name = 'ParseError'
    this.sourceUrl = sourceUrl
  }
}

/**
 * Expand a JSON-LD document to quads.
 *
 * Routed through N-Quads rather than `jsonld`'s in-memory dataset so what lands in the store is
 * ordinary RDF/JS terms produced by one parser, with no second term-factory to keep consistent.
 *
 * A `ContextFetchError` from the loader is deliberately allowed to propagate: a document expanded
 * without one of its contexts is a smaller graph that looks complete, and returning it would turn a
 * deployment problem into a phantom missing feature.
 */
export async function quadsFromJsonLd(
  document: unknown,
  loader: DocumentLoader,
  sourceUrl: string,
): Promise<Quad[]> {
  let nquads: string
  try {
    nquads = (await jsonld.toRDF(document as jsonld.JsonLdDocument, {
      format: 'application/n-quads',
      documentLoader: loader as never,
      base: sourceUrl,
    })) as unknown as string
  } catch (cause) {
    // jsonld.js wraps loader failures in its own error, so the original has to be dug out rather than
    // matched directly. A context failure must keep its identity all the way to the caller: it is a
    // deployment problem with a named document, not a malformed payload.
    const contextFailure = findContextFetchError(cause)
    if (contextFailure) throw contextFailure
    throw new ParseError(sourceUrl, describe(cause), { cause })
  }

  return quadsFromNQuads(nquads, sourceUrl)
}

/** Walk the cause chain, including jsonld.js's `details.cause`, looking for our named error. */
function findContextFetchError(cause: unknown, depth = 0): ContextFetchError | null {
  if (depth > 8 || cause === null || typeof cause !== 'object') return null
  if (cause instanceof ContextFetchError) return cause

  const candidates = [
    (cause as { cause?: unknown }).cause,
    (cause as { details?: { cause?: unknown } }).details?.cause,
  ]
  for (const candidate of candidates) {
    const found = findContextFetchError(candidate, depth + 1)
    if (found) return found
  }
  return null
}

/** Parse Turtle — the serialisation a shapes graph or an ontology is most likely to arrive in. */
export function quadsFromTurtle(turtle: string, sourceUrl: string): Quad[] {
  return parseWith(turtle, sourceUrl, { format: 'text/turtle', baseIRI: sourceUrl })
}

export function quadsFromNQuads(nquads: string, sourceUrl: string): Quad[] {
  return parseWith(nquads, sourceUrl, { format: 'application/n-quads' })
}

function parseWith(
  input: string,
  sourceUrl: string,
  config: { format: string; baseIRI?: string },
): Quad[] {
  try {
    return new Parser(config).parse(input)
  } catch (cause) {
    throw new ParseError(sourceUrl, describe(cause), { cause })
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/**
 * Pick the serialisation from a `Content-Type`, falling back to JSON-LD.
 *
 * Content negotiation asks for `application/ld+json`, so an unfamiliar type usually means the server
 * ignored the request rather than that the body is something exotic — but Turtle is common enough for
 * shapes and ontologies that it is worth recognising.
 */
export function serialisationOf(contentType: string | null): 'json-ld' | 'turtle' | 'n-quads' {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (type === 'text/turtle' || type === 'application/x-turtle') return 'turtle'
  if (type === 'application/n-quads' || type === 'application/n-triples') return 'n-quads'
  return 'json-ld'
}
