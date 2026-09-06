/** Post-build artifact gate: stock Loader imports both public MCP plugin roles. */
import { verifyMcpHostEntry } from '../packages/mcp/mcp-client/tests/host-entry.proof.ts'

await verifyMcpHostEntry()
console.log('verify-mcp-host-entry: public Host/Agent composition passed')
