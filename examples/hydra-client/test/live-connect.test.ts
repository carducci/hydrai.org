import { beforeAll, describe, expect, it } from 'vitest'

import { createHttpClient } from '../src/http/client'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings, FINDING_KINDS, type Findings } from '../src/rdf/findings'
import { createSessionGraph, type SessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { createQueryRunner } from '../src/query/engine'
import { createTrace, type Trace } from '../src/trace'
import {
  buildCapabilityModel,
  constraintsFor,
  primaryNamespace,
  type CapabilityModel,
} from '../src/vocab/capability'
import { discoverApi, type DiscoveredApi } from '../src/vocab/discover'
import { assessTier, probeOntology } from '../src/vocab/tiers'

/**
 * Discovery against a running deployment.
 *
 * Everything else in the suite runs against captured documents, which proves the code handles what the
 * server said *once*. This proves it handles a live connect: real Link headers, real redirects, real
 * content types, a real SPARQL probe.
 *
 * Skipped unless `HYDRA_LIVE` is set, because it needs a booted app — it must never be what fails in CI.
 * The bearer token comes from `HYDRA_LIVE_TOKEN` and is deliberately not in this file.
 *
 *   HYDRA_LIVE=1 HYDRA_LIVE_TOKEN=<pat> npm test
 */

const live = process.env['HYDRA_LIVE'] === '1'
const entrypoint = process.env['HYDRA_LIVE_ENTRYPOINT'] ?? 'http://localhost:1648/Api/'
const token = process.env['HYDRA_LIVE_TOKEN'] ?? null

describe.skipIf(!live)('connecting to a live API', () => {
  let discovered: DiscoveredApi
  let graph: SessionGraph
  let findings: Findings
  let trace: Trace
  let model: CapabilityModel
  let ontology: { available: boolean; url: string | null }

  beforeAll(async () => {
    graph = createSessionGraph()
    findings = createFindings()
    trace = createTrace()
    trace.start()

    const http = createHttpClient({ token })
    const contexts = createContextStore()

    discovered = await discoverApi(entrypoint, { http, graph, contexts, findings, trace })

    model = buildCapabilityModel(graph)

    ontology = await probeOntology(primaryNamespace(model), {
      http,
      findings,
      connectOrigin: entrypoint,
    })
  }, 120_000)

  describe('the vocabulary is discovered, not constructed (task 3.1, finding F2)', () => {
    it('finds it at all', () => {
      expect(discovered.vocabularyUrl).toBeTruthy()
      expect(graph.match(null, null, null, GRAPHS.vocab).length).toBeGreaterThan(100)
    })

    it('reaches the deployment it connected to, not whatever origin the header named', () => {
      // The header advertises a canonical production IRI from every deployment. Following it verbatim
      // from a local connect would issue authenticated requests to production.
      expect(new URL(discovered.vocabularyUrl).origin).toBe(new URL(entrypoint).origin)
    })

    it('records the origin mismatch rather than silently correcting it', () => {
      if (!discovered.rebased) return
      const recorded = findings.all().filter((f) => f.kind === FINDING_KINDS.originMismatch)
      expect(recorded.length).toBeGreaterThan(0)
      // Assert the two things that make this a finding rather than a repair: it says what it did
      // instead, and it names the fix. An earlier version matched one incidental phrase, which the
      // message no longer contained — and because this suite is gated on a booted app, nothing
      // caught the drift. Match on substance, not on a sentence someone may reword again.
      expect(recorded[0]?.message).toMatch(/resolved against the connect origin/i)
      expect(recorded[0]?.message).toMatch(/request host/i)
    })

    it('discloses the discovery in the trace', () => {
      const messages = trace.entries.map((e) => e.message).join('\n')
      expect(messages).toMatch(/Link header/)
    })
  })

  describe('probing what else is published (task 3.2)', () => {
    it('loads the shapes graph into its own named graph', () => {
      expect(discovered.shapesUrl).toBeTruthy()
      expect(graph.match(null, null, null, GRAPHS.shapes).length).toBeGreaterThan(0)
    })

    it('keeps connect-time documents out of the data graph', () => {
      expect(graph.subjects()).toEqual([])
    })

    it('probes the SPARQL endpoint rather than trusting the advertisement', () => {
      if (discovered.sparqlEndpoint === null) return
      // Either answer is correct; what matters is that it was asked. This deployment has been in both
      // states within one session with the advertisement unchanged.
      expect(typeof discovered.sparqlReachable).toBe('boolean')
    })

    it('resolves every referenced context, or names the ones it could not', () => {
      expect(discovered.contextsUnreachable).toEqual([])
    })

    it('degrades rather than dying when a served context is not valid JSON-LD', () => {
      // Retrieved and wrong is a different failure from unreachable, and it must not take the working
      // T0 surface down with it. If this API's context is invalid the connect still completes, the
      // vocabulary is still loaded, and the defect is named.
      if (discovered.contextUsable) return

      const recorded = findings.all().filter((f) => f.kind === FINDING_KINDS.invalidContext)
      expect(recorded.length).toBeGreaterThan(0)
      expect(recorded[0]?.message).toMatch(/not valid JSON-LD|could not be expanded/)
      // The vocabulary is unaffected — it uses the W3C Hydra context, which is valid.
      expect(graph.match(null, null, null, GRAPHS.vocab).length).toBeGreaterThan(100)
    })
  })

  describe('the capability model from a live vocabulary (task 3.3)', () => {
    it('finds classes and collections', () => {
      expect(model.classes.length).toBeGreaterThan(20)
      expect(model.collections.length).toBeGreaterThan(5)
    })

    it('associates every collection it found with a member class', () => {
      const withoutMember = model.collections.filter((c) => c.memberClass === null)
      expect(withoutMember.map((c) => c.iri)).toEqual([])
    })

    it('reads write operations for the writable collections', () => {
      const posts = model.collections.flatMap((c) => c.operations).filter((o) => o.method === 'POST')
      expect(posts.length).toBeGreaterThan(0)
    })
  })

  describe('tier assessment (task 3.6)', () => {
    it('reports a tier with evidence for each rung', () => {
      const assessment = assessTier(graph, discovered, {
        ontology: ontology.available,
        // Reachable is not the same as usable. An invalid context buys no tier.
        contextResolved: discovered.contextsUnreachable.length === 0 && discovered.contextUsable,
      })

      expect(['T0', 'T1', 'T2', 'T3']).toContain(assessment.tier)
      expect(assessment.evidence.vocabulary).toBe(true)

      // Whatever tier this is, the client must be able to say what the next rung would buy — unless it
      // is already at the top.
      if (assessment.tier !== 'T3') expect(assessment.nextUnlocks).toBeTruthy()
      else expect(assessment.nextUnlocks).toBeNull()
    })
  })
})

/**
 * The sync gate against the real deployment and a real SPARQL endpoint (baseline §1.0a).
 *
 * Gated separately on `HYDRA_LIVE_SPARQL`, because the endpoint URL is a property of the operator's
 * machine and hardcoding one here would make this suite fail on any deployment that puts Fuseki
 * somewhere else — or, worse, quietly pass by checking nothing.
 *
 *   HYDRA_LIVE=1 HYDRA_LIVE_TOKEN=<pat> HYDRA_LIVE_SPARQL=http://localhost:3030/mago/sparql npm test
 *
 * This is where the defect was found, so this is where the fix has to be observed. It asserts nothing
 * about *which* way the comparison comes out: an endpoint in step with the API and one that is stale
 * are both valid states of someone's machine. What it asserts is that the client reached a verdict by
 * comparing two real figures rather than by assuming one.
 */
const liveSparql = process.env['HYDRA_LIVE_SPARQL'] ?? null

describe.skipIf(!live || !liveSparql)('the sync gate against a live endpoint', () => {
  it('compares what the endpoint holds against what the API declares', async () => {
    const graph = createSessionGraph()
    const findings = createFindings()
    const trace = createTrace()
    trace.start()

    const http = createHttpClient({ token })
    const contexts = createContextStore()
    // Called for the graph it populates, not for what it returns — the endpoint is supplied below.
    await discoverApi(entrypoint, { http, graph, contexts, findings, trace })
    const model = buildCapabilityModel(graph)

    const runner = createQueryRunner({
      graph,
      model,
      http,
      contexts,
      findings,
      trace,
      constraintsFor: (iri) => constraintsFor(graph, iri),
      origin: entrypoint,
      entrypoint,
      // Explicit rather than discovered: the endpoint may be configured off while a parity baseline
      // is being captured, and this test is about the gate rather than about discovery.
      sparqlEndpoint: liveSparql,
    })

    const namespace = primaryNamespace(model)
    expect(namespace).toBeTruthy()
    const contactClass = model.classes.find((entry) => /Contact$/.test(entry.iri) && !entry.isCollection)
    expect(contactClass, 'the vocabulary should declare a Contact class').toBeTruthy()

    const outcome = await runner.run(
      `SELECT (COUNT(*) AS ?n) WHERE { ?c a <${contactClass?.iri ?? ''}> }`,
    )

    const messages = trace.entries.map((entry) => entry.message).join('\n')

    // Either verdict is a real state of someone's deployment. What must be true is that the client
    // said which, having read both figures — the failure being fixed is answering with neither.
    expect(messages).toMatch(/Endpoint sync:/)

    expect(outcome.ok).toBe(true)
    if (outcome.ranOn === 'remote') {
      expect(messages).toMatch(/In step\./)
    } else {
      // A diverged endpoint no longer dead-ends: the same query answers locally over collections
      // materialised from the API, and the result says which dataset answered and why
      // (deterministic-agent-surface).
      expect(outcome.ranOn).toBe('local')
      expect(outcome.content).toMatch(/Computed locally/)
      expect(outcome.content).toMatch(/the API declares \d+, the endpoint holds \d+/)
    }
  }, 300_000)
})
