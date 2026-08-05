---
layout: doc.njk
title: Documentation
description: HydrAI documentation — an opinionated companion vocabulary that makes a Hydra/JSON-LD API legible and safe for LLM agents.
---

# HydrAI documentation

<p class="lede">A small, curated vocabulary that makes a <a href="https://www.hydra-cg.com/">Hydra</a>/JSON-LD API legible and safe for LLM agents. A conservative superset of Hydra core — everything Hydra can express, plus the handful of things an agent needs that Hydra does not.</p>

HydrAI is deliberately opinionated. Where the standards leave a choice, it makes one, states why, and gives you a working reference implementation that proves it. If you want the raw, unopinionated stack, it is all still there underneath — HydrAI only ever *adds*, and every borrowed term points back to its source.

> **In one line:** Hydra was designed for machines that *navigate*. Agents *reason in examples* and *plan and act*. HydrAI is Hydra for the agent generation.

## Where to go next

- **[The vision](/docs/vision/)** — why semantically grounded data is the mechanism for safe, accurate AI, and how HydrAI extends that semantic layer to the surface agents act through.
- **[Getting started](/docs/getting-started/)** — connect the hosted agent to a Hydra API, or wire up the MCP server, in a few minutes.
- **[The nine opinions](/docs/opinions/)** — the stances baked into the vocabulary, and the reasons for them.
- **[Vocabulary design note](/docs/vocabulary/)** — the full design rationale: the earned-term test, the namespace architecture, and the wire posture.
- **[Browse the namespace](/ns/agent)** — the published `agent#` vocabulary, in HTML, Turtle, and JSON-LD.

## The three pieces of this repository

This site is served from the HydrAI monorepo, which holds three things that stay in step with each other:

| | What it is |
|---|---|
| **The vocabulary** | `vocab/` — the `agent#` ontology, published at [`hydrai.org/ns/agent`](/ns/agent). |
| **The generic agent** | `examples/hydra-client/` — a generic Hydra/JSON-LD client with an agent loop, [hosted here](/agent/) and consumable as an [MCP server](/docs/mcp/). |
| **This site** | `site/` — the landing pages and these docs. |

The reference implementation is the conformance proof: the vocabulary is *extracted* from working code, not designed in advance and hoped into use.

## Status

HydrAI is **{{ site.version }}** and built by harvest, not by decree. Terms are minted one at a time, each shipping with client code that consumes it. Term IRIs are stable across versions; the vocabulary version is not — pin the context version you build against.
