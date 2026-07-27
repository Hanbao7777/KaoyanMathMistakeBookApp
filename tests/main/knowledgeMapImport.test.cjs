const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const {
  cleanupTestRoot,
  databaseService,
  projectRoot,
  requireMain,
  resetTestDatabase,
  testRoot
} = require('./helpers/mainTestEnv.cjs');

const electron = require('electron');

const knowledgeMapService = requireMain('services/knowledgeMapService.js');

const seedResourcesDir = path.join(projectRoot, 'dist', 'main', 'resources');
const seedZipPath = path.join(seedResourcesDir, 'knowledge_map_seed.zip');
const originalSeedZip = fs.existsSync(seedZipPath) ? fs.readFileSync(seedZipPath) : null;

function zipJson(entries) {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(JSON.stringify(value), 'utf8'));
  }
  return zip;
}

function writeKnowledgeMapZip(fileName, entries) {
  const tempDir = fs.mkdtempSync(path.join(testRoot, 'km-import-'));
  const zipPath = path.join(tempDir, fileName);
  zipJson(entries).writeZip(zipPath);
  return { tempDir, zipPath };
}

function setDialogFile(filePath) {
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
}

function cleanupSeedZip() {
  if (originalSeedZip) {
    fs.mkdirSync(seedResourcesDir, { recursive: true });
    fs.writeFileSync(seedZipPath, originalSeedZip);
  } else {
    fs.rmSync(seedZipPath, { force: true });
  }
}

async function dbRows() {
  const db = await databaseService.getDatabase();
  return {
    db,
    textbooks: databaseService.allSql(db, 'SELECT * FROM textbooks ORDER BY id ASC'),
    points: databaseService.allSql(db, 'SELECT * FROM knowledge_points ORDER BY sort_order ASC, node_id ASC'),
    batches: databaseService.allSql(db, 'SELECT * FROM import_batches ORDER BY imported_at ASC'),
    items: databaseService.allSql(db, 'SELECT * FROM import_batch_items ORDER BY id ASC')
  };
}

function validEntries(prefix = 'km-test') {
  return {
    'textbooks.json': {
      title: `${prefix}-测试教材`,
      subject: '高等数学',
      edition: '1'
    },
    'knowledge_points.json': [
      { node_id: `${prefix}-root`, title: '父节点', parent_node_id: '', level: 1, sort_order: 1 },
      { node_id: `${prefix}-child`, title: '子节点', parent_node_id: `${prefix}-root`, level: 2, sort_order: 2 }
    ]
  };
}

test.after(() => {
  cleanupSeedZip();
  cleanupTestRoot();
});

test.beforeEach(async () => {
  cleanupSeedZip();
  await resetTestDatabase();
  electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
});

test('importKnowledgeMapZip imports textbook, knowledge points, and import batch records', async () => {
  const { tempDir, zipPath } = writeKnowledgeMapZip('knowledge_map_import.zip', validEntries('km-manual'));
  setDialogFile(zipPath);
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  const result = await knowledgeMapService.importKnowledgeMapZip();

  assert.ok(result);
  assert.equal(result.textbookTitle, 'km-manual-测试教材');
  assert.equal(result.importedCount, 2);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.failedCount, 0);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 1);

  const { textbooks, points, batches, items } = await dbRows();
  assert.equal(textbooks.length, 1);
  assert.equal(textbooks[0].title, 'km-manual-测试教材');
  assert.equal(textbooks[0].subject, '高等数学');

  assert.equal(points.length, 2);
  assert.equal(points[0].node_id, 'km-manual-root');
  assert.equal(points[0].title, '父节点');
  assert.equal(points[1].node_id, 'km-manual-child');
  assert.equal(points[1].parent_node_id, 'km-manual-root');

  assert.equal(batches.length, 1);
  assert.equal(batches[0].type, 'knowledge_map');
  assert.equal(batches[0].item_count, 3);

  assert.deepEqual(
    items.map((item) => [item.target_table, item.target_id]),
    [
      ['textbooks', String(textbooks[0].id)],
      ['knowledge_points', 'km-manual-root'],
      ['knowledge_points', 'km-manual-child']
    ]
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('importKnowledgeMapZip rejects zip missing textbooks.json', async () => {
  const { tempDir, zipPath } = writeKnowledgeMapZip('missing-textbook.zip', {
    'knowledge_points.json': validEntries('km-missing-textbook')['knowledge_points.json']
  });
  setDialogFile(zipPath);

  await assert.rejects(
    () => knowledgeMapService.importKnowledgeMapZip(),
    /textbooks\.json/
  );

  const { textbooks, points, batches, items } = await dbRows();
  assert.equal(textbooks.length, 0);
  assert.equal(points.length, 0);
  assert.equal(batches.length, 0);
  assert.equal(items.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('importKnowledgeMapZip rejects zip missing knowledge_points.json', async () => {
  const { tempDir, zipPath } = writeKnowledgeMapZip('missing-points.zip', {
    'textbooks.json': validEntries('km-missing-points')['textbooks.json']
  });
  setDialogFile(zipPath);

  await assert.rejects(
    () => knowledgeMapService.importKnowledgeMapZip(),
    /knowledge_points\.json/
  );

  const { textbooks, points, batches, items } = await dbRows();
  assert.equal(textbooks.length, 0);
  assert.equal(points.length, 0);
  assert.equal(batches.length, 0);
  assert.equal(items.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('importKnowledgeMapZip rejects non-array knowledge_points.json', async () => {
  const { tempDir, zipPath } = writeKnowledgeMapZip('invalid-points.zip', {
    'textbooks.json': validEntries('km-invalid-points')['textbooks.json'],
    'knowledge_points.json': { node_id: 'km-invalid-points-root', title: '不是数组' }
  });
  setDialogFile(zipPath);

  await assert.rejects(
    () => knowledgeMapService.importKnowledgeMapZip(),
    /必须是数组/
  );

  const { textbooks, points, batches, items } = await dbRows();
  assert.equal(textbooks.length, 0);
  assert.equal(points.length, 0);
  assert.equal(batches.length, 0);
  assert.equal(items.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('seedImportKnowledgeMap imports bundled seed zip smoke path', async () => {
  fs.mkdirSync(seedResourcesDir, { recursive: true });
  zipJson(validEntries('km-seed')).writeZip(seedZipPath);

  const result = await knowledgeMapService.seedImportKnowledgeMap();

  assert.equal(result.textbookTitle, 'km-seed-测试教材');
  assert.equal(result.importedCount, 2);
  assert.equal(result.failedCount, 0);

  const { textbooks, points, batches, items } = await dbRows();
  assert.equal(textbooks.length, 1);
  assert.equal(textbooks[0].title, 'km-seed-测试教材');
  assert.equal(points.length, 2);
  assert.equal(points[0].node_id, 'km-seed-root');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].type, 'knowledge_map');
  assert.equal(items.length, 3);
});
