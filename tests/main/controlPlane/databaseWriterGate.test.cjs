const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const mainRoot = path.join(projectRoot, 'src/main');

function productionFiles(root = mainRoot) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files.sort();
}

function relative(file) {
  return path.relative(projectRoot, file).replaceAll(path.sep, '/');
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function matchingClose(source, openIndex) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const open = source[openIndex];
  const close = pairs[open];
  let depth = 1;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (character === '\\') { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === open) depth += 1;
    if (character === close && --depth === 0) return index;
  }
  return -1;
}

function invocationRanges(source, pattern) {
  const ranges = [];
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf('(', match.index);
    const end = matchingClose(source, open);
    if (end >= 0) ranges.push({ start: match.index, end });
  }
  return ranges;
}

function inRanges(index, ranges) {
  return ranges.some((range) => index >= range.start && index <= range.end);
}

function functionRange(source, marker, endMarker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const end = endMarker ? source.indexOf(endMarker, start + marker.length) : source.length;
  return { start, end: end < 0 ? source.length : end };
}

function inRange(index, range) {
  return range && index >= range.start && index < range.end;
}

function scopeName(source, index) {
  const before = source.slice(0, index);
  const declarations = [...before.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:export\s+)?class\s+(\w+)/g)];
  const latest = declarations.at(-1);
  return latest ? latest[1] || latest[2] : '<module>';
}

function enclosingFunctionBody(source, index) {
  const name = scopeName(source, index);
  if (name === '<module>') return '';
  const start = source.lastIndexOf(`function ${name}`, index);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  const close = matchingClose(source, open);
  if (close >= index) return source.slice(start, close + 1);
  const remainder = source.slice(index);
  const nextExport = remainder.search(/\nexport\s+(?:async\s+)?function\s+/);
  return source.slice(start, nextExport < 0 ? source.length : index + nextExport);
}

function isProvenReadOnlyBody(body) {
  if (!body) return false;
  return !/\b(?:database|db)\.run\s*\(/.test(body)
    && !/\b(?:runSql|mutateSql)\s*\(\s*(?:database|db)\b/.test(body)
    && !/\bpersistDatabase\s*\(/.test(body);
}

function isVerifiedReadSqlCall(source, index) {
  const open = source.indexOf('(', index);
  const close = matchingClose(source, open);
  if (open < 0 || close < 0) return false;
  const argument = source.slice(open + 1, close);
  return /\b(?:SELECT|PRAGMA\s+(?:quick_check|foreign_key_check|table_info))\b/i.test(argument)
    && !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(argument);
}

function isCommentMatch(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const linePrefix = source.slice(lineStart, index);
  return linePrefix.includes('//');
}

function scanMutableAcquisitions() {
  const findings = [];
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const name = relative(file);
    for (const match of source.matchAll(/\bgetDatabase\s*\(/g)) {
      if (isCommentMatch(source, match.index)) continue;
      if (/function\s+$/.test(source.slice(Math.max(0, match.index - 30), match.index))) continue;
      const scope = scopeName(source, match.index);
      const readOnly = new Set([
        'listImportBatches', 'getImportBatchDetail',
        'listKnowledgeTree', 'getKnowledgePointReviewStats', 'listKnowledgeReviewStats', 'getKnowledgeReviewQuestions',
        'getKnowledgeDetail', 'listKnowledgeForQuestion', 'bindTextbookPdf', 'rematchKnowledgePoints',
        'listExternalQuestions', 'getExternalQuestion', 'getExternalQuestionStats',
        'aiDecomposeTask', 'aiGenerateDailyPlan', 'aiGenerateReview'
      ]);
      const classification = readOnly.has(scope)
        ? (isProvenReadOnlyBody(enclosingFunctionBody(source, match.index)) ? 'body-proven read-only acquisition' : null)
        : name === 'src/main/services/importBatchService.ts' && scope === 'createImportBatch'
          ? 'unreferenced compatibility writer definition'
          : null;
      findings.push({ file: name, line: lineAt(source, match.index), scope, classification });
    }
  }
  return findings;
}

function scanPersistence() {
  const occurrences = [];
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bpersistDatabase\s*\(/g)) {
      const definition = /export\s+function\s+$/.test(source.slice(Math.max(0, match.index - 40), match.index));
      occurrences.push({ file: relative(file), line: lineAt(source, match.index), classification: definition ? 'unused compatibility export definition' : null });
    }
  }
  return occurrences;
}

function scanTransactionsAndMutators() {
  const occurrences = [];
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const name = relative(file);
    const coordinatorRanges = [
      ...invocationRanges(source, /\bexecuteLegacyMutation\s*\(/g),
      ...invocationRanges(source, /\.executeWrite\s*\(/g),
      ...invocationRanges(source, /\bexecuteWriteWithVerifiedSnapshot\s*\(/g),
      ...(name === 'src/main/agent/bootstrap.ts' ? invocationRanges(source, /\bexecuteControlWrite\s*\(/g) : [])
    ];
    const agentRegistryControlRanges = name === 'src/main/agent/clientRegistry.ts'
      ? invocationRanges(source, /\bthis\.write\s*\(/g)
      : [];
    const bootstrapRanges = name === 'src/main/services/databaseService.ts'
      ? [functionRange(source, 'async function initializeDatabaseOnce(', 'function migrateDatabase('), functionRange(source, 'function migrateDatabase(', 'export function runSql(')]
      : [];
    const replacementRanges = name === 'src/main/services/databaseService.ts'
      ? [
          functionRange(source, 'async function replaceDatabaseIdentity', 'export async function exportData('),
          functionRange(source, 'export async function importData(', 'export async function createVerifiedDatabaseSnapshot('),
          functionRange(source, 'export async function restoreDatabaseFromFile(', 'export interface DataRootSwitchDependencies'),
          functionRange(source, 'export async function switchDataRoot(', 'export function resetDatabaseConnection(')
        ]
      : [];
    const repositoryScoped = name === 'src/main/application/questions/questionRepository.ts'
      && /assertDatabaseMutationScope\(this\.scope, this\.database\)/.test(source);
    const capabilityFiles = new Set([
      'src/main/persistence/databaseCoordinator.ts',
      'src/main/persistence/revisionStore.ts'
    ]);
    const candidateFiles = new Set([
      'src/main/persistence/databaseCandidate.ts',
      'src/main/persistence/databaseBootstrap.ts'
    ]);
    const agentDurabilityFiles = new Set([
      'src/main/agent/auditLedger.ts',
      'src/main/agent/executionReceipts.ts',
      'src/main/agent/idempotencyStore.ts',
      'src/main/agent/jobStore.ts',
      'src/main/agent/sqlRows.ts',
      'src/main/agent/workflows.ts'
    ]);
    for (const match of source.matchAll(/\.(run|exec|prepare)\s*\(|\b(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|ROLLBACK)\b/g)) {
      const token = match[0];
      let classification = null;
      if (inRanges(match.index, coordinatorRanges)) classification = 'coordinator invocation scope';
      else if (inRanges(match.index, agentRegistryControlRanges)) classification = 'coordinator control invocation scope';
      else if (bootstrapRanges.some((range) => inRange(match.index, range))) classification = 'database bootstrap/migration';
      else if (replacementRanges.some((range) => inRange(match.index, range))) classification = 'coordinator-fenced identity replacement';
      else if (repositoryScoped) classification = 'capability-scoped question repository';
      else if (name === 'src/main/application/knowledge/commands.ts' && /assertDatabaseMutationScope\(scope, database\)/.test(source)) classification = 'capability-scoped knowledge application';
      else if (name === 'src/main/application/study/commands.ts' && /assertDatabaseMutationScope\(scope, database\)/.test(source)) classification = 'capability-scoped study application';
      else if (capabilityFiles.has(name)) classification = 'coordinator transaction/revision primitive';
      else if (candidateFiles.has(name)) classification = 'bootstrap/candidate validation';
      else if (name === 'src/main/database/schema.ts') classification = 'database bootstrap/migration schema';
      else if (agentDurabilityFiles.has(name) && scopeName(source, match.index) === 'one') classification = 'control ledger read helper';
      else if (agentDurabilityFiles.has(name) && scopeName(source, match.index) === 'all') classification = 'control ledger read helper';
      else if (
        agentDurabilityFiles.has(name) &&
        /assertDatabaseMutationScope\(/.test(source) &&
        (name === 'src/main/agent/executionReceipts.ts' || /executeControlWrite/.test(source))
      ) classification = 'coordinator-scoped agent durability collaborator';
      else if (name === 'src/main/services/bridgeService.ts' && scopeName(source, match.index) === 'getOrCreateDefaultList') classification = 'coordinator-only bridge helper';
      else if (name === 'src/main/services/studySupervisorService.ts' && scopeName(source, match.index) === 'ensureColumn') classification = 'coordinator-only study bootstrap helper';
      else if (name === 'src/main/services/questionBankService.ts' && scopeName(source, match.index) === 'extractMarkdownImageRefs') continue;
      else if (name === 'src/main/application/queryBus.ts' && scopeName(source, match.index) === 'createReadOnlyDatabaseFacade') classification = 'validated read-only query facade';
      else if (name === 'src/main/agent/clientRegistry.ts' && ['one', 'all'].includes(scopeName(source, match.index))
        && isProvenReadOnlyBody(enclosingFunctionBody(source, match.index))) classification = 'control registry read helper';
      else if (name === 'src/main/agent/clientRegistry.ts' && scopeName(source, match.index) === 'ClientRegistry'
        && /assertDatabaseMutationScope\(/.test(source)) classification = 'coordinator-scoped registry mutation seam';
      else if (['src/main/services/importBatchService.ts', 'src/main/services/knowledgeMapService.ts', 'src/main/services/questionBankService.ts'].includes(name)
        && scopeName(source, match.index) === 'mutateSql') classification = 'scope-asserting mutation helper';
      else if (/\b(?:operationJournal|journal)\.prepare\s*\(/.test(source.slice(Math.max(0, match.index - 30), match.index + 9))) continue;
      else if (/\.(?:exec|prepare)\s*\(/.test(token) && isVerifiedReadSqlCall(source, match.index)) classification = 'verified read-only database SQL call';
      occurrences.push({ file: name, line: lineAt(source, match.index), token, scope: scopeName(source, match.index), classification });
    }
  }
  return occurrences;
}

function scanDirectHelpers() {
  const findings = [];
  const helpers = ['runSql', 'mutateSql'];
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const name = relative(file);
    const coordinatorRanges = [
      ...invocationRanges(source, /\bexecuteLegacyMutation\s*\(/g),
      ...invocationRanges(source, /\.executeWrite\s*\(/g),
      ...invocationRanges(source, /\bexecuteWriteWithVerifiedSnapshot\s*\(/g)
    ];
    for (const helper of helpers) {
      const pattern = new RegExp(`\\b${helper}\\s*\\(`, 'g');
      for (const match of source.matchAll(pattern)) {
        const definition = /function\s+$/.test(source.slice(Math.max(0, match.index - 50), match.index));
        let classification = null;
        if (definition && helper === 'runSql' && name === 'src/main/services/databaseService.ts') classification = 'compatibility helper definition';
        else if (definition && helper === 'mutateSql') classification = 'scope-asserting helper definition';
        else if (inRanges(match.index, coordinatorRanges)) classification = 'coordinator invocation helper call';
        else if (name === 'src/main/services/importBatchService.ts' && ['createImportBatch', 'recordImportBatchItem', 'recordImportAsset', 'finalizeImportBatch'].includes(scopeName(source, match.index))) classification = 'unreferenced compatibility writer definition';
        else if (name === 'src/main/services/knowledgeMapService.ts' && ['upsertTextbook', 'upsertKnowledgePoint', 'createKnowledgeImportBatch', 'recordKnowledgeImportItem', 'recordKnowledgeImportAsset', 'finalizeKnowledgeImportBatch'].includes(scopeName(source, match.index))) classification = 'scope-propagating coordinator helper';
        else if (name === 'src/main/services/questionBankService.ts' && ['recordImportAssetMutation', 'recordImportBatchItemMutation', 'finalizeImportBatchMutation', 'createImportBatchMutation'].includes(scopeName(source, match.index))) classification = 'scope-propagating coordinator helper';
        else if (['src/main/services/studySupervisorService.ts', 'src/main/services/ticktickService.ts'].includes(name) && scopeName(source, match.index) === 'runMutation') classification = 'coordinator-only legacy mutation helper';
        findings.push({ file: name, line: lineAt(source, match.index), helper, scope: scopeName(source, match.index), classification });
      }
    }
  }
  return findings;
}

test('raw persistence has only its separately classified compatibility definition', () => {
  const occurrences = scanPersistence();
  assert.deepEqual(occurrences, [{
    file: 'src/main/services/databaseService.ts',
    line: 242,
    classification: 'unused compatibility export definition'
  }]);
});

test('mutable database acquisition is confined to evidence-backed reads', () => {
  const findings = scanMutableAcquisitions();
  const unclassified = findings.filter((entry) => !entry.classification);
  assert.deepEqual(unclassified, [], `Mutable getDatabase acquisition outside a read-only scope:\n${JSON.stringify(unclassified, null, 2)}`);
  assert.equal(findings.length, 17);
});

test('transactions and direct database mutators are bootstrap, replacement, or coordinator-contained', () => {
  const occurrences = scanTransactionsAndMutators();
  const unclassified = occurrences.filter((entry) => !entry.classification);
  assert.deepEqual(unclassified, [], `Uncontained database mutators:\n${JSON.stringify(unclassified, null, 2)}`);
  const counts = Object.fromEntries([...new Set(occurrences.map((entry) => entry.classification))].sort().map((classification) => [
    classification,
    occurrences.filter((entry) => entry.classification === classification).length
  ]));
  assert.deepEqual(counts, {
    'bootstrap/candidate validation': 7,
    'capability-scoped question repository': 2,
      'capability-scoped knowledge application': 2,
      'capability-scoped study application': 2,
    'control ledger read helper': 2,
    'coordinator-only bridge helper': 2,
    'coordinator-only study bootstrap helper': 1,
    'coordinator control invocation scope': 7,
    'coordinator invocation scope': 33,
    'coordinator transaction/revision primitive': 24,
    'coordinator-scoped agent durability collaborator': 42,
    'coordinator-scoped registry mutation seam': 14,
    'coordinator-fenced identity replacement': 16,
    'database bootstrap/migration': 39,
    'database bootstrap/migration schema': 4,
    'scope-asserting mutation helper': 3,
    'validated read-only query facade': 1,
    'verified read-only database SQL call': 11
  });
});

test('direct mutating SQL helpers have no uncontained production caller', () => {
  const findings = scanDirectHelpers();
  const unclassified = findings.filter((entry) => !entry.classification);
  assert.deepEqual(unclassified, [], `Direct mutating helper outside coordinator scope:\n${JSON.stringify(unclassified, null, 2)}`);
  assert.equal(findings.length, 37);
});

test('unreferenced compatibility import helpers have no production caller or import', () => {
  const names = ['createImportBatch', 'recordImportBatchItem', 'recordImportAsset', 'finalizeImportBatch'];
  const occurrences = Object.fromEntries(names.map((name) => [name, []]));
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const name of names) {
      const pattern = new RegExp(`\\b${name}\\b`, 'g');
      for (const match of source.matchAll(pattern)) occurrences[name].push({ file: relative(file), line: lineAt(source, match.index) });
    }
  }
  assert.deepEqual(Object.fromEntries(names.map((name) => [name, occurrences[name].length])), {
    createImportBatch: 1,
    recordImportBatchItem: 1,
    recordImportAsset: 1,
    finalizeImportBatch: 1
  });
});
