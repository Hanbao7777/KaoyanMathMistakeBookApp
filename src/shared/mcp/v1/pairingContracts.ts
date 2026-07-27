import { agentScopes, trustProfiles, type AgentScope, type TrustProfile } from '../../agent/v1/gatewayContracts';

export const pairingApiVersion = 'kaoyan-pairing-v1@1' as const;
export const pairingProducts = ['codex', 'claude_code'] as const;
export type PairingProduct = (typeof pairingProducts)[number];
export const pairingStates = ['pending', 'installed', 'healthy', 'conflict', 'repairing', 'disconnected', 'failed', 'recovery_required'] as const;
export type PairingState = (typeof pairingStates)[number];

export interface PairingRequest {
  readonly product: PairingProduct;
  readonly clientId: string;
  readonly requestedScopes: readonly AgentScope[];
  readonly trust: TrustProfile;
  readonly disclosureAccepted: true;
  readonly authorityConfirmed: boolean;
}

export interface PairingTargetRequest {
  readonly product: PairingProduct;
  readonly clientId: string;
}

export interface ManualClientConfiguration {
  readonly executable: string;
  readonly argv: readonly string[];
}

export interface PairingStatus {
  readonly apiVersion: typeof pairingApiVersion;
  readonly product: PairingProduct;
  readonly clientId: string;
  readonly state: PairingState;
  readonly launcherPath?: string;
  readonly message: string;
  readonly manualConfiguration?: ManualClientConfiguration;
  readonly requestedScopes: readonly AgentScope[];
  readonly requestedTrust: TrustProfile;
  readonly grantedScopes: readonly AgentScope[];
  readonly grantedTrust: TrustProfile;
  readonly generation: number;
}

const CLIENT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FORBIDDEN_PAIRING_SCOPES = new Set<AgentScope>([
  'control.manage', 'clients.read', 'clients.manage', 'sessions.read', 'sessions.manage',
  'r4.read', 'r4.manage', 'approvals.read', 'approvals.manage', 'changesets.read',
  'changesets.manage', 'policy.read', 'policy.manage', 'audit.read', 'audit.export'
]);

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${path}`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const result = object(value, path);
  if (Object.keys(result).length !== keys.length || !keys.every((key) => Object.hasOwn(result, key))) throw new Error(`Invalid ${path} fields`);
  return result;
}

function product(value: unknown, path: string): asserts value is PairingProduct {
  if (!pairingProducts.includes(value as PairingProduct)) throw new Error(`Invalid ${path}`);
}

function clientId(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 121 || !CLIENT_ID.test(value)) throw new Error(`Invalid ${path}`);
}

function scopes(value: unknown, path: string): asserts value is readonly AgentScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > agentScopes.length) throw new Error(`Invalid ${path}`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (!agentScopes.includes(entry as AgentScope) || seen.has(entry as string)) throw new Error(`Invalid ${path}`);
    seen.add(entry as string);
  }
  if ([...value].sort().some((entry, index) => entry !== value[index])) throw new Error(`Invalid ${path} order`);
}

function trust(value: unknown, path: string): asserts value is TrustProfile {
  if (!trustProfiles.includes(value as TrustProfile)) throw new Error(`Invalid ${path}`);
}

function safeNumber(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${path}`);
}

export function validatePairingRequest(value: unknown, path = 'pairingRequest'): asserts value is PairingRequest {
  const request = exact(value, ['product', 'clientId', 'requestedScopes', 'trust', 'disclosureAccepted', 'authorityConfirmed'], path);
  product(request.product, `${path}.product`);
  clientId(request.clientId, `${path}.clientId`);
  scopes(request.requestedScopes, `${path}.requestedScopes`);
  trust(request.trust, `${path}.trust`);
  if (request.disclosureAccepted !== true || typeof request.authorityConfirmed !== 'boolean') throw new Error(`Invalid ${path} consent`);
  if ((request.requestedScopes as readonly AgentScope[]).some((scope) => FORBIDDEN_PAIRING_SCOPES.has(scope))) throw new Error(`Unsafe ${path} authority`);
  const isDefault = request.trust === 'observer' && (request.requestedScopes as readonly AgentScope[]).length === 1 && request.requestedScopes[0] === 'system.read';
  if (!isDefault && request.authorityConfirmed !== true) throw new Error(`Explicit ${path} authority confirmation is required`);
  if (request.trust === 'observer' && (request.requestedScopes as readonly AgentScope[]).some((scope) => !scope.endsWith('.read'))) throw new Error(`Unsafe ${path} observer authority`);
}

export function validatePairingTargetRequest(value: unknown, path = 'pairingTarget'): asserts value is PairingTargetRequest {
  const request = exact(value, ['product', 'clientId'], path);
  product(request.product, `${path}.product`);
  clientId(request.clientId, `${path}.clientId`);
}

export function validatePairingStatus(value: unknown, path = 'pairingStatus'): asserts value is PairingStatus {
  const result = object(value, path);
  const allowed = ['apiVersion', 'product', 'clientId', 'state', 'launcherPath', 'message', 'manualConfiguration', 'requestedScopes', 'requestedTrust', 'grantedScopes', 'grantedTrust', 'generation'];
  const required = allowed.filter((key) => key !== 'launcherPath' && key !== 'manualConfiguration');
  if (!Object.keys(result).every((key) => allowed.includes(key)) || !required.every((key) => Object.hasOwn(result, key))) throw new Error(`Invalid ${path} fields`);
  if (result.apiVersion !== pairingApiVersion) throw new Error(`Invalid ${path}.apiVersion`);
  product(result.product, `${path}.product`); clientId(result.clientId, `${path}.clientId`);
  if (!pairingStates.includes(result.state as PairingState) || typeof result.message !== 'string' || result.message.length > 500) throw new Error(`Invalid ${path}`);
  scopes(result.requestedScopes, `${path}.requestedScopes`); trust(result.requestedTrust, `${path}.requestedTrust`);
  scopes(result.grantedScopes, `${path}.grantedScopes`); trust(result.grantedTrust, `${path}.grantedTrust`); safeNumber(result.generation, `${path}.generation`);
  if (result.launcherPath !== undefined && (typeof result.launcherPath !== 'string' || result.launcherPath.length > 1024)) throw new Error(`Invalid ${path}.launcherPath`);
  if (result.manualConfiguration !== undefined) {
    const manual = exact(result.manualConfiguration, ['executable', 'argv'], `${path}.manualConfiguration`);
    if (typeof manual.executable !== 'string' || manual.executable.length < 1 || manual.executable.length > 1024 || !Array.isArray(manual.argv) || manual.argv.length > 32 || manual.argv.some((entry) => typeof entry !== 'string' || entry.length > 1024)) throw new Error(`Invalid ${path}.manualConfiguration`);
  }
}
