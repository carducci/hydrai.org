import Anthropic from '@anthropic-ai/sdk'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  MANIFEST_TOKEN_THRESHOLD,
  measureManifest,
  renderManifest,
  type Manifest,
} from '../src/agent/manifest'
import { DEFAULT_MODEL, readModelCapability, requestShapeFor } from '../src/agent/model'
import { buildSystem, userTurn } from '../src/agent/prompt'
import { toolsForRequest } from '../src/agent/tools'
import { createContextStore } from '../src/rdf/document-loader'
import { createFindings } from '../src/rdf/findings'
import { quadsFromJsonLd } from '../src/rdf/ingest'
import { createSessionGraph } from '../src/rdf/session-graph'
import { GRAPHS } from '../src/rdf/terms'
import { projectTools, type ToolSurface } from '../src/project/tools'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  primaryNamespace,
} from '../src/vocab/capability'

import magoShapes from './fixtures/mago-shapes.json'
import magoVocab from './fixtures/mago-vocab.json'

/**
 * Tasks 6.3a and 6.4 — the two things that cannot be settled offline.
 *
 * Both are questions about a service, not about this code: how many tokens *this* tokenizer makes of
 * the rendered manifest, and whether the API honours the breakpoint the offline tests prove is
 * correctly placed. Reasoning about either produces a number or a claim that is not evidence.
 *
 * Gated on a key so a missing one is a skip rather than a failing suite:
 *
 *     wsl zsh -lic 'cd "…/src/Web/HydraClient" && ANTHROPIC_API_KEY="sk-…" npm test'
 *
 * These spend real tokens. The cache smoke test issues two small requests; the measurement issues
 * one `count_tokens` call, which is not billed.
 */

const KEY = process.env['ANTHROPIC_API_KEY']
const live = KEY ? describe : describe.skip

live('measured against the API', () => {
  let anthropic: Anthropic
  let manifest: Manifest
  let surface: ToolSurface

  beforeAll(async () => {
    anthropic = new Anthropic({ apiKey: KEY, dangerouslyAllowBrowser: true })

    const contexts = createContextStore({
      fetchJson: async (url) => {
        throw new Error(`the network must not be reached for documents, but ${url} was requested`)
      },
    })
    const graph = createSessionGraph()

    // The real published documents, captured from a live boot — so the measurement is of this API's
    // actual vocabulary rather than of a fixture written to be convenient.
    graph.ingestDocument(
      await quadsFromJsonLd(magoVocab, contexts.load, 'http://example.test/Api/Vocab'),
      GRAPHS.vocab,
    )
    graph.ingestDocument(
      await quadsFromJsonLd(magoShapes, contexts.load, 'http://example.test/Api/Shapes'),
      GRAPHS.shapes,
    )

    const model = buildCapabilityModel(graph)
    manifest = renderManifest(model, {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      primaryNamespace: primaryNamespace(model),
      // A stand-in address per collection, shaped like the real ones, so the measurement covers
      // the address lines the live page renders (deterministic-agent-surface). Offline fixtures
      // have no entry-point document to resolve real addresses from.
      locate: (classIri) => {
        const local = classIri.split(/[#/]/).pop() ?? ''
        return local.length > 0
          ? `http://example.test/Api/${local.replace(/Collection$/, '')}/`
          : null
      },
    })
    surface = projectTools(model, {
      constraintsFor: (iri) => constraintsFor(graph, iri),
      constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
      findings: createFindings(),
    })
  })

  it('measures the rendered manifest, and reports which side of the threshold it lands on', async () => {
    /*
     * Task 6.3a. Design D7 estimated 3–6K tokens from "roughly 220 terms"; the local ontology
     * declares more classes than that estimate assumed terms, so the estimate is not evidence about
     * this API. Only the tokenizer for the model that will read it can settle it.
     *
     * Both sections are measured separately, because the disclosure decision is about dropping the
     * property detail — knowing the total without knowing the split would not tell you what dropping
     * it buys.
     */
    // All four sections — the affordance index (task 3.1) is part of the map and has to be in the
    // measurement, or "whole" measures the map of a change ago and the number is not evidence.
    const whole = await measureManifest(anthropic, DEFAULT_MODEL, [
      manifest.prefixes,
      manifest.classes,
      manifest.affordances,
      manifest.properties,
    ])
    const orientationOnly = await measureManifest(anthropic, DEFAULT_MODEL, [
      manifest.prefixes,
      manifest.classes,
      manifest.affordances,
    ])

    // eslint-disable-next-line no-console
    console.log(
      `manifest: ${whole} tokens whole, ${orientationOnly} with property detail dropped ` +
        `(${manifest.counts.classes} classes, ${manifest.counts.properties} properties); ` +
        `threshold ${MANIFEST_TOKEN_THRESHOLD} — ` +
        `${whole > MANIFEST_TOKEN_THRESHOLD ? 'disclose on demand' : 'ship whole'}`,
    )

    expect(whole).toBeGreaterThan(0)
    expect(orientationOnly).toBeLessThan(whole)
  }, 60_000)

  it('reads a cache hit on the second request of a conversation', async () => {
    /*
     * Task 6.4. The offline tests prove the breakpoint is on the last block of the stable prefix and
     * that nothing volatile precedes it. This is the other half: that the API agrees.
     *
     * Zero here is the finding, not a flake — it means something in the prefix differs between the
     * two requests, and the offline tests cannot see it because they compare the prompt this code
     * builds, not the bytes the SDK serialises.
     */
    const capability = await readModelCapability(anthropic, DEFAULT_MODEL)
    const request = toolsForRequest(surface)
    const system = buildSystem({ manifest })
    const tools = request.tools as Anthropic.ToolUnion[]
    const shape = requestShapeFor(capability)

    const ask = (question: string) =>
      anthropic.messages.create({
        model: capability.id,
        system,
        tools,
        messages: [userTurn(question, new Date())],
        ...shape,
      })

    const first = await ask('Reply with the single word OK and call no tools.')
    const second = await ask('Reply with the single word FINE and call no tools.')

    // The prefix has to clear the model's minimum before any of this is eligible at all. Creation
    // and read are summed, not chained with `??`: a run within the cache TTL of a previous one
    // legitimately reads on its FIRST request (creation 0, read > 0), and `0 ?? x` never falls
    // through — the old chain misread a warm cache as no cache. Found when two full-suite runs
    // three minutes apart flipped this test.
    expect(
      (first.usage.cache_creation_input_tokens ?? 0) + (first.usage.cache_read_input_tokens ?? 0),
    ).toBeGreaterThan(0)
    expect(second.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(0)
  }, 180_000)
})
