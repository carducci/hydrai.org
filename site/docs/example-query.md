---
layout: doc.njk
title: exampleQuery
description: The HydrAI exampleQuery term — a worked (intent, query, endpoint) tuple an agent can learn from.
---
{% from "termref.njk" import termCard, shapeCard %}

# `hydrai:ExampleQuery`

<p class="lede">A worked query a client can learn from: a natural-language intent, the query text, and the endpoint it runs against. Few-shot orientation, expressed as data.</p>

<div class="note">This page is a companion to the <a href="/ns/agent#ExampleQuery">namespace entry</a>. The definitions and shape below are generated from <a href="/vocab/agent.ttl"><code>agent.ttl</code></a> at build time.</div>

## The authoritative definitions

{{ termCard(vocab.byLocal.ExampleQuery, 3) }}
{{ termCard(vocab.byLocal.exampleQuery, 3) }}
{{ termCard(vocab.byLocal.intent, 3) }}
{{ termCard(vocab.byLocal.queryText, 3) }}
{{ termCard(vocab.byLocal.overEndpoint, 3) }}

{{ shapeCard(vocab.byLocal.ExampleQueryShape, 3) }}

## How to use it

Few-shot is how an agent orients. `exampleQuery` is the hypermedia-native way to advertise it: an *(intent, query, endpoint)* tuple carried as data, so the one hand-written orchestration block a client used to carry becomes served, versioned, projectable content.

```turtle
@prefix hydrai: <https://hydrai.org/ns/agent#> .
@prefix schema: <https://schema.org/> .

</Api/> hydrai:exampleQuery [
    a hydrai:ExampleQuery ;
    hydrai:intent      "Contacts created this quarter, most recent first" ;
    hydrai:queryText   "SELECT ?c WHERE { ?c a schema:Person ; schema:dateCreated ?d . FILTER(?d >= '2026-07-01') } ORDER BY DESC(?d)" ;
    hydrai:overEndpoint <https://example.org/sparql> ;
] .
```

## Executable content is never run verbatim

An `exampleQuery` is **executable**, and that is exactly why a consumer never runs it as-is. It is a *candidate* routed through the consumer's own query gates and executed only under the consumer's own authority. The `ExampleQueryShape` above is **coarse, defence-in-depth** structural validation — it requires a read verb, forbids the obvious mutation keywords, caps length, and types the endpoint.

<div class="note warn"><strong>The shape does not make a query safe.</strong> SPARQL is not a regular language, and a read-only query can still exfiltrate via <code>SERVICE</code> federation. Safety is enforced at <em>execution</em>, in the client's query containment — not by the shape. The shape is a coarse filter; the execution gate is the real wall. See the <a href="/docs/safety/">safety posture</a>.</div>

## Bound semantics

The one thing core Hydra genuinely cannot say about a template variable — that two variables are the ends of a *range* over one property — is expressed with `lowerBoundOf` / `upperBoundOf` (harvest pending):

```turtle
[] hydrai:lowerBoundOf schema:dateCreated .   # ?from  →  ?d >= ?from
[] hydrai:upperBoundOf schema:dateCreated .   # ?to    →  ?d <= ?to
```
