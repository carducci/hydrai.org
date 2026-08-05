---
layout: doc.njk
title: The nine opinions
description: The stances baked into the HydrAI vocabulary — and the reasons for them.
---

# The nine opinions

<p class="lede">These are the stances baked into the vocabulary. They are the reason it is called <em>opinionated</em>.</p>

### 1. A hypermedia API is a UI for agents

The web gave humans a universal interface: one browser, a handful of constant controls, and every site's capability delivered as content on the page. An agent should get the same deal — driving a generic hypermedia client the way you drive a browser, with capability carried by the API's responses rather than by bespoke per-API tools. The agent isn't the browser; it's the machine driving one, given the same powers HTML and the web gave people. HydrAI is the vocabulary that lets responses carry that capability.

### 2. Mint only at the gap; reuse everything else

A term enters HydrAI only when no existing standard says it *and* a real client already needs it. Every term's definition carries a "why not the existing thing." If VoID, SHACL, or Hydra already says it, HydrAI points at them — it does not re-say it.

### 3. Learn one vocabulary, not a dozen

A single curated JSON-LD `@context` maps friendly terms to the canonical IRIs of Hydra, SHACL, VoID, and HydrAI's own additions. You write `member`, `exampleQuery`, `sparqlEndpoint`; each expands to the right vocabulary's real IRI. This is the move [schema.org](https://schema.org/) made — hide the zoo behind one legible surface — applied to hypermedia affordances.

### 4. Steward the orphans; reference the living

HydrAI *mirrors* Hydra (dormant, in need of a steward) with formal equivalence axioms. It merely *references* VoID, SHACL, schema.org (alive and maintained). You do not fork what someone is still tending.

### 5. Constrain our own prose

The one freeform slot — a server's greeting — is capped by a SHACL constraint *in the vocabulary itself*, and clients enforce it. A greeting is identity and stance in a few sentences, not a manual. We prevent prose from becoming a crutch not by forbidding it but by giving everything else a structured home, so there is nothing left to cram into prose. A vocabulary that teaches people to build agents should model the discipline it teaches.

### 6. Every term is a doorway

Each curated term carries `rdfs:isDefinedBy` (its source vocabulary) and `rdfs:seeAlso` (a place to learn it). The turn-key context gets you running fast; the pointers let you walk from any term into the full depth behind it. Turn-key and rigorous are not a trade-off — they are different layers of the same term.

### 7. Refuse, don't warn

Invalid input is rejected with an honest error, not silently coerced. A constraint that can be quietly ignored is not a constraint.

### 8. Additive and degradable

HydrAI never contradicts Hydra core. An agent that has never heard of HydrAI still works against a HydrAI-described API via plain Hydra. Adopt as much or as little as you want.

### 9. Untrusted by default; signing is authenticity, not authority

A greeting and an example query are content a server injects into an agent — the prompt-injection surface. HydrAI's answer is a client posture, not per-term typing — injection rides on ordinary data too, so you cannot type your way to safety: all server content is untrusted by default, and a verifiable proof upgrades a value's *attribution*, never its *authority*. Even a signed greeting is data, never a command. Nothing a server sends is ever obeyed; executable examples run only through the client's own gates, under the client's own authority.

---

See how opinion 9 plays out in practice in the [safety posture](/docs/safety/), and where each opinion touched the vocabulary in the [design note](/docs/vocabulary/).
