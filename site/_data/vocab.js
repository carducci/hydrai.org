// Eleventy data: the vocabulary term model for every published partition, parsed from the `.ttl`
// sources at build time.
//
// This is what makes the browsable /ns/* pages and the docs term references *generated* rather than
// hand-written — templates read `vocab.*` and never restate the ontology. It shares its parser
// (`vocab/lib.mjs`) with the machine-representation generator, so the HTML and the RDF cannot disagree.
import { SOURCES, readTurtle, parseStore, buildModel, toJsonLd } from '../../vocab/lib.mjs'

export default async function () {
  const sources = []
  for (const source of SOURCES) {
    const store = parseStore(await readTurtle(source))
    const model = buildModel(store, source)
    sources.push({
      ...model,
      slug: source.slug,
      layer: source.layer,
      jsonldString: JSON.stringify(await toJsonLd(store), null, 2),
    })
  }
  const agent = sources.find((s) => s.slug === 'agent')
  const core = sources.find((s) => s.slug === 'core')
  return {
    sources, // one entry per partition
    agent, // convenience for the agent partition (invention layer)
    core, // convenience for the core partition (stewardship layer)
    byLocal: agent.byLocal, // docs term pages read authoritative definitions from here
  }
}
