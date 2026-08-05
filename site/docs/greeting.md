---
layout: doc.njk
title: greeting
description: The HydrAI greeting term — a short, agent-directed self-introduction, capped so it stays a greeting, not a manual.
---
{% from "termref.njk" import termCard, shapeCard %}

# `hydrai:greeting`

<p class="lede">A short, agent-directed self-introduction: the API's identity and its cross-cutting stance. Orientation, not documentation.</p>

<div class="note">This page is a companion to the <a href="/ns/agent#greeting">namespace entry</a>. The definition and shape below are generated from <a href="/vocab/agent.ttl"><code>agent.ttl</code></a> at build time — the same source the machine representations come from.</div>

## The authoritative definition

{{ termCard(vocab.byLocal.greeting, 3) }}

{{ shapeCard(vocab.byLocal.GreetingShape, 3) }}

## How to use it

`greeting` carries the conventions that no single affordance can — the things you would tell a new integrator in the first thirty seconds. Per-resource "how do I use this" belongs in declared affordances and [example queries](/docs/example-query/); the greeting is the cross-cutting orientation that sits above them.

```turtle
@prefix hydrai: <https://hydrai.org/ns/agent#> .

</Api/> hydrai:greeting
  "This is a performer-CRM API. Contacts, companies, and events are the
   core entities; money is always in minor units; every collection is
   paginated and filterable. Ask before you write." .
```

## It caps its own prose

The `GreetingShape` above targets every subject of `greeting` and enforces a single value within a hard length cap. This is [opinion 5](/docs/opinions/) made mechanical: a greeting is a few sentences, not a manual. We do not forbid prose — we give everything else a structured home so there is nothing left to cram into it, and then we cap what remains. Clients enforce the shape; an over-length greeting is [refused, not warned](/docs/opinions/).

## It is untrusted by default

A greeting is content a server injects into an agent's context. It is therefore **fail-closed**: treated as untrusted third-party data, attributed and quarantined, never elevated to instruction level. A [W3C Data Integrity](https://www.w3.org/TR/vc-data-integrity/) proof, when present and verified against a trust anchor, upgrades only its *attribution* — never its *authority*. Even a verified greeting is data, never a command. See the [safety posture](/docs/safety/).
