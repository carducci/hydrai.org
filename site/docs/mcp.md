---
layout: doc.njk
title: The MCP server
description: The same generic Hydra runtime, embedded as a Model Context Protocol server — drive any conformant Hydra API from any MCP client.
---

# The MCP server

<p class="lede">The reference client's runtime has two embeddings: the <a href="/agent/">browser agent</a> and a <a href="https://modelcontextprotocol.io/">Model Context Protocol</a> server. Both import the same layers, share one test suite, and expose the same semantic surface — the proof that the runtime is portable.</p>

Any MCP client — Claude Code, Claude Desktop, another vendor's agent — can drive the whole semantic surface (discovery, the affordance map, the constraint / completeness / budget gates, offloaded SPARQL analytics) against **any** conformant Hydra API.

## The tool surface

Six tools, identical for every API and every session:

- **`connect`** — returns the affordance map plus a server-minted session handle.
- **`follow`**, **`search_collection`**, **`get_resource`**, **`invoke`**, **`sparql`** — the constant envelope five, each taking the handle as an ordinary argument.

Capability arrives as *content* (the map is `connect`'s result), never as tool-surface differences. The tool descriptions are imported verbatim from the runtime, so the browser agent and the server cannot drift.

<div class="note"><strong>Session state rides the handle.</strong> <code>connect</code> composes a session and stores it in a bounded, idle-evicting store; a lost handle refuses toward reconnection and names the entry point it was minted for. Tokens come from <code>HYDRA_MCP_TOKEN</code> (preferred) or a <code>connect</code> argument, and never appear in a handle, result, or log.</div>

## Refusals are results

A gate refusal reaches the model as ordinary content carrying the full contract — never as an `isError` protocol failure. An MCP client that saw a refusal as a transport error would retry blindly; instead the model reads *why* it was refused and what the contract is.

## Run it

From the repository root:

```bash
npm install
cd examples/hydra-client
npm run mcp        # start the stdio server
```

Configure it in an MCP client (this example is the Claude Desktop / Claude Code shape) — point the command at the server and pass the API token via the environment:

```json
{
  "mcpServers": {
    "hydra": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/path/to/hydrai.org/examples/hydra-client",
      "env": { "HYDRA_MCP_TOKEN": "your-api-token-if-needed" }
    }
  }
}
```

Then call `connect` with the API entry point (for example `https://…/Api/`) and drive it with the envelope five.

## Notes

- **`stdio` is the only transport shipped**, but the shell is HTTP-ready by construction — reconstructible handles, no process-local tool semantics.
- **The trace goes to stderr** with an elapsed/kind prefix: the operator's server-log view, with zero protocol footprint.
- The full design and the origin-wide discoverability story (RFC 9727 `/.well-known/api-catalog`) live in `examples/hydra-client/README.md`.
