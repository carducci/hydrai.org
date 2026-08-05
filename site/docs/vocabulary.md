---
layout: doc.njk
title: Vocabulary design note
description: The design rationale behind HydrAI — the earned-term test, the namespace architecture, the terms, and the wire posture.
---

# Vocabulary design note

<p class="lede">Why HydrAI exists, how the namespace is organized, and the reasoning behind every term. This is the design behind what you can <a href="/ns/agent">browse in the namespace</a>.</p>

## 1. Thesis

Hydra describes hypermedia APIs well for generic REST clients. An LLM agent is a different consumer, and HydrAI adds the handful of affordances it needs — no more. HydrAI is a *conservative superset* of Hydra core: everything Hydra can express, plus the agentic last mile, presented as one vocabulary rather than a dozen you assemble yourself.

## 2. The earned-term test

A term is minted into HydrAI only when **both** hold:

1. **No existing standard says it.** Not Hydra, not SHACL, not VoID, not schema.org.
2. **A real client already needs it.** The reference implementation is blocked, or paying for the term's absence with hand-written orchestration.

Every term's definition records its "why not the existing thing." This is the guard against sprawl: a vocabulary that keeps its own growth honest.

## 3. Why the gap is real

Hydra was built for machines that *navigate* a hypermedia API. An agent does two things Hydra never had to serve:

- **It learns from examples.** Few-shot is the single most effective agent technique. Hydra has prose comments, but nothing that carries an *(intent, query, expected-shape)* tuple as data.
- **It plans and acts.** It wants to know whether an operation is reversible, expensive, or idempotent *before* it fires. Hydra describes an operation's method, input, and output, and stops.

These are not bugs in Hydra — they are a generational mismatch. The agent arrived after the spec did.

## 4. Namespace architecture: partition by governance contract

Published at `https://hydrai.org/`, the namespace is partitioned. **A partition earns existence by having a distinct governance contract — ownership + stability + mission — never by grouping thematically related terms.** That rule is the guard against reintroducing the dozen-vocabulary zoo under one domain.

```
   https://hydrai.org/
   │
   ├── ns/core#   STEWARDSHIP   the orphaned vocabularies HydrAI adopts
   │              today: Hydra (dormant). owl:equivalentClass/Property → canonical
   │              hydra: IRIs. frozen; the "picked-up torch."
   │
   └── ns/agent#  INVENTION     the agentic gap HydrAI owns outright
                  today: greeting, exampleQuery, bounds, action-semantics.
                  0.1, evolving as the reference client demands a term.

   VoID · SHACL · JSON-LD · schema.org  →  REFERENCED, never mirrored, never a partition.
```

How a term is assigned — by authority, not by theme. One question decides it:

```
   Does an existing vocabulary already define this term?
   │
   ├── YES, actively maintained     →  REFERENCE it   (schema.org, SHACL, VoID)
   │                                   stays in ITS namespace; HydrAI only points at it.
   │
   ├── YES, but orphaned / dormant  →  STEWARD it      →  ns/core#
   │                                   (Hydra, today) re-assert via equivalence; nothing else.
   │
   └── NO — HydrAI names it first   →  INVENT it       →  ns/agent#
                                       (greeting, exampleQuery, bounds…) define it fully.
```

The rule of record: **reference the living, steward the orphaned, invent the genuinely absent.** The boundary is observable, not a judgement — a `core#` term carries *only* an equivalence axiom; an `agent#` term carries real definitional axioms; a referenced term is not declared here at all.

Path form is **locked**: `https://hydrai.org/ns/core#` and `https://hydrai.org/ns/agent#`. Term IRIs are stable forever. Suggested prefixes: `hydrai:` → `ns/agent#`, `hcore:` → `ns/core#`.

## 5. The terms (0.1)

| Need | Near-miss standards | Why they fall short | Term |
| --- | --- | --- | --- |
| **Orientation** | MCP `instructions`; `rdfs:comment` | MCP's died with `initialize`; `rdfs:comment` is not agent-directed | [`greeting`](/docs/greeting/) |
| **Worked examples** | SPARQL SD; `void:exampleResource` | Nothing carries *(intent, query, endpoint)* as data | [`exampleQuery`](/docs/example-query/) → `intent`, `queryText`, `overEndpoint` |
| **Range / bound** | Hydra `IriTemplateMapping` | Two vars on one property are two equalities; cannot say "≥" | `lowerBoundOf` / `upperBoundOf` *(harvest pending)* |
| **Action semantics** | HTTP idempotency; schema.org `Action` | `hydra:operation` carries no consequence metadata | `reversibility`, `sideEffect`, `cost` *(harvest pending)* |
| **User context** | Solid WebID; PROV | None models evolving, consent-scoped relationship state | *deferred* |

Two terms are the most justified because the client already pays for their absence: **bounds** (they block query routing) and **examples** (few-shot is the highest-leverage technique, and advertising it turns hand-written orchestration into served, versioned, projectable content). The 0.1 vocabulary ships `greeting` and `exampleQuery` first, each with a reference consumer.

## 6. Superset via equivalence — and the wire posture

HydrAI is a **conservative superset of Hydra core**. Two mechanisms deliver two different things:

- **The ontology superset** — `core#` mirrors every Hydra core term with an `owl:equivalentClass` / `owl:equivalentProperty` axiom, so the claim "HydrAI ⊇ Hydra" is *provable* for reasoners.
- **The curated `@context`** — friendly compact keys (`member`, `exampleQuery`, `sparqlEndpoint`) expand to the right vocabulary's canonical IRI, so an adopter learns one vocabulary.

This is how [schema.org](https://schema.org/) won: an opinionated, curated, single-namespace re-presentation that hid the underlying zoo behind one legible surface.

**Wire posture.** The rule is about the `core#` mirror, not about `hydrai:` wholesale:

- **`core#` stays off the wire.** The API keeps serving canonical `hydra:` IRIs, so pure-Hydra clients keep working. The equivalence ontology sits behind them as the formal backbone.
- **`agent#` rides the wire** — but only in the discovery/documentation surfaces that carry it (the ApiDocumentation, the entry point), not smeared across every resource. Invention terms have no canonical alternative, so to use `greeting` / `exampleQuery` at all, they must be emitted.

## 7. The greeting, and the injection surface it opens

A greeting and an example query are server-controlled content that flows into an agent's context — the textbook prompt-injection surface. HydrAI's answer is a **client posture, not per-term typing**: because injection rides on ordinary data too, you cannot type your way to safety. All server content is untrusted by default (fail-closed), and a verifiable proof upgrades a value's *attribution*, never its *authority*. This is important enough to have [its own page](/docs/safety/).

## 8. Versioning

Term IRIs are stable across versions; the version lives on the ontology, never in a term IRI. Because `agent#` will change before 1.0, **pin the context version you build against.** The `core#` mirror, by contrast, is frozen — you can only steward a vocabulary that will not move under you.

## 9. Relationship to existing work

HydrAI is a curator, not an inventor. If you learn nothing else here, learn these — HydrAI is a friendly front door to them:

- **[Hydra Core](https://www.hydra-cg.com/spec/latest/core/)** — the vocabulary HydrAI stewards.
- **[JSON-LD](https://www.w3.org/TR/json-ld11/)** — JSON as linked data, the substrate.
- **[SHACL](https://www.w3.org/TR/shacl/)** — shapes and constraints; how HydrAI declares (and caps) valid values.
- **[VoID](https://www.w3.org/TR/void/)** — dataset description, including SPARQL endpoints.
- **[RDF / RDFS](https://www.w3.org/TR/rdf11-concepts/)** — the graph model and the `label` / `comment` / `isDefinedBy` / `seeAlso` that make every term a doorway.
