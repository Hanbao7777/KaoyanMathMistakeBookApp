import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AgentGateway } from '../../shared/agent/v1/gatewayContracts';
import { mcpProtocolVersions } from '../../shared/mcp/v1/versions';
import { publishMcpDiscovery, readValidatedMcpDiscovery, removeMcpDiscovery, type McpDiscoveryRecord } from './discovery';
import {
  createDenyAllLoopbackAuthenticator,
  createLoopbackMcpRequestHandler,
  type AuthenticatedLoopbackRequest,
  type LoopbackHttpResponse,
  type LoopbackMcpRequestHandler,
  type LoopbackSessionAuthenticator
} from './transport/loopbackHttp';
import { createMcpInitializeResult, createMcpProtocolHandler } from './protocol';

export interface McpLoopbackHostOptions {
  readonly discoveryRoot: string;
  readonly externalControlEnabled: () => Promise<boolean> | boolean;
  readonly authenticatedReady: () => Promise<boolean> | boolean;
  readonly authenticator?: LoopbackSessionAuthenticator;
  readonly onAuthenticatedRequest?: (request: AuthenticatedLoopbackRequest) => Promise<LoopbackHttpResponse | null | undefined> | LoopbackHttpResponse | null | undefined;
  readonly now?: () => Date;
  readonly instanceId?: string;
  readonly launcherRange?: string;
  readonly discoveryTtlMs?: number;
  readonly discoveryOwnershipCheck?: (filePath: string, root: string) => boolean;
  readonly gateway?: AgentGateway;
  readonly initializeResult?: Readonly<Record<string, unknown>> | ((protocolVersion: string) => Readonly<Record<string, unknown>>);
}

export interface McpLoopbackHostStatus {
  readonly state: 'disabled' | 'ready' | 'stopped';
  readonly instanceId: string;
  readonly port?: number;
}

class StartCancelledError extends Error {
  constructor() { super('MCP loopback host start was cancelled'); }
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

function probeDiscoveryPort(record: McpDiscoveryRecord): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port: record.port, path: '/mcp', method: 'GET', agent: false, timeout: 500, headers: { host: `127.0.0.1:${record.port}` } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode === 401 && response.headers['mcp-instance-id'] === record.instanceId));
    });
    request.once('error', () => resolve(false));
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.end();
  });
}

export class McpLoopbackHost {
  private readonly instanceId: string;
  private readonly authenticator: LoopbackSessionAuthenticator;
  private server: http.Server | null = null;
  private handler: LoopbackMcpRequestHandler | null = null;
  private state: McpLoopbackHostStatus['state'] = 'stopped';
  private port: number | undefined;
  private lifecycle = 0;
  private startPromise: Promise<McpLoopbackHostStatus> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: McpLoopbackHostOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.authenticator = options.authenticator ?? createDenyAllLoopbackAuthenticator();
  }

  status(): McpLoopbackHostStatus {
    return Object.freeze({ state: this.state, instanceId: this.instanceId, ...(this.port === undefined ? {} : { port: this.port }) });
  }

  async start(): Promise<McpLoopbackHostStatus> {
    if (this.startPromise) return this.startPromise;
    if (this.state === 'ready') {
      if (!await this.options.externalControlEnabled()) await this.disable();
      return this.status();
    }
    const token = ++this.lifecycle;
    this.stopPromise = null;
    const promise = this.startOnce(token);
    this.startPromise = promise;
    try { return await promise; } finally { if (this.startPromise === promise) this.startPromise = null; }
  }

  async disable(): Promise<void> {
    const token = ++this.lifecycle;
    this.state = 'disabled';
    this.port = undefined;
    removeMcpDiscovery(this.options.discoveryRoot, this.instanceId);
    this.handler?.invalidateSessions();
    await Promise.resolve(this.authenticator.invalidateAll()).catch(() => undefined);
    const server = this.server;
    this.server = null;
    if (server) await closeServer(server);
    if (token === this.lifecycle) this.handler = null;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const promise = this.stopOnce();
    this.stopPromise = promise;
    try { await promise; } finally { if (this.stopPromise === promise) this.stopPromise = null; }
  }

  private async stopOnce(): Promise<void> {
    ++this.lifecycle;
    this.state = 'stopped';
    this.port = undefined;
    removeMcpDiscovery(this.options.discoveryRoot, this.instanceId);
    this.handler?.invalidateSessions();
    await Promise.resolve(this.authenticator.invalidateAll()).catch(() => undefined);
    const server = this.server;
    this.server = null;
    this.handler = null;
    if (server) await closeServer(server);
    if (this.startPromise) await this.startPromise.catch(() => undefined);
  }

  private async startOnce(token: number): Promise<McpLoopbackHostStatus> {
    const enabled = await this.options.externalControlEnabled();
    const ready = enabled && await this.options.authenticatedReady();
    if (!ready || token !== this.lifecycle) {
      if (token === this.lifecycle) {
        this.state = 'disabled';
        removeMcpDiscovery(this.options.discoveryRoot, this.instanceId);
      }
      return this.status();
    }

    const existing = await readValidatedMcpDiscovery({
      root: this.options.discoveryRoot,
      now: this.options.now,
      handshake: probeDiscoveryPort
    });
    if (existing && existing.instanceId !== this.instanceId) throw new Error('Another MCP loopback host is already discoverable');
    removeMcpDiscovery(this.options.discoveryRoot, this.instanceId);

    let boundPort = 0;
    const onAuthenticatedRequest = this.options.onAuthenticatedRequest ?? (this.options.gateway
      ? createMcpProtocolHandler({ gateway: this.options.gateway })
      : undefined);
    const handler = createLoopbackMcpRequestHandler({
      getPort: () => boundPort,
      instanceId: this.instanceId,
      authenticator: this.authenticator,
      externalControlEnabled: this.options.externalControlEnabled,
      onExternalControlDisabled: () => this.disable(),
      onAuthenticatedRequest,
      initializeResult: this.options.initializeResult ?? (this.options.gateway ? createMcpInitializeResult : undefined),
      now: this.options.now
    });
    const server = http.createServer(handler);
    this.server = server;
    this.handler = handler;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
      });
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port < 1) throw new Error('Loopback listener did not bind IPv4 localhost');
      boundPort = address.port;
      this.port = boundPort;
      if (token !== this.lifecycle || !await this.options.externalControlEnabled() || !await this.options.authenticatedReady()) throw new StartCancelledError();
      const now = (this.options.now ?? (() => new Date()))();
      const ttl = this.options.discoveryTtlMs ?? 5 * 60_000;
      if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 10 * 60_000) throw new Error('Discovery TTL is invalid');
      const record: McpDiscoveryRecord = Object.freeze({
        schemaVersion: 1,
        pid: process.pid,
        instanceId: this.instanceId,
        port: boundPort,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
        protocolVersions: Object.freeze([...mcpProtocolVersions]),
        launcherRange: this.options.launcherRange ?? '>=1 <2'
      });
      publishMcpDiscovery(this.options.discoveryRoot, record, { now });
      const published = await readValidatedMcpDiscovery({
        root: this.options.discoveryRoot,
        now: this.options.now,
        handshake: probeDiscoveryPort,
        ownershipCheck: this.options.discoveryOwnershipCheck
      });
      if (!published || published.instanceId !== this.instanceId || published.port !== boundPort) {
        throw new Error('MCP discovery publication failed security validation');
      }
      if (token !== this.lifecycle) throw new StartCancelledError();
      this.state = 'ready';
      return this.status();
    } catch (error) {
      this.server = this.server === server ? null : this.server;
      this.handler = this.handler === handler ? null : this.handler;
      this.port = undefined;
      removeMcpDiscovery(this.options.discoveryRoot, this.instanceId);
      handler.invalidateSessions();
      await Promise.resolve(this.authenticator.invalidateAll()).catch(() => undefined);
      await closeServer(server);
      if (error instanceof StartCancelledError && token === this.lifecycle) this.state = 'disabled';
      if (error instanceof StartCancelledError || token !== this.lifecycle) {
        return this.status();
      }
      this.state = 'stopped';
      throw error;
    }
  }
}
