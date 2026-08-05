// Generate vocab/core.ttl — the `core#` stewardship mirror of the Hydra Core Vocabulary.
//
// core# re-asserts every Hydra core term via a single equivalence axiom to its canonical `hydra:`
// IRI, so the claim "HydrAI ⊇ Hydra" is provable by a reasoner. Every mirror subject carries EXACTLY
// ONE axiom and nothing else — no domain, range, or constraint — because any extra axiom would, via
// the equivalence, silently change Hydra's own meaning. Stewardship means re-asserting faithfully.
//
// The mirror is GENERATED from the authoritative Hydra vocabulary the reference client already
// bundles (its JSON-LD context), so it is complete and correct by construction rather than by hand.
// Re-run this if the bundled Hydra vocabulary is ever updated:  node vocab/build-core.mjs
// The generated core.ttl is checked in and validated by vocab/vocab.test.mjs (purity + bijection).

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hydraContextPath = resolve(here, '../examples/hydra-client/src/rdf/contexts/hydra-context.json')

const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x])

function classify(types) {
  const t = new Set(asArray(types))
  if (t.has('hydra:Class') || t.has('rdfs:Class') || t.has('rdfs:Datatype')) return 'class'
  // Instances of a Hydra class (representations, base-URI sources) are named individuals.
  if (t.has('hydra:VariableRepresentation') || t.has('hydra:BaseUriSource')) return 'individual'
  // rdf:Property, hydra:Link, hydra:TemplatedLink, or untyped predicates → properties.
  return 'property'
}

const PREDICATE = {
  class: 'owl:equivalentClass',
  property: 'owl:equivalentProperty',
  individual: 'owl:sameAs',
}

async function build() {
  const ctx = JSON.parse(await readFile(hydraContextPath, 'utf8'))
  const defines = ctx.defines ?? []

  const rows = { class: [], property: [], individual: [] }
  for (const term of defines) {
    const id = term['@id'] // e.g. "hydra:Resource"
    if (!id || !id.startsWith('hydra:')) continue
    const local = id.slice('hydra:'.length)
    rows[classify(term['@type'])].push(local)
  }
  for (const k of Object.keys(rows)) rows[k].sort()

  const emit = (locals, kind) =>
    locals.map((l) => `hcore:${l}  ${PREDICATE[kind]}  hydra:${l} .`).join('\n')

  const total = rows.class.length + rows.property.length + rows.individual.length

  const ttl = `@prefix hcore:   <https://hydrai.org/ns/core#> .
@prefix hydra:   <http://www.w3.org/ns/hydra/core#> .
@prefix owl:     <http://www.w3.org/2002/07/owl#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .

# =============================================================================
# HydrAI — core# (the stewardship layer)   ·   GENERATED — do not hand-edit
# =============================================================================
# Generated from the Hydra Core Vocabulary by vocab/build-core.mjs. ${total} terms mirrored.
#
# core# adopts the (dormant) Hydra Core Vocabulary and re-asserts it, unchanged, via one equivalence
# axiom per term. It exists so "HydrAI is a conservative superset of Hydra" is a theorem, not a claim.
#
#   >>> USE CANONICAL hydra: IRIs OVER THE WIRE. <<<
#
# core# is a formal backbone for reasoners and for the "superset" proof — it is NOT a wire vocabulary.
# A HydrAI-described API keeps emitting canonical hydra: IRIs, so pure-Hydra clients keep working; the
# curated @context is what makes the surface read as one vocabulary. Never emit hcore: on the wire.
#
# Purity (enforced by vocab/vocab.test.mjs): every subject here is an hcore: term carrying exactly one
# equivalence axiom whose object is the canonical hydra: term. No domain, range, label, or comment is
# added to a mirror — that would change Hydra's meaning through the equivalence. hydra: never appears
# as a subject; the assertion is always hydrai→hydra.
# =============================================================================

<https://hydrai.org/ns/core>
    a               owl:Ontology ;
    dcterms:title   "HydrAI — core# (Hydra stewardship mirror)" ;
    owl:versionInfo "0.1" ;
    dcterms:license <https://creativecommons.org/licenses/by/4.0/> ;
    rdfs:seeAlso    <https://www.hydra-cg.com/spec/latest/core/> ;
    rdfs:comment    """Stewardship mirror of the Hydra Core Vocabulary. Each term is re-asserted via a single owl:equivalentClass / owl:equivalentProperty / owl:sameAs axiom to its canonical hydra: IRI, making "HydrAI ⊇ Hydra" provable. USE hydra: IRIs OVER THE WIRE — core# is a formal backbone, not a wire vocabulary; APIs emit canonical hydra: IRIs so pure-Hydra clients keep working.""" .


# ── Classes (${rows.class.length}) ────────────────────────────────────

${emit(rows.class, 'class')}


# ── Properties (${rows.property.length}) ─────────────────────────────

${emit(rows.property, 'property')}


# ── Named individuals (${rows.individual.length}) ──────────────────────

${emit(rows.individual, 'individual')}
`

  await writeFile(resolve(here, 'core.ttl'), ttl, 'utf8')
  console.log(`vocab/core.ttl generated — ${rows.class.length} classes, ${rows.property.length} properties, ${rows.individual.length} individuals (${total} terms).`)
}

build().catch((err) => {
  console.error(err)
  process.exit(1)
})
