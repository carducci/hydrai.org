import jsonld from 'jsonld'

import type { DocumentLoader } from '../rdf/document-loader'
import { FINDING_KINDS, type Findings } from '../rdf/findings'
import { quadsFromJsonLd } from '../rdf/ingest'
import { HYDRA } from '../rdf/terms'
import type { ClassCapability } from './capability'

/**
 * Member serialisation completeness (task 3.5, design D5's "remaining thorn").
 *
 * The failure this exists to prevent: if collection pages serialise abbreviated members without the
 * field being aggregated, materialising all 4,832 events yields 4,832 subjects and zero fees, and `SUM`
 * returns a confidently wrong number. So before aggregating locally, the client establishes that the
 * collection actually serves the fields.
 *
 * ## Why this cannot be done from the quads
 *
 * Design D5 says this is "detectable from one page: compare the predicates present on a member against
 * the class's readable `supportedProperty` set". Against this API that does not work, for two compounding
 * reasons found by running it:
 *
 * 1. **Data is sparse.** On page 1 of `/Api/Contact`, one member had 21 of its 36 fields empty. A single
 *    member proves nothing.
 * 2. **Nulls vanish.** The server serialises absent values as JSON `null`, and JSON-LD expansion emits no
 *    triple for a null. Even the union across all 25 members yielded only 20 predicates, because fields
 *    like `fax` and `custom7` are null in every one of them.
 *
 * So a predicate missing from the graph is ambiguous: not serialised, or serialised as null throughout.
 * Treating that as "not served" would refuse aggregation over fields the server does provide.
 *
 * ## What distinguishes them
 *
 * The server *mentions* the key even when the value is null — that mention is the proof it serialises the
 * field. Keys are visible at this boundary and nowhere above it, which is what the invariant requires:
 * *above the graph layer there is no JSON*. This module sits at that boundary.
 *
 * Rather than mapping keys to IRIs by hand — which would reintroduce exactly the string matching the
 * rebuild exists to remove — each member is expanded twice: once as served, and once with every null
 * replaced by a placeholder. The second expansion resolves the same keys through the same context and
 * yields the predicates the serialisation *mentions*. Term resolution stays with the JSON-LD processor.
 */

/** A value that survives expansion, to stand in for a null whose key we want to observe. */
const PLACEHOLDER = 'urn:hydraclient:mentioned'

export interface MemberSerialisation {
  /** Predicate IRIs the serialisation mentions, whether or not any sampled member had a value. */
  readonly mentioned: readonly string[]
  /** Predicate IRIs that carried an actual value in the sample. */
  readonly populated: readonly string[]
  /** Readable properties the class declares that the serialisation never mentions. */
  readonly missing: readonly string[]
  /** Every readable declared property is served, so a local aggregate over any of them is sound. */
  readonly aggregationReady: boolean
}

/** Replace every null with a placeholder, recursively, leaving structure and keys untouched. */
function unmaskNulls(node: unknown): unknown {
  if (node === null) return PLACEHOLDER
  if (Array.isArray(node)) return node.map(unmaskNulls)
  if (typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // Keywords keep their meaning; rewriting @id or @type would change what the document says.
    out[key] = key.startsWith('@') ? value : unmaskNulls(value)
  }
  return out
}

export interface MemberSerialisationDeps {
  readonly loader: DocumentLoader
  readonly findings?: Findings
}

export async function assessMemberSerialisation(
  members: readonly unknown[],
  memberClass: ClassCapability,
  collectionIri: string,
  deps: MemberSerialisationDeps,
): Promise<MemberSerialisation> {
  const mentioned = new Set<string>()
  const populated = new Set<string>()

  for (const member of members) {
    for (const quad of await quadsFromJsonLd(member, deps.loader, collectionIri)) {
      populated.add(quad.predicate.value)
    }
    for (const quad of await quadsFromJsonLd(unmaskNulls(member), deps.loader, collectionIri)) {
      mentioned.add(quad.predicate.value)
    }
  }

  // Only readable properties are in scope. A write-only property absent from a listing is correct.
  const readable = memberClass.properties.filter((p) => p.readable).map((p) => p.iri)
  const missing = readable.filter((iri) => !mentioned.has(iri)).sort()

  if (missing.length > 0 && deps.findings) {
    deps.findings.record({
      about: collectionIri,
      kind: FINDING_KINDS.abbreviatedMembers,
      message:
        `Members of <${collectionIri}> omit ${missing.length} propert${missing.length === 1 ? 'y' : 'ies'} ` +
        `that ${memberClass.iri} declares readable: ${missing.join(', ')}. ` +
        `Aggregating over those fields locally would compute a total from records that never carried ` +
        `them, so it is refused. Serialising them in collection members — as null where absent — would ` +
        `make it possible.`,
    })
  }

  return {
    mentioned: [...mentioned].sort(),
    populated: [...populated].sort(),
    missing,
    aggregationReady: missing.length === 0,
  }
}

/**
 * The members of a collection page, found without knowing what the page calls them.
 *
 * A page may serialise its members under `member`, under `hydra:member`, or under the full IRI, and
 * which of those it is depends on a context this client does not write. Guessing the key would be the
 * string matching the rebuild exists to remove, one layer down from where the POC did it.
 *
 * So the document is expanded — every key resolved by the JSON-LD processor against the context the
 * server published — and the members are read from the one predicate Hydra defines for them. What
 * comes back is still JSON, with its keys and its nulls, which is what the assessment above needs.
 */
async function expandedMembersOf(document: unknown, loader: DocumentLoader, base: string): Promise<unknown[]> {
  const expanded = (await jsonld.expand(document as jsonld.JsonLdDocument, {
    documentLoader: loader as never,
    base,
  })) as unknown[]

  const members: unknown[] = []

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === HYDRA.member && Array.isArray(value)) members.push(...value)
      else if (key !== '@context') walk(value)
    }
  }

  walk(expanded)
  return members
}

/**
 * Assess a whole collection page (task 3.5, wired in by stage 7's completeness gate).
 *
 * The page is expanded **twice**, once as served and once with every null replaced, and the members
 * are located in each expansion rather than sliced out of the raw JSON. Expanding first means the
 * assessment never has to know the page's own vocabulary; replacing nulls first means it sees the keys
 * a server mentions even where every sampled record left them empty.
 *
 * Returns `null` when the page declares no members — an empty collection says nothing about what its
 * members would carry, and inferring "serves nothing" from it would refuse every aggregate over it.
 */
export async function assessPageSerialisation(
  page: unknown,
  memberClass: ClassCapability,
  collectionIri: string,
  deps: MemberSerialisationDeps,
): Promise<MemberSerialisation | null> {
  const served = await expandedMembersOf(page, deps.loader, collectionIri)
  if (served.length === 0) return null

  const mentioned = await expandedMembersOf(unmaskNulls(page), deps.loader, collectionIri)

  const populated = new Set<string>()
  for (const member of served) {
    for (const key of Object.keys(member as Record<string, unknown>)) {
      if (!key.startsWith('@')) populated.add(key)
    }
  }

  const mentions = new Set<string>()
  for (const member of mentioned) {
    for (const key of Object.keys(member as Record<string, unknown>)) {
      if (!key.startsWith('@')) mentions.add(key)
    }
  }

  const readable = memberClass.properties.filter((property) => property.readable).map((p) => p.iri)
  const missing = readable.filter((iri) => !mentions.has(iri)).sort()

  if (missing.length > 0 && deps.findings) {
    deps.findings.record({
      about: collectionIri,
      kind: FINDING_KINDS.abbreviatedMembers,
      message:
        `Members of <${collectionIri}> omit ${missing.length} propert${missing.length === 1 ? 'y' : 'ies'} ` +
        `that ${memberClass.iri} declares readable: ${missing.join(', ')}. ` +
        `Aggregating over those fields locally would compute a total from records that never carried ` +
        `them, so it is refused. Serialising them in collection members — as null where absent — would ` +
        `make it possible.`,
    })
  }

  return {
    mentioned: [...mentions].sort(),
    populated: [...populated].sort(),
    missing,
    aggregationReady: missing.length === 0,
  }
}
