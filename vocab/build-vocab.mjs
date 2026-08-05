// Build the machine-readable vocabulary representations for hydrai.org.
//
// Azure Static Web Apps cannot content-negotiate on the `Accept` header, so each source ontology is
// published as pre-generated files at stable URLs. This script writes the two *machine* ones:
//
//   ns/<slug>.ttl       the authored Turtle, verbatim (comments preserved) — text/turtle
//   ns/<slug>.jsonld    a JSON-LD serialization compacted against the curated context
//
// The **HTML** representation at `/ns/<slug>` is NOT written here — it is an Eleventy template
// (`site/ns/agent.njk`) that renders from the same parsed model via `site/_data/vocab.js`, so the
// browsable page shares the site's layout, nav, footer, and accessibility, and cannot drift from the
// RDF. Both paths import `vocab/lib.mjs`; this file only serializes.
//
// The alternates are advertised by the HTML page (`<link rel=alternate>` + inline JSON-LD) and by
// `staticwebapp.config.json` (HTTP `Link` headers + MIME types).

import { writeFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SOURCES, readTurtle, parseStore, toJsonLd } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distNs = resolve(here, 'dist', 'ns')

async function build() {
  // Best-effort clean. On a OneDrive-synced /mnt/c mount, `rmdir` can fail with EACCES while the
  // folder is syncing; that must not fail the build, because every file below is overwritten anyway.
  try {
    await rm(resolve(here, 'dist'), { recursive: true, force: true })
  } catch (err) {
    console.warn(`  (could not fully clean vocab/dist — overwriting in place): ${err.code}`)
  }
  await mkdir(distNs, { recursive: true })

  for (const source of SOURCES) {
    const ttl = await readTurtle(source)
    const store = parseStore(ttl)

    // Turtle — the authored source verbatim (keeps the comments a re-serialization would drop).
    await writeFile(resolve(distNs, `${source.slug}.ttl`), ttl, 'utf8')

    // JSON-LD — a real serialization of the graph, compacted against the curated context.
    const compacted = await toJsonLd(store)
    await writeFile(resolve(distNs, `${source.slug}.jsonld`), JSON.stringify(compacted, null, 2), 'utf8')

    console.log(`  ns/${source.slug}: ${store.size} triples → ${source.slug}.ttl, ${source.slug}.jsonld`)
  }
  console.log('vocabulary (machine representations) built → vocab/dist/ns/')
}

build().catch((err) => {
  console.error(err)
  process.exit(1)
})
