import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStarDustMcpServer, StarDustClient } from "./star-dust-mcp";

async function main() {
  const client = StarDustClient.fromEnv();
  const server = createStarDustMcpServer(client);
  console.error(`Star Dust MCP server. Studio: ${client.baseUrl}`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
