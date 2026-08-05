---
layout: doc.njk
title: The vision
description: HydrAI is the agentic last mile of a bigger idea — that AI gets safe and accurate when data carries its own meaning. This page is about HydrAI's piece of it.
---

# The agentic last mile

<p class="lede">HydrAI is one piece of a bigger idea: that AI gets safe, accurate, and cost-effective when data carries its own meaning. This page is about <em>HydrAI's</em> piece — extending that meaning to the surface an agent acts through. It stands on its own; the full thesis lives elsewhere, and we leave breadcrumbs.</p>

## The foundation, briefly

An LLM has no mechanism for truth — only probability. That gap isn't closed by a bigger model; it's closed by better data. **Semantically grounded data** — [JSON-LD](https://www.w3.org/TR/json-ld11/) layered over the APIs you already have, additive and non-breaking — turns "magic strings" the model has to guess at into terms with identity it can actually rely on. Give a model facts instead of a puzzle, and its answers become discoverable, justifiable, and cheap.

That is the foundation HydrAI stands on, and it is a deep story in its own right — the semantic layer, the chains of justification, integration that stops being a problem. HydrAI does not retell it here.

<div class="note">Want the bigger picture — why the semantic layer is the non-negotiable foundation for trustworthy AI? Start with <a href="{{ site.bigPicture }}">{{ site.bigPictureLabel }}</a>. This page assumes only the one-paragraph version above.</div>

## Meaning doesn't have to stop with your data

Here is the leap HydrAI cares about. Once your systems can communicate with meaning, you can describe more than what a *field* means. You can describe your system's own **surface for interaction** — what an agent can do, where it can go, how to build a query.

Today we compensate for the absence of that with custom tools, hand-written MCP servers, and hundred-thousand-token prompts that memorize an API in advance. Imagine a browser that had to hard-code every website's map before it could load a page. That is how we build agents now.

It doesn't have to be that way, because describing an interaction surface is also a semantics problem — and [Hydra](https://www.hydra-cg.com/) already solves it. Hydra is a lightweight JSON-LD vocabulary for an API's **affordances**, carried in the responses themselves. A generic agent connects with **one fact** — the entry-point URL — and discovers the rest. No prompt, no manifest, no custom code. The same way your browser reads a search form out of the page and simply knows how to use it.

This is a **web for agents**: self-describing interoperability that falls out for free once the surface means something. [Try it](/agent/) — point the generic agent at a Hydra API and watch it navigate, filter, and act against a system it was never told about.

## Hydra's stable core, extended for the age of agents

Hydra is a stable, robust core — essentially finished, because it is a foundation. But it was built for machines that *navigate*. An agent also *reasons in examples* and *plans and acts*, and Hydra has no vocabulary for the few things those require: a greeting to orient on, worked examples to learn from, consequence semantics to plan against.

That gap is HydrAI: a conservative superset of Hydra core — everything Hydra says, plus the agentic last mile, minted only at the gap and always additive. The [Hydra Community Group](https://www.hydra-cg.com/) is dormant, so HydrAI [stewards the core unchanged](/docs/vocabulary/) and adds the missing terms on top.

The aim is to be the **one-stop shop** for building domain-agnostic, agent-friendly hypermedia APIs: one vocabulary that covers the whole interaction surface, so you learn it once instead of assembling a dozen. It stays domain-agnostic on purpose — HydrAI describes *how to interact* with an API, never what your API is *about*, so your own entities keep their own vocabulary and ride in on your API's context.

## Standards, not walled gardens

A universal semantic layer can't come with lock-in, so HydrAI lives at a neutral namespace, on open standards, as [open-source reference code](/docs/). It is not a product or a platform — it is a discipline, additive by design: start with one API that describes itself, break nothing, and grow from there.

<p style="margin-top:2rem;"><a class="btn btn-primary" href="/agent/" target="_blank" rel="noopener">See the generic agent <span aria-hidden="true">↗</span></a> &nbsp; <a class="btn btn-ghost" href="/docs/vocabulary/">The vocabulary design note</a></p>
