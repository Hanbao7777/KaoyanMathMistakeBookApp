import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mcpProtocolVersions } from '../../shared/mcp/v1/versions';

export const discoveryFileName = 'mcp-loopback.discovery.json';
export const discoverySchemaVersion = 1 as const;
export const maxDiscoveryBytes = 8 * 1024;
export const maxDiscoveryAgeMs = 10 * 60_000;
const defaultDiscoveryTtlMs = 5 * 60_000;

export interface McpDiscoveryRecord {
  readonly schemaVersion: typeof discoverySchemaVersion;
  readonly pid: number;
  readonly instanceId: string;
  readonly port: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly protocolVersions: readonly string[];
  readonly launcherRange: string;
  readonly directHttpsPort?: number;
  readonly authority?: string;
  readonly resource?: string;
  readonly issuer?: string;
  readonly certificateThumbprint?: string;
}

export interface DiscoveryValidationOptions {
  readonly root: string;
  readonly now?: () => Date;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly handshake: (record: McpDiscoveryRecord) => Promise<boolean> | boolean;
  readonly ownershipCheck?: (filePath: string, root: string) => boolean;
}

export interface DiscoveryPublishOptions {
  readonly now?: Date;
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(normalizeForComparison(root), normalizeForComparison(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function discoveryPath(root: string): string {
  return path.join(root, discoveryFileName);
}

function secureRoot(root: string): { readonly resolved: string; readonly real: string } {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) throw new Error('Discovery root does not exist');
  const rootStat = fs.lstatSync(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Discovery root is not a regular directory');
  const real = fs.realpathSync.native(resolved);
  if (!isDescendant(real, resolved) || normalizeForComparison(real) !== normalizeForComparison(resolved)) throw new Error('Discovery root is not canonical');
  return Object.freeze({ resolved, real });
}

function assertNoLinkSegments(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!isDescendant(target, root)) throw new Error('Discovery path escapes its root');
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Discovery path contains a symbolic link or junction');
  }
}

function validateRecord(value: unknown, now: Date): McpDiscoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Discovery is malformed');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const legacy = ['createdAt', 'expiresAt', 'instanceId', 'launcherRange', 'pid', 'port', 'protocolVersions', 'schemaVersion'];
  const directAllowed = new Set(['authority', 'certificateThumbprint', 'directHttpsPort', 'issuer', 'resource']);
  if (!(keys.length === legacy.length && keys.every((key, index) => key === legacy[index])) && (!keys.includes('directHttpsPort') || keys.some((key) => !legacy.includes(key) && !directAllowed.has(key)) || keys.filter((key) => legacy.includes(key)).length !== legacy.length)) throw new Error('Discovery contains unsupported fields');
  if (
    record.schemaVersion !== discoverySchemaVersion ||
    !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
    !isUuid(record.instanceId) ||
    !Number.isSafeInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535 ||
    typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string' ||
    typeof record.launcherRange !== 'string' || record.launcherRange.length < 1 || record.launcherRange.length > 128 ||
    !Array.isArray(record.protocolVersions) || record.protocolVersions.length === 0 ||
    record.protocolVersions.length !== new Set(record.protocolVersions).size ||
    record.protocolVersions.some((version) => typeof version !== 'string' || !(mcpProtocolVersions as readonly string[]).includes(version))
  ) throw new Error('Discovery schema is invalid');
  const directFields = ['directHttpsPort', 'authority', 'resource', 'issuer'] as const;
  const hasDirect = directFields.some((key) => record[key] !== undefined);
  if (hasDirect && (
    record.directHttpsPort === undefined ||
    record.authority !== `https://127.0.0.1:${record.directHttpsPort}` ||
    record.resource !== `${record.authority}/mcp` ||
    record.issuer !== record.authority ||
    !Number.isSafeInteger(record.directHttpsPort) ||
    (record.directHttpsPort as number) < 1 ||
    (record.directHttpsPort as number) > 65535 ||
    (record.certificateThumbprint !== undefined && !/^[0-9A-Fa-f]{40,128}$/.test(String(record.certificateThumbprint)))
  )) throw new Error('Direct HTTPS discovery is invalid');

  const createdAt = new Date(record.createdAt);
  const expiresAt = new Date(record.expiresAt);
  const nowMs = now.getTime();
  if (
    Number.isNaN(createdAt.getTime()) || Number.isNaN(expiresAt.getTime()) ||
    createdAt.toISOString() !== record.createdAt || expiresAt.toISOString() !== record.expiresAt ||
    createdAt.getTime() > nowMs || createdAt.getTime() < nowMs - maxDiscoveryAgeMs ||
    expiresAt.getTime() <= nowMs || expiresAt.getTime() - createdAt.getTime() > maxDiscoveryAgeMs
  ) throw new Error('Discovery is stale');

  return Object.freeze({
    schemaVersion: discoverySchemaVersion,
    pid: record.pid as number,
    instanceId: record.instanceId,
    port: record.port as number,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    protocolVersions: Object.freeze([...(record.protocolVersions as string[])]),
    launcherRange: record.launcherRange,
    ...(hasDirect ? { directHttpsPort: record.directHttpsPort as number, authority: String(record.authority), resource: String(record.resource), issuer: String(record.issuer), ...(record.certificateThumbprint ? { certificateThumbprint: String(record.certificateThumbprint) } : {}) } : {})
  });
}

function defaultWindowsOwnershipCheck(filePath: string, root: string): boolean {
  try {
    const currentUser = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim().toLowerCase();
    if (!currentUser) return false;
    const acl = `${execFileSync('icacls', [filePath], { encoding: 'utf8', windowsHide: true })}\n${execFileSync('icacls', [root], { encoding: 'utf8', windowsHide: true })}`;
    if (/\b(?:everyone|builtin\\users|nt authority\\authenticated users|authenticated users)\b/i.test(acl)) return false;
    return acl.toLowerCase().includes(currentUser);
  } catch {
    return false;
  }
}

function assertSecureDiscoveryFile(filePath: string, root: string, ownershipCheck?: (filePath: string, root: string) => boolean): void {
  const secure = secureRoot(root);
  const target = path.resolve(filePath);
  assertNoLinkSegments(secure.real, target);
  const realFile = fs.realpathSync.native(target);
  if (!isDescendant(realFile, secure.real) || path.dirname(normalizeForComparison(realFile)) !== normalizeForComparison(secure.real)) throw new Error('Discovery path escapes its root');
  const stat = fs.lstatSync(realFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Discovery is not a regular file');
  if (process.platform === 'win32') {
    if (!(ownershipCheck ?? defaultWindowsOwnershipCheck)(realFile, secure.real)) throw new Error('Discovery Windows ACL ownership could not be established');
    return;
  }
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error('Discovery owner or permissions are unsafe');
}

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function flushDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const handle = fs.openSync(directory, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

export function getMcpDiscoveryPath(root: string): string {
  return discoveryPath(path.resolve(root));
}

export function removeMcpDiscovery(root: string, instanceId?: string): void {
  let secure: { readonly resolved: string; readonly real: string };
  try { secure = secureRoot(root); } catch { return; }
  const target = discoveryPath(secure.real);
  if (!fs.existsSync(target)) return;
  try {
    const stat = fs.lstatSync(target);
    if (instanceId !== undefined && stat.isFile() && !stat.isSymbolicLink()) {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { instanceId?: unknown };
      if (parsed.instanceId !== instanceId) return;
    }
  } catch {
    // A malformed record is untrusted and may be removed from the owned root.
  }
  try { fs.rmSync(target, { force: true }); } catch { /* stale cleanup is best effort */ }
}

export function publishMcpDiscovery(root: string, record: McpDiscoveryRecord, options: DiscoveryPublishOptions = {}): string {
  const secure = (() => {
    const resolved = path.resolve(root);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    return secureRoot(resolved);
  })();
  const target = discoveryPath(secure.real);
  if (path.dirname(target) !== secure.real || !isDescendant(target, secure.real)) throw new Error('Discovery root is invalid');
  validateRecord(record, options.now ?? new Date());
  const temporary = path.join(secure.real, `.${discoveryFileName}.${randomUUID()}.tmp`);
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    const encoded = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > maxDiscoveryBytes) throw new Error('Discovery exceeds the size limit');
    fs.writeFileSync(handle, encoded, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, target);
    flushDirectory(secure.real);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return target;
}

export async function readValidatedMcpDiscovery(options: DiscoveryValidationOptions): Promise<McpDiscoveryRecord | null> {
  const root = path.resolve(options.root);
  let target: string;
  try {
    target = discoveryPath(secureRoot(root).real);
  } catch {
    return null;
  }
  if (!fs.existsSync(target)) return null;
  try {
    assertSecureDiscoveryFile(target, root, options.ownershipCheck);
    const bytes = fs.readFileSync(target);
    if (bytes.byteLength > maxDiscoveryBytes) throw new Error('Discovery exceeds the size limit');
    const record = validateRecord(JSON.parse(bytes.toString('utf8')), (options.now ?? (() => new Date()))());
    if (!(options.isPidAlive ?? defaultPidAlive)(record.pid)) throw new Error('Discovery PID is not alive');
    if (!await options.handshake(record)) throw new Error('Discovery instance handshake failed');
    return record;
  } catch {
    removeMcpDiscovery(root);
    return null;
  }
}
