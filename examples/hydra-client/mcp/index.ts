import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createHydraMcpServer } from './server'

/**
 * The stdio entry point — `npm run mcp` (design D1).
 *
 * The second embedding of the HydraClient runtime, alongside the playground page. stdio is the only
 * transport this increment ships; the shell is HTTP-ready by construction (reconstructible handles,
 * no process-local assumptions in tool semantics), so Streamable HTTP is a later additive change, not
 * a redesign.
 *
 * Nothing but the transport is printed to stdout — that is the protocol channel. The operator trace
 * goes to stderr (design D5), where every MCP client surfaces it as the server log.
 */
async function main(): Promise<void> {
  const { server } = createHydraMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('hydra-mcp-server ready on stdio\n')
}

main().catch((cause) => {
  process.stderr.write(`hydra-mcp-server failed to start: ${String(cause)}\n`)
  process.exitCode = 1
})
