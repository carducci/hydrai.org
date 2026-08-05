// Global site data, available in every template as `site.*`.
// `discussions` derives from the repository URL.
const repo = 'https://github.com/carducci/hydrai.org'

export default {
  name: 'HydrAI',
  tagline: 'Hydra for the age of agents',
  // HydrAI = HYpermedia DRiven AI (and it reads as "Hydra I").
  expansion: 'HYpermedia DRiven AI',
  description:
    'HydrAI is an opinionated companion vocabulary that makes a Hydra/JSON-LD API legible and safe ' +
    'for LLM agents — a conservative superset of Hydra core, with a generic client and MCP server ' +
    'as the reference implementation.',
  url: 'https://hydrai.org',
  repo,
  discussions: `${repo}/discussions`,
  // The broader semantic-layer thesis lives off this site; HydrAI only breadcrumbs to it.
  // TODO(michael): confirm the canonical destination (semantic.consulting / the talk / the book).
  bigPicture: 'https://semantic.consulting',
  bigPictureLabel: 'the semantic-layer thesis',
  version: '0.1',
  nav: [
    { text: 'Docs', url: '/docs/' },
    { text: 'Vocabulary', url: '/ns/agent' },
    { text: 'Agent demo', url: '/agent/', newTab: true },
    { text: 'MCP', url: '/docs/mcp/' },
  ],
}
