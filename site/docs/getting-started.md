---
layout: doc.njk
title: Getting started
description: Connect the hosted HydrAI agent to a Hydra API, or run the generic client and MCP server locally.
---

# Getting started

There are three ways in, from least to most setup.

## 1. Use the hosted agent

The [generic agent](/agent/) runs entirely in your browser. Point it at any conformant Hydra API entry point, paste an API token if the API needs one, and give it your Anthropic API key (it calls the model directly from your browser — nothing is proxied through this site).

The agent learns everything it knows about the API at runtime from the documents that API publishes. There is no vendor hostname, namespace, or term baked into it. When the API advertises HydrAI orientation terms — a `greeting`, some `exampleQuery` seeds — the agent folds them into its prompt, **fail-closed**: an unverified greeting is quarantined as untrusted data, and example queries are offered as candidates routed through the client's query gates, never auto-executed.

<div class="note"><strong>What “generic” means here.</strong> The agent drives a generic hypermedia client — a browser for machines — with five constant controls (<code>follow</code>, <code>search_collection</code>, <code>get_resource</code>, <code>invoke</code>, <code>sparql</code>), identical for every Hydra API. Capability arrives as content in the API's responses, not as a bespoke tool surface.</div>

## 2. Run the client and MCP server locally

The reference client lives in `examples/hydra-client/`. From the repository root:

```bash
npm install
npm run build:agent      # build the browser agent bundle
```

To drive any Hydra API from an MCP client (Claude Code, Claude Desktop, another agent), start the stdio server:

```bash
cd examples/hydra-client
npm run mcp
```

It exposes six tools: `connect` (returns the affordance map plus a session handle) and the constant envelope five. The surface is identical for every API and every session. See [the MCP server](/docs/mcp/) for configuration.

## 3. Make your own API HydrAI-ready

You do not rewrite your API. You *add a few declarations* to what it already publishes:

- a **greeting** on the entry point — identity and cross-cutting conventions, within the 500-character cap;
- a handful of **example queries** — `(intent, queryText, overEndpoint)` tuples for common questions;
- consequence semantics on the risky operations, as those terms land.

Everything expands through the curated `@context`, so `greeting`, `exampleQuery`, and `sparqlEndpoint` each resolve to the right vocabulary's canonical IRI. A HydrAI-described API is still a plain Hydra API: an agent that has never heard of HydrAI still works against it.

Read the [vocabulary design note](/docs/vocabulary/) for the full picture, or [browse the namespace](/ns/agent) to see the exact terms.
