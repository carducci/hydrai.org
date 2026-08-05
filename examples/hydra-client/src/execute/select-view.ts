import { FINDING_KINDS, type Findings } from '../rdf/findings'
import type { SessionGraph } from '../rdf/session-graph'
import { HYDRA } from '../rdf/terms'
import type { FoldedTemplate, ProjectedTool } from '../project/tools'
import type { Trace } from '../trace'
import type { ClassCapability } from '../vocab/capability'

import { locateClass } from './locate'
import { rebaseAndDisclose } from './origin'
import { expandTemplate, isQueryOnlyTemplate } from './template'

/**
 * Choosing the address of a filtered collection view (design D1).
 *
 * Extracted from the executor so the SPARQL local path and the interactive `search_collection` path
 * select a filtered view the *same* way. The no-drift requirement is the whole point: the predicate-IRI
 * matching that maps a supplied filter to a declared `hydra:IriTemplate` variable exists once, and both
 * the listing that shows a filtered subset and the query engine that materialises it for computation
 * reach it here. A second implementation would be a second thing to keep in step, and it would not stay
 * in step.
 *
 * Nothing here holds session state; everything the selection reads is passed in `SelectContext`, so a
 * caller with a graph, an origin and somewhere to log can select a view without being the executor.
 */
export interface SelectContext {
  readonly graph: SessionGraph
  /** The entry point IRI, for locating a collection from a declared link. */
  readonly entrypoint: string | null
  /** The origin this session connected to, so a foreign URL is rebased and disclosed. */
  readonly origin: string
  readonly findings: Findings
  readonly trace: Trace
}

/** Where the plain listing of a collection class lives, per what the server declared. */
export function locateCollection(
  cls: ClassCapability,
  ctx: SelectContext,
): { url: string } | { reason: string } {
  const location = locateClass(cls, { graph: ctx.graph, entrypoint: ctx.entrypoint })
  if (location.url === null) {
    ctx.findings.record({
      about: cls.iri,
      kind: FINDING_KINDS.undeclaredLinkRange,
      message: location.reason,
    })
    return { reason: location.reason }
  }
  ctx.trace.log(`Resolved <${cls.iri}> to ${location.url} — ${location.evidence}`, 'info')
  return {
    url: rebaseAndDisclose(location.url, `The IRI declared for <${cls.iri}>`, {
      origin: ctx.origin,
      findings: ctx.findings,
      trace: ctx.trace,
    }),
  }
}

/**
 * Choose the address form for a filtered listing from what was actually supplied.
 *
 * Matching is by **predicate**, not by variable spelling. Two forms may name one predicate
 * differently — this API's path form says `status` where its query form says `eventStatus` —
 * and a caller cannot know which spelling belongs to which form; the predicate is the identity,
 * so a supplied name translates into a form's own variable where exactly one carries that
 * predicate. A form's `hydra:pageIndex` variable is filled with the declared first page when
 * unsupplied — the model asking for a filtered listing has asked for its first page, and a
 * published address form must not lose to the model not restating that. Any other path variable
 * left without a value disqualifies the form: dropping the `{leaf}` of `/stacks/leaf/{leaf}`
 * yields a URL the server never published, requested with confidence.
 *
 * Among the forms that fit, the values choose: a reserved character (`:`, `/`) in a path segment
 * is rejected by real servers however faithfully it is percent-encoded, so a form carrying every
 * value in the query outranks one that puts such a value in the path; then the fewest variables,
 * then the template string — all deterministic.
 *
 * The safety property that must never be lost: a supplied value no template can carry is refused
 * rather than dropped, because a request that silently ignores a filter comes back looking
 * filtered.
 */
export function chooseTemplateUrl(
  record: ProjectedTool,
  cls: ClassCapability,
  filters: Readonly<Record<string, unknown>>,
  ctx: SelectContext,
): { url: string } | { reason: string } {
  const supplied = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key]) => key)

  // With nothing supplied this call *is* the collection's plain GET, and a declared `rdfs:range`
  // on an entry point link still beats a template's prefix: a range is an exact statement of the
  // address, a prefix is a reading of one.
  if (supplied.length === 0) return locateCollection(cls, ctx)

  const propertyOf = (name: string): string | null =>
    record.dispatch.bindings.find((binding) => binding.name === name)?.property ?? null

  interface Candidate {
    readonly form: FoldedTemplate
    readonly values: Record<string, unknown>
    /** Path variables the form still needs — empty for a dispatchable candidate. */
    readonly missing: readonly string[]
  }

  /** How this form would carry the supplied filters, or `null` if a filter does not fit it. */
  const planFor = (form: FoldedTemplate): Candidate | null => {
    const values: Record<string, unknown> = {}

    for (const name of supplied) {
      if (form.variables.includes(name)) {
        values[name] = filters[name]
        continue
      }
      const property = propertyOf(name)
      const alternates = property
        ? form.mappings.filter(
            (mapping) =>
              mapping.property === property &&
              !supplied.includes(mapping.variable) &&
              !(mapping.variable in values),
          )
        : []
      if (alternates.length === 1) {
        values[(alternates[0] as { variable: string }).variable] = filters[name]
        continue
      }
      return null
    }

    const missing: string[] = []
    if (!isQueryOnlyTemplate(form.template)) {
      for (const mapping of form.mappings) {
        if (mapping.variable in values) continue
        if (mapping.property === HYDRA.pageIndex) {
          // The vocabulary's own pagination variable, at its declared first page. Traversal
          // still follows hydra:next from there; nothing about termination is assumed.
          values[mapping.variable] = '1'
        } else {
          missing.push(mapping.variable)
        }
      }
    }
    return { form, values, missing }
  }

  const plans = record.dispatch.templates
    .map(planFor)
    .filter((plan): plan is Candidate => plan !== null)
  const candidates = plans.filter((plan) => plan.missing.length === 0)

  if (candidates.length === 0) {
    /*
     * The refusal teaches the near miss: a form that fits everything supplied and needs one or
     * two more values is one call away, and naming those values is what turns a dead end into
     * the next move. An open-ended condition — a lower bound with no upper — is what no form
     * carries by construction, and that is the query tool's case.
     */
    const nearMisses = plans
      .filter((plan) => plan.missing.length > 0 && plan.missing.length <= 2)
      .sort((a, b) => a.missing.length - b.missing.length)
      .slice(0, 2)
      .map(
        (plan) =>
          `supplying ${plan.missing.join(' and ')} as well would fit the published form ` +
          `${plan.form.template} (its variables travel together)`,
      )
    return {
      reason:
        `No address form this API publishes for <${cls.iri}> carries the combination ` +
        `${supplied.join(', ')} on its own. ` +
        (nearMisses.length > 0
          ? `${nearMisses.join('; ')}. `
          : `Each value may be filterable in a different combination; the result footer lists ` +
            `the published ones. `) +
        `For a condition no published combination carries — an open-ended range, say — ask ` +
        `\`sparql\` over this collection instead. Rather than issue a request that silently ` +
        `ignores a filter, none was issued.`,
    }
  }

  /*
   * The shared-key pattern: an enum individual's fragment is the key the vocabulary and the
   * route share — <ns#BookedGig> travels as `BookedGig` — and a request IRI never embeds
   * another IRI. So a fragment-bearing IRI value expands as its fragment. A fragment-less IRI
   * (a resource reference like a company's own address) has no shared key and passes through;
   * the server's registry owns coercing those.
   */
  const sharedKey = (value: unknown): unknown => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value
    const hash = value.indexOf('#')
    return hash > 0 && hash < value.length - 1 ? value.slice(hash + 1) : value
  }
  for (const candidate of candidates) {
    for (const [name, value] of Object.entries(candidate.values)) {
      candidate.values[name] = sharedKey(value)
    }
  }

  const pathHostile = (candidate: Candidate): number =>
    isQueryOnlyTemplate(candidate.form.template)
      ? 0
      : Object.values(candidate.values).some((value) => /[:/?#]/.test(String(value)))
        ? 1
        : 0

  /*
   * A `hydra:freetextQuery` form advertises analyzer-based, relevance-ranked matching; an
   * exact-filter form binds each variable to a concrete predicate. When a structured filter is all
   * that was supplied, the exact-filter form is the honest address for it — a status is an identity
   * to match, not a phrase to rank. So among forms that all satisfy the request, a freetext form
   * ranks last. This never routes a real free-text query wrong: a supplied `q` binds no predicate on
   * the exact-filter forms, so `planFor` disqualifies them and the freetext form is the only
   * candidate left. The signal is `hydra:freetextQuery` itself (via the folded `kind`), not any
   * resource or route name, so the preference is a reading of the advertised vocabulary, not a rule
   * about this API.
   */
  const freetextRank = (candidate: Candidate): number => (candidate.form.kind === 'freetext' ? 1 : 0)

  candidates.sort((a, b) => {
    const hostility = pathHostile(a) - pathHostile(b)
    if (hostility !== 0) return hostility
    const kind = freetextRank(a) - freetextRank(b)
    if (kind !== 0) return kind
    const size = a.form.variables.length - b.form.variables.length
    if (size !== 0) return size
    return a.form.template < b.form.template ? -1 : 1
  })

  const chosen = candidates[0] as Candidate

  /*
   * Every fitting form is a path form and a value cannot travel in a path segment (a reserved
   * character survives percent-encoding only to be rejected by the server's own request
   * validation). Issuing that request buys a guaranteed 400; refusing teaches instead — quoting
   * the API's own prose about the variable, which is where the declared lexical form lives.
   */
  if (pathHostile(chosen) === 1) {
    const offending = Object.entries(chosen.values).filter(([, value]) => /[:/?#]/.test(String(value)))
    const described = offending.map(([variable, value]) => {
      const comment = chosen.form.mappings.find((mapping) => mapping.variable === variable)?.comment
      return (
        `"${value}" cannot travel in the {${variable}} path segment` +
        (comment ? ` — the API describes ${variable} as "${comment}"` : '')
      )
    })
    return {
      reason:
        `The published form ${chosen.form.template} carries this combination, but ` +
        `${described.join('; ')}. Reshape the value to the described form, or ask \`sparql\` ` +
        `for a condition no published form can carry. No request was issued.`,
    }
  }

  const expansion = expandTemplate(chosen.form.template, chosen.values as Record<string, string>)
  if (expansion.unused.length > 0) {
    return {
      reason:
        `The template ${chosen.form.template} declares no variable for ` +
        `${expansion.unused.join(', ')}, so those values cannot be carried into the request. ` +
        `Rather than issue a request that silently ignores them, none was issued.`,
    }
  }
  return {
    url: rebaseAndDisclose(expansion.url, 'A published IriTemplate', {
      origin: ctx.origin,
      findings: ctx.findings,
      trace: ctx.trace,
    }),
  }
}
