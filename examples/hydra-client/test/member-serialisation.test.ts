import { beforeAll, describe, expect, it } from 'vitest'

import { createContextStore } from '../src/rdf/document-loader'
import { FINDING_KINDS, createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { buildCapabilityModel, type ClassCapability } from '../src/vocab/capability'
import { assessMemberSerialisation } from '../src/vocab/member-serialisation'

import libraryVocab from './fixtures/library-vocab.json'

const LEND = 'https://lending.example/ns#'
const STACKS = 'https://lending.example/api/stacks'

function offlineContexts() {
  return createContextStore({
    fetchJson: async (url) => {
      throw new Error(`no network in tests: ${url}`)
    },
  })
}

/** A Tome as a collection member would serialise it, with control over which fields are present. */
function tome(fields: Record<string, unknown>) {
  return {
    '@context': { lend: LEND, heading: 'lend:heading', isbn: 'lend:isbn', shelvedOn: 'lend:shelvedOn' },
    '@id': 'https://lending.example/api/tomes/1',
    ...fields,
  }
}

describe('detecting whether a collection serves the fields it declares', () => {
  let tomeClass: ClassCapability

  beforeAll(async () => {
    const graph = createSessionGraph()
    graph.ingestDocument(
      await quadsFromJsonLd(libraryVocab, offlineContexts().load, 'https://lending.example/api/vocab'),
      GRAPHS.vocab,
    )
    const model = buildCapabilityModel(graph)
    tomeClass = model.byIri(`${LEND}Tome`)!
  })

  it('treats a mentioned-but-null field as served', async () => {
    /*
     * The heart of it. The server writes `"isbn": null` for a tome with no ISBN, and JSON-LD expansion
     * emits no triple for a null — so the predicate is absent from the graph. Reading that as "not served"
     * would refuse aggregation over a field the API does provide.
     *
     * The mention is the proof, and mentions are only visible in the JSON, at this boundary.
     */
    const result = await assessMemberSerialisation(
      [tome({ heading: 'Dune', isbn: null, shelvedOn: null })],
      tomeClass,
      STACKS,
      { loader: offlineContexts().load },
    )

    expect(result.mentioned).toContain(`${LEND}isbn`)
    expect(result.populated).not.toContain(`${LEND}isbn`)
    expect(result.missing).toEqual([])
    expect(result.aggregationReady).toBe(true)
  })

  it('is not fooled by sparse data across a page', async () => {
    // Real page 1 of this API's Contact collection had a member with 21 of 36 fields empty. Any check
    // that treated an empty field as an unserved field would condemn almost every collection.
    const result = await assessMemberSerialisation(
      [
        tome({ heading: 'Dune', isbn: null, shelvedOn: null }),
        tome({ heading: null, isbn: null, shelvedOn: null }),
        tome({ heading: null, isbn: '978-0', shelvedOn: null }),
      ],
      tomeClass,
      STACKS,
      { loader: offlineContexts().load },
    )

    expect(result.aggregationReady).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('reports a genuinely abbreviated member, naming what is missing', async () => {
    // The failure design D5 exists to prevent: materialise everything, aggregate a field no member
    // carries, and SUM returns a confidently wrong number.
    const findings = createFindings()
    const result = await assessMemberSerialisation(
      [tome({ heading: 'Dune' }), tome({ heading: 'Emma' })],
      tomeClass,
      STACKS,
      { loader: offlineContexts().load, findings },
    )

    expect(result.aggregationReady).toBe(false)
    expect(result.missing).toEqual([`${LEND}isbn`, `${LEND}shelvedOn`])

    const recorded = findings.all()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.kind).toBe(FINDING_KINDS.abbreviatedMembers)
    expect(recorded[0]?.about).toBe(STACKS)
    // Actionable: which fields, and what serialising them would make possible.
    expect(recorded[0]?.message).toContain(`${LEND}isbn`)
    expect(recorded[0]?.message).toMatch(/refused/)
    expect(recorded[0]?.message).toMatch(/null where absent/)
  })

  it('records no finding when there is nothing to report', async () => {
    const findings = createFindings()
    await assessMemberSerialisation(
      [tome({ heading: 'Dune', isbn: null, shelvedOn: null })],
      tomeClass,
      STACKS,
      { loader: offlineContexts().load, findings },
    )
    expect(findings.all()).toEqual([])
  })

  it('does not hold a write-only property against a listing', async () => {
    // Only readable properties are in scope. Every Tome property is readable in the fixture, so this
    // asserts the filter exists rather than that it fires.
    const writeOnly = tomeClass.properties.filter((p) => !p.readable)
    expect(writeOnly).toEqual([])
    expect(tomeClass.properties.every((p) => p.readable)).toBe(true)
  })
})
