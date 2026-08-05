import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Design D11 — "No vendor IRI in `src/`. A grep-based assertion."
 *
 * The client's entire claim is that it knows nothing about any particular API. A single hardcoded
 * vendor detail makes it a bespoke client with extra steps. Three were present in the implementation
 * this replaces: a `mago.co` hostname test, a `PREFIX ns: <https://mago.co/ns#>` declaration, and a
 * hardcoded `ns:jsonKey` predicate.
 *
 * This should pass trivially and fail loudly the first time someone hardcodes one. It scans `src/`
 * only — fixtures under `test/` describe real and imaginary APIs and are supposed to name them.
 */

const clientRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(clientRoot, 'src')

/**
 * Deployment-specific identifiers. Any absolute IRI naming a particular deployment belongs in a
 * fixture or in a runtime-supplied value, never in the source.
 *
 * The bare vendor word is forbidden, not just `mago.co`. The spec requires no "vendor hostname,
 * vendor namespace IRI, vendor predicate, or vendor term **in any form**", and a hostname-only check
 * would pass things that plainly are vendor terms — `urn:mago:prov` as an internal graph name, or a
 * `mago:` prefix on a client-minted predicate. Enforcing the wider rule is cheap and means the
 * requirement is checked rather than described.
 *
 * This is why the session graphs are named `urn:hydraclient:*` rather than the `urn:mago:*` that
 * design D4 and D8 first wrote down.
 */
const FORBIDDEN = ['mago']

/**
 * Standard vocabularies are not vendor knowledge — they are the shared language the client reads
 * *with*. Bundling them is design D9. Listed here so the distinction is legible rather than implied:
 * anything on this list is fine in `src/`, anything naming a deployment is not.
 */
const PERMITTED_NAMESPACES = [
  'www.w3.org',
  'schema.org',
  'www.hydra-cg.com',
  'rdfs.org',
  'purl.org',
  'xmlns.com',
]

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...walk(full))
    } else if (/\.(ts|tsx|js|mjs|css|html)$/.test(entry)) {
      found.push(full)
    }
  }
  return found
}

/**
 * Everything that ships: the module tree, plus the page template. `index.html` sits at the project
 * root because that is where Vite looks for it, so it needs naming separately.
 */
function sourceFiles(): string[] {
  return [...walk(srcRoot), join(clientRoot, 'index.html')]
}

describe('no vendor IRI in src/', () => {
  it('finds no deployment-specific identifier', () => {
    const offences: string[] = []

    for (const file of sourceFiles()) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        for (const needle of FORBIDDEN) {
          if (line.toLowerCase().includes(needle)) {
            offences.push(`${relative(clientRoot, file)}:${i + 1} — ${line.trim()}`)
          }
        }
      })
    }

    expect(
      offences,
      `A deployment-specific identifier appears in src/. Everything the client knows about an API ` +
        `must come from documents that API publishes at runtime.\n\n${offences.join('\n')}`,
    ).toEqual([])
  })

  it('scans a non-empty set of files, so a passing result means something', () => {
    // Guards against the assertion above silently passing because the glob matched nothing.
    expect(sourceFiles().length).toBeGreaterThan(0)
  })

  it('documents which namespaces are permitted', () => {
    // Standard vocabularies are the client's reading language, not knowledge of one API.
    expect(PERMITTED_NAMESPACES).toContain('www.w3.org')
  })
})
