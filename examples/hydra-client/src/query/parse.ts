import { Parser, type SparqlQuery, type Pattern, type Expression, type Triple } from 'sparqljs'

import { RDF } from '../rdf/terms'

/**
 * Reading a query as facts (tasks 7.2 and 7.2a).
 *
 * Everything stage 7 decides — which terms are named, which classes are involved, what is being
 * aggregated — is read off a parsed syntax tree rather than off the query string. That is the same
 * rule the rest of the client follows for documents: the proof of concept matched query text with
 * regular expressions, and a regular expression cannot tell a predicate from a substring of a literal.
 *
 * Nothing here decides anything. It reports what the query says; the gate and the scoper decide what
 * to do about it.
 */

export type QueryForm = 'SELECT' | 'CONSTRUCT' | 'ASK' | 'DESCRIBE' | 'UPDATE'

/** A variable typed by an `rdf:type` pattern, and the class it was typed with. */
export interface TypePattern {
  /** The variable name, without the `?`. `null` where the subject is an IRI rather than a variable. */
  readonly variable: string | null
  readonly classIri: string
}

/** An aggregate, and the variable it consumes. */
export interface AggregateUse {
  /** `sum`, `count`, `avg`, `min`, `max`, `sample`, `group_concat` — as SPARQL spells it. */
  readonly aggregation: string
  /** The variable being aggregated, or `null` for `COUNT(*)`. */
  readonly variable: string | null
}

/**
 * A predicate constrained to a constant by a conjunctive triple `?s <predicate> <value>` (task 3.1).
 *
 * The exact-equality conjunct filter pushdown reuses (design D1): a triple whose object is a concrete
 * IRI or literal, in the conjunctive part of the WHERE — never under an OPTIONAL, UNION, MINUS, GRAPH,
 * SERVICE or sub-select, where it does not constrain the whole result and pushing it down would drop
 * rows. Only the *identity* form (an IRI object) is exact against this kind of API; a literal object
 * (a text match) is carried too but the engine chooses not to push it, because the server matches text
 * by analyzer rather than by equality.
 */
export interface EqualityFilter {
  readonly predicate: string
  /** The constant the predicate equals: an IRI, or a literal's lexical value. */
  readonly value: string
  /** Whether the value was an IRI (a NamedNode) rather than a literal. */
  readonly isIri: boolean
}

export interface ParsedQuery {
  readonly text: string
  readonly form: QueryForm
  /** Every IRI the query names, in any term position. The term gate's input. */
  readonly iris: readonly string[]
  /** Classes named in an `rdf:type` pattern. What makes a query scopable. */
  readonly types: readonly TypePattern[]
  /** Predicate IRIs used in a triple pattern, `rdf:type` excluded. */
  readonly predicates: readonly string[]
  readonly aggregates: readonly AggregateUse[]
  /**
   * Which predicates bound each variable.
   *
   * `?e ns:fee ?fee` records `fee → [ns:fee]`, which is what lets the completeness gate say that
   * `SUM(?fee)` reads a field the collection does not serve. Without it the gate could only refuse
   * per collection, and would refuse aggregates over fields that are served.
   */
  readonly variableSources: ReadonlyMap<string, readonly string[]>
  /** Conjunctive equality conjuncts — the input to filter pushdown (design D1). */
  readonly equalityFilters: readonly EqualityFilter[]
  /** Whether the outer SELECT carries a GROUP BY. An ungrouped aggregate returns exactly one row. */
  readonly grouped: boolean
  /**
   * Output variables of the outer SELECT that are directly an aggregate — `(AVG(?fee) AS ?avg)` names
   * `avg`. What the unbound-aggregate guard (design D2) watches: an ungrouped aggregate that binds none
   * of these produced no value, which must not read as a confident empty answer.
   */
  readonly aggregateOutputs: readonly string[]
}

export interface ParseFailure {
  readonly error: string
}

export type ParseResult = ParsedQuery | ParseFailure

export function isParseFailure(result: ParseResult): result is ParseFailure {
  return 'error' in result
}

/** Accumulates everything one walk finds, so the tree is traversed once. */
interface Readings {
  readonly iris: Set<string>
  readonly types: TypePattern[]
  readonly predicates: Set<string>
  readonly aggregates: AggregateUse[]
  readonly variableSources: Map<string, string[]>
  readonly equalityFilters: EqualityFilter[]
}

type TermLike = Triple['subject'] | Triple['object'] | Triple['predicate']

function noteTerm(term: TermLike, into: Readings): void {
  if (!('termType' in term)) return

  if (term.termType === 'NamedNode') {
    into.iris.add(term.value)
    return
  }
  if (term.termType === 'Literal') {
    // A typed literal names its datatype, and a mistyped one is exactly the sort of invented term the
    // gate exists to catch — `xsd:decimel` matches nothing and reports zero rows rather than erroring.
    if (term.datatype) into.iris.add(term.datatype.value)
    return
  }
  if (term.termType === 'Quad') {
    noteTerm(term.subject, into)
    noteTerm(term.predicate, into)
    noteTerm(term.object, into)
  }
}

/** A predicate position may be an IRI or a property path built from IRIs. Both name terms. */
function notePredicate(predicate: Triple['predicate'], into: Readings): string[] {
  if ('termType' in predicate) {
    if (predicate.termType === 'NamedNode') {
      into.iris.add(predicate.value)
      return [predicate.value]
    }
    return []
  }

  const found: string[] = []
  for (const item of predicate.items) {
    found.push(...notePredicate(item as Triple['predicate'], into))
  }
  return found
}

function walkTriples(triples: readonly Triple[], into: Readings, conjunctive: boolean): void {
  for (const triple of triples) {
    noteTerm(triple.subject, into)
    noteTerm(triple.object, into)
    const predicates = notePredicate(triple.predicate, into)

    const object = triple.object
    const constObject =
      'termType' in object && (object.termType === 'NamedNode' || object.termType === 'Literal')
        ? object
        : null

    for (const predicate of predicates) {
      if (predicate === RDF.type) {
        // The class is the object of the type pattern. An `a ?class` pattern types nothing knowable,
        // so it is not recorded — and a query with only those is one the scoper honestly refuses.
        if ('termType' in triple.object && triple.object.termType === 'NamedNode') {
          into.types.push({
            variable:
              'termType' in triple.subject && triple.subject.termType === 'Variable'
                ? triple.subject.value
                : null,
            classIri: triple.object.value,
          })
        }
        continue
      }

      into.predicates.add(predicate)

      if ('termType' in triple.object && triple.object.termType === 'Variable') {
        const held = into.variableSources.get(triple.object.value) ?? []
        if (!held.includes(predicate)) held.push(predicate)
        into.variableSources.set(triple.object.value, held)
      }
    }

    // A single-predicate triple whose object is a constant, in the conjunctive part of the WHERE, is
    // an equality conjunct filter pushdown may reuse. A property path (predicates.length > 1) is not a
    // simple predicate equality, so it is excluded.
    if (conjunctive && constObject !== null && predicates.length === 1 && predicates[0] !== RDF.type) {
      into.equalityFilters.push({
        predicate: predicates[0] as string,
        value: constObject.value,
        isIri: constObject.termType === 'NamedNode',
      })
    }
  }
}

function walkExpression(expression: Expression, into: Readings): void {
  if (Array.isArray(expression)) {
    for (const item of expression) walkExpression(item, into)
    return
  }

  if ('termType' in expression) {
    noteTerm(expression as TermLike, into)
    return
  }

  if (expression.type === 'aggregate') {
    const inner: unknown = expression.expression
    const isTerm = typeof inner === 'object' && inner !== null && 'termType' in inner
    const termType = isTerm ? (inner as { termType: string }).termType : null

    into.aggregates.push({
      aggregation: expression.aggregation,
      // `COUNT(*)` aggregates over a wildcard and reads no field, which is exactly why it is allowed
      // over a set the completeness gate would refuse to sum.
      variable: termType === 'Variable' ? (inner as { value: string }).value : null,
    })

    // `SUM(?a + ?b)` aggregates over an expression, whose own terms still have to be gated.
    if (termType !== 'Wildcard') walkExpression(inner as Expression, into)
    return
  }

  if (expression.type === 'functionCall') {
    if (typeof expression.function !== 'string') into.iris.add(expression.function.value)
    for (const argument of expression.args) walkExpression(argument, into)
    return
  }

  if (expression.type === 'operation') {
    for (const argument of expression.args) {
      // `EXISTS { … }` carries patterns rather than expressions, and its triples are real triples —
      // but a triple inside a FILTER expression does not constrain the outer result conjunctively.
      if (typeof argument === 'object' && 'type' in argument && isPattern(argument)) {
        walkPattern(argument, into, false)
      } else {
        walkExpression(argument as Expression, into)
      }
    }
  }
}

const PATTERN_TYPES = new Set(['bgp', 'optional', 'union', 'group', 'graph', 'minus', 'service', 'filter', 'bind', 'values', 'query'])

function isPattern(node: { type?: unknown }): node is Pattern {
  return typeof node.type === 'string' && PATTERN_TYPES.has(node.type)
}

function walkPattern(pattern: Pattern, into: Readings, conjunctive: boolean): void {
  switch (pattern.type) {
    case 'bgp':
      walkTriples(pattern.triples, into, conjunctive)
      return
    case 'filter':
      walkExpression(pattern.expression, into)
      return
    case 'bind':
      walkExpression(pattern.expression, into)
      return
    case 'values':
      for (const row of pattern.values) {
        for (const value of Object.values(row)) {
          if (value) noteTerm(value, into)
        }
      }
      return
    case 'graph':
    case 'service':
      // A named graph or a remote service scopes its triples away from the default-graph result the
      // local engine reads, so an equality inside one is not a conjunctive constraint on it.
      noteTerm(pattern.name, into)
      for (const nested of pattern.patterns) walkPattern(nested, into, false)
      return
    case 'optional':
    case 'union':
    case 'minus':
      // A row absent from an OPTIONAL still appears; a UNION or MINUS branch does not constrain the
      // whole result. None of these equalities may push down — they would drop rows the query keeps.
      for (const nested of pattern.patterns) walkPattern(nested, into, false)
      return
    case 'group':
      // A group is bracketing, not branching — its triples remain conjunctive with their surroundings.
      for (const nested of pattern.patterns) walkPattern(nested, into, conjunctive)
      return
    case 'query':
      walkQuery(pattern, into, false)
      return
  }
}

/** A SELECT, in the outer position or nested as a sub-select. */
function walkQuery(
  query: Extract<SparqlQuery, { type: 'query' }>,
  into: Readings,
  conjunctive: boolean,
): void {
  for (const graph of query.from?.default ?? []) into.iris.add(graph.value)
  for (const graph of query.from?.named ?? []) into.iris.add(graph.value)

  for (const pattern of query.where ?? []) walkPattern(pattern, into, conjunctive)

  for (const row of query.values ?? []) {
    for (const value of Object.values(row)) {
      if (value) noteTerm(value, into)
    }
  }

  if (query.queryType === 'SELECT') {
    for (const variable of query.variables) {
      if ('expression' in variable) walkExpression(variable.expression, into)
    }
    for (const grouping of query.group ?? []) walkExpression(grouping.expression, into)
    for (const having of query.having ?? []) walkExpression(having, into)
    for (const ordering of query.order ?? []) walkExpression(ordering.expression, into)
  }

  // Template triples are the query's output, not a constraint on its input.
  if (query.queryType === 'CONSTRUCT') walkTriples(query.template ?? [], into, false)

  if (query.queryType === 'DESCRIBE') {
    for (const variable of query.variables) {
      // `DESCRIBE *` carries a wildcard rather than a term, and names nothing to check.
      if ('termType' in variable && variable.termType === 'NamedNode') noteTerm(variable, into)
    }
  }
}

/**
 * Parse a query, or say why it could not be parsed.
 *
 * The parser is given **no prefixes**. A query has to declare its own, which is what makes the text
 * the client holds the same text a remote endpoint would receive — seeding prefixes here would let a
 * query parse locally and fail at T3, and the difference would only show up against a deployment that
 * has an endpoint.
 */
export function parseQuery(text: string): ParseResult {
  let ast: SparqlQuery
  try {
    ast = new Parser().parse(text)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return {
      error:
        `The query could not be parsed: ${message}\n\n` +
        `Every prefix a query uses must be declared in the query itself — the PREFIX lines in the ` +
        `vocabulary section above are there to be copied in.`,
    }
  }

  const into: Readings = {
    iris: new Set<string>(),
    types: [],
    predicates: new Set<string>(),
    aggregates: [],
    variableSources: new Map<string, string[]>(),
    equalityFilters: [],
  }

  if (ast.type === 'update') {
    /*
     * Writes do not come through here, and that is a deliberate limit rather than an omission.
     *
     * Every projected write is gated before dispatch, read before replacing, and verified against the
     * representation the server echoes back. A SPARQL UPDATE reaches none of that — it would be a
     * second write path with none of the guarantees of the first, and the model has no way to know
     * which one it is on.
     */
    return {
      error:
        `This is an update, and the query tool reads. Writes go through the operations this API ` +
        `declares, which check published constraints before issuing a request and verify what the ` +
        `server persisted afterwards; a SPARQL update would reach none of that.`,
    }
  }

  // The outer WHERE is conjunctive; branches and sub-scopes turn that off as they are entered.
  walkQuery(ast, into, true)

  // Grouping and the outer aggregate outputs are read from the top-level SELECT directly — the walk
  // recurses into sub-selects, whose grouping is not the outer query's.
  let grouped = false
  const aggregateOutputs: string[] = []
  if (ast.queryType === 'SELECT') {
    grouped = (ast.group?.length ?? 0) > 0
    for (const variable of ast.variables) {
      if (
        typeof variable === 'object' &&
        'expression' in variable &&
        'variable' in variable &&
        typeof variable.expression === 'object' &&
        variable.expression !== null &&
        'type' in variable.expression &&
        (variable.expression as { type: unknown }).type === 'aggregate'
      ) {
        aggregateOutputs.push(variable.variable.value)
      }
    }
  }

  return {
    text,
    form: ast.queryType,
    iris: [...into.iris].sort(),
    types: into.types,
    predicates: [...into.predicates].sort(),
    aggregates: into.aggregates,
    variableSources: new Map([...into.variableSources].map(([name, sources]) => [name, [...sources].sort()])),
    equalityFilters: into.equalityFilters,
    grouped,
    aggregateOutputs,
  }
}
