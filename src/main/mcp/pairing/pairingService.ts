import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import { agentApiVersion } from '../../../shared/agent/versions';
import {
  agentScopes, trustProfiles, type AgentGateway, type AgentPrincipal, type AgentScope,
  type GatewayManagementCommand, type GatewayWorkflowCommand, type PublicKeyBindingInput,
  type SafeClientKeyBindingResult, type TrustProfile
} from '../../../shared/agent/v1/gatewayContracts';
import { validateGatewayManagementCommand, validateSafeClientKeyBindingResult } from '../../../shared/agent/v1/gatewaySchemas';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import {
  pairingApiVersion, pairingProducts, type ManualClientConfiguration, type PairingProduct,
  type PairingRequest, type PairingStatus, type PairingTargetRequest, validatePairingRequest,
  validatePairingTargetRequest, validatePairingStatus
} from '../../../shared/mcp/v1/pairingContracts';

const LAUNCHER_VERSION = '1.0.0';
const STATE_VERSION = 1;
const MANIFEST_VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const REAL_DATA_ROOT = 'D:\\KaoyanMathMistakeBook';
const DEFAULT_SCOPES = Object.freeze(['system.read'] as const);
const DEFAULT_TRUST = 'observer' as const;

export interface LauncherArtifact {
  readonly root: string;
  readonly path: string;
  readonly version: typeof LAUNCHER_VERSION;
  readonly sha256: string;
  readonly compatibility: { readonly pairingApiVersion: typeof pairingApiVersion; readonly launcherVersion: typeof LAUNCHER_VERSION };
}

export interface PairingRunResult { readonly stdout: string; readonly stderr: string; readonly exitCode?: number; }

export class PairingSimulatedCrash extends Error { constructor(readonly phase: string) { super(`Simulated pairing crash at ${phase}`); this.name = 'PairingSimulatedCrash'; } }

export interface PairingServiceOptions {
  readonly gateway: AgentGateway;
  readonly principal: () => AgentPrincipal;
  readonly launcherArtifact: LauncherArtifact;
  readonly localAppData: string;
  readonly discoveryRoot: string;
  readonly journalRoot: string;
  readonly run?: (file: string, args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<PairingRunResult>;
  readonly fault?: (phase: string) => void | Promise<void>;
}

interface InstalledLauncher { readonly version: typeof LAUNCHER_VERSION; readonly path: string; readonly sha256: string; }
interface PublicBinding { readonly publicKey: string; readonly publicKeyFormat: 'spki-der-base64url'; readonly publicKeyFingerprint: string; readonly signatureAlgorithm: 'rsa-pss-sha256'; }
interface PairingRecord {
  readonly version: 1; readonly product: PairingProduct; readonly clientId: string; readonly configName: string;
  readonly keyName: string; readonly launcher: InstalledLauncher; readonly registryGeneration: number; readonly keyGeneration: number;
  readonly requestedScopes: readonly AgentScope[]; readonly requestedTrust: TrustProfile;
  readonly grantedScopes: readonly AgentScope[]; readonly grantedTrust: TrustProfile; readonly generation: number;
}

type TransactionAction = 'connect' | 'rotate' | 'disconnect';
interface PairingTransaction {
  readonly version: 1; readonly id: string; readonly action: TransactionAction; readonly phase: string;
  readonly key: string; readonly requestId: string; readonly record: PairingRecord;
  readonly binding?: PublicBinding; readonly previous?: PairingRecord; readonly previousBinding?: PublicBinding;
  readonly gatewayResult?: SafeClientKeyBindingResult; readonly accessRequestId?: string; readonly revokeRequestId?: string;
  readonly conflict?: boolean;
}
interface PairingState { readonly version: 1; readonly generation: number; readonly records: Readonly<Record<string, PairingRecord>>; readonly transaction?: PairingTransaction; }

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function normalized(value: string): string { const result = path.resolve(value); return process.platform === 'win32' ? result.toLowerCase() : result; }
function descendant(root: string, target: string): boolean { const relative = path.relative(normalized(root), normalized(target)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function related(left: string, right: string): boolean { return descendant(left, right) || descendant(right, left); }
function reparse(value: ReturnType<typeof lstatSync>): boolean { const candidate = value as ReturnType<typeof lstatSync> & { isReparsePoint?: () => boolean }; return candidate.isSymbolicLink() || candidate.isReparsePoint?.() === true; }

function assertExistingSegments(base: string, target: string, allowMissing = true): void {
  const resolvedBase = path.resolve(base); const resolvedTarget = path.resolve(target);
  if (!descendant(resolvedBase, resolvedTarget)) throw new Error('Pairing path escapes its root');
  let current = resolvedBase;
  for (const segment of path.relative(resolvedBase, resolvedTarget).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) { if (allowMissing) break; throw new Error('Pairing path is missing'); }
    const info = lstatSync(current);
    if (reparse(info)) throw new Error('Pairing path contains a link or junction');
    if (!descendant(resolvedBase, realpathSync.native(current))) throw new Error('Pairing realpath escapes its root');
  }
}

function safeExistingRoot(root: string, label: string): string {
  if (typeof root !== 'string' || root.length < 1) throw new Error(`Invalid ${label}`);
  const resolved = path.resolve(root); const dataRoot = path.resolve(REAL_DATA_ROOT);
  if (related(resolved, dataRoot)) throw new Error(`${label} overlaps the protected data root`);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist`);
  const info = lstatSync(resolved); if (!info.isDirectory() || reparse(info)) throw new Error(`${label} is unsafe`);
  const real = realpathSync.native(resolved); if (normalized(real) !== normalized(resolved)) throw new Error(`${label} is not canonical`);
  assertExistingSegments(path.parse(resolved).root, resolved, false);
  if (related(real, dataRoot)) throw new Error(`${label} overlaps the protected data root`);
  return real;
}

function ensureDirectory(root: string, target: string): void {
  assertExistingSegments(root, target);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const info = lstatSync(current); if (!info.isDirectory() || reparse(info) || !descendant(root, realpathSync.native(current))) throw new Error('Pairing directory is unsafe');
  }
}

function object(value: unknown, pathName: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${pathName}`); return value as Record<string, unknown>; }
function exact(value: unknown, keys: readonly string[], optional: readonly string[], pathName: string): Record<string, unknown> {
  const result = object(value, pathName); const allowed = new Set([...keys, ...optional]);
  if (!Object.keys(result).every((key) => allowed.has(key)) || !keys.every((key) => Object.hasOwn(result, key))) throw new Error(`Invalid ${pathName} fields`);
  return result;
}
function safeId(value: unknown, pathName: string): asserts value is string { if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 200) throw new Error(`Invalid ${pathName}`); }
function hashValue(value: unknown, pathName: string): asserts value is string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid ${pathName}`); }
function safeInteger(value: unknown, pathName: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${pathName}`); }
function stringArray(value: unknown, allowed: readonly string[], pathName: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length || value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry)) || new Set(value).size !== value.length || [...value].sort().some((entry, index) => entry !== value[index])) throw new Error(`Invalid ${pathName}`);
}

function validateLauncher(value: unknown, root: string, pathName: string): asserts value is InstalledLauncher {
  const result = exact(value, ['version', 'path', 'sha256'], [], pathName);
  if (result.version !== LAUNCHER_VERSION || typeof result.path !== 'string') throw new Error(`Invalid ${pathName}`);
  hashValue(result.sha256, `${pathName}.sha256`); assertExistingSegments(root, result.path, true);
}
function validateRecord(value: unknown, root: string, pathName: string): asserts value is PairingRecord {
  const result = exact(value, ['version', 'product', 'clientId', 'configName', 'keyName', 'launcher', 'registryGeneration', 'keyGeneration', 'requestedScopes', 'requestedTrust', 'grantedScopes', 'grantedTrust', 'generation'], [], pathName);
  if (result.version !== 1 || !pairingProducts.includes(result.product as PairingProduct)) throw new Error(`Invalid ${pathName}`);
  safeId(result.clientId, `${pathName}.clientId`); safeId(result.configName, `${pathName}.configName`);
  if (typeof result.keyName !== 'string' || !/^kaoyan-[A-Za-z0-9._-]{1,160}$/.test(result.keyName)) throw new Error(`Invalid ${pathName}.keyName`);
  validateLauncher(result.launcher, root, `${pathName}.launcher`); safeInteger(result.registryGeneration, `${pathName}.registryGeneration`); safeInteger(result.keyGeneration, `${pathName}.keyGeneration`);
  stringArray(result.requestedScopes, agentScopes, `${pathName}.requestedScopes`); stringArray(result.grantedScopes, agentScopes, `${pathName}.grantedScopes`);
  if (!trustProfiles.includes(result.requestedTrust as TrustProfile) || !trustProfiles.includes(result.grantedTrust as TrustProfile)) throw new Error(`Invalid ${pathName}.trust`);
  safeInteger(result.generation, `${pathName}.generation`);
}
function validateBinding(value: unknown, clientId: string, generation: number, pathName: string): asserts value is PublicBinding {
  const result = exact(value, ['publicKey', 'publicKeyFormat', 'publicKeyFingerprint', 'signatureAlgorithm'], [], pathName);
  validateGatewayManagementCommand({ type: 'agent.clients.rotate_key', payload: { clientId, expectedRegistryGeneration: generation, ...result } }, pathName);
}
function validateTransaction(value: unknown, root: string, pathName: string): asserts value is PairingTransaction {
  const result = exact(value, ['version', 'id', 'action', 'phase', 'key', 'requestId', 'record'], ['binding', 'previous', 'previousBinding', 'gatewayResult', 'accessRequestId', 'revokeRequestId', 'conflict'], pathName);
  if (result.version !== 1 || !['connect', 'rotate', 'disconnect'].includes(result.action as string) || typeof result.phase !== 'string' || result.phase.length > 60) throw new Error(`Invalid ${pathName}`);
  safeId(result.id, `${pathName}.id`); if (typeof result.key !== 'string' || result.key.length > 330 || typeof result.requestId !== 'string') throw new Error(`Invalid ${pathName}`);
  validateRecord(result.record, root, `${pathName}.record`);
  if (result.previous !== undefined) validateRecord(result.previous, root, `${pathName}.previous`);
  if (result.binding !== undefined) validateBinding(result.binding, result.record.clientId, result.record.registryGeneration, `${pathName}.binding`);
  if (result.previousBinding !== undefined) validateBinding(result.previousBinding, result.record.clientId, result.record.registryGeneration, `${pathName}.previousBinding`);
  if (result.gatewayResult !== undefined) validateSafeClientKeyBindingResult(result.gatewayResult, `${pathName}.gatewayResult`);
  for (const field of ['accessRequestId', 'revokeRequestId'] as const) if (result[field] !== undefined && typeof result[field] !== 'string') throw new Error(`Invalid ${pathName}.${field}`);
  if (result.conflict !== undefined && typeof result.conflict !== 'boolean') throw new Error(`Invalid ${pathName}.conflict`);
}
function parseState(bytes: Buffer, installRoot: string): PairingState {
  if (bytes.length > MAX_STATE_BYTES) throw new Error('Pairing state exceeds its bound');
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Pairing state is corrupt'); }
  const result = exact(parsed, ['version', 'generation', 'records'], ['transaction'], 'pairingState');
  if (result.version !== STATE_VERSION) throw new Error('Unsupported pairing state version'); safeInteger(result.generation, 'pairingState.generation');
  const records = object(result.records, 'pairingState.records');
  if (Object.keys(records).length > 64) throw new Error('Too many pairing records');
  for (const [key, record] of Object.entries(records)) { validateRecord(record, installRoot, `pairingState.records.${key}`); if (`${record.product}:${record.clientId}` !== key) throw new Error('Pairing record key mismatch'); }
  if (result.transaction !== undefined) validateTransaction(result.transaction, installRoot, 'pairingState.transaction');
  return parsed as PairingState;
}

async function flushDirectory(directory: string): Promise<void> {
  let handle; try { handle = await open(directory, 'r'); await handle.sync(); } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally { await handle?.close().catch(() => undefined); }
}
async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  const directory = path.dirname(target); await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle; try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, target); await flushDirectory(directory);
  } finally { await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
}
async function durableJson(target: string, value: unknown, preserve = true): Promise<void> {
  if (preserve && existsSync(target)) await atomicWrite(`${target}.previous`, await readFile(target));
  await atomicWrite(target, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'operation failed';
  return message.replace(/[A-Za-z]:\\[^\r\n]*/g, '<redacted-path>').slice(0, 300);
}

function resolveWindowsProductInvocation(file: string, args: readonly string[], env: NodeJS.ProcessEnv): { readonly file: string; readonly args: readonly string[] } {
  if (process.platform !== 'win32' || (file !== 'codex' && file !== 'claude')) return { file, args };
  const appData = env.APPDATA; if (!appData) throw new Error(`${file} CLI location is unavailable`);
  const npmRoot = path.join(path.resolve(appData), 'npm');
  if (file === 'claude') {
    const executable = path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    assertExistingSegments(path.resolve(appData), executable, false); return { file: executable, args };
  }
  const script = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'); assertExistingSegments(path.resolve(appData), script, false);
  const searchPath = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const node = searchPath.split(path.delimiter).map((entry) => path.join(entry.replace(/^"|"$/g, ''), 'node.exe')).find((candidate) => existsSync(candidate));
  if (!node) throw new Error('Codex Node runtime is unavailable');
  return { file: node, args: [script, ...args] };
}

function configName(clientId: string): string { return `kaoyan-mcp-${clientId}`; }
export function loadPackagedLauncherArtifact(resourcesPath: string): LauncherArtifact {
  const resourcesRoot = safeExistingRoot(resourcesPath, 'resourcesPath');
  const root = path.join(resourcesRoot, 'mcp-stdio'); assertExistingSegments(resourcesRoot, root, false);
  const manifestPath = path.join(root, 'launcher-manifest.json'); assertExistingSegments(root, manifestPath, false);
  const bytes = readFileSyncBounded(manifestPath, 16 * 1024); let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Packaged launcher manifest is corrupt'); }
  const value = exact(parsed, ['manifestVersion', 'launcherVersion', 'file', 'sha256', 'compatibility'], [], 'launcherManifest');
  if (value.manifestVersion !== MANIFEST_VERSION || value.launcherVersion !== LAUNCHER_VERSION || value.file !== 'kaoyan-mcp.exe') throw new Error('Packaged launcher manifest is incompatible');
  hashValue(value.sha256, 'launcherManifest.sha256');
  const compatibility = exact(value.compatibility, ['pairingApiVersion', 'launcherVersion'], [], 'launcherManifest.compatibility');
  if (compatibility.pairingApiVersion !== pairingApiVersion || compatibility.launcherVersion !== LAUNCHER_VERSION) throw new Error('Packaged launcher compatibility mismatch');
  const launcherPath = path.join(root, value.file as string); assertExistingSegments(root, launcherPath, false);
  return Object.freeze({ root, path: launcherPath, version: LAUNCHER_VERSION, sha256: value.sha256, compatibility: { pairingApiVersion, launcherVersion: LAUNCHER_VERSION } }) as LauncherArtifact;
}

function readFileSyncBounded(filePath: string, maximum: number): Buffer {
  const size = lstatSync(filePath).size; if (size < 1 || size > maximum) throw new Error('File exceeds expected bound');
  const descriptor = openSync(filePath, 'r'); try { return Buffer.from(require('node:fs').readFileSync(descriptor)); } finally { closeSync(descriptor); }
}

class ClientConfigAdapter {
  constructor(private readonly invoke: NonNullable<PairingServiceOptions['run']>, private readonly discoveryRoot: string, private readonly journalRoot: string) {}
  private executable(product: PairingProduct): string { return product === 'codex' ? 'codex' : 'claude'; }
  private expectedArgs(record: PairingRecord): readonly string[] { return ['--client-id', record.clientId, '--key-name', record.keyName, '--discovery-root', this.discoveryRoot, '--journal-root', this.journalRoot]; }
  manual(record: PairingRecord): ManualClientConfiguration {
    const argv = record.product === 'codex'
      ? ['mcp', 'add', record.configName, '--', record.launcher.path, ...this.expectedArgs(record)]
      : ['mcp', 'add', '--scope', 'user', record.configName, '--', record.launcher.path, ...this.expectedArgs(record)];
    return Object.freeze({ executable: this.executable(record.product), argv: Object.freeze(argv) });
  }
  private async get(record: PairingRecord): Promise<PairingRunResult> {
    const args = record.product === 'codex' ? ['mcp', 'get', '--json', record.configName] : ['mcp', 'get', record.configName];
    return this.invoke(this.executable(record.product), args);
  }
  async inspect(record: PairingRecord): Promise<'absent' | 'owned' | 'conflict'> {
    const result = await this.get(record); if ((result.exitCode ?? 0) !== 0) {
      if (/No MCP server named|not found|does not exist/i.test(`${result.stdout}\n${result.stderr}`)) return 'absent';
      throw new Error(`${this.executable(record.product)} mcp get failed`);
    }
    if (record.product === 'codex') {
      let value: unknown; try { value = JSON.parse(result.stdout); } catch { return 'conflict'; }
      const entry = object(value, 'codexEntry'); const transport = object(entry.transport, 'codexEntry.transport');
      const expected = this.expectedArgs(record);
      return entry.name === record.configName && entry.enabled === true && transport.type === 'stdio' && transport.command === record.launcher.path && Array.isArray(transport.args) && transport.args.length === expected.length && transport.args.every((arg, index) => arg === expected[index]) ? 'owned' : 'conflict';
    }
    const normalizedOutput = result.stdout.replace(/\r/g, ''); const expectedArgs = this.expectedArgs(record);
    const command = normalizedOutput.match(/^\s*Command:\s*(.*)$/mi)?.[1]?.trim();
    const args = normalizedOutput.match(/^\s*Args:\s*(.*)$/mi)?.[1]?.trim();
    const scope = normalizedOutput.match(/^\s*Scope:\s*(.*)$/mi)?.[1]?.trim();
    return command === record.launcher.path && args === expectedArgs.join(' ') && /user/i.test(scope ?? '') ? 'owned' : 'conflict';
  }
  async add(record: PairingRecord): Promise<void> {
    const existing = await this.inspect(record); if (existing === 'owned') return; if (existing === 'conflict') throw new Error('App-owned MCP name has an external conflict');
    const manual = this.manual(record); const result = await this.invoke(manual.executable, manual.argv);
    if ((result.exitCode ?? 0) !== 0 || await this.inspect(record) !== 'owned') throw new Error(`${manual.executable} mcp add failed`);
  }
  async remove(record: PairingRecord): Promise<'removed' | 'absent' | 'conflict'> {
    const existing = await this.inspect(record); if (existing !== 'owned') return existing;
    const args = record.product === 'codex' ? ['mcp', 'remove', record.configName] : ['mcp', 'remove', '--scope', 'user', record.configName];
    const result = await this.invoke(this.executable(record.product), args);
    if ((result.exitCode ?? 0) !== 0 || await this.inspect(record) !== 'absent') throw new Error(`${this.executable(record.product)} mcp remove failed`);
    return 'removed';
  }
  async replace(previous: PairingRecord, next: PairingRecord): Promise<void> {
    if (await this.inspect(previous) !== 'owned') throw new Error('App-owned MCP entry changed externally');
    await this.remove(previous);
    try { await this.add(next); } catch (error) { await this.add(previous).catch(() => undefined); throw error; }
  }
}

export class PairingService {
  private readonly invokeExecutable: NonNullable<PairingServiceOptions['run']>;
  private readonly localRoot: string; private readonly installRoot: string; private readonly statePath: string;
  private readonly config: ClientConfigAdapter; private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: PairingServiceOptions) {
    const localAppData = safeExistingRoot(options.localAppData, 'LocalAppData');
    this.localRoot = localAppData; this.installRoot = path.join(localAppData, 'KaoyanMathMistakeBook'); ensureDirectory(localAppData, this.installRoot);
    this.statePath = path.join(this.installRoot, 'mcp-pairings-v1.json'); assertExistingSegments(this.installRoot, this.statePath);
    const discoveryRoot = safeExistingRoot(options.discoveryRoot, 'discoveryRoot');
    if (!existsSync(options.journalRoot)) ensureDirectory(discoveryRoot, path.resolve(options.journalRoot));
    const journalRoot = safeExistingRoot(options.journalRoot, 'journalRoot');
    const artifactRoot = safeExistingRoot(options.launcherArtifact.root, 'launcherArtifact.root'); assertExistingSegments(artifactRoot, options.launcherArtifact.path, false);
    if (options.launcherArtifact.version !== LAUNCHER_VERSION || options.launcherArtifact.compatibility.pairingApiVersion !== pairingApiVersion || options.launcherArtifact.compatibility.launcherVersion !== LAUNCHER_VERSION || !/^[0-9a-f]{64}$/.test(options.launcherArtifact.sha256)) throw new Error('Launcher artifact metadata is invalid');
    this.invokeExecutable = options.run ?? ((file, args, env) => this.defaultRun(file, args, env));
    this.config = new ClientConfigAdapter(this.invokeExecutable, discoveryRoot, journalRoot);
  }

  private async defaultRun(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<PairingRunResult> {
    const executionEnvironment = env ?? process.env; const invocation = resolveWindowsProductInvocation(file, args, executionEnvironment);
    return new Promise((resolve) => execFile(invocation.file, [...invocation.args], { windowsHide: true, timeout: 20_000, maxBuffer: MAX_OUTPUT_BYTES, env: executionEnvironment }, (error, stdout, stderr) => resolve({ stdout, stderr, exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0 })));
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work, work); this.queue = result.catch(() => undefined); return result; }
  private async fault(phase: string): Promise<void> { await this.options.fault?.(phase); }
  private key(product: PairingProduct, clientId: string): string { return `${product}:${clientId}`; }
  private emptyState(): PairingState { return Object.freeze({ version: 1, generation: 0, records: Object.freeze({}) }); }
  private async loadState(): Promise<PairingState> { assertExistingSegments(this.installRoot, this.statePath, true); if (!existsSync(this.statePath)) return this.emptyState(); return parseState(await readFile(this.statePath), this.installRoot); }
  private async saveState(state: PairingState): Promise<void> { assertExistingSegments(this.installRoot, this.statePath, true); await durableJson(this.statePath, state); await this.fault(`state:${state.transaction?.action ?? 'idle'}:${state.transaction?.phase ?? 'published'}`); }
  private nextState(state: PairingState, updates: Partial<Pick<PairingState, 'records' | 'transaction'>>): PairingState {
    return Object.freeze({ version: 1, generation: state.generation + 1, records: updates.records ?? state.records, ...(updates.transaction ? { transaction: updates.transaction } : {}) });
  }
  private async setTransaction(state: PairingState, transaction: PairingTransaction): Promise<PairingState> { const next = this.nextState(state, { transaction }); await this.saveState(next); return next; }
  private updateTransaction(transaction: PairingTransaction, updates: Partial<PairingTransaction>): PairingTransaction { return Object.freeze({ ...transaction, ...updates }); }

  private async install(): Promise<InstalledLauncher> {
    const source = await readFile(this.options.launcherArtifact.path); if (sha256(source) !== this.options.launcherArtifact.sha256) throw new Error('Packaged launcher hash mismatch');
    const binRoot = path.join(this.installRoot, 'bin'); const directory = path.join(binRoot, LAUNCHER_VERSION); ensureDirectory(this.installRoot, binRoot); ensureDirectory(this.installRoot, directory);
    const target = path.join(directory, 'kaoyan-mcp.exe'); assertExistingSegments(this.installRoot, target);
    if (!existsSync(target) || sha256(await readFile(target)) !== this.options.launcherArtifact.sha256) {
      const temporary = path.join(directory, `.kaoyan-mcp.${process.pid}.${randomUUID()}.tmp`); let handle;
      try { handle = await open(temporary, 'wx', 0o700); await handle.writeFile(source); await handle.sync(); await handle.close(); handle = undefined;
        if (sha256(await readFile(temporary)) !== this.options.launcherArtifact.sha256) throw new Error('Launcher copy verification failed');
        await this.selfTest(temporary); await this.fault('install:before-version-publish'); await rename(temporary, target); await flushDirectory(directory);
      } finally { await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
    }
    await this.selfTest(target);
    const installed = Object.freeze({ version: LAUNCHER_VERSION, path: target, sha256: this.options.launcherArtifact.sha256 });
    const currentPath = path.join(binRoot, 'current.json'); assertExistingSegments(this.installRoot, currentPath, true); const previous = existsSync(currentPath) ? await readFile(currentPath) : undefined;
    try { await durableJson(currentPath, { manifestVersion: 1, launcher: installed }); await this.fault('install:after-manifest-publish'); await this.selfTest(target); }
    catch (error) { if (previous) await atomicWrite(currentPath, previous); else { await rm(currentPath, { force: true }); await flushDirectory(binRoot); } throw error; }
    return installed;
  }
  private async selfTest(file: string): Promise<void> { const result = await this.invokeExecutable(file, ['--self-test']); let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new Error('Launcher self-test output is invalid'); }
    if ((result.exitCode ?? 0) !== 0 || result.stderr !== '' || JSON.stringify(value) !== JSON.stringify({ ok: true, kind: 'kaoyan-mcp-self-test-v1', launcherVersion: LAUNCHER_VERSION })) throw new Error('Launcher self-test failed'); }
  private async validateCurrentLauncher(record: PairingRecord): Promise<void> {
    const manifestPath = path.join(this.installRoot, 'bin', 'current.json'); assertExistingSegments(this.installRoot, manifestPath, false);
    const bytes = await readFile(manifestPath); if (bytes.length > 16 * 1024) throw new Error('Current launcher manifest exceeds its bound');
    let parsed: unknown; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Current launcher manifest is corrupt'); }
    const manifest = exact(parsed, ['manifestVersion', 'launcher'], [], 'currentLauncherManifest');
    if (manifest.manifestVersion !== MANIFEST_VERSION) throw new Error('Current launcher manifest version mismatch');
    validateLauncher(manifest.launcher, this.installRoot, 'currentLauncherManifest.launcher');
    const launcher = manifest.launcher as unknown as InstalledLauncher;
    if (launcher.version !== record.launcher.version || normalized(launcher.path) !== normalized(record.launcher.path) || launcher.sha256 !== record.launcher.sha256) throw new Error('Current launcher manifest binding mismatch');
  }
  private async keyControl(record: PairingRecord, operation: 'create' | 'get' | 'delete'): Promise<PublicBinding | undefined> {
    const result = await this.invokeExecutable(record.launcher.path, ['--pairing-control', operation, '--key-name', record.keyName]);
    if ((result.exitCode ?? 0) !== 0 || result.stderr !== '') throw new Error(`Launcher key ${operation} failed`);
    let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new Error('Launcher key output is invalid'); }
    if (operation === 'delete') { const deleted = exact(value, ['version', 'kind', 'keyName'], [], 'keyDeleteResult'); if (deleted.version !== 1 || deleted.kind !== 'cng-key-deleted' || deleted.keyName !== record.keyName) throw new Error('Launcher key delete output is invalid'); return; }
    const output = exact(value, ['version', 'kind', 'publicKey', 'publicKeyFormat', 'publicKeyFingerprint', 'signatureAlgorithm'], [], 'keyBindingResult');
    if (output.version !== 1 || output.kind !== 'cng-public-key-binding') throw new Error('Launcher key output is invalid');
    const binding = { publicKey: output.publicKey, publicKeyFormat: output.publicKeyFormat, publicKeyFingerprint: output.publicKeyFingerprint, signatureAlgorithm: output.signatureAlgorithm };
    validateBinding(binding, record.clientId, record.registryGeneration, 'keyBindingResult'); return Object.freeze(binding as PublicBinding);
  }
  private async executeGateway(command: GatewayManagementCommand | GatewayWorkflowCommand, requestId: string): Promise<unknown> {
    const outcome = await this.options.gateway.execute({ apiVersion: agentApiVersion, kind: 'agent-command', operation: command.type, payload: command.payload as never, requestId, catalog: operationCatalogIdentity }, this.options.principal());
    if (outcome.kind === 'completed' || outcome.kind === 'replayed') return outcome.result.value;
    if (outcome.kind === 'rejected') throw new AgentError(outcome.error.code, outcome.error.details);
    throw new AgentError('APPROVAL_REQUIRED');
  }
  private async management(command: GatewayManagementCommand, requestId: string): Promise<SafeClientKeyBindingResult> { validateGatewayManagementCommand(command); const result = await this.executeGateway(command, requestId); validateSafeClientKeyBindingResult(result); return result as SafeClientKeyBindingResult; }
  private async revoke(clientId: string, requestId: string): Promise<void> { await this.executeGateway({ type: 'agent.clients.revoke', payload: { clientId } }, requestId); }
  private async applyAccess(record: PairingRecord, requestId: string): Promise<void> { await this.executeGateway({ type: 'agent.clients.update_access', payload: { clientId: record.clientId, scopes: record.requestedScopes, trust: record.requestedTrust } }, requestId); }

  private status(record: PairingRecord, state: PairingStatus['state'], message: string): PairingStatus {
    const result = Object.freeze({ apiVersion: pairingApiVersion, product: record.product, clientId: record.clientId, state, launcherPath: record.launcher.path, message,
      manualConfiguration: this.config.manual(record), requestedScopes: record.requestedScopes, requestedTrust: record.requestedTrust,
      grantedScopes: record.grantedScopes, grantedTrust: record.grantedTrust, generation: record.generation }); validatePairingStatus(result); return result;
  }
  private disconnected(target: PairingTargetRequest, message = '未配置'): PairingStatus { const result = Object.freeze({ apiVersion: pairingApiVersion, ...target, state: 'disconnected' as const, message, requestedScopes: DEFAULT_SCOPES, requestedTrust: DEFAULT_TRUST, grantedScopes: DEFAULT_SCOPES, grantedTrust: DEFAULT_TRUST, generation: 0 }); validatePairingStatus(result); return result; }

  private async recover(state: PairingState): Promise<PairingState> {
    const transaction = state.transaction; if (!transaction) return state;
    if (transaction.action === 'connect') return this.recoverConnect(state, transaction);
    if (transaction.action === 'rotate') return this.recoverRotate(state, transaction);
    return this.recoverDisconnect(state, transaction);
  }
  private async clearTransaction(state: PairingState, records = state.records): Promise<PairingState> { const next = this.nextState(state, { records }); await this.saveState(next); return next; }
  private async compensateConnect(state: PairingState, transaction: PairingTransaction): Promise<PairingState> {
    if (transaction.phase !== 'compensated') {
      const originalPhase = transaction.phase.startsWith('compensating:') ? transaction.phase.slice('compensating:'.length) : transaction.phase;
      if (!transaction.phase.startsWith('compensating:')) state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: `compensating:${originalPhase}` }));
      await this.config.remove(transaction.record);
      if (['registering', 'gateway_registered', 'access_applied', 'config_added'].includes(originalPhase)) await this.revoke(transaction.record.clientId, transaction.revokeRequestId!);
      if (originalPhase !== 'prepared') await this.keyControl(transaction.record, 'delete');
      state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'compensated' }));
    }
    if (Object.keys(state.records).length === 0) await this.uninstall();
    return this.clearTransaction(state);
  }
  private async recoverConnect(state: PairingState, transaction: PairingTransaction): Promise<PairingState> {
    try {
      if (transaction.phase === 'config_added') { const records = Object.freeze({ ...state.records, [transaction.key]: transaction.record }); return this.clearTransaction(state, records); }
      if (transaction.phase === 'registering' && transaction.binding) {
        const result = await this.management({ type: 'agent.clients.register_key', payload: { clientId: transaction.record.clientId, expectedRegistryGeneration: 0, ...transaction.binding } }, transaction.requestId);
        state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'gateway_registered', gatewayResult: result }));
      }
      if (transaction.phase === 'gateway_registered') {
        if (transaction.record.requestedTrust !== DEFAULT_TRUST || transaction.record.requestedScopes.length !== 1 || transaction.record.requestedScopes[0] !== 'system.read') await this.applyAccess(transaction.record, transaction.accessRequestId!);
        const record = Object.freeze({ ...transaction.record, grantedScopes: transaction.record.requestedScopes, grantedTrust: transaction.record.requestedTrust });
        state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'access_applied', record }));
      }
      if (transaction.phase === 'access_applied') { await this.config.add(transaction.record); state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'config_added' })); return this.recoverConnect(state, transaction); }
      return this.compensateConnect(state, transaction);
    } catch { return this.compensateConnect(state, transaction); }
  }
  private async recoverRotate(state: PairingState, transaction: PairingTransaction): Promise<PairingState> {
    const previous = transaction.previous!;
    try {
      if (transaction.phase === 'prepared') { await this.keyControl(transaction.record, 'delete').catch(() => undefined); return this.clearTransaction(state); }
      if (transaction.phase === 'rotating' && transaction.binding) {
        const result = await this.management({ type: 'agent.clients.rotate_key', payload: { clientId: transaction.record.clientId, expectedRegistryGeneration: previous.registryGeneration, ...transaction.binding } }, transaction.requestId);
        const record = Object.freeze({ ...transaction.record, registryGeneration: result.registryGeneration, keyGeneration: result.keyGeneration });
        state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'gateway_rotated', gatewayResult: result, record }));
      }
      if (transaction.phase === 'gateway_rotated') { await this.config.replace(previous, transaction.record); state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'config_updated' })); }
      if (transaction.phase === 'config_updated') { const records = Object.freeze({ ...state.records, [transaction.key]: transaction.record }); state = await this.setTransaction(this.nextState(state, { records, transaction }), transaction = this.updateTransaction(transaction, { phase: 'state_published' })); }
      if (transaction.phase === 'state_published') { await this.keyControl(previous, 'delete'); return this.clearTransaction(state, state.records); }
      return state;
    } catch (error) {
      if (error instanceof PairingSimulatedCrash) throw error;
      if (transaction.gatewayResult && transaction.previousBinding) {
        try {
          const rollbackId = transaction.revokeRequestId ?? randomUUID();
          const rollback = await this.management({ type: 'agent.clients.rotate_key', payload: { clientId: previous.clientId, expectedRegistryGeneration: transaction.gatewayResult.registryGeneration, ...transaction.previousBinding } }, rollbackId);
          const restored = Object.freeze({ ...previous, registryGeneration: rollback.registryGeneration, keyGeneration: rollback.keyGeneration });
          await this.config.remove(transaction.record); await this.config.add(previous); await this.keyControl(transaction.record, 'delete');
          return this.clearTransaction(state, Object.freeze({ ...state.records, [transaction.key]: restored }));
        } catch { throw new Error(`Rotation recovery requires intervention: ${normalizeError(error)}`); }
      }
      await this.keyControl(transaction.record, 'delete').catch(() => undefined); return this.clearTransaction(state);
    }
  }
  private async recoverDisconnect(state: PairingState, transaction: PairingTransaction): Promise<PairingState> {
    let conflict = transaction.conflict ?? false;
    if (transaction.phase === 'prepared') { const removed = await this.config.remove(transaction.record); conflict = removed === 'conflict'; state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'config_removed', conflict })); }
    if (transaction.phase === 'config_removed') { await this.revoke(transaction.record.clientId, transaction.revokeRequestId!); state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'gateway_revoked' })); }
    if (transaction.phase === 'gateway_revoked') { await this.keyControl(transaction.record, 'delete'); state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'key_deleted' })); }
    if (transaction.phase === 'key_deleted') { const mutableRecords = { ...state.records }; delete mutableRecords[transaction.key]; const records = Object.freeze(mutableRecords); transaction = this.updateTransaction(transaction, { phase: 'records_removed' }); state = this.nextState(state, { records, transaction }); await this.saveState(state); }
    if (transaction.phase === 'records_removed') { if (Object.keys(state.records).length === 0) await this.uninstall(); state = await this.clearTransaction(state, state.records); }
    return state;
  }
  private async readyState(): Promise<PairingState> { return this.recover(await this.loadState()); }
  private async uninstall(): Promise<void> { const binRoot = path.join(this.installRoot, 'bin'); assertExistingSegments(this.installRoot, binRoot, true); await this.fault('uninstall:before-remove'); await rm(binRoot, { recursive: true, force: true }); await flushDirectory(this.installRoot); }

  async connect(value: unknown): Promise<PairingStatus> { return this.serialize(async () => {
    validatePairingRequest(value); const request = value; let state = await this.readyState(); const key = this.key(request.product, request.clientId);
    if (state.records[key]) return this.healthInternal(state, request);
    const prospectiveLauncherPath = path.join(this.installRoot, 'bin', LAUNCHER_VERSION, 'kaoyan-mcp.exe');
    const placeholder: PairingRecord = Object.freeze({ version: 1, product: request.product, clientId: request.clientId, configName: configName(request.clientId), keyName: `kaoyan-c5-${request.clientId}-${randomUUID()}`,
      launcher: { version: LAUNCHER_VERSION as typeof LAUNCHER_VERSION, path: prospectiveLauncherPath, sha256: this.options.launcherArtifact.sha256 }, registryGeneration: 0, keyGeneration: 0,
      requestedScopes: Object.freeze([...request.requestedScopes]), requestedTrust: request.trust, grantedScopes: DEFAULT_SCOPES, grantedTrust: DEFAULT_TRUST, generation: 1 });
    let transaction: PairingTransaction = Object.freeze({ version: 1, id: `txn-${randomUUID()}`, action: 'connect', phase: 'prepared', key, requestId: randomUUID(), accessRequestId: randomUUID(), revokeRequestId: randomUUID(), record: placeholder });
    state = await this.setTransaction(state, transaction);
    try {
      const launcher = await this.install(); const record = Object.freeze({ ...placeholder, launcher }); state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'launcher_installed', record }));
      const binding = (await this.keyControl(record, 'create'))!; state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'registering', binding }));
      const gatewayResult = await this.management({ type: 'agent.clients.register_key', payload: { clientId: record.clientId, expectedRegistryGeneration: 0, ...binding } }, transaction.requestId);
      let registered = Object.freeze({ ...record, registryGeneration: gatewayResult.registryGeneration, keyGeneration: gatewayResult.keyGeneration });
      state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'gateway_registered', gatewayResult, record: registered }));
      if (request.trust !== DEFAULT_TRUST || request.requestedScopes.length !== 1 || request.requestedScopes[0] !== 'system.read') { await this.applyAccess(registered, transaction.accessRequestId!); registered = Object.freeze({ ...registered, grantedScopes: registered.requestedScopes, grantedTrust: registered.requestedTrust }); }
      state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'access_applied', record: registered }));
      await this.config.add(registered); state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'config_added' }));
      state = await this.recoverConnect(state, transaction); return this.healthInternal(state, request);
    } catch (error) { if (error instanceof PairingSimulatedCrash) throw error; state = await this.compensateConnect(state, transaction); return this.status(transaction.record, 'failed', `连接已补偿：${normalizeError(error)}`); }
  }); }

  async health(value: unknown): Promise<PairingStatus> { return this.serialize(async () => { validatePairingTargetRequest(value); return this.healthInternal(await this.readyState(), value); }); }
  private async healthInternal(state: PairingState, target: PairingTargetRequest): Promise<PairingStatus> {
    const record = state.records[this.key(target.product, target.clientId)]; if (!record) return this.disconnected(target);
    try { assertExistingSegments(this.installRoot, record.launcher.path, false); const launcher = await stat(record.launcher.path); if (!launcher.isFile() || sha256(await readFile(record.launcher.path)) !== record.launcher.sha256) return this.status(record, 'repairing', '启动器缺失或校验失败');
      await this.validateCurrentLauncher(record); await this.selfTest(record.launcher.path); const config = await this.config.inspect(record); if (config === 'owned') return this.status(record, 'healthy', '配置、启动器与授权状态一致');
      return this.status(record, config === 'conflict' ? 'conflict' : 'repairing', config === 'conflict' ? 'App-owned 配置名称已被外部修改' : 'App-owned 配置缺失');
    } catch (error) { return this.status(record, 'failed', normalizeError(error)); }
  }

  async repair(value: unknown): Promise<PairingStatus> { return this.serialize(async () => { validatePairingTargetRequest(value); let state = await this.readyState(); const record = state.records[this.key(value.product, value.clientId)]; if (!record) return this.disconnected(value);
    const config = await this.config.inspect(record); if (config === 'conflict') return this.status(record, 'conflict', '外部修改冲突，未覆盖现有条目');
    const launcher = await this.install(); const repaired = Object.freeze({ ...record, launcher, generation: record.generation + 1 }); await this.config.add(repaired);
    const records = Object.freeze({ ...state.records, [this.key(value.product, value.clientId)]: repaired }); state = this.nextState(state, { records }); await this.saveState(state); return this.healthInternal(state, value);
  }); }

  async rotate(value: unknown): Promise<PairingStatus> { return this.serialize(async () => { validatePairingTargetRequest(value); let state = await this.readyState(); const key = this.key(value.product, value.clientId); const previous = state.records[key]; if (!previous) return this.disconnected(value);
    const previousBinding = (await this.keyControl(previous, 'get'))!; const next: PairingRecord = Object.freeze({ ...previous, keyName: `kaoyan-c5-${previous.clientId}-${randomUUID()}`, generation: previous.generation + 1 });
    let transaction: PairingTransaction = Object.freeze({ version: 1, id: `txn-${randomUUID()}`, action: 'rotate', phase: 'prepared', key, requestId: randomUUID(), revokeRequestId: randomUUID(), record: next, previous, previousBinding }); state = await this.setTransaction(state, transaction);
    try { const binding = (await this.keyControl(next, 'create'))!; state = await this.setTransaction(state, transaction = this.updateTransaction(transaction, { phase: 'rotating', binding })); state = await this.recoverRotate(state, transaction); return this.healthInternal(state, value); }
    catch (error) { if (error instanceof PairingSimulatedCrash) throw error; return this.status(previous, 'recovery_required', normalizeError(error)); }
  }); }

  async disconnect(value: unknown): Promise<PairingStatus> { return this.serialize(async () => { validatePairingTargetRequest(value); let state = await this.readyState(); const key = this.key(value.product, value.clientId); const record = state.records[key]; if (!record) return this.disconnected(value);
    const conflict = await this.config.inspect(record) === 'conflict';
    const transaction: PairingTransaction = Object.freeze({ version: 1, id: `txn-${randomUUID()}`, action: 'disconnect', phase: 'prepared', key, requestId: randomUUID(), revokeRequestId: randomUUID(), record, conflict }); state = await this.setTransaction(state, transaction);
    try { state = await this.recoverDisconnect(state, transaction); return this.disconnected(value, transaction.conflict ? '已撤权并删除密钥；外部冲突配置未删除' : '已移除 App-owned 配置、撤权并删除密钥'); }
    catch (error) { if (error instanceof PairingSimulatedCrash) throw error; return this.status(record, 'recovery_required', normalizeError(error)); }
  }); }
}
