import type Anthropic from '@anthropic-ai/sdk'

import { NS } from '../rdf/terms'
import type { ToolSurface } from '../project/tools'
import type { ValueSetIndex } from '../render/affordances'
import {
  describeFilterSurface,
  type CapabilityModel,
  type PropertyConstraints,
} from '../vocab/capability'

/**
 * The ontology manifest (tasks 6.3a and 6.3b, design D7).
 *
 * Query authoring needs a vocabulary. This renders one out of the store — not out of the T3
 * introspection queries — because local analytics exists precisely for the tiers below T3, and a
 * manifest that only existed at T3 would leave it without one. Same principle as capability
 * derivation: one path, richer inputs as tiers rise.
 *
 * ## Why the sections are separate
 *
 * Above a measured threshold the manifest switches from wholesale to on-demand. Task 6.3b's
 * requirement is that switching later is *dropping a section*, not restructuring the prompt — so the
 * class list and the property detail are rendered independently and joined by the caller. Design D7
 * is specific about which survives: the class list stays, because the model must always know the
 * full universe of classes; only property detail is withheld and fetched per class.
 *
 * The manifest is **not** the guard against invented terms — stage 7's term gate is, and it runs
 * before execution on every path. That is what makes the size of this a tunable trade-off (a smaller
 * prefix against more retries) rather than a correctness requirement.
 */

/** Prefix labels for the vocabularies the client reads with. */
const STANDARD_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['rdf', NS.rdf],
  ['rdfs', NS.rdfs],
  ['owl', NS.owl],
  ['xsd', NS.xsd],
  ['hydra', NS.hydra],
  ['sh', NS.sh],
  ['schema', NS.schema],
  ['skos', NS.skos],
  ['dcterms', NS.dcterms],
  ['void', NS.void],
]

export interface Manifest {
  /** `PREFIX` declarations, so a query can be written in compact form. */
  readonly prefixes: string
  /** Every class with its published description. Design D7 keeps this section at every size. */
  readonly classes: string
  /**
   * The affordance index (design D4): one line per collection — member class, filter variables,
   * write support, and live value sets where a reference collection serves a class in full.
   * Rendered from the capability model at connect, byte-stable, and placed before the cache
   * breakpoint, so every collection is visible before the first tool call.
   */
  readonly affordances: string
  /** Per-class predicates with their ranges and datatypes. The section disclosure drops first. */
  readonly properties: string
  /** Counts, for the 6.3a measurement and for the trace. */
  readonly counts: { readonly classes: number; readonly properties: number; readonly collections: number }
}

export interface ManifestDeps {
  /** Published constraints for a class, keyed by predicate IRI — supplies datatypes and value sets. */
  readonly constraintsFor: (classIri: string) => Map<string, PropertyConstraints>
  /** The namespace this API mints its own terms in, as `vocab/capability` derives it. */
  readonly primaryNamespace: string | null
  /** Live value sets (design D5) — reference collections render with their members inline. */
  readonly valueSets?: ValueSetIndex
  /**
   * The affordance registry, so write support is stated with its `invoke` handle. A model that
   * knows the handle from the map never needs to list a collection to act on it — an incomplete
   * invoke is refused with the full contract, which costs no request at all.
   */
  readonly surface?: ToolSurface
  /**
   * Resolves a collection class to its address on the session's origin, injected by the caller
   * (a closure over the same resolution dispatch uses) so this layer never imports the executor's.
   * Measured 2026-08-02: without an address in the map, the model composed one from the vocabulary
   * namespace — a spelling the origin veto then had to refuse. An address that can be copied is
   * never composed. Absent, entries render without addresses, exactly as before.
   */
  readonly locate?: (classIri: string) => string | null
}

/**
 * The HTTP method's generic meaning, so write support reads as capability rather than as a name
 * to decode. RFC-level semantics, not knowledge of any API — the same standing the client takes
 * on pagination and content negotiation. Measured 2026-08-02: with `member handles: put_Contact,
 * delete_Contact` in its prompt, the model still reported updates as "likely" unsupported.
 */
function verbFor(method: string): string {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'create'
    case 'PUT':
      return 'update'
    case 'DELETE':
      return 'delete'
    case 'PATCH':
      return 'amend'
    default:
      return method.toUpperCase()
  }
}

/** Render an IRI in compact form where a prefix covers it, and in full angle brackets otherwise. */
function compact(iri: string, prefixes: ReadonlyMap<string, string>): string {
  for (const [label, namespace] of prefixes) {
    if (iri.startsWith(namespace)) return `${label}:${iri.slice(namespace.length)}`
  }
  return `<${iri}>`
}

/** Collapse published prose to one line — the manifest is a reference, not documentation. */
function oneLine(text: string, limit = 160): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > limit ? `${flattened.slice(0, limit - 1)}…` : flattened
}

/**
 * The prefix labels this manifest renders under.
 *
 * Exported so a refusal about a term can be phrased in the same labels the query was written in.
 * Nothing here is published — the labels are local to the page, and carry no meaning off it.
 */
export function manifestPrefixes(deps: ManifestDeps): ReadonlyMap<string, string> {
  return prefixMap(deps)
}

function prefixMap(deps: ManifestDeps): Map<string, string> {
  const prefixes = new Map<string, string>(STANDARD_PREFIXES)
  // The API's own namespace, under the label a query author would reach for. Local to this
  // document — nothing here is published, and the label carries no meaning off the page.
  if (deps.primaryNamespace) prefixes.set('ns', deps.primaryNamespace)
  return prefixes
}

export function renderManifest(model: CapabilityModel, deps: ManifestDeps): Manifest {
  const prefixes = prefixMap(deps)

  const prefixLines = [...prefixes]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, namespace]) => `PREFIX ${`${label}:`.padEnd(9)}<${namespace}>`)

  /*
   * Collections live in the affordance index below, not in CLASSES/PROPERTIES.
   *
   * The old premise for omitting them entirely — that the tool surface carries every collection
   * with its own schema — is no longer true in either architecture: the envelope surface is
   * constant, so if the prompt did not name the collections nothing would. CLASSES and PROPERTIES
   * stay about the classes whose instances hold data, because that is what a query is written
   * over; COLLECTIONS is where a collection's identity, filters and write support are declared.
   */
  const described = model.classes.filter((cls) => !cls.isCollection)

  const classLines: string[] = []
  const propertyLines: string[] = []
  let propertyCount = 0

  for (const cls of described) {
    const name = compact(cls.iri, prefixes)
    const prose = cls.description ?? cls.title
    classLines.push(prose ? `  ${name} — ${oneLine(prose)}` : `  ${name}`)

    const constraints = deps.constraintsFor(cls.iri)
    const readable = cls.properties.filter((property) => property.readable)
    if (readable.length === 0) continue

    propertyLines.push(`  ${name}`)
    for (const property of readable) {
      const constraint = constraints.get(property.iri)

      // What the predicate points at, most specific statement first: a declared Link range, then a
      // SHACL class, then a declared datatype. Silent where the vocabulary is silent — a Link whose
      // range is undeclared is a gap the dispatch path escalates, not one to paper over here.
      const target = property.range ?? constraint?.class ?? constraint?.datatype ?? null

      const enumerated =
        constraint && constraint.allowedValues.length > 0
          ? ` — one of ${constraint.allowedValues.map((value) => compact(value, prefixes)).join(', ')}`
          : ''

      propertyLines.push(
        `    ${compact(property.iri, prefixes)}` +
          (target ? `  →  ${compact(target, prefixes)}` : '') +
          enumerated,
      )
      propertyCount += 1
    }
  }

  /*
   * The affordance index: one line per collection, from the capability model — so every collection
   * and its filter variables are in the prompt before the first tool call. `model.collections` is
   * sorted by IRI and value-set members are sorted at materialisation, which is what keeps the
   * section byte-stable across connects.
   */
  const affordanceLines: string[] = []
  /** Write handles already named on some line, so the completeness sweep below adds only gaps. */
  const namedHandles = new Set<string>()
  /** Each projected write on a class, as `verb with handle ("declared title")`. */
  const describeWrites = (classIri: string): { name: string; method: string; text: string }[] =>
    (deps.surface?.tools ?? []).flatMap((tool) => {
      if (tool.dispatch.kind !== 'operation' || tool.dispatch.classIri !== classIri) return []
      const method = tool.dispatch.method.toUpperCase()
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return []
      // The API's own words ride along where it published any — the verb is only HTTP's meaning.
      const title =
        model.byIri(classIri)?.operations.find(
          (operation) => operation.method.toUpperCase() === method,
        )?.title ?? null
      return [
        {
          name: tool.name,
          method,
          text: `${verbFor(method)} with ${tool.name}${title ? ` ("${oneLine(title, 60)}")` : ''}`,
        },
      ]
    })

  for (const cls of model.collections) {
    const name = compact(cls.iri, prefixes)
    const address = deps.locate?.(cls.iri) ?? null
    const parts: string[] = []
    if (cls.memberClass) {
      // The member class's own writes ride the line, stated as capability: PUT and DELETE are
      // declared on the member, not the collection, and a handle named nowhere is a capability
      // the model must conclude does not exist.
      const memberWrites = describeWrites(cls.memberClass)
      for (const write of memberWrites) namedHandles.add(write.name)
      parts.push(
        `members are ${compact(cls.memberClass, prefixes)}` +
          (memberWrites.length > 0
            ? ` — ${memberWrites.map((write) => write.text).join(', ')}`
            : ''),
      )
    }

    // The published combinations, not a name pool: per-form aliases of one predicate collapse,
    // pagination controls drop, and a fixed form's variables render joined — so the index never
    // teaches a combination no single address form carries, nor a variable that only works with
    // its partner.
    // The map stays compact: combinations only. The per-variable prose rides the result footer,
    // where it is contextual rather than a standing token cost.
    const surface = describeFilterSurface(
      cls.templates.map((template) => ({
        template: template.template,
        mappings: template.mappings.map((mapping) => ({
          variable: mapping.variable,
          property: mapping.propertyIsIri ? mapping.property : null,
        })),
      })),
    )
    if (surface.combinations.length > 0) parts.push(`filter by ${surface.combinations}`)

    const collectionWrites = describeWrites(cls.iri)
    for (const write of collectionWrites) {
      namedHandles.add(write.name)
      parts.push(write.text)
    }
    // An operation declared but not projected keeps the bare note — declared capability is never
    // dropped from the map, even when nothing dispatches it.
    for (const operation of cls.operations) {
      const method = operation.method.toUpperCase()
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') continue
      if (collectionWrites.some((write) => write.method === method)) continue
      parts.push(`accepts ${method}`)
    }

    // A reference collection served in full is an enumeration; its members ride the map inline.
    const served = cls.memberClass ? deps.valueSets?.byClass(cls.memberClass) : undefined
    if (served && served.length > 0) {
      const members = served
        .map((member) => (member.label ? `${member.label} <${member.iri}>` : `<${member.iri}>`))
        .join(', ')
      parts.push(`serves the full set: ${members}`)
    }

    affordanceLines.push(
      `  ${name}${cls.title ? ` (${oneLine(cls.title, 60)})` : ''}${address ? ` at <${address}>` : ''}${parts.length > 0 ? ` — ${parts.join('; ')}` : ''}`,
    )
  }

  /*
   * The completeness sweep: `hydra:supportedOperation` is enumerated at discovery, and every
   * write the vocabulary declares must be in this map — a capability that only appears after a
   * GET is one the model concludes does not exist (measured: it did, and reported the API as
   * unable to update). Most handles were named on the collection lines above; whatever class
   * declares writes and is no collection's member gets its own line here.
   */
  for (const cls of model.classes) {
    if (cls.isCollection) continue
    const writes = describeWrites(cls.iri).filter((write) => !namedHandles.has(write.name))
    if (writes.length === 0) continue
    for (const write of writes) namedHandles.add(write.name)
    affordanceLines.push(
      `  ${compact(cls.iri, prefixes)} — ${writes.map((write) => write.text).join(', ')}`,
    )
  }

  return {
    prefixes: prefixLines.join('\n'),
    classes: `CLASSES\n${classLines.join('\n')}`,
    affordances:
      `COLLECTIONS — this index is complete: every collection and every write operation this API ` +
      `declares is listed here, and nothing new appears by browsing. Read with follow / ` +
      `search_collection; act with invoke — a create/update/delete entry on a line IS that ` +
      `capability, usable now with the handle it names.\n${affordanceLines.join('\n')}`,
    properties: `PROPERTIES\n${propertyLines.join('\n')}`,
    counts: {
      classes: described.length,
      properties: propertyCount,
      collections: model.collections.length,
    },
  }
}

/**
 * The size of a rendered manifest, measured rather than estimated (task 6.3a).
 *
 * Design D7 put this at 3–6K tokens on the basis of roughly 220 terms. That estimate should not
 * survive as one: it is a number about a different vocabulary, and the local ontology declares more
 * classes than the whole estimate assumed terms. Counting characters would not settle it either —
 * only the tokenizer for the model that will read it knows, and it is model-specific.
 */
export async function measureManifest(
  anthropic: Anthropic,
  modelId: string,
  sections: readonly string[],
): Promise<number> {
  const counted = await anthropic.messages.countTokens({
    model: modelId,
    messages: [{ role: 'user', content: sections.join('\n\n') }],
  })
  return counted.input_tokens
}

/**
 * Above this, the manifest is disclosed on demand instead of shipped whole.
 *
 * **Measured for this API (task 6.3a, 2026-07-30): 4,941 tokens whole**, of which the class list and
 * prefixes are 1,032 — so property detail is four fifths of it. Comfortably under, so this API ships
 * whole and takes zero round trips.
 *
 * Design D7 estimated 3–6K and the estimate held, which is worth recording because baseline.md
 * predicted it would not: the ontology declares 454 `owl:Class`, so the manifest looked certain to
 * blow through. It does not, because the manifest renders from the **vocabulary**, not the ontology —
 * 17 non-collection classes and 230 properties. The prediction reasoned from the wrong document.
 *
 * The threshold itself is still a judgement, and this measurement does not test it: at 4,941 against
 * 8,000 nothing turns on where exactly the line sits. A vocabulary that lands near it should measure
 * again rather than trust this number.
 */
export const MANIFEST_TOKEN_THRESHOLD = 8_000
