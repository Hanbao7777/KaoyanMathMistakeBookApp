import type { McpRegistryDescriptor } from '../../../shared/mcp/v1/contracts';

const uuidSchema = Object.freeze({ type: 'string', format: 'uuid' });
const versionSchema = Object.freeze({
  type: 'object',
  properties: { dataEpoch: { type: 'string', minLength: 1, maxLength: 200 }, dataRevision: { type: 'integer', minimum: 0 } },
  required: ['dataEpoch', 'dataRevision'],
  additionalProperties: false
});

/** The runtime validator remains authoritative; this schema is a bounded client hint. */
export function toolInputSchema(descriptor: McpRegistryDescriptor): Record<string, unknown> {
  const command = descriptor.handler.kind === 'gateway' && descriptor.handler.gatewayMethod === 'execute';
  return Object.freeze({
    type: 'object',
    properties: {
      apiVersion: { const: 1 },
      kind: { const: 'mcp-tool-arguments' },
      operation: { const: descriptor.operation },
      requestId: uuidSchema,
      ...(command ? { idempotencyKey: uuidSchema, expectedVersion: versionSchema } : {}),
      payload: { type: 'object', additionalProperties: true }
    },
    required: ['apiVersion', 'kind', 'operation', 'requestId', ...(command ? ['idempotencyKey', 'expectedVersion'] : []), 'payload'],
    additionalProperties: false
  });
}

export function visibleToPrincipal(descriptor: McpRegistryDescriptor, scopes: readonly string[]): boolean {
  return descriptor.visibility === 'public' || descriptor.requiredScopes.every((scope) => scopes.includes(scope));
}
