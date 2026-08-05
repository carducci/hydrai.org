import type { Term } from 'n3'

import { FINDING_KINDS, type Findings } from '../rdf/findings'
import type { SessionGraph, TermLike } from '../rdf/session-graph'
import { GRAPHS, HYDRA, RDF, RDFS } from '../rdf/terms'
import { schemaNameFor, type JsonSchema, type ProjectedTool, type ToolSurface } from '../project/tools'
import {
  describeFilterSurface,
  type CapabilityModel,
  type FilterVariableSource,
} from '../vocab/capability'

/**
 * The page: every result carries the affordances of what it holds (design D2, D3).
 *
 * Rendered from the **live response graph**, not from the connect-time snapshot — the quads this
 * module reads are the ones the response put in the store, so a collection discovered at runtime
 * and a resource the vocabulary described at connect render through the same code. Hydra models
 * operations, templates and mappings as blank nodes, so every traversal here carries RDF/JS terms;
 * only leaves become strings.
 *
 * The affordance **registry** (the retained per-affordance projection) supplies what the live
 * response cannot: the handle the model passes to `invoke`, and the input contract the gate will
 * enforce. The join is declaring class + method — the same identity the registry's names are
 * derived from, which is why a handle surfaced here resolves at dispatch and survives a reconnect.
 */

/** A value set served in full by a read-only reference collection (design D5). */
export interface ValueSetMember {
  readonly iri: string
  readonly label: string | null
}

/** Members indexed by the class they instantiate. Absent class ⇒ no set was declared; never guess. */
export interface ValueSetIndex {
  byClass(classIri: string): readonly ValueSetMember[] | undefined
}

export interface AffordanceRenderDeps {
  readonly graph: SessionGraph
  readonly model: CapabilityModel
  /** The retained per-affordance projection: handles, contracts, residue. */
  readonly surface: ToolSurface
  readonly valueSets?: ValueSetIndex
  /** An affordance the response declares but the client cannot read is a conformance finding. */
  readonly findings?: Findings
  /**
   * Told each handle this block disclosed. `invoke` refuses an unknown handle by naming the ones
   * the conversation has actually surfaced, and this is how it knows which those are.
   */
  readonly onHandleSurfaced?: (handle: string) => void
}

export interface AffordanceRenderOptions {
  /**
   * The vocabulary class the subject is known to be, where the caller knows it — a traversal knows
   * which collection class it dispatched against, while the live document may only say
   * `hydra:Collection`. Without it, the subject's own `rdf:type`s are the join key.
   */
  readonly classIri?: string | null
}

function text(graph: SessionGraph, subject: TermLike, predicate: string): string | null {
  const [found] = graph.match(subject, predicate, null, GRAPHS.data)
  return found ? found.object.value : null
}

function nodes(graph: SessionGraph, subject: TermLike, predicate: string): Term[] {
  return graph.match(subject, predicate, null, GRAPHS.data).map((quad) => quad.object)
}

function localName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  if (hash >= 0) return iri.slice(hash + 1)
  const slash = iri.lastIndexOf('/')
  return slash >= 0 ? iri.slice(slash + 1) : iri
}

/** The classes to join the registry on: the caller's hint first, then the live `rdf:type`s. */
function candidateClasses(subject: string, graph: SessionGraph, hint: string | null): string[] {
  const classes = hint ? [hint] : []
  for (const type of nodes(graph, subject, RDF.type)) {
    if (!classes.includes(type.value)) classes.push(type.value)
  }
  return classes
}

/** Registry operations declared by any of the candidate classes, keyed for the live join. */
function registryOperations(surface: ToolSurface, classes: readonly string[]): ProjectedTool[] {
  return surface.tools.filter(
    (tool) => tool.dispatch.kind === 'operation' && classes.includes(tool.dispatch.classIri),
  )
}

/** One line of a value set: the IRI, labelled where the collection labelled it. */
function valueSetLine(members: readonly ValueSetMember[]): string {
  return members
    .map((member) => (member.label ? `<${member.iri}> (${member.label})` : `<${member.iri}>`))
    .join(', ')
}

/** A schema's type, in one word the model can act on. */
function typeWord(schema: JsonSchema): string {
  if (schema.enum) return 'one of an enumerated set'
  if (schema.$ref) return 'object'
  if (schema.format === 'uri') return 'IRI'
  if (schema.format) return `${schema.type ?? 'string'} (${schema.format})`
  return schema.type ?? 'string'
}

/**
 * One property of a write contract, compactly: name, type, requiredness, and every constraint the
 * gate will enforce — so a refusal never cites a rule the model was not shown.
 */
function contractLines(tool: ProjectedTool, valueSets: ValueSetIndex | undefined): string[] {
  const schema = tool.input_schema
  const required = new Set(schema.required ?? [])
  const lines: string[] = []

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (name === 'id') continue // the subject; stated separately, with the value in hand

    const notes: string[] = []
    if (required.has(name)) notes.push('required')

    if (property.enum) notes.push(`one of ${property.enum.map((value) => `"${value}"`).join(', ')}`)

    // The published constraints the schema could not carry — the gate's checklist, shown up front.
    for (const residue of tool.dispatch.residue) {
      if (residue.schemaName !== name) continue
      if (residue.kind === 'maxLength') notes.push(`at most ${residue.value} characters`)
      else if (residue.kind === 'minLength') notes.push(`at least ${residue.value} characters`)
      else if (residue.kind === 'pattern') notes.push(`must match /${residue.value}/`)
      else if (residue.kind === 'maxCount') notes.push(`at most ${residue.value} values`)
      else if (residue.kind === 'class') {
        const set = valueSets?.byClass(String(residue.value))
        if (set && set.length > 0) {
          // The reference collection serves this class in full, so the references are a value set.
          notes.push(`one of: ${valueSetLine(set)}`)
        } else {
          notes.push(`an @id of a <${residue.value}> from a prior read`)
        }
      }
    }

    // A nested shape renders one level of its fields inline, so the model sees the tree it must send.
    if (property.$ref && schema.$defs) {
      const key = property.$ref.replace('#/$defs/', '')
      const nested = schema.$defs[key]
      const inner = Object.entries(nested?.properties ?? {})
        .map(([nestedName, nestedSchema]) => `${nestedName}: ${typeWord(nestedSchema)}`)
        .join(', ')
      lines.push(`    ${name}: { ${inner} }${notes.length > 0 ? ` — ${notes.join('; ')}` : ''}`)
      continue
    }

    lines.push(`    ${name}: ${typeWord(property)}${notes.length > 0 ? ` — ${notes.join('; ')}` : ''}`)
  }

  return lines
}

/** The vocabulary's own prose for an operation, first line only — the block is a footer, not a manual. */
function proseOf(tool: ProjectedTool): string {
  const first = tool.description.split('\n')[0]?.trim() ?? ''
  return first
}

/**
 * One affordance's full contract, as a refusal can carry it.
 *
 * An incomplete `invoke` is the cheapest way to learn a contract — no listing, no dereference —
 * but only if the refusal states the whole contract rather than the one field it tripped on.
 * Same renderer the footers use, so the two can never describe the contract differently.
 */
export function renderContract(tool: ProjectedTool, valueSets?: ValueSetIndex): string {
  const lines = [`The full contract for \`${tool.name}\` (${tool.dispatch.method}): ${proseOf(tool)}`]
  if (tool.dispatch.needsSubject) {
    lines.push(`    id: the IRI of the resource to act on, from a prior read`)
  }
  lines.push(...contractLines(tool, valueSets))
  if (tool.dispatch.method.toUpperCase() === 'PUT') {
    lines.push(
      `    (a field you omit is carried forward from the current representation, not cleared — ` +
        `the read-before-replace merge supplies it)`,
    )
  }
  return lines.join('\n')
}

/**
 * Render the affordance block for one subject, from what the live response declared about it.
 *
 * Returns an empty string when the response declared nothing — a block that said "no affordances"
 * on every plain value read would be noise, not information.
 */
export function renderAffordanceBlock(
  subject: string,
  deps: AffordanceRenderDeps,
  options: AffordanceRenderOptions = {},
): string {
  const { graph, surface } = deps
  const classes = candidateClasses(subject, graph, options.classIri ?? null)
  const registry = registryOperations(surface, classes)
  const lines: string[] = []

  // ── Operations the response itself declares (hydra:operation on the subject).
  const liveOperations = nodes(graph, subject, HYDRA.operation)
  const rendered = new Set<string>()

  const isCollection = classes.some((cls) => deps.model.byIri(cls)?.isCollection ?? false)
  let unreadableOperations = 0

  /** One write handle with its contract — the same rendering wherever a handle is offered. */
  const pushOperation = (match: ProjectedTool, method: string): void => {
    deps.onHandleSurfaced?.(match.name)
    lines.push(`- \`${match.name}\` (${method}) — ${proseOf(match)}`)
    if (match.dispatch.needsSubject) {
      lines.push(`    id: this resource's IRI — <${subject}>`)
    }
    const contract = contractLines(match, deps.valueSets)
    if (contract.length > 0) lines.push(...contract)
    if (method === 'PUT') {
      // The required[]-dropped rule, restated where it applies: a PUT input omits what it keeps.
      lines.push(
        `    (a field you omit is carried forward from the current representation, not cleared — ` +
          `the read-before-replace merge supplies it)`,
      )
    }
  }

  for (const node of liveOperations) {
    const method = text(graph, node, HYDRA.method)?.toUpperCase()
    if (!method) {
      // The response declares an operation whose method did not survive expansion — a bare key
      // the served context never maps is dropped, and what remains is an affordance with no verb.
      // Silently skipping it is how a model concludes a declared capability does not exist.
      unreadableOperations += 1
      continue
    }
    if (rendered.has(method)) continue
    rendered.add(method)

    // Reads go through the envelope's own read tools; they are affordances, not handles.
    if (method === 'GET') {
      lines.push(
        isCollection
          ? `- GET — list with \`follow\` ("${subject}"); \`search_collection\` narrows it`
          : `- GET — re-read with \`get_resource\` ("${subject}")`,
      )
      continue
    }

    const match = registry.find((tool) => tool.dispatch.method.toUpperCase() === method)
    if (match) {
      pushOperation(match, method)
    } else {
      // Declared live but not by the vocabulary: reported honestly rather than given a handle that
      // would not resolve at dispatch.
      const expects = text(graph, node, HYDRA.expects)
      lines.push(
        `- ${method}${expects ? ` (expects <${expects}>)` : ''} — declared by this response but not ` +
          `described by the vocabulary, so no handle can be offered for it.`,
      )
    }
  }

  if (unreadableOperations > 0) {
    // Presence, not a count: a blank operation node re-ingested by a second read of the same page
    // cannot be deduplicated, so any number here would be an artefact of fetch history.
    deps.findings?.record({
      about: subject,
      kind: FINDING_KINDS.unprojectableOperation,
      message:
        `The response for <${subject}> declares hydra:operation nodes carrying no readable ` +
        `hydra:method — a bare key the served @context does not map (and no @vocab covers) is ` +
        `dropped by expansion. Mapping the operation-body terms (method, title, expects, returns) ` +
        `in the context, or serialising them prefixed, would make the affordance readable.`,
    })
    lines.push(
      `- declared operations could not be read (the served context drops the method key) — ` +
        `reported as a conformance finding.`,
    )
    /*
     * The response *did* declare operations for this resource — only their methods are garbled.
     * The resource's own type is readable, and the vocabulary declares that type's operations, so
     * the registry supplies what the serialisation lost, labelled as such. Deliberately only in
     * the garbled case: a response that declares no operations at all is stating a contextual
     * absence, and the vocabulary must not override it.
     */
    const fallback = registry.filter((tool) => !rendered.has(tool.dispatch.method.toUpperCase()))
    if (fallback.length > 0) {
      lines.push(
        `  From the vocabulary's declarations for this resource's type (the response's own could ` +
          `not be read):`,
      )
      for (const match of fallback) {
        const method = match.dispatch.method.toUpperCase()
        if (method === 'GET') continue
        pushOperation(match, method)
      }
    }
  }

  /*
   * ── The filters this collection declares, advertised deduplicated.
   *
   * The capability model's templates carry proper bindings, so they lead where the class is
   * declared; a runtime-discovered collection falls back to the live `hydra:search` nodes. Either
   * way `advertisedFilterVariables` collapses per-form aliases of one predicate and drops the
   * pagination control — advertising `status` and `eventStatus` side by side taught the model to
   * combine names from different address forms, which no single form carries.
   */
  const declaredTemplates = classes.flatMap((cls) => deps.model.byIri(cls)?.templates ?? [])
  const filterSources: FilterVariableSource[] =
    declaredTemplates.length > 0
      ? declaredTemplates.map((template) => ({
          template: template.template,
          mappings: template.mappings.map((mapping) => ({
            variable: mapping.variable,
            property: mapping.propertyIsIri ? mapping.property : null,
            comment: mapping.comment,
          })),
        }))
      : nodes(graph, subject, HYDRA.search).map((templateNode) => ({
          template: text(graph, templateNode, HYDRA.template) ?? '',
          mappings: nodes(graph, templateNode, HYDRA.mapping)
            .map((mappingNode) => {
              const [bound] = graph.match(mappingNode, HYDRA.property, null, GRAPHS.data)
              return {
                variable: text(graph, mappingNode, HYDRA.variable) ?? '',
                property: bound && bound.object.termType === 'NamedNode' ? bound.object.value : null,
                comment: text(graph, mappingNode, RDFS.comment),
              }
            })
            .filter((mapping) => mapping.variable.length > 0),
        }))
  const filterSurface = describeFilterSurface(filterSources)
  if (filterSurface.combinations.length > 0) {
    const example =
      filterSurface.combinations.split(/[ ,+·]+/).find((word) => word && word !== 'any' && word !== 'of') ?? 'q'
    lines.push(
      `- filterable by (each · group is one published combination): ${filterSurface.combinations} — call ` +
        `\`search_collection\` with collection "${subject}" and filters like { "${example}": "…" }. ` +
        `A "+" group must be supplied together; an "any of" group combines freely. For a condition ` +
        `no combination carries (an open-ended range, say), ask \`sparql\` instead.`,
    )
    // The API's own prose per variable — the declared lexical form ("yyyy-MM-dd") lives here.
    for (const note of filterSurface.notes) lines.push(`    ${note.name}: ${note.comment}`)
  }

  // ── Pagination state, from the view the response served.
  const total = text(graph, subject, HYDRA.totalItems)
  const viewNodes = nodes(graph, subject, HYDRA.view)
  const hasNext = viewNodes.some((view) => text(graph, view, HYDRA.next) !== null)
  if (total !== null || viewNodes.length > 0) {
    const parts: string[] = []
    if (total !== null) parts.push(`${total} members declared`)
    if (viewNodes.length > 0) parts.push(hasNext ? 'further pages exist' : 'this view is the last page')
    lines.push(`- pagination: ${parts.join('; ')}`)
  }

  if (lines.length === 0) return ''

  return ['', 'Affordances of what this result holds:', ...lines].join('\n')
}

/**
 * The registry affordances declared by one class, for callers that need the handles without a live
 * response — the connect-time map (design D4) lists write support per collection this way.
 */
export function handlesForClass(surface: ToolSurface, classIri: string): ProjectedTool[] {
  return registryOperations(surface, [classIri])
}

/** Exported for tests: the name a property renders under is the projection's, never re-derived. */
export { schemaNameFor, localName as affordanceLocalName }
