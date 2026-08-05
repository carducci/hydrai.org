import Anthropic from '@anthropic-ai/sdk'

import { createAgent, type Agent } from './agent/loop'
import { manifestPrefixes, renderManifest } from './agent/manifest'
import { DEFAULT_MODEL, MODEL_CHOICES, readModelCapability } from './agent/model'
import { buildSystem } from './agent/prompt'
import { readOrientation, renderOrientation } from './agent/orientation'
import { toolsForRequest } from './agent/tools'
import { createExecutor } from './execute/dispatch'
import { locateClass } from './execute/locate'
import { createHttpClient } from './http/client'
import { projectTools } from './project/tools'
import { createQueryRunner } from './query/engine'
import { QUERY_TOOL_NAME, withQueryTool } from './query/tool'
import { createContextStore } from './rdf/document-loader'
import { createFindings } from './rdf/findings'
import { createSessionGraph } from './rdf/session-graph'
import { createTrace } from './trace'
import { mountCapabilityPanel } from './ui/capability-panel'
import { mountChatInput } from './ui/chat-input'
import { mountConnectionForm } from './ui/connection-form'
import { mountMessages } from './ui/messages'
import { mountSecretFields } from './ui/secret-field'
import { mountTraceView } from './ui/trace-view'
import {
  buildCapabilityModel,
  constraintsFor,
  constraintsOfShape,
  primaryNamespace,
} from './vocab/capability'
import { discoverApi } from './vocab/discover'
import { materialiseValueSets } from './vocab/value-sets'
import { assessTier, probeOntology } from './vocab/tiers'

/**
 * Entry point (task 7.7).
 *
 * Connecting is the whole client in sequence, and the order is not arbitrary — each stage consumes
 * what the one before it produced, and none of them is allowed to reach past its neighbour:
 *
 *     discover ──▶ capability model ──▶ tool surface ──▶ executor ──▶ agent
 *      (docs)        (from the graph)     (projection)   (dispatch)   (loop)
 *
 * Everything below this file is reusable in something that is not this page: nothing in the runtime
 * touches the DOM, and this module is the only place that knows a sidebar exists. That constraint is
 * why the agentic work this playground is a step towards can be built *around* it rather than inside
 * it.
 *
 * ## What connecting does not require
 *
 * A model key. Discovery, the capability model, the projected surface and the tier ladder are all
 * properties of the API, and they are worth seeing on their own — an operator pointing this at their
 * own vocabulary for the first time is asking what it produces, not asking a question. So a connect
 * without a key succeeds, renders everything, and says the chat needs one. A connect that refused
 * would be withholding the part that is actually about their API.
 */

function required<E extends Element>(id: string): E {
  const el = document.getElementById(id)
  if (!el) throw new Error(`The page is missing #${id}, which the shell requires.`)
  return el as unknown as E
}

const trace = createTrace()

const traceView = mountTraceView(trace, {
  main: required<HTMLElement>('main'),
  toggle: required<HTMLElement>('trace-toggle'),
  body: required<HTMLElement>('trace-body'),
  dot: required<HTMLElement>('trace-dot'),
  count: required<HTMLElement>('trace-count'),
})

const secrets = mountSecretFields(document)

const form = mountConnectionForm({
  entrypoint: required<HTMLInputElement>('entrypoint'),
  apiToken: required<HTMLInputElement>('crm-token'),
  modelKey: required<HTMLInputElement>('ai-key'),
  status: required<HTMLElement>('status'),
})

const panel = mountCapabilityPanel({
  tierList: required<HTMLElement>('tier-list'),
  tierNote: required<HTMLElement>('tier-note'),
  capList: required<HTMLElement>('cap-list'),
  sparqlDivider: required<HTMLElement>('sparql-divider'),
  sparqlSection: required<HTMLElement>('sparql-section'),
  sparqlList: required<HTMLElement>('sparql-cap'),
})

const messages = mountMessages({
  list: required<HTMLElement>('messages'),
  empty: required<HTMLElement>('empty'),
})

// The selector's options come from the roster rather than the markup, so adding a model is one edit.
const modelSelect = required<HTMLSelectElement>('model')
for (const choice of MODEL_CHOICES) {
  const option = document.createElement('option')
  option.value = choice.id
  option.textContent = choice.label
  option.title = choice.note
  modelSelect.appendChild(option)
}
modelSelect.value = DEFAULT_MODEL

const connectButton = required<HTMLButtonElement>('connect-btn')
const refreshButton = required<HTMLButtonElement>('refresh-btn')

/** The live session. `null` until a connect succeeds; replaced wholesale by the next one. */
let agent: Agent | null = null
/** Guards against a second connect racing the first — both would write the same panel. */
let connecting = false

const chat = mountChatInput({
  textarea: required<HTMLTextAreaElement>('chat-input'),
  send: required<HTMLButtonElement>('send-btn'),
  async onSubmit(text) {
    if (!agent) return

    messages.add('user', text)
    chat.clear()
    chat.setEnabled(false)
    trace.start()

    const pending = messages.pending('thinking…')

    try {
      const turn = await agent.send(text)
      pending.settle(turn.reply || '(the model replied with nothing)')
      trace.log(
        `Turn complete: ${turn.iterations} request${turn.iterations === 1 ? '' : 's'}, ` +
          `${turn.toolCalls} tool call${turn.toolCalls === 1 ? '' : 's'}, ` +
          `${turn.usage.cacheRead} tokens read from cache.`,
        'info',
      )
    } catch (cause) {
      /*
       * A failed turn stays in the transcript.
       *
       * Removing it would leave a conversation that reads as though the question was never asked,
       * while the agent's own history still holds it — the two would disagree about what happened.
       */
      const reason = cause instanceof Error ? cause.message : String(cause)
      pending.fail(`That turn failed: ${reason}`)
      trace.log(reason, 'error')
    } finally {
      chat.setEnabled(true)
      chat.focus()
    }
  },
})

async function connect(): Promise<void> {
  if (connecting) return
  connecting = true
  connectButton.disabled = true

  const connection = form.read()
  form.save()

  trace.clear()
  trace.start()
  traceView.setActive(true)
  chat.setEnabled(false)
  agent = null

  form.setStatus('connecting…')

  try {
    if (!connection.entrypoint) throw new Error('An API entrypoint is required to connect.')

    /*
     * Every session starts from an empty graph.
     *
     * Reconnecting to a different deployment with the previous one's vocabulary still loaded would
     * project a tool surface describing neither, and the failure would look like a bad vocabulary.
     */
    const graph = createSessionGraph()
    const findings = createFindings()
    const contexts = createContextStore()
    const http = createHttpClient({
      token: connection.apiToken || null,
      onRequest: () => undefined,
    })

    // ── 1. Discovery. One address in; everything else read from what the server publishes.
    const discovered = await discoverApi(connection.entrypoint, {
      http,
      graph,
      contexts,
      findings,
      trace,
    })

    // ── 2. The capability model, built by querying the graph. No JSON is walked.
    const model = buildCapabilityModel(graph)
    const namespace = primaryNamespace(model)
    trace.log(
      `${model.classes.length} classes, ${model.collections.length} collections, ` +
        `${model.classes.reduce((n, c) => n + c.operations.length, 0)} operations declared`,
      'success',
    )

    const ontology = await probeOntology(namespace, {
      http,
      findings,
      connectOrigin: connection.entrypoint,
    })

    const assessment = assessTier(graph, discovered, {
      ontology: ontology.available,
      // Reachable is not the same as usable: an invalid context buys no tier.
      contextResolved: discovered.contextsUnreachable.length === 0 && discovered.contextUsable,
      ontologyAdvertised: discovered.ontologyUrl !== null,
    })
    trace.log(`Capability tier: ${assessment.tier}`, 'info')
    for (const caveat of assessment.caveats) trace.log(caveat, 'warn')

    // ── 3. Projection. One tool per declared affordance, plus the client's own query tool.
    const constraints = (iri: string) => constraintsFor(graph, iri)
    const surface = withQueryTool(
      projectTools(model, {
        constraintsFor: constraints,
        constraintsOfShape: (iri) => constraintsOfShape(graph, iri),
        findings,
      }),
    )
    trace.log(`${surface.tools.length} affordances projected from the vocabulary`, 'success')

    // ── 3b. Live enums (design D5): reference collections materialised at connect, members
    // indexed by class. Absent or incomplete, every consumer degrades to plain IRI references.
    const valueSets = await materialiseValueSets(
      model,
      { http, graph, contexts, findings, trace, origin: connection.entrypoint },
      { entrypoint: discovered.entrypoint },
    )

    // The same resolution dispatch uses, closed over here so the manifest layer never imports it.
    const locate = (classIri: string): string | null => {
      const cls = model.byIri(classIri)
      return cls ? locateClass(cls, { graph, entrypoint: discovered.entrypoint }).url : null
    }
    const manifestDeps = {
      constraintsFor: constraints,
      primaryNamespace: namespace,
      valueSets,
      surface,
      locate,
    }
    const manifest = renderManifest(model, manifestDeps)

    /*
     * ── 4. Execution, with the query runner behind it.
     *
     * The endpoint is passed only when it was **probed and answered**. Routing on the advertisement
     * would send queries somewhere that does not respond and report the failure as the API's.
     */
    const endpoint = discovered.sparqlReachable ? discovered.sparqlEndpoint : null
    const executor = createExecutor({
      http,
      graph,
      contexts,
      findings,
      trace,
      surface,
      model,
      origin: connection.entrypoint,
      entrypoint: discovered.entrypoint,
      valueSets,
      prefixes: manifestPrefixes(manifestDeps),
      shapes: { constraintsFor: constraints, constraintsOfShape: (iri) => constraintsOfShape(graph, iri) },
      query: createQueryRunner({
        graph,
        model,
        http,
        contexts,
        findings,
        trace,
        constraintsFor: constraints,
        origin: connection.entrypoint,
        entrypoint: discovered.entrypoint,
        sparqlEndpoint: endpoint,
        prefixes: manifestPrefixes(manifestDeps),
        // Reuses the executor's own filtered-view selector for pushdown (design D1).
        surface,
      }),
    })

    panel.render({
      assessment,
      model,
      surface,
      queryToolName: QUERY_TOOL_NAME,
      queryRunsOn: endpoint ? 'the advertised endpoint' : 'materialised collections, here',
    })
    refreshButton.hidden = false

    // ── 5. The agent, if there is a key. Everything above is about the API and stands without one.
    if (!connection.modelKey) {
      form.setStatus(`${assessment.tier} — add a model key to chat`, 'error')
      trace.log(
        'Connected and the surface is projected. Add an Anthropic API key to ask questions — ' +
          'everything above this line is about the API and needed no key.',
        'warn',
      )
      return
    }

    const anthropic = new Anthropic({
      apiKey: connection.modelKey,
      dangerouslyAllowBrowser: true,
    })
    const capability = await readModelCapability(anthropic, modelSelect.value)
    const request = toolsForRequest(surface)
    trace.log(
      `${request.count} envelope tools on the wire; ${surface.tools.length} affordances behind them.`,
      'info',
    )

    // Optional HydrAI orientation (design D5): when the API advertises a greeting / example queries,
    // fold them into the system prompt as a fenced, untrusted block. `renderOrientation` yields null
    // when nothing is advertised, so `buildSystem` simply omits the block — absence is not failure.
    const orientation = renderOrientation(readOrientation(graph, discovered.entrypoint)) ?? undefined
    if (orientation) trace.log('HydrAI orientation advertised — folded in, fenced as untrusted', 'info')

    agent = createAgent({
      anthropic,
      executor,
      surface,
      trace,
      model: capability,
      system: buildSystem({ manifest, orientation }),
    })

    chat.setEnabled(true)
    chat.focus()
    form.setStatus(`connected — ${assessment.tier}`, 'connected')
    trace.log(`Ready. Asking ${capability.displayName}.`, 'success')
  } catch (cause) {
    /*
     * A failed connect says what failed and stops. It does not fall back to a partial surface:
     * a tool list built from half a vocabulary is a client that will confidently do the wrong thing.
     */
    const reason = cause instanceof Error ? cause.message : String(cause)
    trace.log(reason, 'error')
    form.setStatus('not connected', 'error')
    panel.reset()
  } finally {
    connecting = false
    connectButton.disabled = false
  }
}

connectButton.addEventListener('click', () => {
  void connect()
})

// Re-reads the published documents without touching the conversation's credentials. A vocabulary
// that changed under a running session is the case this exists for.
refreshButton.addEventListener('click', () => {
  trace.log('Re-reading the published documents…', 'info')
  void connect()
})

required<HTMLButtonElement>('clear-btn').addEventListener('click', () => {
  form.clear()
  secrets.maskAll()
  trace.clear()
  messages.clear()
  panel.reset()
  agent = null
  chat.setEnabled(false)
  refreshButton.hidden = true
  trace.log('Waiting for connection…')
  form.setStatus('not connected')
})

panel.reset()

// Matches the proof of concept's initial trace line, timestamp included: elapsed reads `--` until a
// run starts.
trace.log('Waiting for connection…')
traceView.setActive(false)
