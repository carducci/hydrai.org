import { ContextFetchError, type ContextStore } from './document-loader'
import { FINDING_KINDS, type Findings } from './findings'

/**
 * Runtime context discovery (task 2.4).
 *
 * Only standard vocabularies are bundled. Whatever contexts *this* server references are found by
 * walking the documents it serves, fetched once, and cached for the session — so expansion never
 * reaches the network mid-flight and a customer's own contexts need no build step.
 *
 * A context that cannot be retrieved is reported **by name**. That is the point: a browser-based
 * generic client needs the operator's `@context` documents readable cross-origin, and saying which
 * document is unreadable is far more useful than quietly under-performing. Left unreported it presents
 * as "the vocabulary does not declare X" — a deployment problem wearing a missing feature's clothes.
 */

export interface DiscoveryResult {
  /** Every context IRI referenced by the documents walked. */
  readonly referenced: readonly string[]
  /** Resolved and available for expansion, with how each was obtained. */
  readonly resolved: ReadonlyMap<string, 'bundled' | 'cached' | 'network'>
  /** Referenced but unretrievable. Each has a finding recorded against it. */
  readonly unreachable: readonly string[]
}

export interface DiscoveryDependencies {
  readonly contexts: ContextStore
  readonly findings: Findings
  readonly onProgress?: (message: string) => void
}

/**
 * Collect `@context` references from a parsed JSON-LD document.
 *
 * `@context` may be a string, an inline object, or an array mixing both, and may appear at any depth.
 * Only the string forms name a document that needs retrieving; inline objects are already present.
 */
export function collectContextReferences(document: unknown, base?: string): string[] {
  const found = new Set<string>()

  const add = (value: string) => {
    const resolved = resolve(value, base)
    if (resolved) found.add(resolved)
  }

  const walk = (node: unknown, depth: number): void => {
    if (depth > 32 || node === null || typeof node !== 'object') return

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === '@context') {
        for (const ref of [value].flat()) {
          if (typeof ref === 'string') add(ref)
          // An inline context object may itself reference others via a nested @context.
          else walk(ref, depth + 1)
        }
        continue
      }
      walk(value, depth + 1)
    }
  }

  walk(document, 0)
  return [...found]
}

function resolve(value: string, base?: string): string | null {
  try {
    return base ? new URL(value, base).toString() : new URL(value).toString()
  } catch {
    // A relative reference with no base cannot be resolved, and guessing one would be inventing a
    // convention. Skip it; expansion will report the term as unmapped if it mattered.
    return null
  }
}

export interface DocumentToWalk {
  readonly url: string
  readonly document: unknown
}

export async function discoverContexts(
  documents: readonly DocumentToWalk[],
  deps: DiscoveryDependencies,
): Promise<DiscoveryResult> {
  const { contexts, findings, onProgress } = deps

  const referenced = new Set<string>()
  const unreachable: string[] = []
  const visited = new Set<string>()

  // A context document may reference further contexts, so this is a queue rather than a single pass.
  const queue: string[] = []
  for (const { url, document } of documents) {
    for (const ref of collectContextReferences(document, url)) queue.push(ref)
  }

  while (queue.length > 0) {
    const url = queue.shift()
    if (!url || visited.has(url)) continue
    visited.add(url)
    referenced.add(url)

    try {
      const loaded = await contexts.load(url)
      const how = contexts.resolutions().get(url) ?? 'network'
      onProgress?.(`context ${url} (${how})`)

      // Follow references out of the context we just obtained.
      for (const ref of collectContextReferences(loaded.document, url)) {
        if (!visited.has(ref)) queue.push(ref)
      }
    } catch (cause) {
      unreachable.push(url)
      findings.record({
        about: url,
        kind: FINDING_KINDS.contextUnreachable,
        message:
          cause instanceof ContextFetchError
            ? cause.message
            : `The context <${url}> could not be retrieved: ${String(cause)}`,
      })
      onProgress?.(`context ${url} UNREACHABLE — recorded as a deployment finding`)
    }
  }

  return {
    referenced: [...referenced],
    resolved: contexts.resolutions(),
    unreachable,
  }
}
