---
layout: doc.njk
title: Safety posture
description: HydrAI treats all server content as untrusted by default. A proof upgrades attribution, never authority — and query safety lives at execution.
---

# Safety posture

<p class="lede">A greeting and an example query are content a server injects into an agent. That is the prompt-injection surface, and HydrAI's answer is a client posture, not a per-term type.</p>

## Fail-closed by default

You cannot type your way to safety. Injection rides on ordinary data as easily as on a `greeting`, so marking certain terms "dangerous" would be theatre. Instead, the client treats **all** server-provided content as untrusted by default:

- A `greeting` is attributed and quarantined as untrusted third-party data. It is folded into the prompt as *content the server said about itself*, never as instructions the agent must follow.
- `exampleQuery` values are offered as candidates, routed through the client's query gates, and **never auto-executed**.
- Nothing a server sends is ever obeyed.

## A proof is authenticity, not authority

HydrAI anticipates verifiable content ([W3C Data Integrity](https://www.w3.org/TR/vc-data-integrity/), [HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421)). When a value carries a proof that verifies against a trust anchor, that upgrades exactly one thing: its **attribution** — you now know *who* said it. It never upgrades its **authority** — a signed greeting is still data, still never a command.

<div class="note">This distinction is the whole game. "Signed" answers <em>who said this</em>. It does not answer <em>should I do what it says</em> — the answer to that is always no, because a server never speaks with the client's authority.</div>

## Where query safety actually lives

The `ExampleQueryShape` is coarse, structural defence-in-depth: a read verb, no obvious mutation keyword, a length cap, a typed endpoint. It is not a safety guarantee and cannot be one:

- SPARQL is not a regular language — a pattern cannot fully parse it.
- A read-only query can still exfiltrate data via `SERVICE` federation to an attacker-controlled endpoint.

So the real wall is **execution containment**, enforced by the client when it runs a query under its own authority — not by the shape when it validates one. The shape catches the careless; the execution gate stops the adversarial.

## Three layers

1. **The vocabulary** declares terms and coarse shapes. It describes; it does not enforce.
2. **The wire** carries untrusted server content. Everything on it is data.
3. **The client** is where authority lives. It fences unverified content, routes example queries through its gates, contains execution, and never obeys the server.

A vocabulary that teaches people to build agents should model the discipline it teaches. This is that discipline, written down.
