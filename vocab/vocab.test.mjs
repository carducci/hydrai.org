// Build-time validation of the published vocabulary. Run with `node --test` (see `npm run test:vocab`).
//
// This parses the actual `.ttl` sources and asserts the invariants that make HydrAI trustworthy:
//   • the ontologies parse and declare the terms the site and clients depend on;
//   • the invention layer (agent#) makes NO assertions about Hydra or the stewardship layer;
//   • the stewardship layer (core#) carries ONLY equivalence axioms to canonical hydra: IRIs, and
//     mirrors the Hydra Core Vocabulary exactly (bijection) — so "HydrAI ⊇ Hydra" is a theorem.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  SOURCES,
  readTurtle,
  parseStore,
  buildModel,
  toJsonLd,
  HYDRA_NS,
  STEWARDSHIP_NAMESPACES,
  EQUIVALENCE_PREDICATES,
} from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bySlug = Object.fromEntries(SOURCES.map((s) => [s.slug, s]))

async function load(slug) {
  const source = bySlug[slug]
  const store = parseStore(await readTurtle(source))
  return { source, store, model: buildModel(store, source) }
}

const allQuads = (store) => store.getQuads(null, null, null, null)
const namedNodesIn = (quad) =>
  [quad.subject, quad.predicate, quad.object].filter((t) => t.termType === 'NamedNode')

// ── Every source parses and round-trips ──────────────────────────────────────────────────────────
for (const source of SOURCES) {
  test(`${source.slug}: parses, is non-empty, and its ontology is declared`, async () => {
    const { store, model } = await load(source.slug)
    assert.ok(store.size > 0, 'expected triples')
    assert.equal(model.ontology.iri, source.ontologyIri)
    assert.ok(model.ontology.title, 'ontology has a title')
    assert.ok(model.ontology.version, 'ontology has a version')
    assert.ok(model.ontology.comment, 'ontology has a comment')
  })

  test(`${source.slug}: JSON-LD serialization round-trips to a non-empty graph`, async () => {
    const { store } = await load(source.slug)
    const doc = await toJsonLd(store)
    const graph = doc['@graph'] ?? [doc]
    assert.ok(graph.length > 0, 'expected a non-empty @graph')
  })

  test(`${source.slug}: every declared term IRI is inside the partition namespace`, async () => {
    const { source: s, model } = await load(source.slug)
    for (const term of [...model.terms, ...model.shapes]) {
      assert.ok(term.iri.startsWith(s.namespace), `${term.iri} is outside ${s.namespace}`)
    }
  })
}

// ── agent# — the invention layer ─────────────────────────────────────────────────────────────────
test('agent#: declares the 0.1 orientation terms and shapes', async () => {
  const { model } = await load('agent')
  for (const local of [
    'greeting',
    'exampleQuery',
    'ExampleQuery',
    'intent',
    'queryText',
    'overEndpoint',
    'GreetingShape',
    'ExampleQueryShape',
  ]) {
    assert.ok(model.byLocal[local], `expected agent#${local} to be declared`)
  }
})

test('agent#: every term carries a label and a comment (invention-layer completeness)', async () => {
  const { model } = await load('agent')
  for (const term of model.terms) {
    assert.ok(term.label, `${term.curie} is missing a label`)
    assert.ok(term.comment, `${term.curie} is missing a comment`)
  }
  for (const shape of model.shapes) {
    assert.ok(shape.comment, `${shape.curie} is missing a comment`)
  }
})

test('agent#: PURITY — makes no assertion about Hydra or the stewardship layer', async () => {
  const { store } = await load('agent')
  for (const quad of allQuads(store)) {
    for (const node of namedNodesIn(quad)) {
      for (const ns of STEWARDSHIP_NAMESPACES) {
        assert.ok(
          !node.value.startsWith(ns),
          `agent# references a stewardship IRI (${node.value}); the invention layer must be pure`,
        )
      }
    }
    assert.ok(
      !EQUIVALENCE_PREDICATES.includes(quad.predicate.value),
      `agent# uses an equivalence axiom (${quad.predicate.value}); those belong only in core#`,
    )
  }
})

// ── core# — the stewardship layer ────────────────────────────────────────────────────────────────
test('core#: every mirror subject carries EXACTLY ONE equivalence axiom to a canonical hydra: IRI', async () => {
  const { source, store } = await load('core')
  const perSubject = new Map()
  for (const quad of allQuads(store)) {
    if (quad.subject.value === source.ontologyIri) continue // the ontology header is not a mirror term
    assert.ok(
      quad.subject.value.startsWith(source.namespace),
      `core# has a foreign subject: ${quad.subject.value}`,
    )
    assert.ok(
      EQUIVALENCE_PREDICATES.includes(quad.predicate.value),
      `core#${quad.subject.value} carries a non-equivalence axiom (${quad.predicate.value}) — a mirror may say only its equivalence`,
    )
    assert.ok(
      quad.object.termType === 'NamedNode' && quad.object.value.startsWith(HYDRA_NS),
      `core# equivalence points at ${quad.object.value}, not a canonical hydra: IRI`,
    )
    perSubject.set(quad.subject.value, (perSubject.get(quad.subject.value) ?? 0) + 1)
  }
  for (const [subject, count] of perSubject) {
    assert.equal(count, 1, `${subject} carries ${count} axioms; a mirror carries exactly one`)
  }
})

test('core#: hydra: never appears as a subject (the assertion is always hydrai → hydra)', async () => {
  const { store } = await load('core')
  for (const quad of allQuads(store)) {
    assert.ok(!quad.subject.value.startsWith(HYDRA_NS), `hydra: term ${quad.subject.value} is a subject in core#`)
  }
})

test('core#: BIJECTION — mirrors exactly the Hydra Core Vocabulary, 1:1', async () => {
  const { store } = await load('core')

  // The authoritative Hydra term set: the vocabulary the reference client bundles.
  const ctxPath = resolve(here, '../examples/hydra-client/src/rdf/contexts/hydra-context.json')
  const ctx = JSON.parse(await readFile(ctxPath, 'utf8'))
  const hydraTerms = new Set(
    (ctx.defines ?? [])
      .map((d) => d['@id'])
      .filter((id) => typeof id === 'string' && id.startsWith('hydra:'))
      .map((id) => HYDRA_NS + id.slice('hydra:'.length)),
  )

  // The set core# actually mirrors: the objects of its equivalence axioms.
  const mirrored = []
  for (const quad of allQuads(store)) {
    if (EQUIVALENCE_PREDICATES.includes(quad.predicate.value)) mirrored.push(quad.object.value)
  }
  const mirroredSet = new Set(mirrored)

  assert.equal(mirrored.length, mirroredSet.size, 'a Hydra term is mirrored more than once')

  const missing = [...hydraTerms].filter((t) => !mirroredSet.has(t))
  const extra = [...mirroredSet].filter((t) => !hydraTerms.has(t))
  assert.deepEqual(missing, [], `core# fails to mirror Hydra terms: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `core# mirrors non-Hydra-core terms: ${extra.join(', ')}`)
})
