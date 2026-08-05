import type { Quad } from 'n3'

import { HttpError, type HttpClient } from '../http/client'
import type { ContextStore } from '../rdf/document-loader'
import { FINDING_KINDS, type Findings } from '../rdf/findings'
import { quadsFromJsonLd } from '../rdf/ingest'
import type { SessionGraph } from '../rdf/session-graph'
import { GRAPHS, HYDRA, LD_LABELS, RDF } from '../rdf/terms'
import {
  ENVELOPE,
  schemaNameFor,
  type ProjectedTool,
  type ToolSurface,
} from '../project/tools'
import type { QueryRunner } from '../query/engine'
import { renderAffordanceBlock, renderContract, type ValueSetIndex } from '../render/affordances'
import type { CapabilityModel, ClassCapability, StatusOutcome } from '../vocab/capability'
import { assessPageSerialisation } from '../vocab/member-serialisation'
import type { Trace } from '../trace'

import { materialise, readPage, type CollectionDeps, type PageReading } from './collection'
import { deriveFrame, toWire, type FrameDeps } from './frame'
import { checkConstraints, describeViolations, type GateResult } from './gate'
import { locateClass } from './locate'
import { buildPayload, currentValues, typeOf, verifyEchoGraph } from './payload'
import {
  chooseTemplateUrl as chooseTemplateUrlImpl,
  locateCollection as locateCollectionImpl,
  type SelectContext,
} from './select-view'

/**
 * Turning a tool call into a request (design D1, D2).
 *
 * > Above the execution layer there are no URLs.
 *
 * The model holds five constant controls — `follow`, `search_collection`, `get_resource`,
 * `invoke`, and the query tool — and everything the vocabulary declared is reached through them.
 * `invoke` resolves a **handle** a previous result disclosed into the affordance registry's record
 * for it; the registry record carries the contract the dispatch gate enforces and the dispatch
 * facts the request is built from. Nothing above this layer ever sees a URL, and nothing below it
 * ever sees a tool name.
 */

/** RFC 9110 method semantics. Not a verb table: these are properties of HTTP, not of any vocabulary. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])
const REPLACING_METHODS = new Set(['PUT'])

export type ReadPurpose =
  /** Which IRI something refers to, what type it is, what links to what. */
  | 'identity'
  /** A value that will be reported to the user. */
  | 'value'
  /** Set membership. */
  | 'listing'
  /** The current representation, about to be replaced. */
  | 'pre-write'

export interface ReadDecision {
  readonly source: 'store' | 'origin'
  readonly reason: string
  /** Age of what is held, when it is what is being served. */
  readonly ageMs: number | null
}

export interface ToolOutcome {
  readonly ok: boolean
  /** What the model is given back. */
  readonly content: string
  /** The status of the request, or `null` where none was issued. */
  readonly status: number | null
  /** Whether any HTTP request was issued at all. A refusal must be able to prove it issued none. */
  readonly requested: boolean
}

export interface ExecutorOptions {
  readonly http: HttpClient
  readonly graph: SessionGraph
  readonly contexts: ContextStore
  readonly findings: Findings
  readonly trace: Trace
  /** The affordance registry: per-affordance contracts and dispatch facts, keyed by handle. */
  readonly surface: ToolSurface
  readonly model: CapabilityModel
  /** The origin this session connected to. */
  readonly origin: string
  /** The entry point IRI, for locating a collection from a declared link. */
  readonly entrypoint?: string | null
  /** Members one materialisation may retrieve before asking. Design D5: a budget, not a cap. */
  readonly budget?: number
  /**
   * How long a held value may be reported as current.
   *
   * Zero by default, and that is the honest default: a tool call asking for a resource is a request
   * for its current state, and answering it from the store without saying so is how a stale value
   * gets reported as a fact. Identity questions are answered from the store regardless — an IRI does
   * not go stale.
   */
  readonly freshForMs?: number
  /**
   * How long a value carried in full by a complete listing may be served from the store before a value
   * read re-fetches it (design D3, task 2.7).
   *
   * Distinct from `freshForMs`, which stays 0 — a resource asked for *by name* is a request for its
   * current state. A `member-complete` value is different in kind: the listing already carried the
   * whole representation, so re-dereferencing it buys nothing within the same working session, and the
   * value is served with its disclosed age. A modest session-scoped window rather than the whole
   * session lifetime, because a value does still go stale; five minutes by default, revisited if the
   * demo traces show it under- or over-serving.
   */
  readonly memberFreshForMs?: number
  /** How many member identifiers a listing hands back. Always stated alongside how many it did not. */
  readonly disclose?: number
  /**
   * Live value sets for reference-collection classes (design D5). Optional: absent, every link
   * property degrades to a plain IRI reference exactly as before.
   */
  readonly valueSets?: ValueSetIndex
  /**
   * The prefix labels the manifest renders under (`agent/manifest.manifestPrefixes`), injected by
   * the caller so this layer never imports the agent's. The map spells collections compactly —
   * `ns:ContactCollection` — and a model that copies that spelling into an intake is reading
   * carefully, so intake has to expand it; refusing the page's own renderings as inputs is the
   * same defect as refusing an IRI for its angle brackets. Absent, compact names pass through
   * unexpanded and are refused as undeclared, exactly as before.
   */
  readonly prefixes?: ReadonlyMap<string, string>
  /**
   * The shapes graph reads the framing write path derives frames from (design D6). Optional:
   * absent, writes go out as predicate-IRI documents exactly as before.
   */
  readonly shapes?: FrameDeps
  /**
   * Where a `sparql` tool call goes (task 7.1).
   *
   * Optional because the surface may not carry a query tool — and a tool that is on the surface with
   * no runner behind it is a wiring mistake, reported as one rather than dispatched as an HTTP
   * request to a class IRI that does not exist.
   */
  readonly query?: QueryRunner
}

export interface Executor {
  execute(name: string, input: Readonly<Record<string, unknown>>): Promise<ToolOutcome>
  /** Exposed so the policy can be asked what it would decide, without issuing anything. */
  decideRead(purpose: ReadPurpose, iri: string): ReadDecision
}

function ageWords(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000)
  if (seconds < 90) return `${seconds}s old`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m old` : `${Math.round(minutes / 60)}h old`
}

/** A refusal that provably issued nothing. */
function refusal(content: string): ToolOutcome {
  return { ok: false, content, status: null, requested: false }
}

/**
 * A supplied IRI, unwrapped from the punctuation this client's own renderings carry.
 *
 * Results and refusals spell IRIs as `<http://…>` and handles as `` `name` ``; a model that
 * faithfully copies what it was shown then supplies the wrapping too, and refusing that as "not a
 * valid absolute IRI" punishes it for reading carefully. One layer of angle brackets, backticks,
 * quotes and stray terminal punctuation is presentation, not identity.
 */
function suppliedIri(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .replace(/^[<`"'\s]+/, '')
    .replace(/[>`"'\s.,;]+$/, '')
}

/**
 * Expand a compact (prefixed) name under the supplied prefix table.
 *
 * Only a known label expands — `ns:ContactCollection` becomes the full IRI, while `http://…` and
 * `urn:…` fall through untouched because no table carries those labels. Identity, like the
 * unwrapping above: the compact form is how the manifest renders the IRI, not a different name.
 */
function expandPrefixed(value: string, prefixes: ReadonlyMap<string, string> | undefined): string {
  if (!prefixes) return value
  const match = /^([A-Za-z][\w.-]*):(.*)$/.exec(value)
  if (!match) return value
  const namespace = prefixes.get(match[1] as string)
  return namespace === undefined ? value : `${namespace}${match[2]}`
}

export function createExecutor(options: ExecutorOptions): Executor {
  const { http, graph, findings, trace, surface, model } = options

  /**
   * Every refusal reaches the trace as well as the model. A refusal that only the model sees is
   * invisible to whoever is auditing the session — a turn full of refused calls reads as a hang.
   */
  const refuse = (content: string): ToolOutcome => {
    trace.log(`Refused — ${(content.split('\n')[0] ?? '').slice(0, 200)}`, 'error')
    return refusal(content)
  }
  const expand = (value: string) => expandPrefixed(value, options.prefixes)
  const budget = options.budget ?? 10_000
  const freshForMs = options.freshForMs ?? 0
  const memberFreshForMs = options.memberFreshForMs ?? 300_000
  const disclose = options.disclose ?? 25
  const entrypoint = options.entrypoint ?? null

  const collectionDeps: CollectionDeps = {
    http,
    graph,
    contexts: options.contexts,
    findings,
    trace,
    origin: options.origin,
  }

  /** Findings live in the store with everything else, and are exportable from there (design D8). */
  const recordFindings = () => graph.ingestDocument(findings.quads(), GRAPHS.findings)

  /**
   * Handles this conversation has actually surfaced, so an unknown-handle refusal can name what the
   * model has really been offered rather than the whole registry.
   */
  const surfacedHandles = new Set<string>()

  /** The affordance footer for one subject, from the live quads the response put in the store. */
  function affordanceFooter(subject: string, classIri?: string | null): string {
    return renderAffordanceBlock(
      subject,
      {
        graph,
        model,
        surface,
        findings,
        ...(options.valueSets ? { valueSets: options.valueSets } : {}),
        onHandleSurfaced: (handle) => surfacedHandles.add(handle),
      },
      { classIri: classIri ?? null },
    )
  }

  /**
   * Where a read is served from (design D4's read policy).
   *
   * The pre-write rule is the one with no exception. PUT replaces a resource, so a replacement built
   * from a cached representation reverts every field another client has changed since. That is data
   * loss, not staleness, and read-before-write is the only concurrency control available here.
   */
  function decideRead(purpose: ReadPurpose, iri: string): ReadDecision {
    if (purpose === 'pre-write') {
      return {
        source: 'origin',
        reason:
          'a replacement is built from the current representation, and building one from a held copy ' +
          'would revert every field changed elsewhere since',
        ageMs: null,
      }
    }
    if (purpose === 'listing') {
      return { source: 'origin', reason: 'set membership is volatile', ageMs: null }
    }

    const held = graph.provenanceOf(iri)
    if (held === null) return { source: 'origin', reason: 'nothing is held about it', ageMs: null }

    if (purpose === 'identity') {
      return { source: 'store', reason: 'an IRI does not go stale', ageMs: held.ageMs }
    }

    // A value. It is settled by a dereference — or by a listing proven to serialise every field a
    // dereference would (design D3), within its own freshness window. A plain collection listing may
    // have been abbreviated, and absence in it means nothing.
    if (held.kind === 'member-complete') {
      if (held.ageMs > memberFreshForMs) {
        return {
          source: 'origin',
          reason: `a complete listing carried it in full, but that was ${ageWords(held.ageMs)}`,
          ageMs: held.ageMs,
        }
      }
      return {
        source: 'store',
        reason: `carried in full by a complete listing, ${ageWords(held.ageMs)}`,
        ageMs: held.ageMs,
      }
    }
    if (held.kind !== 'dereferenced') {
      return {
        source: 'origin',
        reason: 'what is held came from a collection listing, which does not settle absent values',
        ageMs: held.ageMs,
      }
    }
    if (held.ageMs > freshForMs) {
      return { source: 'origin', reason: `what is held is ${ageWords(held.ageMs)}`, ageMs: held.ageMs }
    }
    return { source: 'store', reason: `held and ${ageWords(held.ageMs)}`, ageMs: held.ageMs }
  }

  /** Every store hit says so, with its source and its age. Design D4 requires it; audits need it. */
  function announceStoreHit(iri: string, decision: ReadDecision): void {
    const held = graph.provenanceOf(iri)
    const source = held?.sources[0] ?? 'the session store'
    trace.log(
      `Served <${iri}> from the store — read from ${source}, ${ageWords(decision.ageMs ?? 0)}. ` +
        `No request issued.`,
      'info',
    )
  }

  /** A term as the model should read it: an IRI stays an IRI, a literal becomes its value. */
  function renderTerm(quads: readonly Quad[], quad: Quad, depth: number): string {
    if (quad.object.termType === 'BlankNode' && depth < 2) {
      const nested = quads
        .filter((held) => held.subject.equals(quad.object))
        .map((held) => `${schemaNameFor(held.predicate.value)}: ${renderTerm(quads, held, depth + 1)}`)
      return nested.length > 0 ? `{ ${nested.join(', ')} }` : '(empty)'
    }
    return quad.object.value
  }

  /**
   * One resource, under the same names the model was offered inputs under.
   *
   * A single description is an answer, not a data dump: what design D5 and the spec forbid is the
   * *volume* of a materialised collection reaching the context, not the resource the caller asked
   * about by name.
   */
  function renderResource(iri: string): string {
    const quads = graph.describe(iri)
    if (quads.length === 0) return `Nothing is held about <${iri}>.`

    const lines = [`@id: ${iri}`]
    for (const quad of quads.filter((held) => held.subject.value === iri)) {
      if (quad.predicate.value === RDF.type) {
        lines.push(`@type: ${quad.object.value}`)
        continue
      }
      // The operation nodes are rendered as the affordance footer, not as data lines.
      if (quad.predicate.value === HYDRA.operation) continue
      lines.push(`${schemaNameFor(quad.predicate.value)}: ${renderTerm(quads, quad, 0)}`)
    }

    // Every result carries the affordances of what it holds, read from the live response graph.
    const footer = affordanceFooter(iri)
    return footer ? `${lines.join('\n')}\n${footer}` : lines.join('\n')
  }

  /** A label for a member, from a standard vocabulary if the server used one. */
  function labelOf(iri: string): string | null {
    for (const predicate of LD_LABELS) {
      const [found] = graph.match(iri, predicate, null, GRAPHS.data)
      if (found) return found.object.value
    }
    return null
  }

  /**
   * Design D8's escalation: state the limit precisely and hand the problem up.
   *
   * The proof of concept omitted the field and logged a warning — the caller asked for something and
   * it silently did not happen. The client still invents no convention; it says what is undeclared,
   * and what routes remain so the task can complete by another one.
   */
  function escalate(record: ProjectedTool, gate: GateResult): ToolOutcome {
    for (const escalation of gate.escalations) {
      findings.record({
        about: escalation.predicate,
        kind: FINDING_KINDS.undeclaredLinkRange,
        message: escalation.message,
      })
    }
    recordFindings()

    const lines = [
      `${record.name} was not invoked, and the field you supplied was not dropped: the vocabulary ` +
        `does not declare enough to resolve it. No request was issued.`,
      '',
    ]
    for (const escalation of gate.escalations) {
      lines.push(`- ${escalation.path}: ${escalation.message}`)
    }
    lines.push(
      '',
      `Routes that remain: pass an @id obtained from a prior ${ENVELOPE.follow}, ` +
        `${ENVELOPE.searchCollection} or ${ENVELOPE.getResource} result, or omit the field and say so.`,
    )

    trace.log(`${record.name} escalated: ${gate.escalations.map((e) => e.path).join(', ')}`, 'warn')
    return refuse(lines.join('\n'))
  }

  /** How a status is reported: by the meaning the vocabulary declared for it, where it declared one. */
  function describeStatus(declared: readonly StatusOutcome[], status: number, body: string): string {
    const outcome = declared.find((candidate) => candidate.code === status)
    if (outcome) {
      return `${status} — ${outcome.description ?? 'declared by the API for this operation, without a description'}`
    }
    return (
      `${status}, which the vocabulary does not declare as an outcome of this operation. The server ` +
      `said: ${body.slice(0, 300)}`
    )
  }

  async function issue(url: string, method: string, document: Record<string, unknown> | null) {
    trace.log(`${method} ${url}`, 'http')
    const response = await http.request(url, {
      method,
      ...(document === null ? {} : { body: JSON.stringify(document), contentType: 'application/ld+json' }),
    })
    return response
  }

  /**
   * The last `@context` any response served (design D6).
   *
   * The served context is a property of the deployment, observed rather than configured: every
   * document this API serves carries the context its keys are spelled in, and a write compacts
   * against the most specific one in hand — the pre-write read's own, falling back to this.
   */
  let lastServedContext: unknown = null

  /** Read a response body as quads. An unreadable body is reported, never half-ingested. */
  async function quadsOf(body: string, url: string): Promise<Quad[]> {
    if (body.trim().length === 0) return []
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object' && '@context' in parsed) {
      lastServedContext = (parsed as Record<string, unknown>)['@context']
    }
    return quadsFromJsonLd(parsed, options.contexts.load, url)
  }

  /**
   * Reuse of complete collection members (design D3).
   *
   * The listing path assesses its first page the same way the SPARQL path does — from the page already
   * in hand, once per collection — and records the verdict on the collection. Where every readable
   * field the member class declares is serialised, the members are promoted to `member-complete`, so a
   * later value read of one is served from the store instead of re-dereferenced. The assessment is the
   * one the completeness gate already trusts in production; reusing it here adds no new trust.
   */
  async function assessListingSerialisation(
    collectionIri: string,
    memberClassIri: string | null,
    document: unknown,
  ): Promise<void> {
    const memberClass = memberClassIri ? model.byIri(memberClassIri) : undefined
    if (!memberClass || document === undefined || document === null) return
    // Once per collection: a re-assessment of the same class within a session cannot change its mind,
    // and the double JSON-LD expansion it costs is not free. `null` means never assessed.
    if (graph.completenessOf(collectionIri)?.aggregationReady != null) return

    const assessment = await assessPageSerialisation(document, memberClass, collectionIri, {
      loader: options.contexts.load,
      findings,
    })
    if (!assessment) return
    graph.recordCompleteness(collectionIri, {
      have: graph.completenessOf(collectionIri)?.have ?? 0,
      at: new Date(),
      aggregationReady: assessment.aggregationReady,
      unserved: assessment.missing,
    })
  }

  /** Promote a listing's members to `member-complete` iff the collection serialises every field. */
  function promoteCompleteMembers(collectionIri: string, members: readonly string[]): void {
    const completeness = graph.completenessOf(collectionIri)
    if (completeness?.aggregationReady === true && completeness.unserved.length === 0) {
      graph.markMembersComplete(members)
      trace.log(
        `${collectionIri}: members carry every declared field, so held representations answer later ` +
          `value reads without re-fetching.`,
        'info',
      )
    }
  }

  /**
   * Navigation: one page, because `follow` is a browser opening a page, not a retrieval.
   *
   * Measured 2026-08-02, twice in one evening: a model that chose to "look at" a 3,476-member
   * collection before acting paid a 140-request walk for an affordance block the map already
   * carried. The walk is retrieval semantics on a navigation verb. Here the page is read, the
   * partiality is stated honestly with the declared total, and the footer teaches both the
   * deliberate-retrieval call (`search_collection`) and the filters — so a curious follow costs
   * one request, and holding the whole set stays an explicit choice. `search_collection` and the
   * query path keep full materialisation: completeness lives where completeness is claimed.
   */
  async function openListing(url: string, cls: string): Promise<ToolOutcome> {
    const decision = decideRead('listing', url)
    trace.log(`Reading ${url} from the origin — ${decision.reason}.`, 'info')

    let page: PageReading
    try {
      page = await readPage(url, collectionDeps)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      trace.log(`<${url}> could not be read: ${message}`, 'error')
      return { ok: false, content: `<${url}> could not be read: ${message}`, status: null, requested: true }
    }

    const collection = page.collection ?? url
    graph.ingest(page.quads, { url, kind: 'collection-member', fetchedAt: new Date() })

    const total = page.totalItems
    const complete = total !== null ? page.members.length >= total && page.next === null : !page.partial
    graph.recordCompleteness(collection, {
      have: page.members.length,
      total,
      at: new Date(),
      partial: page.partial,
    })

    // Assess whether the page carried its members in full, and promote them if so (design D3). A held
    // member of a fully-serialised collection then answers a value read from the store.
    const memberClassIri = model.byIri(cls)?.memberClass ?? null
    await assessListingSerialisation(collection, memberClassIri, page.document)
    promoteCompleteMembers(collection, page.members)

    const shown = page.members.slice(0, disclose)
    const lines = [
      `${collection}: one page held — ${page.members.length} member${page.members.length === 1 ? '' : 's'}` +
        `${total === null ? '' : ` of ${total} declared`}. ` +
        (complete
          ? 'The set is complete.'
          : 'The set is NOT complete — this was navigation, not retrieval.'),
    ]

    if (shown.length > 0) {
      lines.push('', 'Identifiers:')
      for (const member of shown) {
        const label = labelOf(member)
        lines.push(`- ${member}${label === null ? '' : ` (${label})`}`)
      }
    }

    if (!complete) {
      lines.push(
        '',
        `${page.next === null ? 'Continue' : `Next page: <${page.next}>. Continue`} with ` +
          `search_collection on <${cls || collection}> to hold the whole set (its filters narrow ` +
          `it; none retrieves everything), or put a count or aggregate to sparql instead.`,
      )
    }

    const footer = affordanceFooter(collection, cls)
    if (footer) lines.push(footer)

    recordFindings()
    return { ok: true, content: lines.join('\n'), status: 200, requested: true }
  }

  /** A collection traversal, from a URL the server published. */
  async function traverse(url: string, cls: string): Promise<ToolOutcome> {
    const decision = decideRead('listing', url)
    trace.log(`Reading ${url} from the origin — ${decision.reason}.`, 'info')

    const declared = model
      .byIri(cls)
      ?.templates.find((template) => template.kind === 'pagination')?.template

    const memberClassIri = model.byIri(cls)?.memberClass ?? null

    const result = await materialise(url, collectionDeps, {
      budget,
      declaredPagination: declared ?? null,
      // Assess the first page for member serialisation, from the page already in hand (design D3).
      assessFirstPage: (document, collectionIri) =>
        assessListingSerialisation(collectionIri, memberClassIri, document),
    })

    // A fully-serialised collection's members answer later value reads from the store.
    promoteCompleteMembers(result.collection, result.members)

    const shown = result.members.slice(0, disclose)
    const lines = [
      `${result.collection}: ${result.members.length} member` +
        `${result.members.length === 1 ? '' : 's'} held` +
        `${result.totalItems === null ? '' : ` of ${result.totalItems} declared`}, ` +
        `across ${result.pages} page${result.pages === 1 ? '' : 's'}. ` +
        `${result.complete ? 'The set is complete.' : 'The set is NOT complete.'}`,
    ]

    if (result.refusal) lines.push('', result.refusal)

    if (shown.length > 0) {
      lines.push('', 'Identifiers:')
      for (const member of shown) {
        const label = labelOf(member)
        lines.push(`- ${member}${label === null ? '' : ` (${label})`}`)
      }
      if (result.members.length > shown.length) {
        lines.push(
          `…and ${result.members.length - shown.length} more, not listed here. Every one of them is ` +
            `in the session store; the members are held, not summarised away.`,
        )
      }
    }

    // A listing teaches the filter that would have avoided it: the affordance footer names the
    // declared variables and the search_collection call that applies them.
    const footer = affordanceFooter(result.collection, cls)
    if (footer) lines.push(footer)

    recordFindings()
    return {
      ok: result.refusal === null,
      content: lines.join('\n'),
      status: 200,
      requested: true,
      // A refusal here did issue a request: one page is what it costs to learn the cost of the rest.
    }
  }

  /** A read of one resource, subject to the read policy (design D4). */
  async function readResource(
    iri: string,
    opts: { declared?: readonly StatusOutcome[] } = {},
  ): Promise<ToolOutcome> {
    const declared = opts.declared ?? []
    const decision = decideRead('value', iri)
    if (decision.source === 'store') {
      announceStoreHit(iri, decision)
      return {
        ok: true,
        content: `${renderResource(iri)}\n\n(held locally, ${ageWords(decision.ageMs ?? 0)})`,
        status: null,
        requested: false,
      }
    }
    trace.log(`Reading <${iri}> from the origin — ${decision.reason}.`, 'info')

    const response = await issue(iri, 'GET', null)
    if (!response.ok) {
      return {
        ok: false,
        content: describeStatus(declared, response.status, response.body),
        status: response.status,
        requested: true,
      }
    }

    const quads = await quadsOf(response.body, response.url)
    graph.replaceSubject(iri, quads, { url: response.url, kind: 'dereferenced', fetchedAt: new Date() })
    return { ok: true, content: renderResource(iri), status: response.status, requested: true }
  }

  /** A write, with the replacement merge and the echo check that go with it. */
  async function write(
    record: ProjectedTool,
    url: string,
    subject: string | null,
    input: Readonly<Record<string, unknown>>,
  ): Promise<ToolOutcome> {
    const method = record.dispatch.method
    const declared = record.dispatch.possibleStatus
    const replaces = REPLACING_METHODS.has(method)

    let base: Map<string, unknown> | undefined
    let type: string | null = record.dispatch.expects
    let servedContext: unknown = lastServedContext

    if (replaces && subject !== null) {
      // Absolute: this read reaches the origin. See `decideRead`.
      const decision = decideRead('pre-write', subject)
      trace.log(`GET ${subject} before replacing it — ${decision.reason}.`, 'http')
      const current = await http.request(subject, { method: 'GET' })
      if (!current.ok) {
        return {
          ok: false,
          content:
            `${record.name} was not sent. Reading the current representation of <${subject}> first is ` +
            `required before a replacement, and it answered ` +
            `${describeStatus(declared, current.status, current.body)}`,
          status: current.status,
          requested: true,
        }
      }

      const quads = await quadsOf(current.body, current.url)
      graph.replaceSubject(subject, quads, {
        url: current.url,
        kind: 'dereferenced',
        fetchedAt: new Date(),
      })
      // The pre-write read is the most specific statement of how this resource's keys are spelled.
      servedContext = lastServedContext ?? servedContext

      const expected = model.byIri(record.dispatch.expects ?? '')
      const writeable = (expected ?? model.byIri(record.dispatch.classIri))?.properties
        .filter((property) => property.writeable)
        .map((property) => property.iri)
      base = currentValues(quads, subject, writeable ?? [])
      type = typeOf(quads, subject) ?? type

      trace.log(
        `Replacement assembled from ${base.size} current value${base.size === 1 ? '' : 's'} plus the ` +
          `change requested — a PUT clears every writeable property it does not carry.`,
        'info',
      )
    }

    const { document, requested } = buildPayload(record, input, { subject, type, base })

    /*
     * The framing write path (design D6): the predicate-IRI document compacts against the served
     * context, with tree shape from the frame the target class's shape dictates — so the wire keys
     * are whatever the server itself spells them, by construction. Absent a served context or on a
     * framing failure the predicate-IRI document goes as it is: valid JSON-LD needing no context,
     * which is what this client always sent. The write is never blocked by its own formatting.
     */
    let wire = document
    if (servedContext !== null && servedContext !== undefined) {
      try {
        const frame = options.shapes && type ? deriveFrame(type, options.shapes) : null
        wire = await toWire(document, { context: servedContext, frame, loader: options.contexts.load })
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        trace.log(
          `Compacting the payload against the served context failed (${reason}); sending the ` +
            `predicate-IRI document instead.`,
          'warn',
        )
      }
    }

    const response = await issue(url, method, wire)

    if (!response.ok) {
      return {
        ok: false,
        content: describeStatus(declared, response.status, response.body),
        status: response.status,
        requested: true,
      }
    }

    const echoed = await quadsOf(response.body, response.url)
    // The written resource identifies itself in the response; on a creation that is the only place
    // its IRI has ever existed.
    const written =
      subject ??
      echoed.find((quad) => quad.predicate.value === RDF.type)?.subject.value ??
      echoed[0]?.subject.value ??
      null

    if (written !== null && echoed.length > 0) {
      graph.replaceSubject(written, echoed, {
        url: response.url,
        kind: 'dereferenced',
        fetchedAt: new Date(),
      })
    }

    if (echoed.length === 0) {
      return {
        ok: true,
        content:
          `${describeStatus(declared, response.status, response.body)}. The response carried no ` +
          `representation, so what was written could not be confirmed against what was asked for.`,
        status: response.status,
        requested: true,
      }
    }

    /*
     * Echo verification at graph level (design D6): write-graph ⊆ echo-graph. Both sides become
     * quads first, so a value the server echoes under a differently spelled key — or in a
     * different but equal lexical form — passes, and a dropped field still fails.
     */
    let writeQuads: readonly Quad[]
    try {
      writeQuads = await quadsFromJsonLd(wire, options.contexts.load, response.url)
    } catch {
      // A wire body its own context cannot expand would already have failed the server; the
      // predicate-IRI document is always expandable, so fall back to comparing that.
      writeQuads = await quadsFromJsonLd(document, options.contexts.load, response.url)
    }
    const mismatches = verifyEchoGraph(writeQuads, echoed, subject, requested)
    if (mismatches.length > 0) {
      /*
       * The server accepted the request and did not persist what was asked for.
       *
       * Worth catching precisely because everything else says it worked: the status is a success and
       * a model left to narrate from it reports a change that did not happen. This API's serialiser
       * has dropped fields on write before.
       */
      const lines = [
        `${describeStatus(declared, response.status, response.body)} — but the representation ` +
          `returned does not carry what was requested:`,
      ]
      for (const mismatch of mismatches) {
        lines.push(
          `- <${mismatch.predicate}>: sent "${mismatch.requested}", the response holds ` +
            `${mismatch.returned === null ? 'nothing' : `"${mismatch.returned}"`}`,
        )
      }
      lines.push('', 'Report this as a server-side failure to persist, not as a completed change.')
      trace.log(`Write verification failed for <${written}>`, 'error')
      return { ok: false, content: lines.join('\n'), status: response.status, requested: true }
    }

    trace.log(`Verified: the response confirms every requested field on <${written}>`, 'success')
    return {
      ok: true,
      content: `${describeStatus(declared, response.status, response.body)}\n\n${renderResource(written ?? '')}`,
      status: response.status,
      requested: true,
    }
  }

  async function remove(record: ProjectedTool, subject: string): Promise<ToolOutcome> {
    const declared = record.dispatch.possibleStatus
    const response = await issue(subject, record.dispatch.method, null)
    if (!response.ok) {
      return {
        ok: false,
        content: describeStatus(declared, response.status, response.body),
        status: response.status,
        requested: true,
      }
    }
    // What is held about a deleted resource is no longer a description of anything.
    graph.replaceSubject(subject, [], { url: response.url, kind: 'dereferenced', fetchedAt: new Date() })
    return {
      ok: true,
      content: `${describeStatus(declared, response.status, response.body)}. <${subject}> was removed, and what was held about it has been discarded.`,
      status: response.status,
      requested: true,
    }
  }

  /** The registry's folded-template record for a collection class, if it declares templates. */
  function templateRecordFor(classIri: string): ProjectedTool | null {
    return (
      surface.tools.find(
        (tool) => tool.dispatch.kind === 'template' && tool.dispatch.classIri === classIri,
      ) ?? null
    )
  }

  /**
   * The collection a reference names: its class IRI, its member class IRI, or its published URL.
   *
   * Never lexical — a reference resolves by identity (the model's IRIs) or by the URL the server
   * itself published for the collection.
   */
  function resolveCollection(reference: string): ClassCapability | null {
    const direct = model.byIri(reference)
    if (direct?.isCollection) return direct
    if (direct) return model.collectionFor(direct.iri) ?? null

    for (const candidate of model.collections) {
      const located = locateClass(candidate, { graph, entrypoint })
      if (located.url !== null && located.url.replace(/\/+$/, '') === reference.replace(/\/+$/, '')) {
        return candidate
      }
    }
    return null
  }

  /*
   * Filtered-view selection lives in `select-view`, so the SPARQL local path selects a view the same
   * way this path does (design D1). These wrappers bind the session context; the machinery is shared.
   */
  const selectCtx: SelectContext = {
    graph,
    entrypoint,
    origin: options.origin,
    findings,
    trace,
  }
  const locateCollection = (cls: ClassCapability) => locateCollectionImpl(cls, selectCtx)
  const chooseTemplateUrl = (
    record: ProjectedTool,
    cls: ClassCapability,
    filters: Readonly<Record<string, unknown>>,
  ) => chooseTemplateUrlImpl(record, cls, filters, selectCtx)

  /** The named collections, for a refusal that should teach rather than merely deny. */
  function knownCollections(): string {
    const entries = model.collections.map(
      (cls) => `<${cls.iri}>${cls.title ? ` (${cls.title})` : ''}`,
    )
    return entries.length > 0 ? entries.join(', ') : '(this API declares no collections)'
  }

  // ── The envelope handlers ─────────────────────────────────────────────────────────────────────

  /**
   * Same-origin discipline for model-supplied IRIs.
   *
   * Every IRI a result hands the model is on this session's origin (rebase-and-disclose put it
   * there), so a dereference request for a *different* origin that nothing in the session has ever
   * referred to is an IRI the model composed — and a browser does not spend an authenticated
   * request on an address no page linked to. Foreign IRIs the session legitimately holds (a
   * canonical identifier a response carried) stay reachable.
   */
  function foreignAndUnreferenced(iri: string): string | null {
    let origin: string
    let target: string
    try {
      origin = new URL(options.origin).origin
      target = new URL(iri).origin
    } catch {
      return `<${iri}> is not a valid absolute IRI.`
    }
    if (target === origin || graph.provenanceOf(iri) !== null) return null
    // Mentioned anywhere the session has read — the vocabulary, a response, a finding — is
    // referred to; only an IRI from nowhere is refused.
    if (graph.match(iri, null, null).length > 0 || graph.match(null, null, iri).length > 0) return null
    // A concrete correction the caller can copy: the supplied path on the session's origin. A
    // mistyped host differs from a real address by exactly this substitution, and a refusal that
    // only names the rule leaves a flailing caller regenerating the same typo.
    const path = new URL(iri).pathname + new URL(iri).search
    const suggestion = path.length > 1 ? ` Did you mean <${origin}${path}>?` : ''
    return (
      `<${iri}> is on ${target}, not this session's origin (${origin}), and no result in this ` +
      `session has referred to it — so there is nothing declaring it exists. No request was ` +
      `issued.${suggestion} Use an IRI a result or the collection index actually carried.`
    )
  }

  async function follow(iri: string): Promise<ToolOutcome> {
    if (iri.length === 0) return refuse(`${ENVELOPE.follow} needs an IRI.`)

    // A reference that names a declared collection is a listing, not a resource read — and the
    // declaration is what makes it followable wherever its canonical IRI is minted.
    const cls = resolveCollection(iri)
    if (!cls) {
      const foreign = foreignAndUnreferenced(iri)
      if (foreign) return refuse(foreign)
    }
    if (cls) {
      const located = /^https?:/i.test(iri) && !model.byIri(iri) ? { url: iri } : locateCollection(cls)
      if ('reason' in located) return refuse(located.reason)
      return openListing(located.url, cls.iri)
    }

    const outcome = await readResource(iri)
    if (!outcome.ok || !outcome.requested) return outcome

    // The response may reveal the IRI to be a collection the vocabulary never named — a curated
    // view, say. Members present means a listing is the honest rendering.
    if (graph.match(iri, HYDRA.member, null, GRAPHS.data).length > 0) {
      const type = graph
        .match(iri, RDF.type, null, GRAPHS.data)
        .map((quad) => quad.object.value)
        .find((candidate) => model.byIri(candidate) !== undefined)
      return openListing(iri, type ?? '')
    }
    return outcome
  }

  async function getResource(iri: string): Promise<ToolOutcome> {
    if (iri.length === 0) return refuse(`${ENVELOPE.getResource} needs an IRI.`)
    const foreign = foreignAndUnreferenced(iri)
    if (foreign) return refuse(foreign)
    // Through the read policy, not forcing the origin: a member a complete listing carried in full is
    // served from the store (design D3), while every other subject still reaches the origin for a
    // value read exactly as before.
    return readResource(iri)
  }

  async function searchCollection(input: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
    const reference = expand(suppliedIri(input['collection']))
    if (reference.length === 0) {
      return refuse(
        `${ENVELOPE.searchCollection} needs a collection IRI. Declared collections: ${knownCollections()}.`,
      )
    }

    let filters = input['filters'] ?? {}
    if (typeof filters === 'string') {
      // A model that serialised the object is answered, not corrected.
      try {
        filters = JSON.parse(filters)
      } catch {
        return refuse(`"filters" must be an object of filter variable → value.`)
      }
    }
    if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
      return refuse(`"filters" must be an object of filter variable → value.`)
    }
    const filterRecord = filters as Record<string, unknown>

    const cls = resolveCollection(reference)
    if (!cls) {
      return refuse(
        `<${reference}> is not a collection this API declares. Declared collections: ${knownCollections()}. ` +
          `No request was issued.`,
      )
    }

    const record = templateRecordFor(cls.iri)
    const names = Object.keys(filterRecord).filter(
      (name) => filterRecord[name] !== undefined && filterRecord[name] !== null && filterRecord[name] !== '',
    )

    if (!record || record.dispatch.templates.length === 0) {
      if (names.length > 0) {
        return refuse(
          `<${cls.iri}> declares no filter variables, so ${names.join(', ')} cannot be carried into ` +
            `a request. Its plain listing is available with no filters. No request was issued.`,
        )
      }
      const located = locateCollection(cls)
      if ('reason' in located) {
        recordFindings()
        return refuse(located.reason)
      }
      return traverse(located.url, cls.iri)
    }

    // A wrong filter name is refused before the wire, naming the declared ones.
    const declared = [...new Set(record.dispatch.templates.flatMap((form) => form.variables))].sort()
    const unknown = names.filter((name) => !declared.includes(name))
    if (unknown.length > 0) {
      return refuse(
        `<${cls.iri}> declares no filter named ${unknown.join(', ')}. Declared filters: ` +
          `${declared.join(', ')}. No request was issued.`,
      )
    }

    // Types, enums and published constraints, checked by the gate against the retained contract.
    const gate = checkConstraints(record, filterRecord, {
      graph,
      ...(options.valueSets ? { valueSets: options.valueSets } : {}),
    })
    for (const unverified of gate.unverified) {
      trace.log(`Not checked before dispatch — ${unverified.path}: ${unverified.reason}`, 'warn')
    }
    if (!gate.passed) {
      trace.log(`${ENVELOPE.searchCollection} refused by the constraint gate — no request issued`, 'error')
      return refuse(describeViolations(record, gate))
    }

    const target = chooseTemplateUrl(record, cls, filterRecord)
    if ('reason' in target) {
      recordFindings()
      trace.log(`${ENVELOPE.searchCollection} could not be dispatched — no request issued`, 'error')
      return refuse(target.reason)
    }
    return traverse(target.url, cls.iri)
  }

  async function invokeAffordance(input: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
    const handle = suppliedIri(input['affordance'])
    const record = handle.length > 0 ? surface.byName(handle) : undefined

    if (!record || record.dispatch.kind === 'query') {
      /*
       * The refusal helps the specific ask, not just the rule: where the input identifies a
       * resource the session holds, the handles declared for that resource's own type are exactly
       * what a mistyped or guessed handle was reaching for.
       */
      const payloadForHint = input['input']
      const idForHint =
        payloadForHint !== null && typeof payloadForHint === 'object'
          ? suppliedIri((payloadForHint as Record<string, unknown>)['id'])
          : ''
      const typedHandles =
        idForHint.length > 0
          ? graph
              .match(idForHint, RDF.type, null)
              .flatMap((quad) =>
                surface.tools.filter(
                  (tool) =>
                    tool.dispatch.kind === 'operation' && tool.dispatch.classIri === quad.object.value,
                ),
              )
              .map((tool) => tool.name)
          : []
      /*
       * A guessed handle usually embeds the class it was aimed at — "ns:ContactCollection.create"
       * names ContactCollection even though no such handle exists. The registry is complete at
       * connect (GET is for state, never capability), so match its classes by local name and
       * answer with the handles actually declared on them: one wrong guess then costs one turn,
       * not a discovery walk. Longest match wins — "ContactCollection" beats "Contact", or the
       * hint drowns in every handle of the member class too.
       */
      const guess = handle.toLowerCase()
      const matchedClasses = new Map<string, string>()
      for (const tool of surface.tools) {
        if (tool.dispatch.kind !== 'operation') continue
        const local = (tool.dispatch.classIri.split(/[#/]/).pop() ?? '').toLowerCase()
        if (local.length >= 4 && guess.includes(local)) matchedClasses.set(tool.dispatch.classIri, local)
      }
      const longest = [...matchedClasses.entries()].filter(
        ([, local]) =>
          ![...matchedClasses.values()].some((other) => other !== local && other.includes(local)),
      )
      const nearMisses = longest
        .map(([classIri]) => {
          const handles = surface.tools
            .filter(
              (tool) => tool.dispatch.kind === 'operation' && tool.dispatch.classIri === classIri,
            )
            .map((tool) => tool.name)
            .sort()
          return `<${classIri}> declares: ${handles.join(', ')}`
        })
        .sort()

      const surfaced = [...new Set([...typedHandles, ...surfacedHandles])].sort()
      return refuse(
        `No affordance carries the handle "${handle}". No request was issued. ` +
          (typedHandles.length > 0
            ? `For <${idForHint}>, the declared handles are: ${[...new Set(typedHandles)].sort().join(', ')}.`
            : nearMisses.length > 0
              ? `Nearest by name — ${nearMisses.join('; ')}.`
              : surfaced.length > 0
                ? `Handles surfaced so far: ${surfaced.join(', ')}.`
                : `No affordances have been surfaced yet — the collection index lists each ` +
                  `collection's handles, and every result's footer lists the handles of what it holds.`),
      )
    }

    let payload = input['input'] ?? {}
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload)
      } catch {
        return refuse(`"input" must be an object carrying the affordance's fields.`)
      }
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return refuse(`"input" must be an object carrying the affordance's fields.`)
    }
    const fields = payload as Record<string, unknown>

    // The handle is disclosed alongside what it resolves to, so the trace is auditable.
    trace.log(
      `invoke ${handle} → ${record.dispatch.method} declared on <${record.dispatch.classIri}>`,
      'info',
    )

    // Unconditional, and before anything is sent. There is no `validate` tool: a check the caller
    // chooses to run fails exactly when the caller is overconfident.
    const gate = checkConstraints(record, fields, {
      graph,
      ...(options.valueSets ? { valueSets: options.valueSets } : {}),
    })
    for (const unverified of gate.unverified) {
      trace.log(`Not checked before dispatch — ${unverified.path}: ${unverified.reason}`, 'warn')
    }
    if (!gate.passed) {
      trace.log(`${handle} refused by the constraint gate — no request issued`, 'error')
      // The refusal carries the whole contract, not just the tripped rule: an incomplete invoke
      // is the cheapest way to learn a contract, and it must never take a listing to recover from.
      return refuse(
        `${describeViolations(record, gate)}\n\n${renderContract(record, options.valueSets)}`,
      )
    }
    if (gate.escalations.length > 0) return escalate(record, gate)

    // A template record invoked by handle is a search; answered rather than corrected.
    if (record.dispatch.kind === 'template') {
      const cls = model.byIri(record.dispatch.classIri)
      if (!cls) return refuse(`<${record.dispatch.classIri}> is not described by the vocabulary.`)
      const target = chooseTemplateUrl(record, cls, fields)
      if ('reason' in target) {
        recordFindings()
        return refuse(target.reason)
      }
      return traverse(target.url, cls.iri)
    }

    // The address the operation acts on: the caller-identified subject, or the declared class IRI.
    let url: string
    if (record.dispatch.needsSubject) {
      const subject = suppliedIri(fields['id'])
      if (subject.length === 0) {
        return refuse(`${handle} acts on a resource and no id was supplied.`)
      }
      // The same discipline follow applies: a subject the model composed on a foreign origin that
      // nothing ever referred to is not spent an authenticated write.
      const foreign = foreignAndUnreferenced(subject)
      if (foreign) return refuse(foreign)
      url = subject
    } else {
      const cls = model.byIri(record.dispatch.classIri)
      if (!cls) return refuse(`<${record.dispatch.classIri}> is not described by the vocabulary.`)
      const located = locateCollection(cls)
      if ('reason' in located) {
        recordFindings()
        return refuse(located.reason)
      }
      url = located.url
    }

    const method = record.dispatch.method.toUpperCase()
    if (SAFE_METHODS.has(method)) {
      const cls = model.byIri(record.dispatch.classIri)
      return cls?.isCollection
        ? traverse(url, record.dispatch.classIri)
        : readResource(url, { declared: record.dispatch.possibleStatus })
    }
    if (method === 'DELETE') return remove(record, url)
    return write(record, url, record.dispatch.needsSubject ? url : null, fields)
  }

  async function runQuery(record: ProjectedTool, input: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
    if (!options.query) {
      return refuse(
        `${record.name} is on the tool surface but no query runner is configured for this session.`,
      )
    }
    const text = input['query']
    if (typeof text !== 'string' || text.trim().length === 0) {
      return refuse(`${record.name} was called with no query.`)
    }

    try {
      const outcome = await options.query.run(text)
      return { ok: outcome.ok, content: outcome.content, status: null, requested: outcome.requested }
    } finally {
      recordFindings()
    }
  }

  const queryRecord = surface.tools.find((tool) => tool.dispatch.kind === 'query') ?? null

  return {
    decideRead,

    async execute(name, input) {
      /*
       * A tool call always resolves to an outcome; it never throws.
       *
       * An exception escaping here corrupts the conversation permanently: the model's `tool_use`
       * block is already in the history, and a turn that ends without answering it is rejected by
       * the API — on this request and on every request after it. A failed HTTP request is a
       * result, not an exception; so is a defect in this client.
       */
      try {
        switch (name) {
          case ENVELOPE.follow:
            return await follow(expand(suppliedIri(input['iri'])))
          case ENVELOPE.getResource:
            return await getResource(expand(suppliedIri(input['iri'])))
          case ENVELOPE.searchCollection:
            return await searchCollection(input)
          case ENVELOPE.invoke:
            return await invokeAffordance(input)
          default: {
            if (queryRecord && name === queryRecord.name) return await runQuery(queryRecord, input)
            const names = [
              ENVELOPE.follow,
              ENVELOPE.searchCollection,
              ENVELOPE.getResource,
              ENVELOPE.invoke,
              ...(queryRecord ? [queryRecord.name] : []),
            ]
            return refuse(
              `There is no tool called ${name} on this surface. The tools are ${names.join(', ')}.`,
            )
          }
        }
      } catch (cause) {
        if (cause instanceof HttpError) {
          trace.log(cause.message, 'error')
          return {
            ok: false,
            content:
              `${cause.message}. The server said: ${cause.body.slice(0, 300)}\n\n` +
              `The request was issued and failed server-side. If this route keeps failing, the ` +
              `deployment may not serve it (a search backend that is down, say) — try a different ` +
              `published route to the same answer, or report what is unavailable.`,
            status: cause.status,
            requested: true,
          }
        }
        const reason = cause instanceof Error ? cause.message : String(cause)
        trace.log(`${name} failed inside the client: ${reason}`, 'error')
        return {
          ok: false,
          content:
            `${name} failed inside the client (${reason}). This is a defect in the client, not in ` +
            `your call or in the API; try a different route to the answer.`,
          status: null,
          requested: false,
        }
      } finally {
        recordFindings()
      }
    },
  }
}
