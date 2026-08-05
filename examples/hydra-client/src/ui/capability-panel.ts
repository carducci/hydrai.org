import type { ProjectedTool, ToolSurface } from '../project/tools'
import type { CapabilityModel } from '../vocab/capability'
import { describeLadder, type TierAssessment } from '../vocab/tiers'

/**
 * The sidebar (tasks 3.6 and 7.7).
 *
 * Two panels, and both are the client reporting what it found rather than what it expected. The
 * capability list is the projected tool surface — every entry is something the server declared, so an
 * operator can read the sidebar against their own vocabulary and see the correspondence. The tier
 * ladder is the roadmap: which documents this API publishes, and what publishing the next one buys.
 *
 * Task 3.6 deferred the rendering here because there was no page to render into yet. Nothing in this
 * module decides anything — it is a strict consumer of the runtime, which is the constraint that keeps
 * the runtime embeddable in something that is not this page.
 */

export interface CapabilityPanelElements {
  readonly tierList: HTMLElement
  readonly tierNote: HTMLElement
  readonly capList: HTMLElement
  readonly sparqlDivider: HTMLElement
  readonly sparqlSection: HTMLElement
  readonly sparqlList: HTMLElement
}

export interface CapabilityView {
  readonly assessment: TierAssessment
  readonly model: CapabilityModel
  readonly surface: ToolSurface
  /** The query tool's name, so it is listed under analytics rather than among the REST affordances. */
  readonly queryToolName: string
  /** Where a query would run. Reported to the operator; never told to the model. */
  readonly queryRunsOn: 'the advertised endpoint' | 'materialised collections, here'
}

export interface CapabilityPanel {
  render(view: CapabilityView): void
  reset(): void
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** One row: a bold name and a quieter line under it. Never innerHTML — every value here is server text. */
function item(name: string, detail: string, live: 'live' | 'live-sparql' | null): HTMLElement {
  const row = element('div', live ? `cap-item ${live}` : 'cap-item')
  row.appendChild(element('div', 'cap-name', name))
  if (detail) row.appendChild(element('div', 'cap-ops', detail))
  return row
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** The local name of an IRI, for a label. Not used to derive anything — see `project/tools`. */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  if (hash >= 0) return iri.slice(hash + 1)
  const slash = iri.lastIndexOf('/')
  return slash >= 0 ? iri.slice(slash + 1) : iri
}

export function mountCapabilityPanel(els: CapabilityPanelElements): CapabilityPanel {
  return {
    reset() {
      clear(els.tierList)
      clear(els.capList)
      clear(els.sparqlList)
      els.tierNote.textContent = ''
      els.capList.appendChild(element('div', 'cap-empty', 'connect to discover'))
      els.sparqlSection.hidden = true
      els.sparqlDivider.hidden = true
    },

    render(view) {
      clear(els.tierList)
      clear(els.capList)
      clear(els.sparqlList)

      // ── The ladder. Every rung, with the reached ones marked, so the sidebar doubles as a roadmap.
      for (const rung of describeLadder(view.assessment)) {
        els.tierList.appendChild(item(rung.tier, rung.label, rung.reached ? 'live' : null))
      }

      const notes: string[] = []
      if (view.assessment.nextUnlocks) notes.push(view.assessment.nextUnlocks)
      notes.push(...view.assessment.caveats)
      els.tierNote.textContent = notes.join(' ')

      /*
       * ── REST capabilities, grouped by the class that declared them.
       *
       * Grouped rather than listed flat because the correspondence an operator is checking is
       * class-to-affordance: this class, these operations. The tool names are shown verbatim, since
       * they are what appears in the trace when one is called.
       */
      const byClass = new Map<string, ProjectedTool[]>()
      for (const tool of view.surface.tools) {
        if (tool.name === view.queryToolName) continue
        const held = byClass.get(tool.dispatch.classIri) ?? []
        held.push(tool)
        byClass.set(tool.dispatch.classIri, held)
      }

      if (byClass.size === 0) {
        els.capList.appendChild(element('div', 'cap-empty', 'the vocabulary declares no affordances'))
      }

      for (const classIri of [...byClass.keys()].sort()) {
        const tools = byClass.get(classIri) ?? []
        const declared = view.model.byIri(classIri)
        els.capList.appendChild(
          item(
            declared?.title ?? localName(classIri),
            tools.map((tool) => tool.name).join(' · '),
            'live',
          ),
        )
      }

      // ── Analytics. One tool at every tier; what changes with the tier is where it runs.
      const queryTool = view.surface.byName(view.queryToolName)
      if (queryTool) {
        els.sparqlDivider.hidden = false
        els.sparqlSection.hidden = false
        els.sparqlList.appendChild(item(queryTool.name, `runs on ${view.queryRunsOn}`, 'live-sparql'))
      }
    },
  }
}
