import { constants, createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { canonicalizeJson } from '../../../shared/agent/v1/gatewaySchemas';
import type { AgentPrincipal } from '../../../shared/agent/v1/gatewayContracts';
import type { McpSessionAdmission, LoopbackSessionAuthenticator } from '../transport/loopbackHttp';
import { mcpProtocolVersions } from '../../../shared/mcp/v1/versions';

const protocolVersion = 'kaoyan-stdio-auth-v1';
const audience = 'kaoyan-mcp-loopback';
const transport = 'stdio-bridge';
const maxChallenges = 256;

export interface StdioChallenge {
  readonly version: typeof protocolVersion;
  readonly challengeId: string;
  readonly nonce: string;
  readonly appInstanceId: string;
  readonly clientId: string;
  readonly mcpProtocolVersion: string;
  readonly launcherVersion: string;
  readonly audience: typeof audience;
  readonly transport: typeof transport;
  readonly expiresAt: string;
}

export interface StdioAuthRegistryPort {
  getActivePublicKey(clientId: string): Promise<{
    readonly clientId: string;
    readonly publicKey: string;
    readonly publicKeyFingerprint: string;
    readonly keyGeneration: number;
    readonly registryGeneration: number;
  }>;
  createSession(clientId: string, credentialFingerprint: string, sessionFingerprint: string, expiresAt: string): Promise<{ readonly sessionId: string }>;
  hasActivePublicKeys(): Promise<boolean>;
}

export interface StdioAuthenticatorOptions {
  readonly registry: StdioAuthRegistryPort;
  readonly authenticatePrincipal: (credentialFingerprint: string, sessionFingerprint: string) => Promise<AgentPrincipal>;
  readonly appInstanceId: string;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomUUID?: () => string;
  readonly challengeTtlMs?: number;
  readonly sessionTtlMs?: number;
}

interface ConsumedChallenge { readonly challenge: StdioChallenge; readonly consumed: boolean; }
interface SessionBinding { readonly clientId: string; readonly protocolVersion: string; readonly credentialFingerprint: string; readonly sessionFingerprint: string; readonly expiresAt: string; }

function base64url(bytes: Buffer): string { return bytes.toString('base64url'); }
function fingerprint(value: string): string { return `sha256-v1:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function canonicalBytes(challenge: StdioChallenge): Buffer {
  return Buffer.from(canonicalizeJson({
    audience: challenge.audience, appInstanceId: challenge.appInstanceId, challengeId: challenge.challengeId,
    clientId: challenge.clientId, expiresAt: challenge.expiresAt, launcherVersion: challenge.launcherVersion,
    mcpProtocolVersion: challenge.mcpProtocolVersion, nonce: challenge.nonce, transport: challenge.transport, version: challenge.version
  }), 'utf8');
}
function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined { return headers[name.toLowerCase()]; }
function safeClientId(value: string | undefined): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value); }
function canonicalFuture(value: string, now: Date, maximumMs: number): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && parsed > now.getTime() && parsed <= now.getTime() + maximumMs;
}

/** Transport-only public-key challenge adapter. It has no Gateway capability. */
export class StdioPublicKeyAuthenticator implements LoopbackSessionAuthenticator {
  private readonly challenges = new Map<string, ConsumedChallenge>();
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly now: () => Date;
  private readonly bytes: (size: number) => Buffer;
  private readonly uuid: () => string;
  private readonly challengeTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(private readonly options: StdioAuthenticatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.bytes = options.randomBytes ?? randomBytes;
    this.uuid = options.randomUUID ?? randomUUID;
    this.challengeTtlMs = options.challengeTtlMs ?? 60_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 5 * 60_000;
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(options.appInstanceId) || this.challengeTtlMs < 1_000 || this.sessionTtlMs < 1_000 || this.sessionTtlMs > 15 * 60_000) throw new Error('Invalid stdio authentication configuration');
  }

  async issueChallenge(input: { readonly clientId: string; readonly mcpProtocolVersion: string; readonly launcherVersion: string }): Promise<StdioChallenge> {
    if (
      !safeClientId(input.clientId) ||
      !(mcpProtocolVersions as readonly string[]).includes(input.mcpProtocolVersion) ||
      !/^1\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]{1,32})?$/.test(input.launcherVersion)
    ) throw new AgentError('VALIDATION_ERROR');
    this.prune();
    if (this.challenges.size >= maxChallenges) throw new AgentError('POLICY_DENIED');
    await this.options.registry.getActivePublicKey(input.clientId);
    const now = this.now();
    const challenge = Object.freeze({ version: protocolVersion, challengeId: this.uuid(), nonce: base64url(this.bytes(32)), appInstanceId: this.options.appInstanceId,
      clientId: input.clientId, mcpProtocolVersion: input.mcpProtocolVersion, launcherVersion: input.launcherVersion, audience, transport,
      expiresAt: new Date(now.getTime() + this.challengeTtlMs).toISOString() });
    this.challenges.set(challenge.challengeId, { challenge, consumed: false });
    return challenge;
  }

  async challengeInitialize(request: { readonly headers: Readonly<Record<string, string | undefined>>; readonly protocolVersion: string }): Promise<StdioChallenge | null> {
    const clientId = header(request.headers, 'x-kaoyan-client-id');
    const launcherVersion = header(request.headers, 'x-kaoyan-launcher-version');
    if (!safeClientId(clientId) || !launcherVersion) return null;
    try { return await this.issueChallenge({ clientId, mcpProtocolVersion: request.protocolVersion, launcherVersion }); } catch { return null; }
  }

  async admitInitialize(request: { readonly headers: Readonly<Record<string, string | undefined>>; readonly protocolVersion: string }): Promise<McpSessionAdmission | null> {
    const challengeId = header(request.headers, 'x-kaoyan-challenge-id');
    const signature = header(request.headers, 'x-kaoyan-challenge-signature');
    if (!challengeId || !signature || !/^[A-Za-z0-9_-]{32,16384}$/.test(signature)) return null;
    const record = this.challenges.get(challengeId);
    if (!record || record.consumed || record.challenge.mcpProtocolVersion !== request.protocolVersion || !canonicalFuture(record.challenge.expiresAt, this.now(), this.challengeTtlMs)) return null;
    // Consume before verification so every attempt is one-use, including invalid proofs.
    this.challenges.set(challengeId, { ...record, consumed: true });
    try {
      const key = await this.options.registry.getActivePublicKey(record.challenge.clientId);
      if (!verify('sha256', canonicalBytes(record.challenge), { key: createPublicKey({ key: Buffer.from(key.publicKey, 'base64url'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(signature, 'base64url'))) return null;
      const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      const sessionFingerprint = fingerprint(base64url(this.bytes(32)));
      const session = await this.options.registry.createSession(key.clientId, key.publicKeyFingerprint, sessionFingerprint, expiresAt);
      this.sessions.set(session.sessionId, Object.freeze({ clientId: key.clientId, protocolVersion: request.protocolVersion, credentialFingerprint: key.publicKeyFingerprint, sessionFingerprint, expiresAt }));
      return Object.freeze({ sessionId: session.sessionId, protocolVersion: request.protocolVersion, expiresAt });
    } catch { return null; }
  }

  async validateSession(sessionId: string, requestedProtocolVersion: string): Promise<AgentPrincipal | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.protocolVersion !== requestedProtocolVersion || !canonicalFuture(session.expiresAt, this.now(), this.sessionTtlMs)) { this.sessions.delete(sessionId); return null; }
    try {
      const principal = await this.options.authenticatePrincipal(session.credentialFingerprint, session.sessionFingerprint);
      if (principal.clientId !== session.clientId) throw new AgentError('CLIENT_REVOKED');
      return principal;
    } catch { this.sessions.delete(sessionId); return null; }
  }

  async ready(): Promise<boolean> { return this.options.registry.hasActivePublicKeys(); }

  async invalidateAll(): Promise<void> { this.challenges.clear(); this.sessions.clear(); }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, record] of this.challenges) if (Date.parse(record.challenge.expiresAt) <= now) this.challenges.delete(id);
    for (const [id, session] of this.sessions) if (Date.parse(session.expiresAt) <= now) this.sessions.delete(id);
  }
}

export function canonicalStdioChallengeBytes(challenge: StdioChallenge): Buffer { return canonicalBytes(challenge); }
