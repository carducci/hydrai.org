import { DataFactory, Writer, type Quad } from 'n3'

import { FINDING_KINDS, GRAPHS, HC, HCT, NS, RDF, type FindingKind } from './terms'

const { namedNode, literal, blankNode, quad: makeQuad } = DataFactory

/**
 * Conformance findings (design D8).
 *
 * Where the client cannot act because the API describes something incompletely, it records the
 * omission rather than working around it. The proof of concept omitted the field and logged a warning
 * (`index.html:599-644`) — the user asked for something and it silently did not happen.
 *
 * Two audiences, one record. The model gets an `is_error` tool result naming what is undeclared and
 * what routes remain, so the task can still complete; the operator gets these quads, exportable as
 * Turtle, saying precisely what the server would need to publish. Findings are about the API, so they
 * are input to later server-side changes, never to this client's behaviour.
 */

export interface Finding {
  /** The document, term or IRI the finding concerns. */
  readonly about: string
  readonly kind: FindingKind
  /** What is missing, in terms an operator can act on. */
  readonly message: string
  readonly detectedAt: Date
}

export interface Findings {
  record(finding: Omit<Finding, 'detectedAt'> & { detectedAt?: Date }): void
  all(): readonly Finding[]
  /** Findings about one subject — used when escalating to the model. */
  about(iri: string): readonly Finding[]
  /** Quads for the findings graph, so they live in the store with everything else. */
  quads(): Quad[]
  /** The conformance report (task 8.6). */
  toTurtle(): Promise<string>
}

export function createFindings(now: () => Date = () => new Date()): Findings {
  const recorded: Finding[] = []

  return {
    record(finding) {
      const entry: Finding = {
        about: finding.about,
        kind: finding.kind,
        message: finding.message,
        detectedAt: finding.detectedAt ?? now(),
      }

      // The same gap met twice is one finding. A collection paged 194 times must not produce 194
      // identical complaints about its member serialisation.
      const duplicate = recorded.some(
        (held) =>
          held.about === entry.about && held.kind === entry.kind && held.message === entry.message,
      )
      if (!duplicate) recorded.push(entry)
    },

    all: () => recorded,

    about: (iri: string) => recorded.filter((held) => held.about === iri),

    quads() {
      const graph = namedNode(GRAPHS.findings)
      const quads: Quad[] = []

      for (const [index, finding] of recorded.entries()) {
        const subject = blankNode(`finding${index}`)
        quads.push(
          makeQuad(subject, namedNode(RDF.type), namedNode(HCT.Finding), graph),
          makeQuad(subject, namedNode(HCT.about), namedNode(finding.about), graph),
          makeQuad(subject, namedNode(HCT.findingKind), namedNode(finding.kind), graph),
          makeQuad(subject, namedNode(HCT.message), literal(finding.message), graph),
          makeQuad(
            subject,
            namedNode(HCT.detectedAt),
            literal(finding.detectedAt.toISOString(), namedNode(`${NS.xsd}dateTime`)),
            graph,
          ),
        )
      }

      return quads
    },

    toTurtle() {
      const writer = new Writer({
        prefixes: { hc: HC, xsd: NS.xsd, rdf: NS.rdf },
      })
      // Written from the default graph: a report is a document about the API, and a consumer should
      // not have to know the client's internal graph names to read it.
      for (const q of this.quads()) {
        writer.addQuad(makeQuad(q.subject, q.predicate, q.object))
      }

      return new Promise<string>((resolve, reject) => {
        writer.end((error, result: string) => (error ? reject(error) : resolve(result)))
      })
    },
  }
}

export { FINDING_KINDS }
