# HydrAI

**A one-stop-shop vocabulary for domain-agnostic, agent-friendly hypermedia APIs — with a reference implementation.**

[`hydrai.org`](https://hydrai.org/) · version **0.1** · status: **early, under active development** · a community effort

HydrAI makes a [Hydra](https://www.hydra-cg.com/)/JSON-LD API legible and safe for LLM agents. It is a
*conservative superset* of Hydra core — everything Hydra can express, plus the handful of things an
agent needs that Hydra does not — presented as **one vocabulary you can learn in an afternoon**
instead of a dozen you have to assemble yourself. It describes *how to interact* with an API, never
what a particular API is about, so it stays domain-agnostic: your entities keep their own vocabulary
and ride in on your API's own context.

This repository is the HydrAI monorepo: the **vocabulary**, the **site** at
[hydrai.org](https://hydrai.org/), and the **example tools** — a generic Hydra client that is both a
hosted browser agent and an MCP server.

> **In one line:** Hydra was designed for machines that *navigate*. Agents *reason in examples* and
> *plan and act*. HydrAI is Hydra for the agent generation. The name is a portmanteau of
> **Hy**permedia-**Dr**iven **AI** (and it reads as "Hydra I").

Read the vision and docs at [hydrai.org/docs](https://hydrai.org/docs/).

---

## Repository layout

```
.
├── site/                       the hydrai.org site — landing + docs (Eleventy)
│   ├── _includes/              layouts, the term-reference macros (termref.njk), vocab body
│   ├── _data/                  site config, docs nav, and vocab.js (parses the ontologies)
│   ├── docs/                   the documentation, incl. the vision and the term pages
│   └── ns/                     the browsable namespace pages (agent.njk, core.njk)
│
├── vocab/                      the published vocabulary — the single source of truth
│   ├── agent.ttl               agent# — the invention layer (authored)
│   ├── core.ttl                core# — the Hydra stewardship mirror (generated, checked in)
│   ├── build-core.mjs          regenerates core.ttl from the authoritative Hydra vocabulary
│   ├── build-vocab.mjs         emits the machine representations (.ttl + .jsonld) per partition
│   ├── lib.mjs                 the shared parser + term model (used by the site and the generators)
│   └── vocab.test.mjs          build-time validation: purity + Hydra bijection (node --test)
│
├── examples/
│   └── hydra-client/           the generic Hydra/JSON-LD client
│       ├── src/                the runtime (http · rdf · vocab · execute · agent · query · ui)
│       ├── mcp/                the MCP server (a second embedding of the same runtime)
│       ├── test/               the conformance suite (Vitest)
│       └── UPSTREAM.md         how this vendored copy stays in sync with its source
│
├── .github/workflows/ci.yml    builds everything and runs both test suites on every push
├── eleventy.config.js          assembles _site from all three sources
├── staticwebapp.config.json    Azure Static Web Apps: MIME types, Link headers, routing
└── package.json                npm workspaces + the build/test orchestration
```

The reference implementation is the conformance proof: the vocabulary is *extracted* from the working
client, not designed in advance and hoped into use.

---

## The vocabulary: two partitions, by governance contract

The namespace is partitioned by **who governs each term**, so it can never sprawl back into the
dozen-vocabulary problem it exists to solve.

- **[`ns/agent#`](https://hydrai.org/ns/agent)** — *invention.* The agentic terms HydrAI owns
  outright, minted only at the gap (a `greeting`, `exampleQuery` and friends). Authored in
  `vocab/agent.ttl`.
- **[`ns/core#`](https://hydrai.org/ns/core)** — *stewardship.* The dormant Hydra Core Vocabulary,
  mirrored via one `owl:equivalent*` axiom per term so "HydrAI ⊇ Hydra" is provable. **A formal
  backbone, not a wire vocabulary — emit canonical `hydra:` IRIs over the wire.** Generated into
  `vocab/core.ttl`.

VoID, SHACL, JSON-LD, and schema.org are *referenced*, never mirrored. The curated `@context`
flattens it all into one friendly set of terms.

### Published without content negotiation

`GET /ns/agent` is the dereference target for every `…#term` IRI, but Azure Static Web Apps cannot
content-negotiate on `Accept`. So each partition is published as three pre-generated representations
at stable URLs — HTML (the browsable default), `.ttl`, and `.jsonld` — and the alternates are
advertised **four** ways so a machine agent can always recover the RDF:

1. `<link rel="alternate">` in the HTML `<head>`;
2. the full graph inline as `<script type="application/ld+json">`;
3. **RDFa** on the visible term markup (`about` / `typeof` / `property` / `rel`), generated from the
   same model, so the page itself is parseable RDF;
4. an HTTP `Link: rel=alternate` header per route in `staticwebapp.config.json`, plus the `.ttl` /
   `.jsonld` MIME mappings.

Everything the site and the machine representations show is generated from the `.ttl` sources at build
time — there is no hand-written prose that can drift from the ontology.

---

## The reference tools

- **[The generic agent](https://hydrai.org/agent/)** (`examples/hydra-client/`) — a generic
  Hydra/JSON-LD client with an agent loop. Everything it knows about an API it learns at runtime; there
  is no vendor hostname, namespace, or term anywhere in `src/`. Hosted, runs entirely in your browser.
- **[The MCP server](https://hydrai.org/docs/mcp/)** (`examples/hydra-client/mcp/`) — the same
  runtime, embedded as a Model Context Protocol server, so any MCP client can drive any conformant
  Hydra API.

---

## Building and running

Node ≥ 20 and npm workspaces. From the repository root:

```bash
npm install          # installs the site and the client workspace together
npm run build        # agent bundle → vocabulary → site, into _site/
npm run dev          # build once, then serve the site with live reload
npm test             # vocabulary validation + the client conformance suite
```

| Script | Does |
| --- | --- |
| `npm run build:agent` | Vite build of the browser agent → `examples/hydra-client/dist` |
| `npm run build:core`  | regenerate `vocab/core.ttl` from the authoritative Hydra vocabulary |
| `npm run build:vocab` | emit the machine representations → `vocab/dist/ns` |
| `npm run build:site`  | run Eleventy → `_site` |
| `npm run test:vocab`  | parse the ontologies and assert purity + Hydra bijection (`node --test`) |

CI (`.github/workflows/ci.yml`) runs the full build and both test suites on every push and PR.

---

## Deployment

Deploys to **Azure Static Web Apps** — app location `/`, output location `_site`, build command
`npm run build`. `staticwebapp.config.json` carries the MIME types, `Link` headers, and routing.

---

## License & governance

- **Namespace:** `hydrai.org` — deliberately neutral, so no single vendor owns the vocabulary the
  community is asked to adopt.
- **Vocabulary:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). **Reference code:** MIT.
- **Feedback is the point.** HydrAI is picking up dormant community work; it aims to *become*
  community work. Issues, counter-examples, and "why not standard X instead" are exactly the
  contributions that make it better.
