const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const agent = require(path.join(root, 'dist/main/shared/agent/index.js'));
const contracts = require(path.join(root, 'dist/main/shared/imports/v1.js'));
const exposure = require(path.join(root, 'dist/main/shared/mcp/v1/exposureManifest.js'));

function item(overrides = {}) { return { itemId: 'item-1', title: '极限题', content: 'lim x', wrongThinking: '', correctSolution: '1', answer: '1', subject: '高等数学', category: '极限', questionType: '解答题', errorReason: '概念不清', difficulty: '中等', masteryLevel: '未掌握', source: 'C11', tags: [], knowledgePoints: [], ...overrides }; }

test('C11 exposes exactly eight bounded import operations with explicit scopes and risk', () => {
  const names = exposure.mcpExternalBusinessOperations.filter((name) => name.startsWith('imports.')).sort();
  assert.deepEqual(names, ['imports.add_draft_image', 'imports.apply_draft', 'imports.cancel', 'imports.create_draft', 'imports.delete_batch', 'imports.get', 'imports.preview_draft', 'imports.validate_draft']);
  assert.equal(agent.resolveOperationDescriptor('imports.apply_draft').policyBounds.minimumRisk, 'R3');
  assert.equal(agent.resolveOperationDescriptor('imports.apply_draft').policyBounds.maxAffectedEntities, 50);
  assert.deepEqual(agent.resolveOperationDescriptor('imports.apply_draft').sideEffects, ['database', 'managed_files']);
  assert.deepEqual(agent.resolveOperationDescriptor('imports.get').requiredScopes, ['imports.read']);
  assert.deepEqual(agent.resolveOperationDescriptor('imports.apply_draft').requiredScopes, ['imports.write', 'operations.batch', 'questions.write']);
});

test('C11 validators reject paths, unknown fields, excess batches, disclosure expansion and malformed IDs', () => {
  assert.doesNotThrow(() => contracts.validateImportsCommand({ type: 'imports.create_draft', payload: { source: 'external_multimodal', networkDisclosure: 'none', items: [item()] } }));
  assert.throws(() => contracts.validateImportsCommand({ type: 'imports.create_draft', payload: { source: 'external_multimodal', networkDisclosure: 'arbitrary_network', items: [item()] } }), /invalid/i);
  assert.throws(() => contracts.validateImportsCommand({ type: 'imports.create_draft', payload: { source: 'external_multimodal', networkDisclosure: 'none', path: 'C:\\private', items: [item()] } }), /invalid/i);
  assert.throws(() => contracts.validateImportsCommand({ type: 'imports.create_draft', payload: { source: 'external_multimodal', networkDisclosure: 'none', items: Array.from({ length: 51 }, (_, index) => item({ itemId: `item-${index}` })) } }), /invalid/i);
  assert.throws(() => contracts.validateImportsCommand({ type: 'imports.add_draft_image', payload: { draftId: 'draft-ok', itemId: 'item-1', assetId: '..\\secret.png', role: 'question' } }), /invalid/i);
});

test('C11 inventory and Renderer/AI boundaries contain no direct import writer fallback', () => {
  const inventory = fs.readFileSync(path.join(root, 'docs/archive/completed/tasks/2026-07-20-agent-control-plane-c11-write-entry-inventory.md'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'src/main/ipc/adapters/importsIpc.ts'), 'utf8');
  const aiPage = fs.readFileSync(path.join(root, 'src/renderer/pages/AiImportPage.tsx'), 'utf8');
  assert.match(inventory, /Structured Excel\/JSON\/zip|Question bank import|AI\/OCR|Batch deletion|Temporary cleanup|Image binding|Renderer|IPC|Startup|Timer\/internal writers/);
  assert.doesNotMatch(adapter, /structuredImportService|questionBankService|deepseekService|getDatabase\(|\.run\(|\.exec\(|\.prepare\(/);
  assert.match(aiPage, /imports\.createDraft|imports\.stageSelectedImages|imports\.validateDraft|imports\.previewDraft|imports\.applyDraft/);
  assert.doesNotMatch(aiPage, /QuestionForm|recordAiImport|createQuestion\(/);
});
