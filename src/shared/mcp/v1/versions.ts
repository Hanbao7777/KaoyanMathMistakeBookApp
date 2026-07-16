export const mcpProtocolVersions = Object.freeze(['2025-06-18', '2025-11-25'] as const);
export type McpProtocolVersion = (typeof mcpProtocolVersions)[number];

export const mcpCurrentProtocolVersion: McpProtocolVersion = '2025-11-25';
export const mcpServerVersion = 'kaoyan-mcp-server-v1@1' as const;
export const mcpCapabilityVersion = 'kaoyan-mcp-capabilities-v1@1' as const;
export const mcpSchemaVersion = 'kaoyan-mcp-schema-v1@1' as const;
export const mcpTasksEnabled = false as const;

export const mcpMeasuredClientCompatibility = Object.freeze([
  Object.freeze({ client: 'codex-cli', version: '0.144.3', protocol: '2025-06-18' as const, tasks: false as const }),
  Object.freeze({ client: 'claude-code', version: '2.1.211', protocol: '2025-11-25' as const, tasks: false as const })
]);

export function negotiateMcpProtocol(requested: readonly string[]): McpProtocolVersion {
  if (!Array.isArray(requested) || requested.length === 0) throw new Error('MCP protocol negotiation failed');
  if (requested.includes(mcpCurrentProtocolVersion)) return mcpCurrentProtocolVersion;
  const compatible = requested.find((version): version is McpProtocolVersion =>
    (mcpProtocolVersions as readonly string[]).includes(version)
  );
  if (compatible) return compatible;
  throw new Error('MCP protocol negotiation failed');
}
