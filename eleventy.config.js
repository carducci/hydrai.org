// Eleventy 3 (ESM) config for hydrai.org.
//
// The site is assembled from three sources, each built before Eleventy runs (see the root `build`
// script): the Eleventy pages under `src/`, the vocabulary documents generated into `vocab/dist/ns`,
// and the hosted generic agent bundled by Vite into `client/dist`. Eleventy is the last step and
// stitches them together via passthrough copy so the whole of `_site` is one static tree ready for
// Azure Static Web Apps.

import { existsSync } from 'node:fs'
import { curie } from './vocab/lib.mjs'

export default function (eleventyConfig) {
  // Shorten a full IRI to `prefix:local` for the vocabulary term macros.
  eleventyConfig.addFilter('curie', curie)

  // The generic agent (the "AI Playground" SPA) → /agent. Built by `npm run build:agent` into
  // `examples/hydra-client/dist`. Guarded so a site-only build (before the agent is built) still
  // succeeds instead of failing on a missing passthrough source.
  if (existsSync('examples/hydra-client/dist')) {
    eleventyConfig.addPassthroughCopy({ 'examples/hydra-client/dist': 'agent' })
  } else {
    console.warn('[11ty] examples/hydra-client/dist not found — skipping /agent (run `npm run build:agent`)')
  }

  // The published vocabulary (HTML + Turtle + JSON-LD) → /ns. Built by `npm run build:vocab`.
  // The generator emits `ns/agent/index.html`, `ns/agent.ttl`, `ns/agent.jsonld`.
  eleventyConfig.addPassthroughCopy({ 'vocab/dist/ns': 'ns' })

  // Static assets (css, logo, fonts) live beside the templates and copy through verbatim.
  eleventyConfig.addPassthroughCopy('site/assets')

  // The Turtle ontology source is also dereferenceable at its own path for anyone who wants the
  // authored file with its comments intact.
  eleventyConfig.addPassthroughCopy({ 'vocab/agent.ttl': 'vocab/agent.ttl' })

  // A short, absolute-ish year helper for footers etc. Eleventy can't call Date.now() in some
  // sandboxes, so read it once at config load where that restriction does not apply.
  eleventyConfig.addGlobalData('buildYear', new Date().getFullYear())

  return {
    dir: {
      input: 'site',
      includes: '_includes',
      data: '_data',
      output: '_site',
    },
    // Nunjucks everywhere: templates, and Markdown files rendered through a Nunjucks layer so docs
    // can use the same includes and shortcodes as the hand-authored pages.
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
    templateFormats: ['njk', 'md', 'html'],
  }
}
