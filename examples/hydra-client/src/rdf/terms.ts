/**
 * Every IRI the client itself mints or relies on, in one place.
 *
 * Two rules govern this file:
 *
 * 1. **Nothing here names a deployment.** These are the client's own identifiers and the standard
 *    vocabularies it reads with. The 1.8 lint enforces it.
 * 2. **The client does not mint terms in other people's namespaces.** Where a standard vocabulary
 *    already has a term for something, that term is used; where it does not, the term goes in the
 *    client's own namespace under `HC`. Design D4 sketched the provenance predicates as `prov:*`, but
 *    `prov:sourcedFrom`, `prov:descriptionKind`, `prov:memberCount` and `prov:materialisedAt` are not
 *    PROV-O terms — inventing them under the `prov:` prefix would be publishing claims in the W3C's
 *    namespace. The mapping below keeps the design's intent and fixes the namespaces.
 */

/** The client's own namespace, for terms no standard vocabulary provides. */
export const HC = 'urn:hydraclient:term:' as const

/** Named graphs. Graph layout is private to `rdf/` — see the `SessionGraph` seam in design D4. */
export const GRAPHS = {
  /** Every data quad. One graph, so no query becomes a union. */
  data: 'urn:hydraclient:data',
  /** Statements *about* the data: where it came from, when, and how complete it is. */
  prov: 'urn:hydraclient:prov',
  /** Conformance findings about the API being read (design D8), exportable as Turtle. */
  findings: 'urn:hydraclient:findings',
  /** Connect-time documents, each stable and separately replaceable. */
  vocab: 'urn:graph:vocab',
  shapes: 'urn:graph:shapes',
  ontology: 'urn:graph:ontology',
  context: 'urn:graph:context',
} as const

export type GraphName = (typeof GRAPHS)[keyof typeof GRAPHS]

/** Standard vocabularies. The language the client reads with, not knowledge of any one API. */
export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  hydra: 'http://www.w3.org/ns/hydra/core#',
  sh: 'http://www.w3.org/ns/shacl#',
  void: 'http://rdfs.org/ns/void#',
  prov: 'http://www.w3.org/ns/prov#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dcterms: 'http://purl.org/dc/terms/',
  schema: 'http://schema.org/',
  /**
   * HydrAI — the agentic companion vocabulary's invention layer. A third-party vocabulary the client
   * reads *with*, exactly as it reads with `hydra` and `schema`: its `agent#` terms say the agentic
   * things Hydra core structurally cannot. Reading a term is not obeying it — the client treats every
   * server-provided value under these terms as untrusted by default (see `agent/orientation.ts`).
   */
  hydrai: 'https://hydrai.org/ns/agent#',
} as const

export const RDF = {
  type: `${NS.rdf}type`,
  /** RDF collections. `sh:in` is always one, so walking them is required to read an enum. */
  first: `${NS.rdf}first`,
  rest: `${NS.rdf}rest`,
  nil: `${NS.rdf}nil`,
} as const

export const RDFS = {
  label: `${NS.rdfs}label`,
  comment: `${NS.rdfs}comment`,
  range: `${NS.rdfs}range`,
  domain: `${NS.rdfs}domain`,
  subClassOf: `${NS.rdfs}subClassOf`,
  isDefinedBy: `${NS.rdfs}isDefinedBy`,
} as const

export const HYDRA = {
  apiDocumentation: `${NS.hydra}apiDocumentation`,
  Collection: `${NS.hydra}Collection`,
  member: `${NS.hydra}member`,
  totalItems: `${NS.hydra}totalItems`,
  view: `${NS.hydra}view`,
  /** Its presence is what makes a collection partial; its absence proves a page held every member. */
  PartialCollectionView: `${NS.hydra}PartialCollectionView`,
  next: `${NS.hydra}next`,
  first: `${NS.hydra}first`,
  last: `${NS.hydra}last`,
  previous: `${NS.hydra}previous`,
  search: `${NS.hydra}search`,
  IriTemplate: `${NS.hydra}IriTemplate`,
  template: `${NS.hydra}template`,
  mapping: `${NS.hydra}mapping`,
  variable: `${NS.hydra}variable`,
  property: `${NS.hydra}property`,
  required: `${NS.hydra}required`,
  Link: `${NS.hydra}Link`,
  Operation: `${NS.hydra}Operation`,
  supportedClass: `${NS.hydra}supportedClass`,
  supportedOperation: `${NS.hydra}supportedOperation`,
  supportedProperty: `${NS.hydra}supportedProperty`,
  method: `${NS.hydra}method`,
  expects: `${NS.hydra}expects`,
  returns: `${NS.hydra}returns`,
  possibleStatus: `${NS.hydra}possibleStatus`,
  statusCode: `${NS.hydra}statusCode`,
  title: `${NS.hydra}title`,
  description: `${NS.hydra}description`,
  readable: `${NS.hydra}readable`,
  writeable: `${NS.hydra}writeable`,
  freetextQuery: `${NS.hydra}freetextQuery`,
  pageIndex: `${NS.hydra}pageIndex`,
  entrypoint: `${NS.hydra}entrypoint`,
  /** Affordances carried on a representation. The client's business; the model acts through tools. */
  operation: `${NS.hydra}operation`,
} as const

/**
 * HydrAI orientation terms (the `agent#` invention layer). The client reads these, and reading is
 * not obeying: a greeting is data the consumer quarantines by default, an example query is a
 * candidate the consumer routes through its own gates and never runs verbatim (see
 * `agent/orientation.ts`, design D2/D5).
 */
export const HYDRAI = {
  greeting: `${NS.hydrai}greeting`,
  /** The self-cap on the greeting's prose. Read from the shapes graph, not hardcoded. */
  GreetingShape: `${NS.hydrai}GreetingShape`,
  exampleQuery: `${NS.hydrai}exampleQuery`,
  ExampleQuery: `${NS.hydrai}ExampleQuery`,
  intent: `${NS.hydrai}intent`,
  queryText: `${NS.hydrai}queryText`,
  overEndpoint: `${NS.hydrai}overEndpoint`,
} as const

/**
 * Where a human-readable name for a resource may be published.
 *
 * Standard vocabularies only, which is the distinction that matters: knowing that `rdfs:label` names
 * things is the language the client reads with, whereas knowing that some API calls it `displayName`
 * would be knowledge of that API. A resource whose publisher used none of these simply has no label,
 * and is identified by its IRI — honest, and one dereference away from more.
 */
export const LD_LABELS = [
  `${NS.rdfs}label`,
  `${NS.schema}name`,
  `${NS.dcterms}title`,
  `${NS.skos}prefLabel`,
  `${NS.hydra}title`,
] as const

export const SHACL = {
  shapesGraph: `${NS.sh}shapesGraph`,
  NodeShape: `${NS.sh}NodeShape`,
  targetClass: `${NS.sh}targetClass`,
  /** Targets every subject of a predicate — how the greeting cap reaches any node carrying one. */
  targetSubjectsOf: `${NS.sh}targetSubjectsOf`,
  property: `${NS.sh}property`,
  path: `${NS.sh}path`,
  datatype: `${NS.sh}datatype`,
  nodeKind: `${NS.sh}nodeKind`,
  minCount: `${NS.sh}minCount`,
  maxCount: `${NS.sh}maxCount`,
  minLength: `${NS.sh}minLength`,
  maxLength: `${NS.sh}maxLength`,
  pattern: `${NS.sh}pattern`,
  in: `${NS.sh}in`,
  class: `${NS.sh}class`,
  node: `${NS.sh}node`,
  IRI: `${NS.sh}IRI`,
} as const

export const VOID = {
  sparqlEndpoint: `${NS.void}sparqlEndpoint`,
  /** A vocabulary a dataset draws its terms from — one way an ontology is advertised. */
  vocabulary: `${NS.void}vocabulary`,
} as const

export const OWL = {
  /** An ontology this document imports — another way an ontology is advertised. */
  imports: `${NS.owl}imports`,
} as const

/**
 * Provenance. Real PROV-O terms where PROV-O has one; the client's namespace otherwise.
 *
 * `prov:wasDerivedFrom` and `prov:generatedAtTime` carry exactly the design's `sourcedFrom` and
 * `retrievedAt`. The rest have no standard equivalent, except the collection total, which Hydra
 * already names.
 */
export const PROV = {
  /** The document this description was read out of. */
  wasDerivedFrom: `${NS.prov}wasDerivedFrom`,
  /** When that document was retrieved. */
  generatedAtTime: `${NS.prov}generatedAtTime`,
} as const

export const HCT = {
  /**
   * Whether a description is a dereference of the subject or an entry in a collection listing.
   *
   * This is what makes absence meaningful. RDF cannot distinguish "Jane has no jobTitle" from "the
   * description I hold does not mention jobTitle", and the difference decides whether a missing value
   * may be reported to the user.
   */
  descriptionKind: `${HC}descriptionKind`,
  DereferencedDescription: `${HC}DereferencedDescription`,
  CollectionMember: `${HC}CollectionMember`,
  /**
   * A collection member whose listing serialised every field a dereference would (design D3).
   *
   * Stronger than a plain `CollectionMember` — it settles a value read the way a dereference does —
   * but weaker than `DereferencedDescription`, so an actual dereference still supersedes it and the
   * provenance never claims a fetch that did not happen.
   */
  MemberComplete: `${HC}MemberComplete`,

  /** Members of a collection currently held, against `hydra:totalItems` for the declared size. */
  memberCount: `${HC}memberCount`,
  materialisedAt: `${HC}materialisedAt`,

  /** Whether members carry every readable property of their class — see design D5. */
  aggregationReady: `${HC}aggregationReady`,

  /**
   * A readable property the class declares that this collection's members never mention.
   *
   * Recorded per property rather than folded into `aggregationReady`, because the question stage 7's
   * completeness gate asks is per field: a collection may serve nine of ten declared properties, and
   * an aggregate over one of the nine is sound while an aggregate over the tenth would total records
   * that never carried it. One flag can only refuse both.
   */
  unservedProperty: `${HC}unservedProperty`,

  /**
   * Whether the collection served a `hydra:PartialCollectionView`. `false` proves completeness on its
   * own, independently of any declared total.
   */
  partial: `${HC}partial`,

  /** Conformance findings about the API being read (design D8). Exportable as Turtle. */
  Finding: `${HC}Finding`,
  about: `${HC}about`,
  findingKind: `${HC}findingKind`,
  message: `${HC}message`,
  detectedAt: `${HC}detectedAt`,
} as const

/**
 * What a finding says about the API. Each names a specific thing the API could publish differently,
 * so the exported report is actionable rather than a list of complaints.
 */
export const FINDING_KINDS = {
  /** A referenced `@context` could not be retrieved — usually missing CORS headers. */
  contextUnreachable: `${HC}ContextUnreachable`,
  /**
   * A `@context` was retrieved but is not valid JSON-LD, so no conformant processor can use it. Distinct
   * from unreachable: the document is there, and it is wrong.
   */
  invalidContext: `${HC}InvalidContext`,
  /** A `hydra:Link` property declares no `range`, so a reference cannot be resolved. */
  undeclaredLinkRange: `${HC}UndeclaredLinkRange`,
  /** A collection declares no pagination template. */
  undeclaredPagination: `${HC}UndeclaredPagination`,
  /**
   * A template variable binds to nothing — no `hydra:property`, or one expressed as a string rather
   * than an IRI. Either way nothing connects the variable to what it filters, so a client cannot tell
   * which template paginates, which searches free text, or which published constraints apply to a
   * variable's value.
   */
  unboundTemplateVariable: `${HC}UnboundTemplateVariable`,
  /** Collection members omit properties the class declares readable — blocks aggregation (D5). */
  abbreviatedMembers: `${HC}AbbreviatedMembers`,
  /** A constraint was published that the client cannot evaluate. */
  unevaluableConstraint: `${HC}UnevaluableConstraint`,
  /** An operation was declared that could not be projected into a tool. */
  unprojectableOperation: `${HC}UnprojectableOperation`,
  /** An IRI in a header or body names a different origin than the one serving it. */
  originMismatch: `${HC}OriginMismatch`,
} as const

export type FindingKind = (typeof FINDING_KINDS)[keyof typeof FINDING_KINDS]

/**
 * How a description entered the store. Governs whether absence of a value means anything.
 *
 * Ordered weakest to strongest: a `collection-member` listing does not settle absent values; a
 * `member-complete` one does, because it was proven to serialise every field a dereference would; a
 * `dereferenced` description settles them outright. See `strongerKind` in `session-graph`.
 */
export type DescriptionKind = 'collection-member' | 'member-complete' | 'dereferenced'

export const DESCRIPTION_KIND_IRI: Record<DescriptionKind, string> = {
  dereferenced: HCT.DereferencedDescription,
  'member-complete': HCT.MemberComplete,
  'collection-member': HCT.CollectionMember,
}
