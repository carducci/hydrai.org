import type { HttpClient } from '../http/client'
import { FINDING_KINDS, type Findings } from '../rdf/findings'
import type { SessionGraph } from '../rdf/session-graph'
import { GRAPHS } from '../rdf/terms'
import type { DiscoveredApi } from './discover'

/**
 * Tiers (design D6, task 3.6).
 *
 * Not every API publishes all four documents. A client that requires them all demonstrates nothing
 * portable; one that silently does less is unaccountable. So the client detects what is there, declares
 * it, and degrades at a specific layer — and the badge doubles as a roadmap for an operator pointing
 * this at their own API.
 *
 *   T0  vocabulary          names · methods · required · descriptions · possibleStatus
 *   T1  + JSON-LD context   nested keys ⇄ IRIs, so payload keys are known rather than guessed
 *   T2  + SHACL shapes      datatypes · formats · sh:in as a hard enum · the residue gate
 *   T3  + ontology          subclass closure, and remote SPARQL replacing local execution
 *       + reachable endpoint
 *
 * T0 is the floor and must work.
 */

export type Tier = 'T0' | 'T1' | 'T2' | 'T3'

export interface TierEvidence {
  readonly vocabulary: boolean
  readonly context: boolean
  readonly shapes: boolean
  readonly ontology: boolean
  /** Advertised. Says nothing about whether it answers. */
  readonly sparqlAdvertised: boolean
  /** Probed. This is the one that counts. */
  readonly sparqlReachable: boolean
}

export interface TierAssessment {
  readonly tier: Tier
  readonly evidence: TierEvidence
  /** What publishing or fixing the next thing would unlock. `null` at T3. */
  readonly nextUnlocks: string | null
  /** Anything true but awkward — advertised-and-dead, present-but-undiscoverable. */
  readonly caveats: readonly string[]
}

/**
 * Strip the fragment from a term IRI to get its dereference target.
 *
 * This is not a constructed URL. A hash namespace means exactly this: `https://…/ns#Contact` and
 * `https://…/ns#Company` both dereference to `https://…/ns`, by the definition of a fragment. It is the
 * fallback route to the ontology, taken when the vocabulary advertises none explicitly (`discoverApi`
 * reads an `rdfs:isDefinedBy` / `owl:imports` / `void:vocabulary` reference where one is published).
 * A client that follows an advertised reference needs neither this nor the hash-namespace convention.
 */
export function dereferenceTargetOf(termIri: string): string | null {
  const hash = termIri.indexOf('#')
  if (hash <= 0) return null
  return termIri.slice(0, hash)
}

export interface OntologyProbeDeps {
  readonly http: HttpClient
  readonly findings: Findings
  /** Rebase the term namespace onto the connect origin, as discovery does for the Link header. */
  readonly connectOrigin: string
}

/**
 * Probe for an ontology by dereferencing one term IRI.
 *
 * Deliberately a probe and not a load. This API's ontology is 885KB of Turtle; at T3 the SPARQL
 * endpoint already holds it, so subclass closure comes from there and paying to parse it in the browser
 * buys nothing. Load it only where local reasoning needs it.
 */
export async function probeOntology(
  termIri: string | null,
  deps: OntologyProbeDeps,
): Promise<{ available: boolean; url: string | null }> {
  // Callers pass the API's own term namespace. A standard-vocabulary IRI would be meaningless here, and
  // rebasing one onto the connect origin would emit a false finding about somebody else's namespace.
  if (termIri === null) return { available: false, url: null }

  const target = dereferenceTargetOf(termIri)
  if (!target) return { available: false, url: null }

  let url = target
  try {
    const declared = new URL(target)
    const connect = new URL(deps.connectOrigin)
    if (declared.origin !== connect.origin) {
      // Term IRIs are stable identifiers and correctly are *not* rebased by the server — but that means
      // dereferencing one from a local boot leaves the deployment under test. Same brick wall as the
      // Link header, same treatment: rebase, disclose, record.
      url = connect.origin + declared.pathname
      deps.findings.record({
        about: target,
        kind: FINDING_KINDS.originMismatch,
        message:
          `Term IRIs are minted under ${declared.origin} while this deployment serves ${connect.origin}. ` +
          `Dereferencing a term IRI verbatim leaves this deployment. Resolved against the connect ` +
          `origin instead. A deployment serving a vocabulary under an origin it does not answer on ` +
          `should either serve that origin or advertise the ontology explicitly.`,
      })
    }
  } catch {
    return { available: false, url: null }
  }

  try {
    const response = await deps.http.request(url, { accept: 'text/turtle, application/ld+json' })
    return { available: response.ok, url }
  } catch {
    return { available: false, url }
  }
}

export function assessTier(
  graph: SessionGraph,
  discovered: Pick<DiscoveredApi, 'sparqlEndpoint' | 'sparqlReachable'>,
  extras: { ontology: boolean; contextResolved: boolean; ontologyAdvertised?: boolean },
): TierAssessment {
  const evidence: TierEvidence = {
    vocabulary: graph.match(null, null, null, GRAPHS.vocab).length > 0,
    context: extras.contextResolved,
    shapes: graph.match(null, null, null, GRAPHS.shapes).length > 0,
    ontology: extras.ontology,
    sparqlAdvertised: discovered.sparqlEndpoint !== null,
    sparqlReachable: discovered.sparqlReachable === true,
  }

  const caveats: string[] = []

  // Advertised and dead is the case worth naming: this deployment has been in both states within one
  // session with the advertisement unchanged, which is why reachability is probed and not assumed.
  if (evidence.sparqlAdvertised && !evidence.sparqlReachable) {
    caveats.push(
      'A SPARQL endpoint is advertised but did not answer. Operating without it — analytics will be ' +
        'computed locally over materialised collections, gated on completeness.',
    )
  }
  // Found-but-not-advertised is the case worth naming: the ontology was reached only by dereferencing
  // a term IRI, which a generic client need not do. Once the vocabulary advertises it explicitly
  // (rdfs:isDefinedBy / owl:imports / void:vocabulary), the inference tier is discoverable and the
  // recommendation is moot, so it is dropped.
  if (evidence.ontology && !evidence.sparqlReachable && !extras.ontologyAdvertised) {
    caveats.push(
      'An ontology is reachable but is not referenced by the vocabulary; it was found by dereferencing ' +
        'a term IRI. Advertising it would make the inference tier discoverable rather than inferred.',
    )
  }

  // Each tier requires every tier beneath it. A shapes graph without a context does not make T2 —
  // claiming it would mean claiming payload keys the client cannot actually resolve.
  let tier: Tier = 'T0'
  let nextUnlocks: string | null =
    'A JSON-LD context would let payload keys be resolved to IRIs instead of taken on trust (T1).'

  if (!evidence.vocabulary) {
    // Below the floor. Reported honestly rather than dressed as T0.
    return {
      tier: 'T0',
      evidence,
      nextUnlocks: 'A Hydra ApiDocumentation is the floor — without it there is no tool surface at all.',
      caveats,
    }
  }

  if (evidence.context) {
    tier = 'T1'
    nextUnlocks =
      'A SHACL shapes graph would turn datatypes and value sets into schema constraints and a ' +
      'pre-dispatch gate, so invalid writes cost no request (T2).'
  }
  if (tier === 'T1' && evidence.shapes) {
    tier = 'T2'
    nextUnlocks =
      'An ontology plus a reachable SPARQL endpoint would add subclass reasoning and move analytics ' +
      'to the server, removing the completeness gate on aggregation (T3).'
  }
  if (tier === 'T2' && evidence.ontology && evidence.sparqlReachable) {
    tier = 'T3'
    nextUnlocks = null
  }

  return { tier, evidence, nextUnlocks, caveats }
}

/** One line per tier for the sidebar, with the reached tier marked. */
export function describeLadder(assessment: TierAssessment): ReadonlyArray<{
  tier: Tier
  label: string
  reached: boolean
}> {
  const order: Tier[] = ['T0', 'T1', 'T2', 'T3']
  const reachedIndex = order.indexOf(assessment.tier)

  const labels: Record<Tier, string> = {
    T0: 'Vocabulary — operations, methods, required fields',
    T1: 'JSON-LD context — keys resolved to IRIs',
    T2: 'SHACL shapes — enforced constraints',
    T3: 'Ontology + SPARQL — reasoning and server-side analytics',
  }

  return order.map((tier, index) => ({
    tier,
    label: labels[tier],
    reached: index <= reachedIndex,
  }))
}
