# HydraClient

A generic Hydra/JSON-LD client. Everything it knows about an API it learns at runtime from documents
that API publishes — there is no vendor hostname, namespace IRI, predicate or term anywhere in `src/`.
The playground page is one surface built on it, not the artifact itself.

The model's interface is a **browser**: five constant controls (`follow`, `search_collection`,
`get_resource`, `invoke`, `sparql`), identical for every Hydra API. Capability arrives as content —
an affordance index rendered into the prompt at connect, and an affordance block on every result:
the operations a resource offers (as stable handles with input contracts), the filters a collection
declares, pagination state, live value sets. The per-affordance projection still exists, but as a
registry behind `invoke` and as the dispatch gate's checklist, never as tool definitions on the
wire.

Two invariants carry most of the weight:

> Above the graph layer there is no JSON. Above the execution layer there are no URLs.

## Running commands

This package is a workspace of the [HydrAI monorepo](../../README.md). Install once from the
repository root (`npm install`), then run its scripts either from the root via the workspace flag or
from this directory:

```bash
# from the repo root
npm run build --workspace hydra-client
# or from examples/hydra-client
npm test
```

| Script | Does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then emit the browser bundle into `dist/` |
| `npm run typecheck` | `tsc --noEmit` alone |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |
| `npm run mcp` | start the stdio MCP server (`vite-node mcp/index.ts`) |

## Build output

`npm run build` writes `index.html`, `how-it-works.html` and `assets/*` into `dist/`. The site's
Eleventy build passthrough-copies `dist/` to `/agent` on hydrai.org (see the root
`eleventy.config.js`). `how-it-works.html` is a hand-edited, self-contained page kept in `public/`, so
Vite copies it into the bundle verbatim; `emptyOutDir` is `true` because nothing hand-edited shares
`dist/`.

**Sourcemaps are off for the production build** — they are the bulk of the output and buy little,
since the TypeScript they map back to is checked in beside the page. `npm run dev` serves full
sourcemaps.

`base: './'` in `vite.config.ts` makes every asset and dynamic chunk resolve against the page's own
URL, so the bundle works mounted at the `/agent/` subpath rather than the origin root.

## A note on `node_modules` and served roots

`test/layout.test.ts` asserts that the runtime keeps its dependencies out of any web-served content
root. Here that is satisfied by construction: only `dist/` is copied into the published site, never
`node_modules` or `src/`.

## Layout

```
src/
  http/      fetch · auth · content negotiation · Link headers · origin rebasing
  rdf/       N3 store · JSON-LD expansion · named graphs · provenance
  vocab/     query the graph into a normalised capability model · tier detection · live value sets
  project/   capability model → affordance registry (handles, contracts) + the constant envelope
  execute/   envelope dispatch · IriTemplate expansion · pagination · constraint gate · framing
             write path (compact against the served @context) · SPARQL routing
  render/    live response graph → the affordance block every result carries
  agent/     tool_use loop · prompt assembly · manifest + affordance index · model capability
  query/     term gate · scoping · local and remote execution · the completeness gate
  ui/        chat · trace · capability panel — a strict consumer of everything above
test/
  fixtures/  vocabularies and shapes graphs, including one for an API that does not exist
tools/
  fake-hydra.mjs   a minimal Hydra server, for driving the page without booting the app
```

Three test files are gated on an environment variable so a missing credential is a skip rather than a
failing suite: `HYDRA_LIVE=1` runs the connect tests against a booted app, `ANTHROPIC_API_KEY` runs
the manifest measurement and the prompt-cache smoke test, and `test/live-analytics.test.ts` needs
both. All spend real resources; everything else is offline.

**`npm test` takes about 70 seconds**, nearly all of it `test/query-local.test.ts` starting the query
engine once — see the note on Comunica below. `npx vitest run test/query.test.ts` covers the query
gates with nothing executed and finishes in milliseconds.

### Seeing it run

`tools/fake-hydra.mjs` publishes the imaginary lending API from `test/fixtures/` with a real `Link`
header, which is the part a static file server cannot do and the part discovery turns on. Run it
alongside `npm run dev`, then connect to `http://127.0.0.1:4310/Api/` — expect tier T1, 7 classes and
17 affordances behind the constant five-tool envelope. Booting the real app on `localhost:1648` is
the higher-fidelity check; this is the fast one.

The `mago-*.json` fixtures are **real documents**, captured verbatim from a live boot on
`localhost:1648` — vocabulary, shapes graph, context and entry point. `test/live-documents.test.ts`
runs against them, which is what makes its assertions about the server's behaviour observations rather
than expectations. Re-capture them if the published surface changes; do not hand-edit them.

Each layer knows only the one beneath it. `ui/` being a strict consumer is what lets the runtime be
embedded in something that is not this page.

## The MCP server (second embedding)

`mcp/` is the runtime's second composition — a peer of `ui/`, importing the same layers the page
does, sharing this `package.json`, this `node_modules`, and this test suite. It is the proof that the
runtime is portable: any MCP client (Claude Code, Claude Desktop, other vendors' agents) drives the
whole semantic surface — discovery, the affordance map, the constraint/completeness/budget gates,
offloaded SPARQL analytics — against **any** conformant Hydra API, with the pinned behaviour set
travelling because the tests exercise the runtime directly rather than the page.

```
npm run mcp        # start the stdio server (vite-node mcp/index.ts)
```

- **Six tools:** `connect` (returns the affordance map + a server-minted session handle) plus the
  constant envelope five (`follow`, `search_collection`, `get_resource`, `invoke`, `sparql`), each
  taking the handle as an ordinary argument. The surface is identical for every API and every
  session — capability arrives as content (the map is `connect`'s result), never as tool-surface
  differences. The tool descriptions are imported verbatim from the runtime (`ENVELOPE_TOOLS`,
  `ORCHESTRATION`, `queryTool`), so the page and the server cannot drift.
- **Session state rides the handle** (SEP-2567's stateless-state pattern): `connect` composes a
  session exactly as `main.ts` does and stores it in a bounded, idle-evicting store; a lost handle
  refuses toward reconnection and names the entry point it was minted for. Tokens come from
  `HYDRA_MCP_TOKEN` (preferred) or a `connect` argument, and never appear in a handle, result, or log.
- **Refusals are results** — never `isError`. A gate refusal reaches the model as ordinary content
  carrying the full contract; an MCP client treating it as a protocol failure would retry blindly.
- **The trace goes to stderr** with its elapsed/kind prefix — the operator's server-log view, zero
  protocol footprint. No Logging/Sampling/Roots capability is advertised (all deprecated in the
  07-28 revision).
- **Protocol pin:** `@modelcontextprotocol/sdk` is pinned exact. The aspirational v2 line does not
  exist in the registry yet, so the shell targets the pinned v1.x with identical tool semantics —
  the tool surface, handle semantics, and capability delivery are revision-independent by design
  (see the change's design D2). `stdio` is the only transport shipped; the shell is HTTP-ready by
  construction (reconstructible handles, no process-local tool semantics).

`test/mcp.test.ts` drives a real SDK client ↔ the shell over the in-memory transport, against the
same `library-vocab.json` fixture the runtime suite uses. Origin-wide discoverability (RFC 9727
`/.well-known/api-catalog`) is a server-side sibling of this work, in `Mago.Web`.

**NEXT — MCP `.well-known` server cards.** SEP-1649 (`/.well-known/mcp/server-card.json`) and the
competing SEP-1960 are drafts the final 07-28 spec adopted neither; `server/discover` (in-protocol)
covers the capability-advertisement half. Add a server-card entry to the RFC 9727 api-catalog **only
when** both hold: (a) one of those SEPs lands as a standard, **and** (b) an HTTP-hosted MCP endpoint
exists to describe. Until then the cost of waiting is zero — the catalog is the extension point.

## Notes on dependencies

- **`sparqljs`** is published with a deprecation notice, but it remains the de facto SPARQL parser in
  the JS ecosystem and is what Comunica itself parses with. The term gate is load-bearing and reads
  its syntax tree, so a dead parser would need replacing — worth re-checking periodically.
- **`@comunica/query-sparql-rdfjs`** is loaded behind a dynamic `import()` in `query/local.ts`, so an
  API with its own reachable SPARQL endpoint never pays to load it. That matters more than bundle
  size: **it costs about 72 seconds to start on this machine** — 31s to import, 41s to construct, then
  tens of milliseconds per query. It loads a precompiled engine, so this is the cost of requiring
  several hundred small files across the Windows mount rather than runtime dependency injection; a
  Linux runner and a bundled browser chunk are different costs and neither has been measured. The
  engine is cached after first construction, so a session pays it once.
