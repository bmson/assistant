import { qualifyMcpDiscovery } from '@assistant/tools/mcp-discovery-qualification';

const usage = 'Usage: pnpm mcp:discover <loopback-http-endpoint> [--allow-legacy]';
const args = process.argv.slice(2);
const [endpoint, flag] = args;
if (endpoint === '--help' && args.length === 1) {
  console.log(usage);
} else if (
  !endpoint ||
  endpoint.startsWith('-') ||
  args.length > 2 ||
  (flag !== undefined && flag !== '--allow-legacy')
) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    const result = await qualifyMcpDiscovery(endpoint, {
      enabled: true,
      allowLegacyFallback: flag === '--allow-legacy',
    });
    console.log(
      JSON.stringify(
        {
          protocolVersion: result.protocolVersion,
          complete: result.complete,
          ...(result.excludedTools ? { excludedTools: result.excludedTools } : {}),
          toolNames: result.tools.map((tool) => tool.name),
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      'MCP discovery failed. Check the local server, endpoint, and supported protocol.',
    );
    process.exitCode = 1;
  }
}
