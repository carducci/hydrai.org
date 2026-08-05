import type { Quad } from 'n3'

import type { HttpClient } from '../http/client'
import type { ContextStore } from '../rdf/document-loader'
import { FINDING_KINDS, type Findings } from '../rdf/findings'
import { quadsFromJsonLd, quadsFromTurtle, serialisationOf } from '../rdf/ingest'
import type { MaterialisationPlan, SessionGraph } from '../rdf/session-graph'
import { HYDRA, RDF } from '../rdf/terms'
import type { Trace } from '../trace'

import { rebaseAndDisclose, type DisclosureDeps } from './origin'

/**
 * Traversing a collection (tasks 5.2 and 5.3).
 *
 * Two rules, and both are corrections of the implementation this replaces:
 *
 * - **No page cap.** `index.html:500` stopped after ten pages — 250 members of a 3,467-member
 *   collection — logged a warning, and returned the truncated set as the result. Partial data that
 *   looks complete is the exact failure design D5 names. Traversal here follows `hydra:next` until
 *   there is no next.
 * - **No constructed URL.** `index.html:487` built `base + '/Page/' + n` whenever a collection
 *   declared no pagination template. Nothing here builds a page address: the next page is the IRI the
 *   server put in `hydra:next`, and a collection that is incomplete and offers no such link is a
 *   reported gap rather than an invitation to guess a convention.
 *
 * The cap does not become nothing — it becomes a budget, decided from page one's declared total
 * before the rest is fetched. One page is the cost of learning the cost.
 */

export interface PageReading {
  readonly url: string
  /** The subject the document describes as a collection, if it names one. */
  readonly collection: string | null
  readonly quads: readonly Quad[]
  readonly members: readonly string[]
  /** The next page, exactly as the server stated it. `null` when the server stated none. */
  readonly next: string | null
  readonly totalItems: number | null
  /**
   * Whether the document declared a `hydra:PartialCollectionView`.
   *
   * `false` is a completeness proof in its own right: a collection that is not partial served every
   * member it has. This API's reference collections work that way, and requiring a declared total
   * would have refused aggregation over them permanently.
   */
  readonly partial: boolean
  /**
   * The page as served, before it became quads. `null` for a Turtle page, and absent when the reading
   * was built from quads alone. Carried, never inspected — see `fetchPage`.
   */
  readonly document?: unknown
}

export interface CollectionDeps {
  readonly http: HttpClient
  readonly graph: SessionGraph
  readonly contexts: ContextStore
  readonly findings: Findings
  readonly trace: Trace
  /** The origin this session is talking to, so a foreign IRI is rebased and disclosed. */
  readonly origin: string
}

function disclosure(deps: CollectionDeps): DisclosureDeps {
  return { origin: deps.origin, findings: deps.findings, trace: deps.trace }
}

/**
 * Fetch a document and read it as quads, choosing the parser from what the server said it sent.
 *
 * The parsed document travels alongside the quads, and does **not** stop here. Nothing in this module
 * reads a key off it — the invariant that above the graph layer there is no JSON still holds, because
 * carrying an opaque value is not interpreting one. It exists for task 3.5's member-serialisation
 * assessment, which has to see the keys a server *mentions*: a value serialised as `null` yields no
 * triple, so from quads alone "not served" and "null in every record" are the same observation.
 * `vocab/member-serialisation` is the one module permitted to look, and this is how a page reaches it
 * without a second request for a page already in hand.
 */
export async function fetchPage(
  url: string,
  deps: CollectionDeps,
): Promise<{ quads: Quad[]; document: unknown }> {
  deps.trace.log(`GET ${url}`, 'http')
  const response = await deps.http.request(url, { throwOnError: true })

  if (serialisationOf(response.contentType) === 'turtle') {
    return { quads: quadsFromTurtle(response.body, response.url), document: null }
  }

  const document: unknown = JSON.parse(response.body)
  return { quads: await quadsFromJsonLd(document, deps.contexts.load, response.url), document }
}

function firstNumber(quads: readonly Quad[], subject: string | null, predicate: string): number | null {
  const found = quads.find(
    (quad) => quad.predicate.value === predicate && (subject === null || quad.subject.value === subject),
  )
  return found ? Number(found.object.value) : null
}

/** Read one page as facts, not as JSON. */
export function readPageQuads(url: string, quads: readonly Quad[]): PageReading {
  const memberQuads = quads.filter((quad) => quad.predicate.value === HYDRA.member)

  // Whatever subject carries the members is the collection. Not the request URL: a server may answer
  // a page request with a document whose `@id` is the canonical collection, and that identity is the
  // one worth carrying.
  const collection = memberQuads[0]?.subject.value ?? null

  const members = [
    ...new Set(
      memberQuads
        .filter((quad) => quad.object.termType === 'NamedNode')
        .map((quad) => quad.object.value),
    ),
  ]

  const viewNodes = quads
    .filter((quad) => quad.predicate.value === HYDRA.view)
    .map((quad) => quad.object)
  const partialViews = quads.filter(
    (quad) => quad.predicate.value === RDF.type && quad.object.value === HYDRA.PartialCollectionView,
  )

  // `hydra:next` sits on the view node, but a server may put it on the collection itself. Both are
  // statements of the same fact, so both are read.
  const nextQuad = quads.find(
    (quad) =>
      quad.predicate.value === HYDRA.next &&
      (viewNodes.some((node) => node.equals(quad.subject)) || quad.subject.value === collection),
  )

  return {
    url,
    collection,
    quads,
    members,
    next: nextQuad ? nextQuad.object.value : null,
    totalItems: firstNumber(quads, collection, HYDRA.totalItems),
    partial: partialViews.length > 0 || viewNodes.length > 0,
  }
}

export async function readPage(url: string, deps: CollectionDeps): Promise<PageReading> {
  const { quads, document } = await fetchPage(url, deps)
  return { ...readPageQuads(url, quads), document }
}

export interface MaterialiseOptions {
  /** The most members one materialisation may retrieve without being asked again. */
  readonly budget: number
  /** Proceed past the budget, because the cost was reported and accepted. */
  readonly consent?: boolean
  /** How the collection was reached, recorded as the provenance of every member. */
  readonly via?: string
  /**
   * A pagination template the class declares, if it declares one.
   *
   * Carried so a reported gap can say which routes were looked for and found missing. It is not used
   * to traverse: `hydra:next` is a statement that another page exists, whereas walking a template's
   * page variable is the client doing arithmetic against a termination condition the server never
   * stated — one step from the `/Page/{n}` construction this replaces.
   */
  readonly declaredPagination?: string | null
  /**
   * Given the first page as served, so task 3.5's assessment can see the keys.
   *
   * Called once, before the traversal continues, because whether the members carry the fields decides
   * whether retrieving the rest of them buys anything. Awaited rather than fired and forgotten: a
   * completeness gate reading a record that has not been written yet would pass for the wrong reason.
   */
  readonly assessFirstPage?: (document: unknown, collectionIri: string) => Promise<void>
}

export interface MaterialisationResult {
  /** The collection's own identity, as the first page stated it. */
  readonly collection: string
  readonly members: readonly string[]
  readonly pages: number
  readonly totalItems: number | null
  readonly complete: boolean
  readonly plan: MaterialisationPlan
  /** Why the traversal did not finish, when it did not. `null` when it did. */
  readonly refusal: string | null
}

/**
 * Retrieve a collection into the store, in full or not at all.
 *
 * Members land in the session graph and nowhere else — retrieved data does not enter the model's
 * context, which is what makes exhaustive retrieval affordable and truncation unnecessary.
 */
export async function materialise(
  firstPageUrl: string,
  deps: CollectionDeps,
  options: MaterialiseOptions,
): Promise<MaterialisationResult> {
  const first = await readPage(firstPageUrl, deps)
  const collection = first.collection ?? firstPageUrl
  const fetchedAt = new Date()

  const members = new Set<string>(first.members)
  deps.graph.ingest(first.quads, {
    url: options.via ?? first.url,
    kind: 'collection-member',
    fetchedAt,
  })
  deps.graph.recordCompleteness(collection, {
    have: members.size,
    total: first.totalItems,
    at: fetchedAt,
    partial: first.partial,
  })

  if (options.assessFirstPage && first.document !== undefined && first.document !== null) {
    await options.assessFirstPage(first.document, collection)
  }

  const plan = deps.graph.planFor(collection, { budget: options.budget })

  const settle = (pages: number, refusal: string | null): MaterialisationResult => {
    const completeness = deps.graph.completenessOf(collection)
    return {
      collection,
      members: [...members],
      pages,
      totalItems: first.totalItems,
      complete: completeness?.complete ?? false,
      plan: deps.graph.planFor(collection, { budget: options.budget }),
      refusal,
    }
  }

  if (plan.complete) {
    deps.trace.log(
      `${collection} is complete at ${members.size} member${members.size === 1 ? '' : 's'} ` +
        `${first.totalItems === null ? '— the page declared no partial view, so it held them all' : `of ${first.totalItems}`}`,
      'success',
    )
    return settle(1, null)
  }

  // The rest is not free, so whether to pay is decided here rather than discovered halfway through.
  if (plan.refusal !== null && !options.consent) {
    deps.trace.log(plan.refusal, 'warn')
    return settle(1, plan.refusal)
  }

  if (first.next === null) {
    /*
     * Incomplete, and no declared way forward.
     *
     * The proof of concept met this case by constructing `…/Page/{n}`. That happens to work against
     * this API and is a guess about every other one — and a client that guesses right is still a
     * client that guessed. Reported instead.
     */
    const message =
      `<${collection}> reports ${first.totalItems ?? 'an unstated number of'} members, served ` +
      `${members.size} on the first page, and declares no hydra:next. ` +
      (options.declaredPagination
        ? `Its class does declare the pagination template ${options.declaredPagination}, but a ` +
          `template says how a page is addressed and not that another page exists — walking its page ` +
          `variable would be this client inventing a termination condition the API never stated. `
        : `Nor does its class declare a pagination template. `) +
      `There is no published route to the remaining members, and this client will not construct one ` +
      `from a URL pattern. Serving a hydra:PartialCollectionView with hydra:next would make the ` +
      `collection traversable.`
    deps.findings.record({
      about: collection,
      kind: FINDING_KINDS.undeclaredPagination,
      message,
    })
    deps.trace.log(message, 'warn')
    return settle(1, message)
  }

  let next: string | null = rebaseAndDisclose(first.next, 'A hydra:next link', disclosure(deps))
  let pages = 1
  const visited = new Set<string>([first.url, firstPageUrl])

  while (next !== null) {
    if (visited.has(next)) {
      // Not a cap: a well-formed collection never revisits a page. This terminates a server whose
      // links cycle, which would otherwise be an infinite traversal rather than a truncated one.
      const message =
        `Pagination of <${collection}> revisited <${next}>, so the traversal was stopped. A ` +
        `hydra:next chain that returns to a page it has already served cannot terminate.`
      deps.findings.record({ about: collection, kind: FINDING_KINDS.undeclaredPagination, message })
      deps.trace.log(message, 'error')
      return settle(pages, message)
    }
    visited.add(next)

    const page: PageReading = await readPage(next, deps)
    pages += 1
    for (const member of page.members) members.add(member)

    deps.graph.ingest(page.quads, {
      url: options.via ?? page.url,
      kind: 'collection-member',
      fetchedAt: new Date(),
    })
    deps.graph.recordCompleteness(collection, {
      have: members.size,
      total: first.totalItems ?? page.totalItems,
      at: new Date(),
      partial: first.partial,
    })

    if (pages % 10 === 0) {
      deps.trace.log(
        `${members.size}${first.totalItems === null ? '' : ` of ${first.totalItems}`} members held ` +
          `after ${pages} pages`,
        'info',
      )
    }

    next = page.next === null ? null : rebaseAndDisclose(page.next, 'A hydra:next link', disclosure(deps))
  }

  const settled = settle(pages, null)
  if (!settled.complete) {
    // The links ran out before the declared total was reached. Reported, because presenting this as
    // the collection is the failure the traversal exists to avoid.
    const message =
      `<${collection}> declares ${first.totalItems} members but its hydra:next chain ended after ` +
      `${members.size} across ${pages} pages. The declared total and the served pages disagree, so ` +
      `the set held cannot be treated as complete.`
    deps.findings.record({ about: collection, kind: FINDING_KINDS.undeclaredPagination, message })
    deps.trace.log(message, 'warn')
    return { ...settled, refusal: message }
  }

  deps.trace.log(
    `${collection} materialised: ${members.size} members across ${pages} pages`,
    'success',
  )
  return settled
}
