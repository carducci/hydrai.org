// Shared vocabulary logic — the single place that reads `agent.ttl` and turns it into a term model.
//
// Two consumers import this, so the site can never disagree with the published RDF:
//   • vocab/build-vocab.mjs  → writes the machine representations (.ttl verbatim, .jsonld generated)
//   • site/_data/vocab.js    → feeds the Eleventy templates that render the browsable /ns/agent page
//                              and the term reference blocks in the docs
//
// Nothing here renders HTML. The HTML is an Eleventy template, so the namespace page shares the site's
// layout, nav, footer, and accessibility exactly — and the vocabulary is built, never duplicated.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Parser, Store, Writer, DataFactory } from 'n3'
import jsonld from 'jsonld'

const { namedNode } = DataFactory
const here = dirname(fileURLToPath(import.meta.url))

// ── Vocabularies published here. `core#` (the Hydra stewardship mirror) joins this list when it is
// extracted; every consumer already loops over it. ──────────────────────────────────────────────
export const SOURCES = [
  {
    slug: 'agent',
    file: 'agent.ttl',
    namespace: 'https://hydrai.org/ns/agent#',
    ontologyIri: 'https://hydrai.org/ns/agent',
    partition: 'agent# — invention layer',
    layer: 'invention',
    blurb:
      'The agentic terms Hydra core structurally cannot express, minted at the gap. Every term ' +
      'HydrAI owns outright lives here.',
  },
  {
    slug: 'core',
    file: 'core.ttl',
    namespace: 'https://hydrai.org/ns/core#',
    ontologyIri: 'https://hydrai.org/ns/core',
    partition: 'core# — stewardship layer',
    layer: 'stewardship',
    blurb:
      'The Hydra Core Vocabulary, mirrored via equivalence so "HydrAI ⊇ Hydra" is provable. A formal ' +
      'backbone, not for the wire — emit canonical hydra: IRIs.',
  },
]

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const OWL = 'http://www.w3.org/2002/07/owl#'
const SH = 'http://www.w3.org/ns/shacl#'
const DCT = 'http://purl.org/dc/terms/'

// The Hydra Core Vocabulary — the vocabulary the `core#` partition stewards.
export const HYDRA_NS = 'http://www.w3.org/ns/hydra/core#'
// Namespaces that make up the stewardship layer (core# itself + what it mirrors). The invention
// layer (agent#) must never reference these — enforced by the purity test.
export const STEWARDSHIP_NAMESPACES = [HYDRA_NS, 'https://hydrai.org/ns/core#']
// The equivalence predicates a stewardship mirror is allowed to use, and nothing else.
export const EQUIVALENCE_PREDICATES = [`${OWL}equivalentClass`, `${OWL}equivalentProperty`, `${OWL}sameAs`]

export const CURATED_CONTEXT = {
  hydrai: 'https://hydrai.org/ns/agent#',
  hcore: 'https://hydrai.org/ns/core#',
  hydra: HYDRA_NS,
  rdf: RDF,
  rdfs: RDFS,
  owl: OWL,
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  sh: SH,
  dcterms: DCT,
  cc: 'http://creativecommons.org/ns#',
}

const PREFIXES = Object.entries(CURATED_CONTEXT)

/** Shorten a full IRI to `prefix:local` when a known prefix matches, else return it bare. */
export function curie(iri) {
  if (typeof iri !== 'string') return iri
  for (const [p, base] of PREFIXES) if (iri.startsWith(base)) return `${p}:${iri.slice(base.length)}`
  return iri
}

const localName = (iri) => (iri.includes('#') ? iri.split('#').pop() : iri.split('/').pop())

export async function readTurtle(source) {
  return readFile(resolve(here, source.file), 'utf8')
}

export function parseStore(ttl) {
  return new Store(new Parser().parse(ttl))
}

const oneValue = (store, s, p) => {
  const [q] = store.getQuads(s, namedNode(p), null, null)
  return q ? q.object.value : undefined
}
const objects = (store, s, p) => store.getQuads(s, namedNode(p), null, null).map((q) => q.object)

function equivalentsOf(store, subject) {
  // Keep the predicate with each equivalence — RDFa needs to emit the exact axiom, not a lump.
  return EQUIVALENCE_PREDICATES.flatMap((p) =>
    objects(store, subject, p).map((o) => ({
      predicateIri: p,
      predicate: curie(p),
      iri: o.value,
      curie: curie(o.value),
    })),
  )
}

function termFrom(store, subject, kindLabel) {
  const iri = subject.value
  const range = oneValue(store, subject, `${RDFS}range`)
  const domain = oneValue(store, subject, `${RDFS}domain`)
  return {
    local: localName(iri),
    iri,
    curie: curie(iri),
    label: oneValue(store, subject, `${RDFS}label`) ?? localName(iri),
    comment: oneValue(store, subject, `${RDFS}comment`),
    kindLabel,
    types: objects(store, subject, `${RDF}type`).map((o) => curie(o.value)),
    range,
    rangeCurie: range ? curie(range) : undefined,
    domain,
    domainCurie: domain ? curie(domain) : undefined,
    equivalentTo: equivalentsOf(store, subject),
    seeAlso: objects(store, subject, `${RDFS}seeAlso`).map((o) => o.value),
    isDefinedBy: objects(store, subject, `${RDFS}isDefinedBy`).map((o) => o.value),
  }
}

function shapeFrom(store, subject) {
  const iri = subject.value
  const target =
    oneValue(store, subject, `${SH}targetClass`) ?? oneValue(store, subject, `${SH}targetSubjectsOf`)
  const properties = objects(store, subject, `${SH}property`).map((propShape) => {
    const constraints = []
    for (const q of store.getQuads(propShape, null, null, null)) {
      if (q.predicate.value === `${RDF}type`) continue
      if (q.object.termType === 'BlankNode') {
        const nested = store
          .getQuads(q.object, null, null, null)
          .filter((n) => n.predicate.value !== `${RDF}type`)
          .map((n) => ({ pred: curie(n.predicate.value), value: n.object.value }))
        constraints.push({ pred: curie(q.predicate.value), nested })
      } else {
        constraints.push({ pred: curie(q.predicate.value), value: curie(q.object.value) })
      }
    }
    return { constraints }
  })
  return {
    local: localName(iri),
    iri,
    curie: curie(iri),
    comment: oneValue(store, subject, `${RDFS}comment`),
    kindLabel: 'SHACL shape',
    target,
    targetCurie: target ? curie(target) : undefined,
    properties,
  }
}

/** The full term model for one source ontology — the shape templates consume. */
export function buildModel(store, source) {
  const ont = namedNode(source.ontologyIri)
  const ontology = {
    iri: source.ontologyIri,
    title: oneValue(store, ont, `${DCT}title`) ?? `HydrAI — ${source.slug}#`,
    version: oneValue(store, ont, `${OWL}versionInfo`) ?? '0.1',
    comment: oneValue(store, ont, `${RDFS}comment`) ?? source.blurb,
    license: oneValue(store, ont, `${DCT}license`),
    seeAlso: objects(store, ont, `${RDFS}seeAlso`).map((o) => o.value),
  }

  const inNs = (iri) => iri.startsWith(source.namespace)
  const iris = [
    ...new Set(
      store
        .getQuads(null, null, null, null)
        .map((q) => q.subject)
        .filter((s) => s.termType === 'NamedNode' && inNs(s.value))
        .map((s) => s.value),
    ),
  ].sort()

  const groups = { classes: [], objectProperties: [], datatypeProperties: [], properties: [], individuals: [], shapes: [] }
  const byLocal = {}
  const has = (s, p) => store.getQuads(s, namedNode(p), null, null).length > 0
  for (const iri of iris) {
    const s = namedNode(iri)
    const types = new Set(objects(store, s, `${RDF}type`).map((o) => o.value))
    let entry
    if (types.has(`${SH}NodeShape`)) {
      entry = shapeFrom(store, s)
      groups.shapes.push(entry)
    } else if (types.has(`${OWL}Class`) || types.has(`${RDFS}Class`) || has(s, `${OWL}equivalentClass`)) {
      // Classes are typed as such in the invention layer, or carry an equivalentClass axiom in the
      // stewardship layer (where a mirror term has no rdf:type of its own).
      entry = termFrom(store, s, 'class')
      groups.classes.push(entry)
    } else if (types.has(`${OWL}ObjectProperty`)) {
      entry = termFrom(store, s, 'object property')
      groups.objectProperties.push(entry)
    } else if (types.has(`${OWL}DatatypeProperty`)) {
      entry = termFrom(store, s, 'datatype property')
      groups.datatypeProperties.push(entry)
    } else if (types.has(`${RDF}Property`) || has(s, `${OWL}equivalentProperty`)) {
      entry = termFrom(store, s, 'property')
      groups.properties.push(entry)
    } else if (has(s, `${OWL}sameAs`)) {
      entry = termFrom(store, s, 'named individual')
      groups.individuals.push(entry)
    } else {
      continue
    }
    byLocal[entry.local] = entry
  }

  const terms = [
    ...groups.classes,
    ...groups.objectProperties,
    ...groups.datatypeProperties,
    ...groups.properties,
    ...groups.individuals,
  ]
  return { source, ontology, groups, terms, shapes: groups.shapes, byLocal, prefixes: PREFIXES }
}

function nquads(store) {
  return new Promise((res, rej) => {
    const writer = new Writer({ format: 'N-Quads' })
    writer.addQuads(store.getQuads(null, null, null, null))
    writer.end((err, result) => (err ? rej(err) : res(result)))
  })
}

/** A JSON-LD serialization of the graph, compacted against the curated context. */
export async function toJsonLd(store) {
  const doc = await jsonld.fromRDF(await nquads(store), { format: 'application/n-quads' })
  return jsonld.compact(doc, CURATED_CONTEXT)
}
