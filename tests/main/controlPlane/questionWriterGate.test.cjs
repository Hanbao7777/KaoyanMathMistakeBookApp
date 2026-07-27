const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const mainRoot = path.join(projectRoot, 'src/main');
const ownedTables = '(?:questions|question_images|tags|question_tags|review_logs|question_knowledge_points)';
const mutationPattern = new RegExp(
  `\\b(?:create\\s+(?:unique\\s+)?(?:table|index)(?:\\s+if\\s+not\\s+exists)?|insert(?:\\s+or\\s+\\w+)?\\s+into|replace\\s+into|update|delete\\s+from|alter\\s+table|drop\\s+table)\\s+[\\x00-\\x20]*[\`'\"]?${ownedTables}\\b`,
  'gi'
);
const legacyWriters = [
  'createQuestion',
  'updateQuestion',
  'deleteQuestion',
  'removeImage',
  'submitReviewResult',
  'addReviewLog',
  'markMastery',
  'linkQuestionKnowledgePoints',
  'migrateCategoryValues',
  'rematchKnowledgePoints'
];

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

function normalize(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function stringLiterals(source) {
  const literals = [];
  let index = 0;
  while (index < source.length) {
    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    let value = '';
    while (index < source.length) {
      const character = source[index];
      if (character === '\\') {
        value += character + (source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (character === quote) break;
      value += character;
      index += 1;
    }
    if (index < source.length) {
      literals.push({ start, end: index + 1, value });
      index += 1;
    }
  }
  return literals;
}

function enclosingRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  return start < 0 || end < 0 ? null : { start, end };
}

function inRange(index, range) {
  return range && index >= range.start && index < range.end;
}

function classifySql(file, source, index, statement) {
  const name = relative(file);
  if (name === 'src/main/database/schema.ts' && /^create (?:table|index)/i.test(statement)) {
    return 'schema bootstrap DDL';
  }
  if (name === 'src/main/application/questions/questionRepository.ts') {
    assert.match(source, /constructor\(database: Database, scope: DatabaseMutationScope/);
    assert.match(source, /assertDatabaseMutationScope\(this\.scope, this\.database\)/);
    return 'coordinator-scoped question repository';
  }
  if (name === 'src/main/application/knowledge/commands.ts') {
    assert.match(source, /assertDatabaseMutationScope\(scope, database\)/);
    return 'coordinator-scoped C9 knowledge application';
  }
  if (name === 'src/main/application/global/importBatchDeletion.ts') {
    return 'coordinator-fenced import-batch replacement';
  }
  if (name === 'src/main/services/databaseService.ts') {
    const migration = enclosingRange(source, 'function migrateDatabase(', 'export function runSql(');
    const restoreReplacement = enclosingRange(source, 'function copyRestorableTablesFromBackup(', 'async function prepareReplacementManifest(');
    const importReplacement = enclosingRange(source, 'export async function importData(', 'export async function clearAllData(');
    const clearReplacement = enclosingRange(source, 'export async function clearAllData(', 'export async function createVerifiedDatabaseSnapshot(');
    const managedClearReplacement = enclosingRange(source, 'export async function replaceManagedDatabaseClear(', 'export interface DataRootSwitchDependencies');
    if (inRange(index, migration)) return 'legacy schema migration bootstrap';
    if (inRange(index, restoreReplacement)) return 'coordinator-fenced restore replacement';
    if (inRange(index, importReplacement)) return 'coordinator-fenced JSON identity replacement';
    if (inRange(index, clearReplacement) || inRange(index, managedClearReplacement)) return 'coordinator-fenced global clear replacement';
  }
  return null;
}

function questionSqlOccurrences() {
  const occurrences = [];
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const literal of stringLiterals(source)) {
      mutationPattern.lastIndex = 0;
      let match;
      while ((match = mutationPattern.exec(literal.value)) !== null) {
        const absoluteIndex = literal.start + 1 + match.index;
        const statement = normalize(literal.value.slice(match.index).split(';', 1)[0]);
        occurrences.push({
          file: relative(file),
          line: lineAt(source, absoluteIndex),
          statement,
          classification: classifySql(file, source, absoluteIndex, statement)
        });
      }
    }
    for (const match of source.matchAll(/DELETE\s+FROM\s+\$\{(?:table|quoteSqlIdentifier\(table\))\}/g)) {
      occurrences.push({
        file: relative(file),
        line: lineAt(source, match.index),
        statement: 'DELETE FROM ${table}',
        classification: classifySql(file, source, match.index, 'DELETE FROM ${table}')
      });
    }
  }
  return occurrences;
}

function legacyWriterCalls() {
  const calls = [];
  const pattern = new RegExp(`\\b(${legacyWriters.join('|')})\\s*\\(`, 'g');
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const prefix = source.slice(Math.max(0, match.index - 80), match.index);
      if (/function\s+$/.test(prefix) || /(?:async\s+)?function\s+$/.test(prefix)) continue;
      const name = relative(file);
      let classification = null;
      if (name === 'src/main/services/databaseService.ts') classification = 'legacy wrapper dispatches a question command';
      if (name === 'src/main/main.ts' && ['migrateCategoryValues', 'rematchKnowledgePoints'].includes(match[1])) {
        classification = 'startup application adapter';
      }
      if (name === 'src/main/ipc/registerIpc.ts' && match[1] === 'rematchKnowledgePoints') {
        classification = 'IPC application adapter';
      }
      if (name === 'src/main/application/questions/commands.ts') classification = 'question application handler';
      if (name === 'src/main/application/questions/questionRepository.ts') classification = 'coordinator-scoped repository method';
      calls.push({ file: name, line: lineAt(source, match.index), writer: match[1], classification });
    }
  }
  return calls;
}

test('all question-owned SQL mutations have an exact allowed scope', () => {
  const occurrences = questionSqlOccurrences();
  const unclassified = occurrences.filter((entry) => !entry.classification);
  assert.deepEqual(unclassified, [], `Unclassified question SQL mutations:\n${JSON.stringify(unclassified, null, 2)}`);

  const counts = Object.fromEntries([...new Set(occurrences.map((entry) => entry.classification))]
    .sort()
    .map((classification) => [classification, occurrences.filter((entry) => entry.classification === classification).length]));
  assert.deepEqual(counts, {
    'coordinator-fenced JSON identity replacement': 3,
    'coordinator-fenced global clear replacement': 2,
    'coordinator-fenced import-batch replacement': 1,
    'coordinator-fenced restore replacement': 1,
    'coordinator-scoped question repository': 18,
    'coordinator-scoped C9 knowledge application': 2,
    'legacy schema migration bootstrap': 9,
    'schema bootstrap DDL': 6
  });
});

test('direct legacy question writer calls remain application or repository scoped', () => {
  const calls = legacyWriterCalls();
  const unclassified = calls.filter((entry) => !entry.classification);
  assert.deepEqual(unclassified, [], `Unclassified legacy question writer calls:\n${JSON.stringify(unclassified, null, 2)}`);
  assert.equal(calls.length, 6, `Expected 6 classified legacy writer call forms, found ${calls.length}`);
});

test('question repository construction is capability-scoped at every production call site', () => {
  const constructions = [];
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/new\s+QuestionRepository\s*\(([^\n]*)/g)) {
      constructions.push({ file: relative(file), line: lineAt(source, match.index), arguments: normalize(match[1]) });
    }
  }
  assert.deepEqual(constructions.map(({ file }) => file), [
    'src/main/application/imports/registerImports.ts',
    'src/main/application/questions/commands.ts',
    'src/main/services/importBatchService.ts',
    'src/main/services/questionBankService.ts'
  ]);
  for (const construction of constructions) assert.match(construction.arguments, /\bscope\b/);
});
