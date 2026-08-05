import type { Term } from 'n3'

import type { SessionGraph, TermLike } from '../rdf/session-graph'
import { GRAPHS, HYDRA, NS, RDF, RDFS, SHACL, type GraphName } from '../rdf/terms'

/**
 * The capability model (task 3.3).
 *
 * Built entirely by querying the graph. No JSON is walked and no name is parsed — which is what makes
 * the two rules in the spec structural rather than aspirational:
 *
 * - **Relationships are read from the graph, never inferred lexically.** A collection's member class
 *   comes from the `rdfs:range` of its own `hydra:member` supported property. The proof of concept
 *   stripped `ies`→`y` and a trailing `s` and then substring-matched IRIs (`index.html:350-351`, `:436`,
 *   `:622`) — and forty lines away, at `:583-588`, did it correctly and only once. Against a vocabulary
 *   that is not English-pluralised the guesses fail silently and wrongly, which is worse than failing.
 * - **Terms are absolute IRIs.** There is no spelling to match, so `sh:shapesGraph` and
 *   `http://www.w3.org/ns/shacl#shapesGraph` cannot diverge.
 *
 * Derivation is document-driven at every tier, deliberately including T3. Deriving capability by SPARQL
 * where an endpoint exists would work — the vocabulary is in the store — but a client with two
 * projection paths depending on tier is two clients. SPARQL adds reasoning; it does not replace this.
 */

export interface StatusOutcome {
  readonly code: number
  readonly description: string | null
}

export interface OperationCapability {
  /*
   * There is deliberately no node identity here.
   *
   * Hydra models operations as blank nodes, and a blank node's label is assigned at parse time — `b0_b33`
   * on one expansion, something else on the next. Exposing it would offer a stable-looking key that is
   * not stable, and the dispatch key has to survive reconnects. Task 4.1 derives that key from the class
   * IRI plus the operation instead.
   */
  readonly method: string
  readonly title: string | null
  /** Carried into the tool description verbatim — see task 4.2. */
  readonly description: string | null
  readonly expects: string | null
  readonly returns: string | null
  readonly possibleStatus: readonly StatusOutcome[]
}

export interface PropertyCapability {
  /** The RDF predicate IRI. The join key for SHACL, and the only identity that matters. */
  readonly iri: string
  readonly title: string | null
  readonly description: string | null
  readonly readable: boolean
  readonly writeable: boolean
  readonly required: boolean
  /** A `hydra:Link` points at another resource rather than carrying a value. */
  readonly isLink: boolean
  /** For a Link, the class it targets. `null` is a gap to escalate, never a licence to guess. */
  readonly range: string | null
}

export interface TemplateMapping {
  readonly variable: string
  /** The property this variable binds to — `hydra:freetextQuery`, `hydra:pageIndex`, or a predicate. */
  readonly property: string | null
  /**
   * Whether that binding is an IRI.
   *
   * A property expressed as a plain string is not a binding at all — it is a name that resembles one.
   * This API publishes its mappings under the compact key `hydra:property`, which does not inherit the
   * `@type: @id` of the Hydra term `property`, so every one of its 50 template variables binds to a
   * *literal*: `"hydra:pageIndex"` rather than `<http://www.w3.org/ns/hydra/core#pageIndex>`. Nothing
   * connects those variables to what they filter, so this is carried rather than papered over — and
   * the projection reports it (design D8) instead of quietly offering an untyped, unconstrained input.
   */
  readonly propertyIsIri: boolean
  readonly required: boolean
  readonly comment: string | null
}

export interface TemplateCapability {
  readonly template: string
  readonly label: string | null
  readonly mappings: readonly TemplateMapping[]
  /** Derived from what the mappings bind to, not from the label's wording. */
  readonly kind: 'pagination' | 'freetext' | 'filter' | 'lookup'
}

export interface ClassCapability {
  readonly iri: string
  readonly title: string | null
  readonly description: string | null
  readonly operations: readonly OperationCapability[]
  readonly properties: readonly PropertyCapability[]
  readonly templates: readonly TemplateCapability[]
  /**
   * For a collection class, the class its members are. Read from `hydra:member`'s declared range.
   * `null` on a non-collection, and on a collection whose vocabulary omitted the range.
   */
  readonly memberClass: string | null
  readonly isCollection: boolean
}

export interface CapabilityModel {
  readonly classes: readonly ClassCapability[]
  readonly collections: readonly ClassCapability[]
  byIri(iri: string): ClassCapability | undefined
  /** The collection class whose members are `classIri`, if one is declared. */
  collectionFor(classIri: string): ClassCapability | undefined
}

/**
 * A single object's lexical value — an IRI or a literal.
 *
 * `nodes` returns terms rather than strings because Hydra models operations, supported properties,
 * templates, mappings and statuses as **blank nodes**. A blank node's `value` is a bare label, so
 * round-tripping it through a string turns it into a `NamedNode` that matches nothing. Traversal keeps
 * terms; only leaves become strings.
 */
function text(graph: SessionGraph, subject: TermLike, predicate: string, from: GraphName): string | null {
  const [found] = graph.match(subject, predicate, null, from)
  return found ? found.object.value : null
}

function nodes(graph: SessionGraph, subject: TermLike, predicate: string, from: GraphName): Term[] {
  return graph.match(subject, predicate, null, from).map((q) => q.object)
}

function flag(graph: SessionGraph, subject: TermLike, predicate: string, from: GraphName): boolean {
  return text(graph, subject, predicate, from) === 'true'
}

/**
 * Classify a template by what its variables bind to.
 *
 * The proof of concept found its pagination template by looking for a `hydra:pageIndex` binding
 * (`index.html:474-476`) — correctly — but found its free-text template by matching the label text in
 * other places. Binding is the declaration; a label is prose for humans.
 */
function classifyTemplate(mappings: readonly TemplateMapping[]): TemplateCapability['kind'] {
  // Only an actual binding counts. `@id` is the exception and a real one: it is a JSON-LD keyword
  // naming the resource's own identifier, so it cannot be an IRI and is not a defective binding.
  const properties = new Set(
    mappings.filter((m) => m.propertyIsIri || m.property === '@id').map((m) => m.property),
  )
  if (properties.has(HYDRA.pageIndex)) return 'pagination'
  if (properties.has(HYDRA.freetextQuery)) return 'freetext'
  if (properties.has('@id')) return 'lookup'
  return 'filter'
}

/**
 * Variables whose binding is missing or is not a property at all.
 *
 * Reported rather than tolerated: a variable bound to nothing is an input the client can neither type,
 * constrain, nor explain — it can only pass a value through and hope. Naming which variables, on which
 * template, is what makes the report actionable.
 */
export function unboundVariables(template: TemplateCapability): string[] {
  return template.mappings
    .filter((mapping) => !mapping.propertyIsIri && mapping.property !== '@id')
    .map((mapping) => mapping.variable)
}

function readTemplates(graph: SessionGraph, classIri: string, from: GraphName): TemplateCapability[] {
  const templates: TemplateCapability[] = []

  for (const node of nodes(graph, classIri, HYDRA.search, from)) {
    const template = text(graph, node, HYDRA.template, from)
    if (!template) continue

    const mappings: TemplateMapping[] = []
    for (const mappingNode of nodes(graph, node, HYDRA.mapping, from)) {
      const variable = text(graph, mappingNode, HYDRA.variable, from)
      if (!variable) continue

      const [bound] = graph.match(mappingNode, HYDRA.property, null, from)
      mappings.push({
        variable,
        property: bound ? bound.object.value : null,
        propertyIsIri: bound?.object.termType === 'NamedNode',
        required: flag(graph, mappingNode, HYDRA.required, from),
        comment: text(graph, mappingNode, RDFS.comment, from),
      })
    }

    templates.push({
      template,
      label: text(graph, node, RDFS.label, from),
      mappings: mappings.sort((a, b) => (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0)),
      kind: classifyTemplate(mappings),
    })
  }

  // Deterministic: the template string is stable across connects where a blank node label is not.
  return templates.sort((a, b) => (a.template < b.template ? -1 : a.template > b.template ? 1 : 0))
}

function readOperations(graph: SessionGraph, classIri: string, from: GraphName): OperationCapability[] {
  const operations: OperationCapability[] = []

  for (const node of nodes(graph, classIri, HYDRA.supportedOperation, from)) {
    const method = text(graph, node, HYDRA.method, from)
    if (!method) continue

    const possibleStatus: StatusOutcome[] = []
    for (const statusNode of nodes(graph, node, HYDRA.possibleStatus, from)) {
      const raw = text(graph, statusNode, HYDRA.statusCode, from)
      if (raw === null) continue
      possibleStatus.push({
        code: Number(raw),
        // A declared outcome is reported by its declared meaning, not as a slice of the response body.
        description:
          text(graph, statusNode, HYDRA.description, from) ?? text(graph, statusNode, HYDRA.title, from),
      })
    }

    operations.push({
      method,
      title: text(graph, node, HYDRA.title, from),
      description: text(graph, node, HYDRA.description, from),
      expects: text(graph, node, HYDRA.expects, from),
      returns: text(graph, node, HYDRA.returns, from),
      possibleStatus: possibleStatus.sort((a, b) => a.code - b.code),
    })
  }

  /*
   * Deterministic ordering, and deliberately not by the operation's node identity.
   *
   * Design D1 says sort by operation IRI, but Hydra operations here are blank nodes — there is no IRI,
   * and a blank node label is an artefact of parse order rather than a property of the vocabulary.
   * Method plus title is stable, and stability is the requirement: tools render at prompt-prefix
   * position 0, so any reordering invalidates the whole cache on every request.
   */
  return operations.sort((a, b) => {
    const byMethod = a.method < b.method ? -1 : a.method > b.method ? 1 : 0
    if (byMethod !== 0) return byMethod
    return (a.title ?? '') < (b.title ?? '') ? -1 : (a.title ?? '') > (b.title ?? '') ? 1 : 0
  })
}

function readProperties(
  graph: SessionGraph,
  classIri: string,
  from: GraphName,
): { properties: PropertyCapability[]; memberClass: string | null } {
  const properties: PropertyCapability[] = []
  let memberClass: string | null = null

  for (const node of nodes(graph, classIri, HYDRA.supportedProperty, from)) {
    const iri = text(graph, node, HYDRA.property, from)
    if (!iri) continue

    const range = text(graph, node, RDFS.range, from)

    // The member declaration is what associates a collection with its class. Nothing lexical.
    if (iri === HYDRA.member) memberClass = range

    properties.push({
      iri,
      title: text(graph, node, HYDRA.title, from),
      description: text(graph, node, HYDRA.description, from),
      readable: flag(graph, node, HYDRA.readable, from),
      writeable: flag(graph, node, HYDRA.writeable, from),
      required: flag(graph, node, HYDRA.required, from),
      // The property node itself carries the type, not the supported-property wrapper.
      isLink: graph.match(iri, RDF.type, HYDRA.Link, from).length > 0,
      range,
    })
  }

  return {
    properties: properties.sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0)),
    memberClass,
  }
}

export function buildCapabilityModel(
  graph: SessionGraph,
  from: GraphName = GRAPHS.vocab,
): CapabilityModel {
  // Whatever the documentation node is called, it is the thing with supportedClass statements.
  const classIris = [...new Set(graph.match(null, HYDRA.supportedClass, null, from).map((q) => q.object.value))]

  const classes: ClassCapability[] = classIris
    .map((iri) => {
      const { properties, memberClass } = readProperties(graph, iri, from)
      return {
        iri,
        title: text(graph, iri, HYDRA.title, from),
        description: text(graph, iri, HYDRA.description, from),
        operations: readOperations(graph, iri, from),
        properties,
        templates: readTemplates(graph, iri, from),
        memberClass,
        // A collection is a class that declares members, or is typed as one. Not a class whose name
        // contains "Collection" — that is the lexical inference this exists to avoid.
        isCollection:
          memberClass !== null ||
          properties.some((p) => p.iri === HYDRA.member) ||
          graph.match(iri, RDF.type, HYDRA.Collection, from).length > 0,
      }
    })
    // Deterministic ordering, so the projected tool surface is byte-identical across connects.
    .sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0))

  const byIri = new Map(classes.map((c) => [c.iri, c]))
  const collections = classes.filter((c) => c.isCollection)

  return {
    classes,
    collections,
    byIri: (iri) => byIri.get(iri),
    collectionFor: (classIri) => collections.find((c) => c.memberClass === classIri),
  }
}

/** An address form's template and its variables with their predicates — what advertising reads. */
export interface FilterVariableSource {
  readonly template: string
  readonly mappings: readonly {
    readonly variable: string
    readonly property: string | null
    /** The API's own prose about the variable, where it published any. */
    readonly comment?: string | null
  }[]
}

export interface FilterSurface {
  /** The published combinations, ` · `-joined — fixed forms with `+`, query forms as "any of …". */
  readonly combinations: string
  /** The API's own prose per advertised variable — the declared lexical form lives here. */
  readonly notes: readonly { readonly name: string; readonly comment: string }[]
}

/**
 * Mirror of `execute/template`'s query-only test, on the template string alone.
 *
 * Duplicated rather than imported because `vocab/` sits below `execute/` — a form whose every
 * expression is form-style query expansion combines its variables freely; a form with a path
 * expression is one fixed combination.
 */
function queryOnly(template: string): boolean {
  const expressions = template.match(/\{[^}]*\}/g) ?? []
  return expressions.length > 0 && expressions.every((expression) => expression[1] === '?' || expression[1] === '&')
}

/**
 * The filter surface a collection should advertise: the published **combinations**, not a name pool.
 *
 * A flat list of variable names lies twice. Two forms may name one predicate differently (`status`
 * in a path form, `eventStatus` in the query form) — so names are canonicalised per predicate,
 * except where they co-occur inside one form (a from/to range over one date is two roles, both
 * kept). And a flat list implies every name works alone, when a path form is one fixed combination
 * — this API's date window carries `fromDate` and `toDate` together or not at all. So each
 * published form renders as one combination: fixed forms joined with `+`, query forms as
 * "any of …" (their variables combine freely). `hydra:pageIndex` variables are pagination
 * controls, not filters, and are excluded throughout. Presentation only: dispatch still accepts
 * every declared name.
 */
export function describeFilterSurface(forms: readonly FilterVariableSource[]): FilterSurface {
  const localName = (iri: string): string => {
    const hash = iri.lastIndexOf('#')
    if (hash >= 0) return iri.slice(hash + 1)
    const slash = iri.lastIndexOf('/')
    return slash >= 0 ? iri.slice(slash + 1) : iri
  }

  // One canonical name per predicate — unless names co-occur inside a form, which makes them
  // distinct roles that keep their own names.
  const byProperty = new Map<string, Set<string>>()
  for (const form of forms) {
    for (const mapping of form.mappings) {
      if (!mapping.property || mapping.property === HYDRA.pageIndex) continue
      let names = byProperty.get(mapping.property)
      if (!names) byProperty.set(mapping.property, (names = new Set()))
      names.add(mapping.variable)
    }
  }
  const canonicalOf = new Map<string, string>()
  for (const [property, names] of byProperty) {
    if (names.size === 1) continue
    const coOccur = forms.some(
      (form) => form.mappings.filter((mapping) => mapping.property === property).length > 1,
    )
    if (coOccur) continue
    const local = localName(property)
    canonicalOf.set(property, names.has(local) ? local : ([...names].sort()[0] as string))
  }

  const displayName = (mapping: { variable: string; property: string | null }): string =>
    mapping.property ? (canonicalOf.get(mapping.property) ?? mapping.variable) : mapping.variable

  const groups: string[] = []
  const seen = new Set<string>()
  for (const form of forms) {
    const names = form.mappings
      .filter((mapping) => mapping.property !== HYDRA.pageIndex)
      .map(displayName)
      .sort()
    if (names.length === 0) continue
    const label = queryOnly(form.template) ? `any of ${names.join(', ')}` : names.join('+')
    if (seen.has(label)) continue
    seen.add(label)
    groups.push(label)
  }

  /*
   * The API's own prose per variable, under the advertised name. This is where a declared lexical
   * form lives — "yyyy-MM-dd" on a date-window variable — and dropping it is how a model ends up
   * inventing one. First comment per name wins; determinism comes from form order, which is the
   * declared order.
   */
  const notes: { name: string; comment: string }[] = []
  const noted = new Set<string>()
  for (const form of forms) {
    for (const mapping of form.mappings) {
      if (mapping.property === HYDRA.pageIndex) continue
      const comment = mapping.comment ?? null
      if (!comment) continue
      const name = displayName(mapping)
      if (noted.has(name)) continue
      noted.add(name)
      notes.push({ name, comment })
    }
  }
  notes.sort((a, b) => (a.name < b.name ? -1 : 1))

  return { combinations: groups.join(' · '), notes }
}

/**
 * The namespace this API mints its own terms in.
 *
 * Needed because a vocabulary declares classes from standard vocabularies alongside its own — this API's
 * `supportedClass` includes `hydra:Collection` — and some operations only make sense against the API's
 * own terms. Dereferencing `http://www.w3.org/ns/hydra/core#Collection` looking for *this API's* ontology
 * is meaningless, and rebasing it onto the connect origin produces a false conformance finding about
 * w3.org.
 *
 * Determined by counting declared classes per namespace and discarding the standard vocabularies the
 * client already reads with. That is arithmetic over declarations, not a guess about names: knowing the
 * standard vocabularies is the client's reading language, not knowledge of any one API.
 */
export function primaryNamespace(model: CapabilityModel): string | null {
  const standard = new Set<string>(Object.values(NS))
  const counts = new Map<string, number>()

  for (const cls of model.classes) {
    const hash = cls.iri.lastIndexOf('#')
    if (hash <= 0) continue
    const namespace = cls.iri.slice(0, hash + 1)
    if (standard.has(namespace)) continue
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1)
  }

  let best: string | null = null
  let most = 0
  for (const [namespace, count] of counts) {
    if (count > most) {
      most = count
      best = namespace
    }
  }
  return best
}

/** A SHACL property shape, joined to a Hydra property on the predicate IRI. */
export interface PropertyConstraints
  extends Readonly<{
    path: string
    datatype: string | null
    nodeKind: string | null
    minCount: number | null
    maxCount: number | null
    minLength: number | null
    maxLength: number | null
    pattern: string | null
    /** `sh:in` — the highest-value mapping: a prose hint becomes an enum the model cannot leave. */
    allowedValues: readonly string[]
    class: string | null
    node: string | null
  }> {}

/**
 * Constraints for a class, keyed by predicate IRI.
 *
 * Joined on `sh:path`, which is the same predicate IRI Hydra's `hydra:property` carries. That the join
 * key is an IRI rather than a name is the whole reason this works across two documents written
 * independently.
 */
export function constraintsFor(
  graph: SessionGraph,
  classIri: string,
  from: GraphName = GRAPHS.shapes,
): Map<string, PropertyConstraints> {
  const constraints = new Map<string, PropertyConstraints>()

  for (const shapeQuad of graph.match(null, SHACL.targetClass, classIri, from)) {
    readShapeProperties(graph, shapeQuad.subject, from, constraints)
  }

  return constraints
}

/**
 * Constraints of one shape, addressed by its own IRI rather than by what it targets.
 *
 * `sh:node` names a shape directly, and a shape reached that way need not declare a
 * `sh:targetClass` at all — this API's `UserRefShape` does not, so it is reachable *only* this
 * way. Nesting therefore cannot be resolved through `constraintsFor` alone.
 */
export function constraintsOfShape(
  graph: SessionGraph,
  shapeIri: string,
  from: GraphName = GRAPHS.shapes,
): Map<string, PropertyConstraints> {
  const constraints = new Map<string, PropertyConstraints>()
  readShapeProperties(graph, shapeIri, from, constraints)
  return constraints
}

/** Read every `sh:property` of one node shape into `into`, keyed by `sh:path`. */
function readShapeProperties(
  graph: SessionGraph,
  shape: TermLike,
  from: GraphName,
  into: Map<string, PropertyConstraints>,
): void {
  for (const shapeNode of nodes(graph, shape, SHACL.property, from)) {
    const path = text(graph, shapeNode, SHACL.path, from)
    if (!path) continue

    const number = (predicate: string): number | null => {
      const raw = text(graph, shapeNode, predicate, from)
      return raw === null ? null : Number(raw)
    }

    const [listHead] = graph.match(shapeNode, SHACL.in, null, from)

    into.set(path, {
      path,
      datatype: text(graph, shapeNode, SHACL.datatype, from),
      nodeKind: text(graph, shapeNode, SHACL.nodeKind, from),
      minCount: number(SHACL.minCount),
      maxCount: number(SHACL.maxCount),
      minLength: number(SHACL.minLength),
      maxLength: number(SHACL.maxLength),
      pattern: text(graph, shapeNode, SHACL.pattern, from),
      // The list head is a blank node, so it has to travel as a term.
      allowedValues: readList(graph, listHead ? listHead.object : null, from),
      class: text(graph, shapeNode, SHACL.class, from),
      node: text(graph, shapeNode, SHACL.node, from),
    })
  }
}

/**
 * Walk an RDF collection into an array.
 *
 * `sh:in` is always an RDF list, so an enum cannot be read without following `rdf:first`/`rdf:rest` to
 * `rdf:nil`. The guard is a malformed-list backstop: a list whose `rest` chain cycles would otherwise
 * spin here rather than surfacing as a bad shapes graph.
 */
function readList(graph: SessionGraph, head: Term | null, from: GraphName): string[] {
  const values: string[] = []
  const seen = new Set<string>()
  let node: Term | null = head

  while (node !== null && node.value !== RDF.nil && !seen.has(node.value)) {
    seen.add(node.value)

    const value = text(graph, node, RDF.first, from)
    if (value !== null) values.push(value)

    const [rest] = graph.match(node, RDF.rest, null, from)
    node = rest ? rest.object : null
  }

  return values
}
