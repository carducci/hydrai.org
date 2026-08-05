import { FINDING_KINDS, type Findings } from '../rdf/findings'
import { NS, SHACL } from '../rdf/terms'
import {
  unboundVariables,
  type CapabilityModel,
  type ClassCapability,
  type OperationCapability,
  type PropertyCapability,
  type PropertyConstraints,
  type StatusOutcome,
  type TemplateCapability,
} from '../vocab/capability'

/**
 * Projection: capability model to tool definitions (tasks 4.1-4.5, design D1 and D3).
 *
 * The generic artifact of this whole client is the function below. Point it at a different Hydra
 * API and the toolset differs with no code change, because every name, every schema and every
 * description is read out of what that server declared. `test/fixtures/library-vocab.json` exists
 * to prove exactly that.
 *
 * Two invariants hold above this layer:
 *
 * - **Nothing here builds a URL.** A projected tool carries the declaring class IRI and, for a
 *   template, the template string the server published. Turning either into a request is the
 *   execution layer's job (stage 5).
 * - **A schema property name is a label; the predicate IRI is the identity.** Names exist for the
 *   model to read. Every one is paired with its predicate IRI in `bindings`, so the payload is
 *   assembled from IRIs rather than from the names the model saw.
 */

/**
 * Whether `sh:pattern` survives strict structured outputs.
 *
 * Design D3 left this open deliberately and **task 3.4 has not run yet** — the documented schema
 * limits list what is supported and what is not, and `pattern` appears in neither list. So the
 * question is still genuinely open rather than answerable by reading.
 *
 * `false` is the safe default and the one to keep until 3.4 says otherwise: a pattern evaluated by
 * the gate is correct whether or not the platform would also have enforced it, whereas emitting an
 * unsupported keyword risks the API rejecting every tool definition carrying one. Flipping this to
 * `true` moves patterns from the gate into the schema, which is the one-line change D3 promised.
 */
export const PATTERN_IN_SCHEMA = false

/** The subset of JSON Schema strict structured outputs accepts. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null'
  format?: string
  enum?: readonly string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: false
  items?: JsonSchema
  $ref?: string
  $defs?: Record<string, JsonSchema>
}

/** A schema property (or template variable) and the predicate IRI it stands for. */
export interface ToolBinding {
  readonly name: string
  /**
   * The RDF predicate this input carries a value for, or `null` for the subject IRI — which is not
   * a predicate at all but the resource the operation acts on.
   */
  readonly property: string | null
  /** A `hydra:Link` carries a reference to another resource rather than a literal. */
  readonly isLink: boolean
  /**
   * For a property shaped by `sh:node`: the bindings of the nested object's own fields, so a
   * supplied nested value is converted to predicate IRIs at every depth. The names the model
   * writes inside a nested object are labels exactly as they are at the top level — without this,
   * a nested field would reach the wire under its label, which is the C9 class one level down.
   */
  readonly nested?: readonly ToolBinding[]
}

export type ResidueKind =
  | 'maxLength'
  | 'minLength'
  | 'maxCount'
  | 'pattern'
  | 'class'
  | 'node'
  | 'unknownDatatype'
  | 'undeclaredLinkRange'

/**
 * A published constraint that JSON Schema could not carry.
 *
 * This list is the stage-5 gate's input, and the reason there is no `validate` tool: a check the
 * model chooses to run fails exactly when the model is overconfident.
 */
export interface ConstraintResidue {
  /**
   * Where the value sits in the tool's input, as a dotted path — `heading`, or `borrower.known_as`
   * for one inside a nested object. A bare name would be ambiguous the moment two shapes declared the
   * same property, and the stage-5 gate has to find the actual value to evaluate the constraint
   * against.
   */
  readonly schemaName: string
  readonly property: string
  readonly kind: ResidueKind
  /** The published value, where there is one to carry (a length, a regex, a class IRI). */
  readonly value: string | number | null
  /** Stated so the gate's rejection can name the constraint rather than describe it vaguely. */
  readonly message: string
}

/**
 * One address form a folded query tool can expand.
 *
 * A collection that publishes several `hydra:IriTemplate`s is publishing several *addresses* for one
 * capability, not several capabilities — so they fold into one tool and the address is chosen at call
 * time from what was actually supplied. Before this, each template became its own tool, and because
 * they all classified alike their names collided and resolved by a digest of the class IRI: this API
 * offered `list_CallCollection_62jv79`, `_hiztlv` and `_pdaabf`, three names carrying **nothing** a
 * model could choose between. A surface the model cannot read is not a surface.
 *
 * This is not the hand-picked verb set design D1 rejects. D1's argument is against inventing
 * capabilities the vocabulary never declared; folding declares no new capability and drops none —
 * every published template is still reachable, and the union of their variables is exactly what the
 * server said could be filtered on.
 */
export interface FoldedTemplate {
  readonly template: string
  readonly kind: TemplateCapability['kind']
  /** Schema names of the variables this template carries, so selection can test coverage. */
  readonly variables: readonly string[]
  /**
   * Each variable with the predicate it binds to. Two address forms may name the same predicate
   * differently — this API's path form says `status` where its query form says `eventStatus`, both
   * bound to the same predicate — and the predicate is the identity, so dispatch translates a
   * supplied name into the chosen form's own spelling through these.
   */
  readonly mappings: readonly {
    readonly variable: string
    readonly property: string | null
    /** The API's own prose about the variable — its declared lexical form lives here. */
    readonly comment: string | null
  }[]
}

/** What the execution layer needs to turn a tool call into a request. Never shown to the model. */
export interface ToolDispatch {
  /**
   * How the execution layer turns this call into work.
   *
   * `operation` and `template` are projections of what the server declared. `query` is not projected
   * from anything — it is a capability the client offers at every tier, and it is here rather than in
   * `projectTools` for that reason: the projection must stay a pure function of the vocabulary, or
   * the claim that pointing this at another API changes the toolset with no code change stops being
   * checkable. See `query/tool.ts`.
   */
  readonly kind: 'operation' | 'template' | 'query'
  /** The class that declared this affordance. The dispatch key is derived from this, not from a
   * blank-node label, so it survives a reconnect. */
  readonly classIri: string
  readonly method: string
  /**
   * Every RFC 6570 template this tool can expand, in the order they were declared. Empty for an
   * operation. More than one when a collection published more than one address form — see
   * {@link FoldedTemplate}.
   */
  readonly templates: readonly FoldedTemplate[]
  readonly expects: string | null
  readonly returns: string | null
  readonly possibleStatus: readonly StatusOutcome[]
  /** True when the operation acts on a resource the caller must identify. */
  readonly needsSubject: boolean
  readonly bindings: readonly ToolBinding[]
  readonly residue: readonly ConstraintResidue[]
}

export interface ProjectedTool {
  readonly name: string
  readonly description: string
  readonly input_schema: JsonSchema
  /** Strict structured outputs. Every constraint that survived into the schema is then enforced by
   * the platform rather than by the model or by this client. */
  readonly strict: true
  readonly dispatch: ToolDispatch
}

export interface ToolSurface {
  readonly tools: readonly ProjectedTool[]
  /** Every constraint the schemas could not express, across every tool. */
  readonly residue: readonly ConstraintResidue[]
  byName(name: string): ProjectedTool | undefined
  /** The wire form: what actually goes in the request, with dispatch metadata stripped. */
  definitions(): readonly { name: string; description: string; input_schema: JsonSchema; strict: true }[]
}

export interface ProjectionDeps {
  /** Constraints for a class, keyed by predicate IRI. */
  readonly constraintsFor: (classIri: string) => Map<string, PropertyConstraints>
  /** Constraints of a shape addressed by its own IRI — how `sh:node` nesting is resolved. */
  readonly constraintsOfShape: (shapeIri: string) => Map<string, PropertyConstraints>
  readonly findings?: Findings
}

/**
 * The local name of an IRI.
 *
 * Splitting at a fragment or the last path segment is what the IRI's own syntax means, and it is
 * the same operation task 3.6 relies on to dereference a term. It is emphatically **not** the
 * morphology the rebuild exists to remove: nothing here stems, singularises or substring-matches.
 */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  if (hash >= 0) return iri.slice(hash + 1)
  const slash = iri.lastIndexOf('/')
  return slash >= 0 ? iri.slice(slash + 1) : iri
}

/** Tool and property names must match `^[a-zA-Z0-9_-]{1,64}$`. */
function sanitise(value: string, limit = 64): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, limit)
  return cleaned.length > 0 ? cleaned : 'unnamed'
}

/**
 * The name a predicate is offered to the model under.
 *
 * Exported so the execution layer renders a result under the same names the model was offered inputs
 * under. Two derivations would drift, and a value shown as `jobTitle` that has to be sent back as
 * `job_title` is a puzzle the model has to solve rather than a fact it can use.
 */
export function schemaNameFor(predicateIri: string): string {
  return sanitise(localName(predicateIri))
}

/**
 * A short stable digest, for discriminating names that collide.
 *
 * FNV-1a over the full IRI. Opaque, but the requirement is stability rather than legibility: the
 * dispatch key has to be the same on every connect to the same vocabulary, and a counter assigned
 * in iteration order would not be.
 */
function digest(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

const XSD = NS.xsd

/** Design D3's datatype rows. Every format here is one strict structured outputs accepts. */
const DATATYPES: Record<string, JsonSchema> = {
  [`${XSD}string`]: { type: 'string' },
  [`${XSD}normalizedString`]: { type: 'string' },
  [`${XSD}token`]: { type: 'string' },
  [`${XSD}boolean`]: { type: 'boolean' },
  [`${XSD}integer`]: { type: 'integer' },
  [`${XSD}int`]: { type: 'integer' },
  [`${XSD}long`]: { type: 'integer' },
  [`${XSD}short`]: { type: 'integer' },
  [`${XSD}nonNegativeInteger`]: { type: 'integer' },
  [`${XSD}positiveInteger`]: { type: 'integer' },
  [`${XSD}decimal`]: { type: 'number' },
  [`${XSD}double`]: { type: 'number' },
  [`${XSD}float`]: { type: 'number' },
  [`${XSD}dateTime`]: { type: 'string', format: 'date-time' },
  [`${XSD}date`]: { type: 'string', format: 'date' },
  [`${XSD}time`]: { type: 'string', format: 'time' },
  [`${XSD}duration`]: { type: 'string', format: 'duration' },
  [`${XSD}anyURI`]: { type: 'string', format: 'uri' },
}

/**
 * The datatypes this client knows how to read.
 *
 * Exported for stage 7's term gate, which has to tell a datatype it understands from one it does not.
 * Derived from the table above rather than listed again, so the two cannot drift: a datatype the
 * projection learns to map is one the gate immediately accepts.
 */
export const MAPPED_DATATYPES: readonly string[] = Object.keys(DATATYPES)

interface SchemaResult {
  readonly schema: JsonSchema
  readonly residue: readonly ConstraintResidue[]
  /** For a nested-object schema: the bindings of its fields, name → predicate IRI. */
  readonly nested?: readonly ToolBinding[]
}

/**
 * One property's schema, plus whatever its constraints could not say in JSON Schema.
 *
 * The split follows design D3 exactly. What survives into the schema is enforced by the platform
 * on every tool call; what does not is returned as residue for the dispatch gate.
 */
function schemaFor(
  schemaName: string,
  property: string,
  constraints: PropertyConstraints | undefined,
  options: { isLink: boolean; range: string | null; description: string | null },
  deps: ProjectionDeps,
  defs: Record<string, JsonSchema>,
  visitedShapes: readonly string[],
): SchemaResult {
  const residue: ConstraintResidue[] = []
  const record = (kind: ResidueKind, value: string | number | null, message: string) =>
    residue.push({ schemaName, property, kind, value, message })

  let schema: JsonSchema = {}
  let nestedBindings: readonly ToolBinding[] | undefined

  // sh:in is the highest-value row in D3: a prose hint becomes a set the model cannot leave.
  if (constraints && constraints.allowedValues.length > 0) {
    schema = { type: 'string', enum: [...constraints.allowedValues].sort() }
  } else if (constraints?.node) {
    // Nested object. Resolved through the shape's own IRI, because a shape reached by sh:node need
    // not declare a target class — this API's UserRefShape does not.
    const nested = nestedSchema(constraints.node, deps, defs, visitedShapes, schemaName)
    if (nested) {
      schema = nested.schema
      nestedBindings = nested.bindings
      // Folded in rather than discarded: a constraint on a nested property that reached neither the
      // schema nor the gate would be published and enforced nowhere.
      residue.push(...nested.residue)
    } else {
      schema = { type: 'string', format: 'uri' }
      record(
        'node',
        constraints.node,
        `<${property}> is shaped by <${constraints.node}>, which could not be projected as a ` +
          `nested object (recursive shapes are not expressible in a strict schema). Supply a ` +
          `reference IRI instead; the constraint is checked before dispatch.`,
      )
    }
  } else if (constraints?.datatype) {
    const mapped = DATATYPES[constraints.datatype]
    if (mapped) {
      schema = { ...mapped }
    } else {
      schema = { type: 'string' }
      record(
        'unknownDatatype',
        constraints.datatype,
        `<${property}> declares datatype <${constraints.datatype}>, which has no JSON Schema ` +
          `equivalent. Typed as a string and checked before dispatch.`,
      )
    }
  } else if (constraints?.nodeKind === SHACL.IRI || options.isLink) {
    schema = { type: 'string', format: 'uri' }
  } else {
    schema = { type: 'string' }
  }

  // A Link with no declared range cannot be resolved deterministically. It stays in the schema and
  // escalates at dispatch (design D8) — the proof of concept dropped the field, which is the
  // failure this records rather than repeats.
  if (options.isLink && !options.range && !constraints?.class && !constraints?.node) {
    record(
      'undeclaredLinkRange',
      null,
      `<${property}> is a hydra:Link with no declared range, so a value cannot be resolved to a ` +
        `resource deterministically. Pass an @id obtained from a prior read, or omit the field.`,
    )
  }

  // Rows D3 marks as runtime-gated. Each is a real published constraint; none is expressible.
  if (constraints?.maxLength !== null && constraints?.maxLength !== undefined) {
    record('maxLength', constraints.maxLength, `<${property}> allows at most ${constraints.maxLength} characters.`)
  }
  if (constraints?.minLength !== null && constraints?.minLength !== undefined) {
    record('minLength', constraints.minLength, `<${property}> requires at least ${constraints.minLength} characters.`)
  }
  if (constraints?.maxCount !== null && constraints?.maxCount !== undefined && constraints.maxCount !== 1) {
    // maxCount 1 is already implied by a non-array schema, so only a genuine plurality is residue.
    record('maxCount', constraints.maxCount, `<${property}> accepts at most ${constraints.maxCount} values.`)
  }
  if (constraints?.class) {
    record(
      'class',
      constraints.class,
      `<${property}> must reference a resource of type <${constraints.class}>, which requires ` +
        `resolving the reference before the request is issued.`,
    )
  }
  if (constraints?.pattern) {
    if (PATTERN_IN_SCHEMA && schema.type === 'string' && !schema.enum) {
      // Deliberately not spread into the object above: the switch has to be visible here.
      ;(schema as { pattern?: string }).pattern = constraints.pattern
    } else {
      record('pattern', constraints.pattern, `<${property}> must match /${constraints.pattern}/.`)
    }
  }

  if (options.description) schema.description = options.description

  return nestedBindings ? { schema, residue, nested: nestedBindings } : { schema, residue }
}

/**
 * Project a `sh:node` target into `$defs` and return a `$ref` to it, plus whatever the nested shape
 * published that JSON Schema could not carry.
 *
 * Returns `null` on a cycle. Recursive schemas are not expressible in a strict schema, and a shape
 * that referenced an ancestor would otherwise recurse here rather than surfacing as a limit.
 *
 * The `$defs` entry is shared by every use of the shape, but the **residue is not**: it is addressed
 * by the path the value sits at, so the gate can find the value to evaluate. Two properties shaped by
 * the same node therefore each get their own residue entries, which is why this descends every time
 * rather than short-circuiting on a populated `defs`.
 */
function nestedSchema(
  shapeIri: string,
  deps: ProjectionDeps,
  defs: Record<string, JsonSchema>,
  visitedShapes: readonly string[],
  pathPrefix: string,
): { schema: JsonSchema; residue: readonly ConstraintResidue[]; bindings: readonly ToolBinding[] } | null {
  if (visitedShapes.includes(shapeIri)) return null

  const key = sanitise(localName(shapeIri))
  // Reserve the key before descending, so a cycle is detected by the visited list rather than by
  // running out of stack.
  defs[key] = { type: 'object', additionalProperties: false, properties: {}, required: [] }

  const nested = deps.constraintsOfShape(shapeIri)
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const residue: ConstraintResidue[] = []
  const bindings: ToolBinding[] = []

  for (const path of [...nested.keys()].sort()) {
    const constraints = nested.get(path)!
    const name = sanitise(localName(path))
    const built = schemaFor(
      `${pathPrefix}.${name}`,
      path,
      constraints,
      { isLink: false, range: null, description: null },
      deps,
      defs,
      [...visitedShapes, shapeIri],
    )
    properties[name] = built.schema
    residue.push(...built.residue)
    bindings.push({ name, property: path, isLink: false, ...(built.nested ? { nested: built.nested } : {}) })
    if ((constraints.minCount ?? 0) >= 1) required.push(name)
  }

  defs[key] = { type: 'object', additionalProperties: false, properties, required: required.sort() }

  return { schema: { $ref: `#/$defs/${key}` }, residue, bindings }
}

/** The subject an operation acts on. Not a predicate — the resource itself. */
const SUBJECT = 'id'

interface BuiltSchema {
  readonly schema: JsonSchema
  readonly bindings: readonly ToolBinding[]
  readonly residue: readonly ConstraintResidue[]
}

/** Methods whose write assembles a full representation from a pre-write read (see `execute/dispatch`). */
const REPLACING_METHODS = new Set(['PUT'])

/** Build the input schema for a set of writeable properties, plus an optional subject IRI. */
function buildBodySchema(
  properties: readonly PropertyCapability[],
  constraints: Map<string, PropertyConstraints>,
  needsSubject: boolean,
  replaces: boolean,
  deps: ProjectionDeps,
): BuiltSchema {
  const schemaProperties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const bindings: ToolBinding[] = []
  const residue: ConstraintResidue[] = []
  const defs: Record<string, JsonSchema> = {}

  if (needsSubject) {
    schemaProperties[SUBJECT] = {
      type: 'string',
      format: 'uri',
      description: 'The IRI of the resource to act on, as returned by a prior read.',
    }
    required.push(SUBJECT)
    bindings.push({ name: SUBJECT, property: null, isLink: false })
  }

  // Names can collide when two predicates from different namespaces share a local name.
  const taken = new Set<string>(Object.keys(schemaProperties))

  for (const property of properties) {
    let name = sanitise(localName(property.iri))
    if (taken.has(name)) name = sanitise(`${name}_${digest(property.iri)}`)
    taken.add(name)

    const built = schemaFor(
      name,
      property.iri,
      constraints.get(property.iri),
      { isLink: property.isLink, range: property.range, description: property.description },
      deps,
      defs,
      [],
    )

    schemaProperties[name] = built.schema
    residue.push(...built.residue)
    bindings.push({
      name,
      property: property.iri,
      isLink: property.isLink,
      ...(built.nested ? { nested: built.nested } : {}),
    })

    // Required is the union of what Hydra and SHACL each say. Either declaration is sufficient — but
    // only for a **create**. A replacing write (PUT) assembles the body from a pre-write read of the
    // current representation and overlays the model's changes (`execute/dispatch` → `buildPayload`),
    // so a mandatory field the model does not restate is carried forward from what the server already
    // holds, not cleared. Marking it required there would force the model to re-supply every
    // mandatory field on every edit — turning a one-field change into a full re-statement, and making
    // strict mode reject the partial call the gate would otherwise complete. The subject stays
    // required: it identifies the resource and there is nothing to merge it from.
    const constraint = constraints.get(property.iri)
    if (!replaces && (property.required || (constraint?.minCount ?? 0) >= 1)) required.push(name)
  }

  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: schemaProperties,
    required: required.sort(),
  }
  if (Object.keys(defs).length > 0) schema.$defs = defs

  return { schema, bindings, residue }
}

/** Build the input schema for an IRI template, from what its variables bind to. */
function buildTemplateSchema(
  templates: readonly TemplateCapability[],
  constraints: Map<string, PropertyConstraints>,
  deps: ProjectionDeps,
): BuiltSchema {
  const schemaProperties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const bindings: ToolBinding[] = []
  const residue: ConstraintResidue[] = []
  const defs: Record<string, JsonSchema> = {}
  const seen = new Set<string>()

  for (const mapping of templates.flatMap((template) => template.mappings)) {
    const name = sanitise(mapping.variable)
    // The union, not a concatenation. Two templates filtering on the same variable describe the same
    // input, so it is declared once — and declaring it twice would emit a duplicate key that the
    // second write silently wins, along with a duplicate binding the payload builder would apply
    // twice.
    if (seen.has(name)) continue
    seen.add(name)

    // A variable bound to a declared predicate inherits that predicate's published constraints; the
    // Hydra control variables (pageIndex, freetextQuery) have none to inherit. A binding that is not
    // an IRI inherits nothing either — it names no predicate to look constraints up by, however much
    // it resembles one.
    const constraint = mapping.propertyIsIri ? constraints.get(mapping.property ?? '') : undefined
    const built = schemaFor(
      name,
      mapping.property ?? name,
      constraint,
      { isLink: false, range: null, description: mapping.comment },
      deps,
      defs,
      [],
    )

    // A pagination variable is an ordinal, whatever the vocabulary called it.
    const schema = mapping.property === `${NS.hydra}pageIndex` ? { ...built.schema, type: 'integer' as const } : built.schema

    schemaProperties[name] = schema
    residue.push(...built.residue)
    bindings.push({ name, property: mapping.property, isLink: false })
    // Required only when there is one address form. Across several, "required" has no meaning at the
    // tool's boundary: a variable a lookup template demands is one a plain listing must not, so
    // marking it required would make the listing uncallable. Which template applies is decided from
    // what was supplied, and a call matching none is refused there — by `target`, naming the values
    // no published template could carry.
    if (mapping.required && templates.length === 1) required.push(name)
  }

  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: schemaProperties,
    required: required.sort(),
  }
  if (Object.keys(defs).length > 0) schema.$defs = defs

  return { schema, bindings, residue }
}

/**
 * The description the model reads.
 *
 * The vocabulary's own prose leads, **verbatim** (task 4.2). This API's `PutOperation` explains
 * replace-semantics — that every writeable property not supplied is cleared — and that paragraph is
 * exactly what stops a model mangling an update, so paraphrasing it would be throwing away the most
 * valuable sentence the server published. Everything appended after it is also declared: the
 * method, the types, and the outcomes the vocabulary lists.
 */
function describeOperation(cls: ClassCapability, operation: OperationCapability): string {
  const lines: string[] = []

  const prose = operation.description ?? operation.title
  if (prose) lines.push(prose)

  lines.push(`${operation.method} on ${cls.title ?? localName(cls.iri)} (<${cls.iri}>).`)
  if (operation.expects) lines.push(`Expects <${operation.expects}>.`)
  if (operation.returns) lines.push(`Returns <${operation.returns}>.`)

  if (operation.possibleStatus.length > 0) {
    const outcomes = operation.possibleStatus
      .map((status) => `${status.code}${status.description ? ` — ${status.description}` : ''}`)
      .join('; ')
    lines.push(`Declared outcomes: ${outcomes}.`)
  }

  return lines.join('\n\n')
}

function describeTemplate(cls: ClassCapability, templates: readonly TemplateCapability[]): string {
  const lines: string[] = []

  // Every label the server published, deduplicated. These are the only prose the vocabulary offers
  // about what each address form is for, and folding must not be the reason a model stops seeing it.
  const labels = [...new Set(templates.map((template) => template.label).filter(Boolean))]
  for (const label of labels) lines.push(label as string)

  lines.push(`GET over ${cls.title ?? localName(cls.iri)} (<${cls.iri}>).`)

  if (templates.length > 1) {
    lines.push(
      `Every parameter is optional and they combine: supply the ones you want to filter or page ` +
        `by. This API publishes ${templates.length} address forms for this collection and the ` +
        `matching one is chosen from what you supply, so a combination none of them carries is ` +
        `refused before any request is issued rather than being silently ignored.`,
    )
  }

  const seen = new Set<string>()
  for (const mapping of templates.flatMap((template) => template.mappings)) {
    if (!mapping.comment || seen.has(mapping.variable)) continue
    seen.add(mapping.variable)
    lines.push(`${mapping.variable}: ${mapping.comment}`)
  }

  return lines.join('\n\n')
}

/**
 * The verb in a tool name.
 *
 * Design D1 illustrates these as `update_`/`create_`/`list_`, but those are four of the five verbs
 * the POC hand-picked and that D1's own argument rejects. The declared HTTP method is what the
 * server actually published, and using it verbatim keeps the name a projection rather than an
 * interpretation — a vocabulary declaring PATCH, or any custom method, names itself correctly with
 * no mapping table to extend. Templates have no method to use, so they take the kind the *bindings*
 * imply, which is derived the same way task 3.3 derives it.
 */
function templateVerb(kind: TemplateCapability['kind']): string {
  return kind === 'pagination' ? 'list' : kind === 'freetext' ? 'search' : kind
}

/**
 * The verb for a folded tool, from the kinds it carries.
 *
 * Still derived and not chosen: the order below is the order of *capability*, so the name reports
 * the most the tool can do. A collection offering free-text search reads as `search_`, one offering
 * only paging reads as `list_`, and neither name is in a table anyone maintains — a vocabulary that
 * publishes some other combination names itself from the same rule.
 */
function foldedVerb(kinds: readonly TemplateCapability['kind'][]): string {
  const order: TemplateCapability['kind'][] = ['freetext', 'filter', 'pagination', 'lookup']
  const best = order.find((kind) => kinds.includes(kind))
  return templateVerb(best ?? kinds[0] ?? 'filter')
}

/**
 * The envelope surface (design D1): the tools the model actually sees.
 *
 * Constant across APIs — capability arrives as content (the affordance index in the prompt, the
 * affordance block on every result), not as tool definitions. A vocabulary of any size projects
 * the same five controls, so the surface always fits under the strict cap and nothing ever defers.
 *
 * `strict` is kept **where it is free** (architecture note §8) and only there: `follow` and
 * `get_resource` have trivial closed schemas. `search_collection.filters` and `invoke.input` are
 * open objects by construction — their keys differ per collection and per affordance — and a
 * strict schema cannot carry an open object (`additionalProperties: false` is required on every
 * object, and a typed `additionalProperties` is rejected; measured, §3). Contorting them into
 * strict-expressible shapes would be architecting around `strict`, so those two tools go without
 * it and the dispatch gate — the always-on validator on every path — enforces their contents.
 */
export interface EnvelopeToolDefinition {
  readonly name: string
  readonly description: string
  readonly input_schema: JsonSchema
  readonly strict?: true
}

export const ENVELOPE = {
  follow: 'follow',
  searchCollection: 'search_collection',
  getResource: 'get_resource',
  invoke: 'invoke',
} as const

export const ENVELOPE_TOOLS: readonly EnvelopeToolDefinition[] = [
  {
    name: ENVELOPE.follow,
    description:
      `Dereference an IRI — the entry point, a resource, or a collection discovered at runtime — ` +
      `and read what it holds. A collection result lists member identifiers and counts; the ` +
      `members themselves land in the session store, not in your context. Every result ends with ` +
      `the affordances of what it holds: the operations you can invoke, the filters you can ` +
      `search by, and pagination state. Following the entry point lists this API's collections.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        /*
         * Deliberately no `format: 'uri'` on any envelope IRI input. Measured live, 2026-08-02:
         * under strict constrained decoding a URI grammar rejects dotless hosts, so against a
         * deployment on `localhost:1648` the model *cannot* emit the true IRI in this field and
         * is forced to hallucinate a dot — `localhost.com:1648`, escalating to gibberish as it
         * retries what it can see is wrong but cannot spell. Architecture note §8's rule cuts the
         * other way here: the keyword was not free. Validation belongs to the URL parse and the
         * gate, where it always ran anyway.
         */
        iri: { type: 'string', description: 'The absolute IRI to dereference, exactly as a result or the index spelled it.' },
      },
      required: ['iri'],
    },
    strict: true,
  },
  {
    name: ENVELOPE.searchCollection,
    description:
      `Find records in a collection by its declared filters. "collection" is the collection's IRI ` +
      `(or its class IRI) as listed in your instructions or in a prior result. "filters" maps ` +
      `filter variables to values, using exactly the variables declared for that collection — ` +
      `filters combine (AND), and an unknown filter name is refused before any request is issued, ` +
      `naming the declared ones. With no filters this is the plain listing.`,
    input_schema: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The IRI of the collection to search, or of the class its members are.',
        },
        filters: {
          type: 'object',
          description:
            'Filter variable → value, using the variables declared for this collection. Omit for ' +
            'the plain listing.',
        },
      },
      required: ['collection'],
    },
  },
  {
    name: ENVELOPE.getResource,
    description:
      `Read one resource in full by its IRI — a fresh dereference of its current state. The ` +
      `result carries the resource's values and its affordances.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // No `format: 'uri'` — see the note on `follow`: the grammar forbade dotless hosts.
        iri: { type: 'string', description: 'The absolute IRI of the resource to read, exactly as a result spelled it.' },
      },
      required: ['iri'],
    },
    strict: true,
  },
  {
    name: ENVELOPE.invoke,
    description:
      `Execute an affordance a previous result offered. "affordance" is the handle exactly as it ` +
      `was disclosed; "input" is an object with the fields from that affordance's contract, ` +
      `including "id" where the contract asks for the resource's IRI. The input is validated ` +
      `against the constraints this API publishes before any request is issued — a refusal names ` +
      `the constraint, and no request was made.`,
    input_schema: {
      type: 'object',
      properties: {
        affordance: { type: 'string', description: 'The handle a result disclosed.' },
        input: {
          type: 'object',
          description: "The affordance's fields, as its contract describes them.",
        },
      },
      required: ['affordance', 'input'],
    },
  },
]

/**
 * Project the capability model into the affordance registry.
 *
 * One record per declared operation and per declared IRI template — no longer sent to the model
 * as tools, but retained whole: the record's name is the **handle** a result disclosed and
 * `invoke` resolves, its schema and residue are the contract renderer's input and the dispatch
 * gate's checklist. Names derive from the **declaring** class rather than from `hydra:expects`:
 * the operation is declared on that class and dispatches against it, and two collections
 * expecting the same member type would otherwise collide.
 */
export function projectTools(model: CapabilityModel, deps: ProjectionDeps): ToolSurface {
  const tools: ProjectedTool[] = []
  const residue: ConstraintResidue[] = []
  const taken = new Set<string>()

  /** Reserve a tool name, discriminating a collision deterministically rather than by order. */
  const claim = (base: string, discriminator: string): string => {
    const name = sanitise(base)
    if (!taken.has(name)) {
      taken.add(name)
      return name
    }
    const suffixed = sanitise(`${name.slice(0, 64 - 8)}_${digest(discriminator)}`)
    taken.add(suffixed)
    return suffixed
  }

  // model.classes is already sorted by IRI, which is what makes the surface byte-identical across
  // connects. Tools render at prompt-prefix position 0, so a reorder invalidates the whole cache.
  for (const cls of model.classes) {
    const constraints = deps.constraintsFor(cls.iri)
    const stem = localName(cls.iri)

    // Templates fold on a **collection** and only there. A collection's templates are address forms
    // for querying it, so they are one capability; elsewhere a template is a distinct affordance
    // (the entry point's user lookup is not a variant of anything) and folding would merge two
    // things the server did not say were the same.
    const foldTemplates = cls.isCollection && cls.templates.length > 0
    const templateGroups: (readonly TemplateCapability[])[] = foldTemplates
      ? [cls.templates]
      : cls.templates.map((template) => [template])

    for (const operation of cls.operations) {
      // A collection's GET *is* its query tool: the folded tool takes no required input, so calling
      // it with nothing supplied is exactly the plain GET this would have emitted. Keeping both
      // published two names for one request and left the model choosing between them on no
      // information. Only GET is absorbed — POST on a collection is a different act entirely.
      if (foldTemplates && operation.method.toUpperCase() === 'GET') continue

      const body = model.byIri(operation.expects ?? '')

      if (operation.expects && !body) {
        // Declared but unprojectable: the expected type is not described anywhere we can read.
        // Reported rather than silently offered with an empty body (design D8).
        deps.findings?.record({
          about: cls.iri,
          kind: FINDING_KINDS.unprojectableOperation,
          message:
            `${operation.method} on <${cls.iri}> expects <${operation.expects}>, which the ` +
            `vocabulary does not describe as a supported class. The operation is offered without a ` +
            `body schema, so its payload cannot be validated. Declaring that class would fix it.`,
        })
      }

      // Writes carry a body; a read or a delete does not.
      const writeable = body ? body.properties.filter((property) => property.writeable) : []
      // A collection's own IRI comes from discovery. A resource has to be named by the caller.
      const needsSubject = !cls.isCollection

      const built = buildBodySchema(
        writeable,
        body ? deps.constraintsFor(body.iri) : constraints,
        needsSubject,
        REPLACING_METHODS.has(operation.method.toUpperCase()),
        deps,
      )

      const name = claim(
        `${operation.method.toLowerCase()}_${stem}`,
        `${cls.iri}|${operation.method}|${operation.title ?? ''}`,
      )

      residue.push(...built.residue)
      tools.push({
        name,
        description: describeOperation(cls, operation),
        input_schema: built.schema,
        strict: true,
        dispatch: {
          kind: 'operation',
          classIri: cls.iri,
          method: operation.method,
          templates: [],
          expects: operation.expects,
          returns: operation.returns,
          possibleStatus: operation.possibleStatus,
          needsSubject,
          bindings: built.bindings,
          residue: built.residue,
        },
      })
    }

    for (const group of templateGroups) {
      const built = buildTemplateSchema(group, constraints, deps)
      const name = claim(
        `${foldedVerb(group.map((template) => template.kind))}_${stem}`,
        // Discriminated by every template the tool carries, so the digest is a function of the
        // folded set rather than of whichever member happened to come first.
        `${cls.iri}|${group.map((template) => template.template).join('|')}`,
      )

      // Reported per template, not per tool. Folding changes which tool a variable arrives on; it
      // must not change how many defects the API is told it has, or the finding count would move
      // with a client-side decision.
      for (const template of group) {
        const unbound = unboundVariables(template)
        if (unbound.length === 0) continue
        deps.findings?.record({
          about: template.template,
          kind: FINDING_KINDS.unboundTemplateVariable,
          message:
            `The template ${template.template} declares ${unbound.length} variable` +
            `${unbound.length === 1 ? '' : 's'} that bind to no property: ${unbound.join(', ')}. ` +
            `A binding must be an IRI; one published as a plain string names nothing. So this ` +
            `template cannot be recognised as pagination or free-text search, and no published ` +
            `constraint can be applied to those values before a request is issued. Publishing the ` +
            `mapping under the Hydra term "property" rather than the compact key "hydra:property" ` +
            `would make the binding an IRI, because only the term carries "@type": "@id".`,
        })
      }

      residue.push(...built.residue)
      tools.push({
        name,
        description: describeTemplate(cls, group),
        input_schema: built.schema,
        strict: true,
        dispatch: {
          kind: 'template',
          classIri: cls.iri,
          method: 'GET',
          templates: group.map((template) => ({
            template: template.template,
            kind: template.kind,
            variables: template.mappings.map((mapping) => sanitise(mapping.variable)),
            mappings: template.mappings.map((mapping) => ({
              variable: sanitise(mapping.variable),
              property: mapping.propertyIsIri ? mapping.property : null,
              comment: mapping.comment,
            })),
          })),
          expects: null,
          returns: null,
          possibleStatus: [],
          needsSubject: false,
          bindings: built.bindings,
          residue: built.residue,
        },
      })
    }
  }

  // Sorted by name, not by discovery order: the name is the only identity the model and the
  // dispatch map share, and sorting on it makes the surface reproducible.
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const entry of residue) {
    if (entry.kind === 'undeclaredLinkRange') {
      deps.findings?.record({
        about: entry.property,
        kind: FINDING_KINDS.undeclaredLinkRange,
        message: entry.message,
      })
    } else if (entry.kind === 'node' || entry.kind === 'unknownDatatype') {
      deps.findings?.record({
        about: entry.property,
        kind: FINDING_KINDS.unevaluableConstraint,
        message: entry.message,
      })
    }
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  return {
    tools,
    residue,
    byName: (name) => byName.get(name),
    definitions: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        strict: tool.strict,
      })),
  }
}
