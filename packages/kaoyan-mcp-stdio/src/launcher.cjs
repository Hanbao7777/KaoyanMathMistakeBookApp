'use strict';

const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { WindowsCngKeyLifecycle } = require('./cngKeyLifecycle.cjs');
const {
  launcherCatalogIdentity,
  resolveLauncherOperation,
  validateLauncherCommandEnvelope,
  validateLauncherQueryEnvelope,
  validateLauncherReceiptStatus,
  validateLauncherMcpOutcome,
  canonicalizeLauncherJson,
  hashLauncherJson,
  extractLauncherTerminalEvidence,
  mapGatewayTerminalToMcpOutcome
} = require('../../../src/shared/mcp/v1/launcherContracts');

const LAUNCHER_VERSION = '1.0.0';
const JOURNAL_VERSION = 3;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024;
const MAX_CLAIM_BYTES = 1024;
const MAX_IN_FLIGHT = 16;
const MAX_CHALLENGE_FUTURE_MS = 65_000;
const DISCOVERY_FILE = 'mcp-loopback.discovery.json';
const STATES = new Set(['prepared', 'forwarded', 'needs_lookup', 'terminal']);
const TRANSITIONS = new Map([
  ['prepared', new Set(['forwarded'])],
  ['forwarded', new Set(['needs_lookup', 'terminal'])],
  ['needs_lookup', new Set(['terminal'])],
  ['terminal', new Set()]
]);
const MCP_PROTOCOLS = new Set(['2025-06-18', '2025-11-25']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const HASH = /^sha256-v1:[0-9a-f]{64}$/;
const REAL_DATA_ROOT = 'D:\\KaoyanMathMistakeBook';

function canonicalize(value) { return canonicalizeLauncherJson(value); }
function hash(value) { return hashLauncherJson(value); }

function safeId(value, field = 'identifier') {
  if (typeof value !== 'string' || !SAFE_NAME.test(value) || value.length > 200) throw new Error(`Invalid ${field}`);
  return value;
}

function safeRequestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid requestId');
  return value.toLowerCase();
}

function normalized(value) {
  const result = path.resolve(value);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function descendant(root, target) {
  const relative = path.relative(normalized(root), normalized(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameOrRelated(left, right) { return descendant(left, right) || descendant(right, left); }

function hasReparsePoint(stat) {
  return stat.isSymbolicLink() || (typeof stat.isReparsePoint === 'function' && stat.isReparsePoint());
}

function assertExistingSegments(base, target, allowMissing = true) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (!descendant(resolvedBase, resolvedTarget)) throw new Error('Filesystem path escapes launcher root');
  let current = resolvedBase;
  const segments = path.relative(resolvedBase, resolvedTarget).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') break;
      throw error;
    }
    if (hasReparsePoint(stat)) throw new Error('Filesystem path contains a link or junction');
    const real = fs.realpathSync.native(current);
    if (!descendant(resolvedBase, real)) throw new Error('Filesystem realpath escapes launcher root');
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error('Filesystem path segment is not a directory');
  }
}

function safeRoot(root) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('Launcher root is invalid');
  const resolved = path.resolve(root);
  const dataRoot = path.resolve(REAL_DATA_ROOT);
  if (sameOrRelated(resolved, dataRoot)) throw new Error('Launcher root overlaps the protected data root');
  if (!fs.existsSync(resolved)) throw new Error('Launcher root does not exist');
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || hasReparsePoint(stat)) throw new Error('Launcher root is not a regular directory');
  const real = fs.realpathSync.native(resolved);
  if (normalized(real) !== normalized(resolved)) throw new Error('Launcher root is not canonical');
  assertExistingSegments(path.parse(resolved).root, resolved, false);
  if (sameOrRelated(real, dataRoot)) throw new Error('Launcher root overlaps the protected data root');
  return real;
}

function ensureDirectory(base, directory) {
  assertExistingSegments(base, directory);
  let current = base;
  for (const segment of path.relative(base, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || hasReparsePoint(stat)) throw new Error('Launcher directory is unsafe');
    if (!descendant(base, fs.realpathSync.native(current))) throw new Error('Launcher directory escapes root');
  }
}

function flushDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = fs.openSync(directory, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function currentUser() {
  if (process.platform === 'win32') return `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`.toLowerCase();
  return typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function onlyKeys(value, keys, required = []) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function defaultFilesystem() {
  return Object.freeze({
    readFile: (target) => fs.readFileSync(target),
    writeFile: (handle, content) => fs.writeFileSync(handle, content),
    flushFile: (handle) => fs.fsyncSync(handle),
    closeFile: (handle) => fs.closeSync(handle),
    openExclusive: (target, mode) => fs.openSync(target, 'wx', mode),
    atomicReplace: (temporary, target) => fs.renameSync(temporary, target),
    flushDirectory,
    removeOwn: (target) => fs.rmSync(target, { force: true }),
    exists: (target) => fs.existsSync(target),
    stat: (target) => fs.lstatSync(target),
    list: (directory) => fs.readdirSync(directory),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  });
}

function durableWrite(fsPort, base, directory, target, content, temporaryPrefix) {
  ensureDirectory(base, directory);
  const temporary = path.join(directory, `.${temporaryPrefix}.${process.pid}.${randomUUID()}.tmp`);
  assertExistingSegments(base, temporary);
  let handle;
  try {
    handle = fsPort.openExclusive(temporary, 0o600);
    try {
      fsPort.writeFile(handle, Buffer.from(content, 'utf8'));
      fsPort.flushFile(handle);
    } finally {
      fsPort.closeFile(handle);
      handle = undefined;
    }
    fsPort.atomicReplace(temporary, target);
    fsPort.flushDirectory(directory);
  } finally {
    if (handle !== undefined) { try { fsPort.closeFile(handle); } catch {} }
    if (fsPort.exists(temporary)) fsPort.removeOwn(temporary);
  }
}

class DurableClaimLock {
  constructor(root, namespace, options = {}) {
    this.root = safeRoot(root);
    this.namespace = safeId(namespace, 'lock namespace');
    this.fs = Object.freeze({ ...defaultFilesystem(), ...(options.filesystem || {}) });
    this.waitMs = options.lockWaitMs ?? 10_000;
    this.staleMs = options.lockStaleMs ?? 30_000;
    this.pollMs = options.lockPollMs ?? 10;
    this.user = options.user || currentUser();
    this.now = options.now || (() => new Date());
    this.isPidAlive = options.isPidAlive || pidAlive;
  }

  async acquire(onWait) {
    const directory = path.join(this.root, '.claims');
    ensureDirectory(this.root, directory);
    const token = randomUUID();
    const ownName = `${this.namespace}.${token}.json`;
    const ownPath = path.join(directory, ownName);
    assertExistingSegments(this.root, ownPath);
    let metadata = Object.freeze({ version: 1, phase: 'waiting', pid: process.pid, user: this.user, createdAt: this.now().toISOString(), token });
    let handle;
    try {
      handle = this.fs.openExclusive(ownPath, 0o600);
      this.fs.writeFile(handle, Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'));
      this.fs.flushFile(handle);
      this.fs.closeFile(handle);
      handle = undefined;
      this.fs.flushDirectory(directory);
    } catch (error) {
      if (handle !== undefined) { try { this.fs.closeFile(handle); } catch {} }
      if (this.fs.exists(ownPath)) { try { this.fs.removeOwn(ownPath); this.fs.flushDirectory(directory); } catch {} }
      throw error;
    }
    const release = async () => {
      try {
        const current = this.fs.readFile(ownPath);
        if (current.byteLength <= MAX_CLAIM_BYTES && JSON.parse(current.toString('utf8')).token === token) {
          this.fs.removeOwn(ownPath);
          this.fs.flushDirectory(directory);
        }
      } catch {}
    };
    const deadline = Date.now() + this.waitMs;
    try {
      while (Date.now() <= deadline) {
        const candidates = [];
        for (const name of this.fs.list(directory)) {
          if (!name.startsWith(`${this.namespace}.`) || !name.endsWith('.json')) continue;
          const candidatePath = path.join(directory, name);
          try {
            const bytes = this.fs.readFile(candidatePath);
            if (bytes.byteLength > MAX_CLAIM_BYTES) throw new Error('invalid claim');
            const owner = JSON.parse(bytes.toString('utf8'));
            if (!exactKeys(owner, ['version', 'phase', 'pid', 'user', 'createdAt', 'token']) || owner.version !== 1 || !['waiting', 'owned'].includes(owner.phase) || owner.user !== this.user || typeof owner.token !== 'string' || !UUID.test(owner.token)) throw new Error('invalid claim');
            const created = Date.parse(owner.createdAt);
            if (!Number.isFinite(created) || new Date(created).toISOString() !== owner.createdAt) throw new Error('invalid claim');
            const stale = Date.now() - created > this.staleMs && !this.isPidAlive(owner.pid);
            if (!stale) {
              const stat = this.fs.stat(candidatePath);
              const order = stat.birthtimeNs !== undefined ? stat.birthtimeNs : BigInt(Math.max(0, Math.floor(stat.birthtimeMs * 1_000_000)));
              candidates.push({ ...owner, order });
            }
          } catch {
            const age = (() => { try { return Date.now() - this.fs.stat(candidatePath).mtimeMs; } catch { return 0; } })();
            if (age <= this.staleMs) candidates.push({ createdAt: '', phase: 'owned', token: name, pid: 0, order: 0n });
          }
        }
        candidates.sort((left, right) => {
          if (left.phase !== right.phase) return left.phase === 'owned' ? -1 : 1;
          return left.order < right.order ? -1 : left.order > right.order ? 1 : left.token.localeCompare(right.token);
        });
        if (candidates[0]?.token === token) {
          if (metadata.phase === 'owned') return { release, observed: null };
          metadata = Object.freeze({ ...metadata, phase: 'owned' });
          durableWrite(this.fs, this.root, directory, ownPath, `${JSON.stringify(metadata)}\n`, `${this.namespace}.${token}.owner`);
          await this.fs.sleep(this.pollMs);
          continue;
        }
        if (onWait) {
          const observed = await onWait();
          if (observed) { await release(); return { release: async () => {}, observed }; }
        }
        await this.fs.sleep(this.pollMs);
      }
      throw new Error('Durable claim lock timed out');
    } catch (error) {
      await release();
      throw error;
    }
  }
}

function validateRecord(record) {
  const expected = [
    'bindingHash', 'catalogHash', 'catalogVersion', 'clientId', 'createdAt', 'envelopeHash', 'gatewayRequestId',
    'operation', 'operationKind', 'payloadHash', 'publicOutcomeHash', 'receiptOutcomeHash', 'receiptRef',
    'requestId', 'state', 'updatedAt', 'version'
  ];
  if (!exactKeys(record, expected)) throw new Error('Journal record schema is invalid');
  if (record.version !== JOURNAL_VERSION || !STATES.has(record.state)) throw new Error('Journal record version or state is invalid');
  safeId(record.clientId, 'clientId');
  safeRequestId(record.requestId);
  if (record.gatewayRequestId !== record.requestId) throw new Error('Journal Gateway requestId is not canonical');
  const operation = resolveLauncherOperation(record.operation);
  if (!operation || operation.kind !== 'command' || record.operationKind !== 'command') throw new Error('Journal operation binding is invalid');
  for (const key of ['bindingHash', 'envelopeHash', 'payloadHash', 'catalogHash']) if (typeof record[key] !== 'string' || !HASH.test(record[key])) throw new Error(`Journal ${key} is invalid`);
  for (const key of ['publicOutcomeHash', 'receiptOutcomeHash']) if (record[key] !== null && (typeof record[key] !== 'string' || !HASH.test(record[key]))) throw new Error(`Journal ${key} is invalid`);
  if (record.catalogVersion !== launcherCatalogIdentity.version || record.catalogHash !== launcherCatalogIdentity.hash) throw new Error('Journal catalog binding is invalid');
  if (record.receiptRef !== null && (typeof record.receiptRef !== 'string' || !UUID.test(record.receiptRef))) throw new Error('Journal receipt reference is invalid');
  for (const key of ['createdAt', 'updatedAt']) {
    const milliseconds = Date.parse(record[key]);
    if (typeof record[key] !== 'string' || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== record[key]) throw new Error('Journal timestamp is invalid');
  }
  if (record.updatedAt < record.createdAt) throw new Error('Journal timestamps are invalid');
  if (record.state === 'terminal' && record.publicOutcomeHash === null) throw new Error('Terminal journal record has no public outcome hash');
  if (record.state !== 'terminal' && (record.publicOutcomeHash !== null || record.receiptOutcomeHash !== null || record.receiptRef !== null)) throw new Error('Non-terminal journal record contains terminal metadata');
  return Object.freeze({ ...record });
}

function sameBinding(left, right) {
  return left.clientId === right.clientId && left.requestId === right.requestId && left.gatewayRequestId === right.gatewayRequestId &&
    left.operation === right.operation && left.operationKind === right.operationKind && left.bindingHash === right.bindingHash &&
    left.envelopeHash === right.envelopeHash && left.payloadHash === right.payloadHash &&
    left.catalogVersion === right.catalogVersion && left.catalogHash === right.catalogHash;
}

function journalPath(root, clientId, requestId) {
  safeId(clientId, 'clientId');
  safeRequestId(requestId);
  const base = safeRoot(root);
  const directory = path.join(base, 'journal', clientId);
  const target = path.join(directory, `${requestId}.json`);
  assertExistingSegments(base, target);
  return { base, directory, target };
}

class ForwardingJournal {
  constructor(root, now = () => new Date(), filesystem = undefined, options = {}) {
    if (filesystem && filesystem.filesystem) { options = filesystem; filesystem = filesystem.filesystem; }
    this.root = safeRoot(root);
    this.now = now;
    this.fs = Object.freeze({ ...defaultFilesystem(), ...(filesystem || {}) });
    this.lockOptions = { ...options, filesystem: this.fs, now };
  }

  read(clientId, requestId) {
    const { target } = journalPath(this.root, clientId, requestId);
    if (!this.fs.exists(target)) return null;
    const bytes = this.fs.readFile(target);
    if (bytes.byteLength > MAX_JOURNAL_BYTES) throw new Error('Journal record exceeds limit');
    try { return validateRecord(JSON.parse(bytes.toString('utf8'))); } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Journal record is malformed');
      throw error;
    }
  }

  write(record, expectedPrevious = null) {
    const valid = validateRecord(record);
    const { base, directory, target } = journalPath(this.root, valid.clientId, valid.requestId);
    ensureDirectory(base, directory);
    const existing = this.read(valid.clientId, valid.requestId);
    if (existing && existing.state === 'terminal') throw new Error('Terminal journal record is immutable');
    if (existing && !expectedPrevious) throw new Error('Journal write requires compare-and-swap');
    if (expectedPrevious && (!existing || canonicalize(existing) !== canonicalize(expectedPrevious))) throw new Error('Stale journal record');
    if (existing && !sameBinding(existing, valid)) throw new Error('Journal binding conflict');
    durableWrite(this.fs, base, directory, target, `${JSON.stringify(valid)}\n`, valid.requestId);
    return valid;
  }

  prepare(binding) {
    const existing = this.read(binding.clientId, binding.requestId);
    if (existing) {
      if (!sameBinding(existing, binding)) throw new Error('Journal binding conflict');
      return existing;
    }
    const timestamp = this.now().toISOString();
    return this.write({
      version: JOURNAL_VERSION, ...binding, state: 'prepared', gatewayRequestId: binding.requestId,
      receiptRef: null, receiptOutcomeHash: null, publicOutcomeHash: null,
      createdAt: timestamp, updatedAt: timestamp
    });
  }

  transition(record, state, values = {}) {
    if (!STATES.has(state) || !TRANSITIONS.get(record.state).has(state)) throw new Error(`Illegal journal transition ${record.state}->${state}`);
    const next = { ...record, ...values, state, updatedAt: this.now().toISOString() };
    return this.write(next, record);
  }

  async acquireRequestLock(clientId, requestId) {
    safeId(clientId, 'clientId');
    safeRequestId(requestId);
    const lock = new DurableClaimLock(this.root, `request-${clientId}-${requestId}`, this.lockOptions);
    return (await lock.acquire()).release;
  }

  async withRequestLock(clientId, requestId, operation) {
    const release = await this.acquireRequestLock(clientId, requestId);
    try { return await operation(); } finally { await release(); }
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function launcherRangeAllows(range, version = LAUNCHER_VERSION) {
  const match = /^>=(\d+)(?:\.(\d+)(?:\.(\d+))?)? <(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(range);
  const current = parseVersion(version);
  if (!match || !current) return false;
  const lower = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
  const upper = [Number(match[4]), Number(match[5] || 0), Number(match[6] || 0)];
  return compareVersion(current, lower) >= 0 && compareVersion(current, upper) < 0;
}

function safeDiscoveryFile(root) {
  const target = path.join(root, DISCOVERY_FILE);
  assertExistingSegments(root, target);
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || hasReparsePoint(stat)) return null;
  if (process.platform === 'win32') {
    try {
      const user = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim().toLowerCase();
      const acl = `${execFileSync('icacls', [target], { encoding: 'utf8', windowsHide: true })}\n${execFileSync('icacls', [root], { encoding: 'utf8', windowsHide: true })}`.toLowerCase();
      if (!user || /\b(?:everyone|builtin\\users|nt authority\\authenticated users|authenticated users)\b/i.test(acl) || !acl.includes(user)) return null;
    } catch { return null; }
  } else if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
  return target;
}

function validDiscovery(record) {
  const expected = ['createdAt', 'expiresAt', 'instanceId', 'launcherRange', 'pid', 'port', 'protocolVersions', 'schemaVersion'];
  if (!exactKeys(record, expected)) return false;
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.instanceId !== 'string' || !UUID.test(record.instanceId) || typeof record.launcherRange !== 'string' || !launcherRangeAllows(record.launcherRange) ||
      !Array.isArray(record.protocolVersions) || record.protocolVersions.length === 0 || new Set(record.protocolVersions).size !== record.protocolVersions.length ||
      record.protocolVersions.some((version) => typeof version !== 'string' || !MCP_PROTOCOLS.has(version))) return false;
  const created = Date.parse(record.createdAt);
  const expires = Date.parse(record.expiresAt);
  return Number.isFinite(created) && Number.isFinite(expires) && new Date(created).toISOString() === record.createdAt &&
    new Date(expires).toISOString() === record.expiresAt && created <= Date.now() && created >= Date.now() - 10 * 60_000 &&
    expires > Date.now() && expires - created <= 10 * 60_000 && pidAlive(record.pid);
}

function validateJsonRpcRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.method.length < 1 || message.method.length > 128) throw new Error('Invalid JSON-RPC message');
  if (Object.hasOwn(message, 'id') && !((typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 256) || (typeof message.id === 'number' && Number.isSafeInteger(message.id)))) throw new Error('Invalid JSON-RPC id');
  if (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) throw new Error('Invalid JSON-RPC params');
}

function toolEnvelope(message) {
  if (message.method !== 'tools/call') return null;
  if (!Object.hasOwn(message, 'id')) throw new Error('MCP tool call requires a JSON-RPC id');
  if (!onlyKeys(message.params, ['name', 'arguments', '_meta'], ['name', 'arguments'])) throw new Error('MCP tool call is invalid');
  const args = message.params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP tool arguments are invalid');
  const operation = resolveLauncherOperation(args.operation);
  if (!operation || message.params.name !== operation.name) throw new Error('MCP tool identity is invalid');
  const allowed = ['apiVersion', 'kind', 'operation', 'requestId', 'idempotencyKey', 'expectedVersion', 'payload'];
  if (!Object.keys(args).every((key) => allowed.includes(key))) throw new Error('MCP tool arguments contain unsupported fields');
  if (args.apiVersion !== 1 || args.kind !== 'mcp-tool-arguments') throw new Error('MCP tool arguments are invalid');
  const envelope = {
    apiVersion: args.apiVersion,
    kind: operation.kind === 'command' ? 'agent-command' : 'agent-query',
    operation: args.operation,
    payload: args.payload,
    requestId: args.requestId,
    ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
    catalog: launcherCatalogIdentity
  };
  if (operation.kind === 'query') {
    if (args.idempotencyKey !== undefined || args.expectedVersion !== undefined) throw new Error('MCP query arguments are invalid');
    validateLauncherQueryEnvelope(envelope);
    return { operation, args, envelope, command: false };
  }
  if (args.idempotencyKey !== args.requestId) throw new Error('Launcher command idempotency is required');
  validateLauncherCommandEnvelope(envelope);
  return { operation, args, envelope, command: true };
}

function requestIdFrom(message) { return toolEnvelope(message)?.args.requestId ?? null; }
function isWrite(message) { return toolEnvelope(message)?.command === true; }
function jsonRpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function structuredOutcome(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.structuredContent !== undefined) return value.structuredContent;
  return value;
}

function mcpToolResult(outcome) {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome) }],
    structuredContent: outcome,
    isError: outcome.ok !== true
  };
}

function validateResponse(body, expectMcpOutcome = false, expectedId = undefined) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || !Object.hasOwn(body, 'id') ||
      (!Object.hasOwn(body, 'result') && !Object.hasOwn(body, 'error')) || (Object.hasOwn(body, 'result') && Object.hasOwn(body, 'error'))) throw new Error('App response is malformed');
  if (expectedId !== undefined && (typeof body.id !== typeof expectedId || body.id !== expectedId)) throw new Error('App response correlation is invalid');
  if (Object.hasOwn(body, 'result')) {
    if (expectMcpOutcome) validateLauncherMcpOutcome(structuredOutcome(body.result));
  } else if (!body.error || typeof body.error !== 'object' || Array.isArray(body.error) || !Number.isInteger(body.error.code) || typeof body.error.message !== 'string' || body.error.message.length > 500) throw new Error('App response error is malformed');
}

function validateChallenge(challenge, record, initialize, clientId) {
  const expected = ['version', 'challengeId', 'nonce', 'appInstanceId', 'clientId', 'mcpProtocolVersion', 'launcherVersion', 'audience', 'transport', 'expiresAt'];
  if (!exactKeys(challenge, expected) || challenge.version !== 'kaoyan-stdio-auth-v1' || !UUID.test(challenge.challengeId) ||
      typeof challenge.nonce !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge.nonce) || challenge.appInstanceId !== record.instanceId ||
      challenge.clientId !== clientId || challenge.mcpProtocolVersion !== initialize.params.protocolVersion || challenge.launcherVersion !== LAUNCHER_VERSION ||
      challenge.audience !== 'kaoyan-mcp-loopback' || challenge.transport !== 'stdio-bridge') throw new Error('App authentication challenge is invalid');
  const expires = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== challenge.expiresAt || expires <= Date.now() || expires > Date.now() + MAX_CHALLENGE_FUTURE_MS) throw new Error('App authentication challenge is expired');
}

class HttpBridgeClient {
  constructor(options) {
    this.options = options;
    this.session = null;
    this.initializeMessage = null;
    this.initialized = false;
  }

  async request(record, method, body, headers = {}, signal) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? null : JSON.stringify(body);
      if (encoded !== null && Buffer.byteLength(encoded) > MAX_LINE_BYTES) { reject(new Error('App request exceeds limit')); return; }
      let settled = false;
      const finish = (callback, value) => { if (!settled) { settled = true; signal?.removeEventListener('abort', abort); callback(value); } };
      const request = http.request({
        host: '127.0.0.1', port: record.port, path: '/mcp', method, timeout: this.options.timeoutMs,
        headers: { host: `127.0.0.1:${record.port}`, ...(encoded === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }), ...headers }
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          else response.destroy(new Error('App response exceeds limit'));
        });
        response.on('end', () => {
          if (bytes > MAX_RESPONSE_BYTES) return;
          let parsed = null;
          try { parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { finish(reject, new Error('App response is invalid')); return; }
          finish(resolve, { status: response.statusCode || 0, headers: response.headers, body: parsed });
        });
        response.on('aborted', () => finish(reject, new Error('App response was interrupted')));
        response.on('close', () => { if (!response.complete) finish(reject, new Error('App response was interrupted')); });
        response.on('error', (error) => finish(reject, error));
      });
      const abort = () => request.destroy(new Error('App request cancelled'));
      request.on('timeout', () => request.destroy(new Error('App request timed out')));
      request.on('error', (error) => finish(reject, error));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      request.end(encoded === null ? undefined : encoded);
    });
  }

  async post(record, body, headers = {}, signal) { return this.request(record, 'POST', body, headers, signal); }

  async handshake(record, signal) {
    const response = await this.request(record, 'GET', undefined, {}, signal).catch(() => null);
    return !!response && response.status === 401 && response.headers['mcp-instance-id'] === record.instanceId;
  }

  async authenticate(record, initialize, signal) {
    const baseHeaders = { 'x-kaoyan-client-id': this.options.clientId, 'x-kaoyan-launcher-version': LAUNCHER_VERSION };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const challenged = await this.post(record, initialize, baseHeaders, signal);
      const challenge = challenged.body?.error?.data?.challenge;
      if (challenged.status !== 401 || !challenge) throw new Error('App did not issue an authentication challenge');
      validateChallenge(challenge, record, initialize, this.options.clientId);
      let signature;
      try {
        signature = await this.options.keyLifecycle.sign(this.options.keyName, Buffer.from(canonicalize(challenge), 'utf8').toString('base64url'));
      } catch (error) {
        if (attempt === 0 && !signal?.aborted) continue;
        throw error;
      }
      const admitted = await this.post(record, initialize, { ...baseHeaders, 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': signature }, signal);
      const sessionId = admitted.headers['mcp-session-id'];
      if (admitted.status === 200 && typeof sessionId === 'string' && UUID.test(sessionId)) {
        this.session = { instanceId: record.instanceId, protocolVersion: initialize.params.protocolVersion, sessionId };
        this.initializeMessage = JSON.parse(JSON.stringify(initialize));
        this.initialized = false;
        return admitted.body;
      }
      if (attempt === 1) throw new Error('App rejected launcher authentication');
    }
    throw new Error('App rejected launcher authentication');
  }

  sessionHeaders() {
    if (!this.session) throw new Error('MCP session is not initialized');
    return { 'mcp-session-id': this.session.sessionId, 'mcp-protocol-version': this.session.protocolVersion };
  }

  async ensureSession(record, signal) {
    if (this.session?.instanceId === record.instanceId) return;
    if (!this.initializeMessage) throw new Error('MCP session is not initialized');
    await this.authenticate(record, this.initializeMessage, signal);
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const response = await this.post(record, initialized, this.sessionHeaders(), signal);
    if (response.status !== 202 && response.status !== 204) throw new Error('App session initialization failed');
    this.initialized = true;
  }

  async forward(record, message, signal) {
    if (message.method === 'initialize') return { status: 200, body: await this.authenticate(record, message, signal) };
    await this.ensureSession(record, signal);
    let response = await this.post(record, message, this.sessionHeaders(), signal);
    if (response.status === 401 && this.initializeMessage) {
      this.session = null;
      await this.ensureSession(record, signal);
      response = await this.post(record, message, this.sessionHeaders(), signal);
    }
    if (message.method === 'notifications/initialized' && (response.status === 202 || response.status === 204)) this.initialized = true;
    return response;
  }

  async lookup(record, binding, signal) {
    await this.ensureSession(record, signal);
    const message = { jsonrpc: '2.0', id: `receipt-${binding.requestId}`, method: 'agent.receipts.get_status', params: { clientId: binding.clientId, requestId: binding.requestId } };
    const headers = { ...this.sessionHeaders(), 'x-kaoyan-receipt-projection': 'mcp-v1' };
    let response = await this.post(record, message, headers, signal);
    if (response.status === 401 && this.initializeMessage) {
      this.session = null;
      await this.ensureSession(record, signal);
      response = await this.post(record, message, { ...this.sessionHeaders(), 'x-kaoyan-receipt-projection': 'mcp-v1' }, signal);
    }
    return response;
  }
}

function validatedAppPath(appPath) {
  if (typeof appPath !== 'string' || !path.isAbsolute(appPath) || !fs.existsSync(appPath)) throw new Error('Kaoyan App path is invalid');
  const stat = fs.lstatSync(appPath);
  if (!stat.isFile() || hasReparsePoint(stat)) throw new Error('Kaoyan App path is unsafe');
  return fs.realpathSync.native(appPath);
}

class Launcher {
  constructor(options) {
    this.options = options;
    this.journal = new ForwardingJournal(options.journalRoot, options.now, options.filesystem, options);
    this.bridge = options.bridge || new HttpBridgeClient(options);
    this.stderrBytes = 0;
    this.closing = false;
    this.terminalResults = new Map();
    this.inFlightControllers = new Map();
    this.toolResultFormat = false;
    this.outputChain = Promise.resolve();
    this.stderr = options.stderr || process.stderr;
    this.stdout = options.stdout || process.stdout;
  }

  diagnostic(code) {
    const safe = new Set(['request_failed', 'journal_recovery_failed', 'startup_failed', 'protocol_input_rejected', 'authentication_failed',
      'authentication_challenge_invalid', 'authentication_challenge_expired', 'authentication_signing_failed', 'response_invalid', 'session_failed', 'shutdown']);
    const line = `kaoyan-mcp: ${safe.has(code) ? code : 'request_failed'}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.stderrBytes + bytes <= MAX_STDERR_BYTES) { this.stderrBytes += bytes; this.stderr.write(line); }
  }

  async discovery(signal) {
    const root = safeRoot(this.options.discoveryRoot);
    const target = safeDiscoveryFile(root);
    if (!target) return null;
    const bytes = fs.readFileSync(target);
    if (bytes.byteLength > 8 * 1024) return null;
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { return null; }
    if (!validDiscovery(record)) return null;
    return await this.bridge.handshake(record, signal) ? Object.freeze(record) : null;
  }

  async ensureApp(signal) {
    let record = await this.discovery(signal);
    if (record) return record;
    if (!this.options.appPath) {
      const deadline = Date.now() + Math.min(this.options.startupTimeoutMs, 1_000);
      while (Date.now() < deadline && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        record = await this.discovery(signal);
        if (record) return record;
      }
      throw new Error('Kaoyan App is unavailable');
    }
    const root = safeRoot(this.options.discoveryRoot);
    const lock = new DurableClaimLock(root, 'app-startup', { ...this.options, filesystem: this.options.filesystem, now: this.options.now });
    const acquired = await lock.acquire(() => this.discovery(signal));
    if (acquired.observed) return acquired.observed;
    try {
      record = await this.discovery(signal);
      if (record) return record;
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = (this.options.spawn || spawn)(validatedAppPath(this.options.appPath), ['--agent-startup'], { detached: true, stdio: 'ignore', windowsHide: true, env: environment });
      child.unref();
      const deadline = Date.now() + this.options.startupTimeoutMs;
      while (Date.now() < deadline && !signal?.aborted) {
        record = await this.discovery(signal);
        if (record) return record;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Kaoyan App startup timed out');
    } finally { await acquired.release(); }
  }

  bindingFor(envelope) {
    return Object.freeze({
      clientId: this.options.clientId,
      requestId: envelope.requestId,
      gatewayRequestId: envelope.requestId,
      operation: envelope.operation,
      operationKind: 'command',
      payloadHash: hash(envelope.payload),
      catalogVersion: envelope.catalog.version,
      catalogHash: envelope.catalog.hash,
      envelopeHash: hash(envelope),
      bindingHash: hash({ clientId: this.options.clientId, requestId: envelope.requestId, operation: envelope.operation, envelope })
    });
  }

  async handle(message, signal) {
    const parsed = toolEnvelope(message);
    const record = await this.ensureApp(signal);
    if (!parsed || !parsed.command) return this.forward(record, message, signal);
    const requestId = safeRequestId(parsed.envelope.requestId);
    const binding = this.bindingFor(parsed.envelope);
    return this.journal.withRequestLock(this.options.clientId, requestId, async () => {
      let journal = this.journal.prepare(binding);
      if (journal.state === 'terminal') {
        const cached = this.terminalResults.get(requestId);
        if (cached && cached.publicOutcomeHash === journal.publicOutcomeHash) return { ...cached.body, id: message.id ?? null };
        return this.resolveReceipt(await this.ensureApp(signal), journal, binding, message.id, signal);
      }
      if (journal.state === 'forwarded' || journal.state === 'needs_lookup') return this.resolveReceipt(await this.ensureApp(signal), journal, binding, message.id, signal);
      journal = this.journal.transition(journal, 'forwarded');
      try {
        const response = await this.bridge.forward(record, message, signal);
        if (response.status < 200 || response.status >= 300 || !response.body) throw new Error('App command response is uncertain');
        validateResponse(response.body, true, message.id);
        if (response.body.error) throw new Error('App command response is not a terminal tool outcome');
        const publicResult = response.body.result;
        if (publicResult && typeof publicResult === 'object' && !Array.isArray(publicResult) && publicResult.structuredContent !== undefined) this.toolResultFormat = true;
        const outcome = structuredOutcome(publicResult);
        if (outcome.ok === true && (outcome.operation !== binding.operation || outcome.requestId !== binding.requestId)) throw new Error('App command outcome binding is invalid');
        if (outcome.ok !== true) {
          journal = this.journal.transition(journal, 'terminal', { publicOutcomeHash: hash(publicResult) });
          return { ...response.body, id: message.id ?? null };
        }
        const publicOutcomeHash = hash(publicResult);
        journal = this.journal.transition(journal, 'needs_lookup');
        return await this.resolveReceipt(await this.ensureApp(signal), journal, binding, message.id, signal, outcome, publicOutcomeHash, publicResult !== outcome);
      } catch (error) {
        let recovery = null;
        try {
          const current = this.journal.read(binding.clientId, binding.requestId);
          const lookupState = current?.state === 'forwarded' ? this.journal.transition(current, 'needs_lookup') : current;
          if (lookupState && (lookupState.state === 'needs_lookup' || lookupState.state === 'terminal')) {
            recovery = await this.resolveReceipt(await this.ensureApp(signal), lookupState, binding, message.id, signal);
          }
        } catch { this.diagnostic('journal_recovery_failed'); }
        if (recovery) return recovery;
        throw error;
      }
    });
  }

  async resolveReceipt(record, journal, binding, callerId, signal, expectedOutcome = undefined, expectedPublicOutcomeHash = undefined, wrapToolResult = undefined) {
    const lookup = await this.bridge.lookup(record, binding, signal);
    if (!lookup || lookup.status < 200 || lookup.status >= 300 || !lookup.body) throw new Error('Receipt outcome is unavailable');
    validateResponse(lookup.body, false, `receipt-${binding.requestId}`);
    const projection = lookup.body.result?.kind === 'mcp-receipt-projection' ? lookup.body.result : null;
    if (projection && (Object.keys(projection).some((key) => !['kind', 'receipt', 'publicOutcome'].includes(key)) ||
        !projection.receipt || (projection.publicOutcome !== undefined && (!projection.publicOutcome || typeof projection.publicOutcome !== 'object' || Array.isArray(projection.publicOutcome))))) {
      throw new Error('Receipt projection is invalid');
    }
    const receiptResponse = projection?.receipt ?? (lookup.body.result?.kind === 'receipt-status' ? lookup.body.result : lookup.body.result?.data);
    try { validateLauncherReceiptStatus(receiptResponse); } catch { throw new Error('Receipt outcome is invalid'); }
    if (receiptResponse.clientId !== binding.clientId || receiptResponse.requestId !== binding.requestId || receiptResponse.receipt.operation !== binding.operation ||
        receiptResponse.receipt.payloadHash !== binding.payloadHash || receiptResponse.receipt.catalog.version !== binding.catalogVersion ||
        receiptResponse.receipt.catalog.hash !== binding.catalogHash) throw new Error('Receipt binding conflict');
    const evidence = extractLauncherTerminalEvidence(receiptResponse);
    if (!evidence) return jsonRpcError(callerId, -32001, `Receipt is ${receiptResponse.status}; redispatch is disabled`);
    const receiptOutcomeHash = hash(evidence.hashSubject);
    if (receiptResponse.receipt.outcomeHash !== receiptOutcomeHash) throw new Error('Receipt outcome hash mismatch');
    const outcome = projection?.publicOutcome ?? mapGatewayTerminalToMcpOutcome(binding.operation, binding.requestId, evidence.terminal);
    validateLauncherMcpOutcome(outcome);
    if (outcome.ok === true && (outcome.operation !== binding.operation || outcome.requestId !== binding.requestId)) throw new Error('Receipt projection binding conflict');
    const directResult = outcome;
    const structuredResult = mcpToolResult(outcome);
    const directHash = hash(directResult);
    const structuredHash = hash(structuredResult);
    const publicResult = wrapToolResult === true
      ? structuredResult
      : wrapToolResult === false
        ? directResult
        : journal.publicOutcomeHash === structuredHash || expectedPublicOutcomeHash === structuredHash
          ? structuredResult
          : journal.publicOutcomeHash === directHash || expectedPublicOutcomeHash === directHash
            ? directResult
            : this.toolResultFormat ? structuredResult : directResult;
    const publicOutcomeHash = hash(publicResult);
    if (expectedOutcome !== undefined && canonicalize(expectedOutcome) !== canonicalize(outcome)) throw new Error('Receipt public outcome mismatch');
    if (expectedPublicOutcomeHash !== undefined && expectedPublicOutcomeHash !== publicOutcomeHash) throw new Error('Receipt public outcome hash mismatch');
    if (journal.publicOutcomeHash !== null && journal.publicOutcomeHash !== publicOutcomeHash) throw new Error('Journal public outcome hash mismatch');
    if (journal.receiptOutcomeHash !== null && journal.receiptOutcomeHash !== receiptOutcomeHash) throw new Error('Journal receipt outcome hash mismatch');
    if (journal.state !== 'terminal') {
      journal = this.journal.transition(journal, 'terminal', { publicOutcomeHash, receiptOutcomeHash, receiptRef: receiptResponse.receipt.receiptId });
    }
    const replay = { jsonrpc: '2.0', id: callerId ?? null, result: publicResult };
    this.terminalResults.set(binding.requestId, { body: replay, publicOutcomeHash });
    return replay;
  }

  async forward(record, message, signal) {
    const response = await this.bridge.forward(record, message, signal);
    if (response.status === 202 || response.status === 204) return null;
    if (response.status === 401) throw new Error('App session was rejected');
    if (response.status === 501) return response.body || jsonRpcError(message.id, -32601, 'MCP capability is not available');
    if (message.id !== undefined) {
      validateResponse(response.body, message.method === 'tools/call', message.id);
      return { ...response.body, id: message.id };
    }
    return null;
  }

  cancelRequest(id) {
    const controller = this.inFlightControllers.get(`${typeof id}:${String(id)}`);
    if (controller) controller.abort();
  }

  emit(message) {
    const encoded = `${JSON.stringify(message)}\n`;
    if (this.stdout === process.stdout) {
      fs.writeSync(1, encoded, null, 'utf8');
      return Promise.resolve();
    }
    this.outputChain = this.outputChain.then(() => new Promise((resolve, reject) => {
      try {
        if (Number.isInteger(this.stdout.fd)) {
          fs.writeSync(this.stdout.fd, encoded, null, 'utf8');
          resolve();
          return;
        }
        const accepted = this.stdout.write(encoded);
        if (accepted !== false) resolve();
        else {
          this.stdout.once('drain', resolve);
          this.stdout.once('error', reject);
        }
      } catch (error) { reject(error); }
    }));
    return this.outputChain;
  }

  async processLine(line) {
    if (line === null) { await this.emit(jsonRpcError(null, -32600, 'JSON-RPC line exceeds limit')); return; }
    let message;
    try {
      message = JSON.parse(line);
      validateJsonRpcRequest(message);
    } catch {
      await this.emit(jsonRpcError(null, -32700, 'Invalid JSON-RPC message'));
      return;
    }
    if (message.method === 'notifications/cancelled' && message.params && Object.hasOwn(message.params, 'requestId')) this.cancelRequest(message.params.requestId);
    const controller = new AbortController();
    const key = message.id === undefined ? null : `${typeof message.id}:${String(message.id)}`;
    if (key) this.inFlightControllers.set(key, controller);
    try {
      const result = await this.handle(message, controller.signal);
      if (message.id !== undefined && result) await this.emit(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      const diagnostic = /authentication challenge is invalid/.test(errorMessage)
        ? 'authentication_challenge_invalid'
        : /authentication challenge is expired/.test(errorMessage)
          ? 'authentication_challenge_expired'
          : /CNG operation failed/.test(errorMessage)
            ? 'authentication_signing_failed'
            : /authentication challenge|rejected launcher authentication/.test(errorMessage)
              ? 'authentication_failed'
        : /response|outcome/.test(errorMessage)
          ? 'response_invalid'
          : /session/.test(errorMessage)
            ? 'session_failed'
            : 'request_failed';
      this.diagnostic(diagnostic);
      if (message.id !== undefined) {
        const failure = jsonRpcError(message.id, -32000, 'Kaoyan MCP bridge unavailable');
        await this.emit(failure);
      }
    } finally {
      if (key && this.inFlightControllers.get(key) === controller) this.inFlightControllers.delete(key);
    }
  }

  async run(input = process.stdin) {
    const inFlight = new Set();
    const shutdown = () => {
      if (this.closing) return;
      this.closing = true;
      for (const controller of this.inFlightControllers.values()) controller.abort();
      input.pause?.();
      input.destroy?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      for await (const line of boundedLines(input, MAX_LINE_BYTES)) {
        if (this.closing) break;
        while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
        const task = this.processLine(line).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      await Promise.allSettled(inFlight);
      await this.outputChain;
    } finally {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    }
  }
}

async function* boundedLines(input, maximum) {
  let segments = [];
  let bytes = 0;
  let discarding = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      let segment = chunk.subarray(start, index);
      if (!discarding && bytes + segment.length <= maximum) {
        segments.push(segment);
        bytes += segment.length;
      } else discarding = true;
      if (discarding) yield null;
      else {
        let line = Buffer.concat(segments, bytes);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        try { yield decoder.decode(line); } catch { yield ''; }
      }
      segments = [];
      bytes = 0;
      discarding = false;
      start = index + 1;
    }
    const tail = chunk.subarray(start);
    if (!discarding && bytes + tail.length <= maximum) { segments.push(tail); bytes += tail.length; }
    else discarding = true;
  }
  if (discarding) yield null;
  else if (bytes > 0) {
    try { yield decoder.decode(Buffer.concat(segments, bytes)); } catch { yield ''; }
  }
}

function parseArguments(argumentsList) {
  const allowed = new Set(['client-id', 'key-name', 'discovery-root', 'journal-root', 'app-path', 'startup-timeout-ms', 'timeout-ms']);
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith('--') || value === undefined || !allowed.has(key.slice(2)) || Object.hasOwn(values, key.slice(2))) throw new Error('Invalid launcher arguments');
    values[key.slice(2)] = value;
  }
  return values;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${field}`);
  return result;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  for (const key of ['client-id', 'key-name', 'discovery-root', 'journal-root']) if (!values[key]) throw new Error('Missing required launcher argument');
  const launcher = new Launcher({
    clientId: safeId(values['client-id'], 'clientId'), keyName: values['key-name'], discoveryRoot: values['discovery-root'], journalRoot: values['journal-root'],
    appPath: values['app-path'], startupTimeoutMs: boundedInteger(values['startup-timeout-ms'], 20_000, 100, 120_000, 'startup timeout'),
    timeoutMs: boundedInteger(values['timeout-ms'], 10_000, 100, 60_000, 'request timeout'), keyLifecycle: new WindowsCngKeyLifecycle()
  });
  await launcher.run();
}

async function pairingControl(argumentsList) {
  if (argumentsList.length !== 3 || !['create', 'get', 'delete'].includes(argumentsList[0]) || argumentsList[1] !== '--key-name') throw new Error('Invalid pairing control arguments');
  const operation = argumentsList[0];
  const keyName = argumentsList[2];
  const lifecycle = new WindowsCngKeyLifecycle();
  if (operation === 'delete') {
    await lifecycle.delete(keyName);
    return Object.freeze({ version: 1, kind: 'cng-key-deleted', keyName });
  }
  const binding = operation === 'create' ? await lifecycle.create(keyName) : await lifecycle.get(keyName);
  return Object.freeze({ version: 1, kind: 'cng-public-key-binding', ...binding });
}

if (require.main === module) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === '--pairing-control') {
    pairingControl(argumentsList.slice(1)).then((binding) => {
      process.stdout.write(`${JSON.stringify(binding)}\n`);
    }).catch(() => { process.stderr.write('kaoyan-mcp: pairing_control_failed\n'); process.exitCode = 1; });
  } else if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
    process.stdout.write(`{"ok":true,"kind":"kaoyan-mcp-self-test-v1","launcherVersion":"${LAUNCHER_VERSION}"}\n`);
  } else {
    main().catch(() => { process.stderr.write('kaoyan-mcp: startup_failed\n'); process.exitCode = 1; });
  }
}

module.exports = {
  DurableClaimLock, ForwardingJournal, HttpBridgeClient, JOURNAL_VERSION, LAUNCHER_VERSION, Launcher, STATES,
  boundedLines, canonicalize, hash, isWrite, launcherRangeAllows, pairingControl, requestIdFrom, safeRoot, toolEnvelope, validateRecord
};
