const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { assertSafeDescendant, assertSafeTempRoot } = require('./spikeSafety.cjs');

const JOURNAL_VERSION = 1;
const JOURNAL_STATES = new Set(['prepared', 'forwarded', 'needs_lookup', 'terminal']);

class InjectedCrash extends Error {
  constructor(phase) {
    super(`injected journal crash at ${phase}`);
    this.name = 'InjectedCrash';
  }
}

function recordPath(root, requestId) {
  const safeRoot = assertSafeTempRoot(root);
  assert.match(requestId, /^[A-Za-z0-9_-]{1,128}$/, 'requestId must be a bounded filename-safe identifier');
  return assertSafeDescendant(safeRoot, path.join(safeRoot, 'journal', `${requestId}.json`), { allowMissing: true });
}

function validateRecord(record) {
  assert.equal(record?.version, JOURNAL_VERSION, 'unsupported journal version');
  assert.equal(typeof record.clientId, 'string');
  assert.match(record.clientId, /^[A-Za-z0-9_-]{1,128}$/, 'invalid clientId');
  assert.match(record.requestId, /^[A-Za-z0-9_-]{1,128}$/, 'invalid requestId');
  assert.match(record.operation, /^[A-Za-z0-9._-]{1,160}$/, 'invalid operation');
  assert.match(record.payloadHash, /^[a-f0-9]{64}$/, 'invalid payload hash');
  assert.equal(JOURNAL_STATES.has(record.state), true, 'invalid journal state');
  return record;
}

function sameBinding(left, right) {
  return left.clientId === right.clientId && left.requestId === right.requestId &&
    left.operation === right.operation && left.payloadHash === right.payloadHash;
}

function flushDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) throw error;
  }
}

function writeRecord(root, record, { faultAt } = {}) {
  const valid = validateRecord({ ...record });
  const target = recordPath(root, valid.requestId);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  assertSafeDescendant(root, directory);
  assertSafeDescendant(root, target, { allowMissing: true });
  if (fs.existsSync(target)) {
    const existing = validateRecord(JSON.parse(fs.readFileSync(target, 'utf8')));
    assert.equal(sameBinding(existing, valid), true, 'journal binding mismatch');
  }
  const temp = path.join(directory, `.${valid.requestId}.${process.pid}.${crypto.randomUUID()}.tmp`);
  if (faultAt === 'before_temp_write') throw new InjectedCrash(faultAt);
  const descriptor = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(valid), 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (faultAt === 'after_temp_flush') throw new InjectedCrash(faultAt);
  fs.renameSync(temp, target);
  flushDirectory(directory);
  if (faultAt === 'after_replace') throw new InjectedCrash(faultAt);
  return target;
}

function recoverJournal(root, { maxTempFiles = 32 } = {}) {
  const safeRoot = assertSafeTempRoot(root);
  const directory = path.join(safeRoot, 'journal');
  if (!fs.existsSync(directory)) return { removedTemps: 0, records: [] };
  assertSafeDescendant(safeRoot, directory);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const tempEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'));
  assert.equal(tempEntries.length <= maxTempFiles, true, 'journal temp cleanup bound exceeded');
  for (const entry of tempEntries) fs.unlinkSync(path.join(directory, entry.name));
  const records = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => validateRecord(JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'))));
  return { removedTemps: tempEntries.length, records };
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function recover(record, receipt) {
  validateRecord(record);
  if (record.state === 'prepared') return { action: 'forward_once' };
  if (record.state === 'forwarded' || record.state === 'needs_lookup') {
    if (!receipt) return { action: 'needs_lookup' };
    if (receipt.payloadHash !== record.payloadHash) return { action: 'conflict' };
    return { action: 'replay_receipt', outcomeHash: receipt.outcomeHash };
  }
  if (record.state === 'terminal') return { action: 'return_cached', outcomeHash: record.outcomeHash };
  throw new Error(`unknown journal state: ${record.state}`);
}

function runStdio() {
  const root = process.env.KAOYAN_C0_ROOT;
  if (root) assertSafeTempRoot(root);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    try {
      const request = JSON.parse(line);
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })}\n`);
      process.stderr.write('kaoyan-c0 diagnostic\n');
    } catch (error) {
      process.stderr.write(`kaoyan-c0 parse failure: ${error.message}\n`);
    }
  });
}

if (require.main === module) runStdio();

module.exports = { InjectedCrash, JOURNAL_VERSION, payloadHash, recover, recoverJournal, writeRecord };
