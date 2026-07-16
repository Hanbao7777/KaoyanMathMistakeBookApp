const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

const gateway = source('src/main/agent/agentGateway.ts');
const contracts = source('src/shared/agent/v1/gatewayContracts.ts');
const rendererAdapter = source('src/main/agent/rendererAdapter.ts');
const questionAdapter = source('src/main/ipc/adapters/questionsIpc.ts');
const tickTickAdapter = source('src/main/ipc/adapters/ticktickIpc.ts');
const policyEngine = source('src/main/agent/policyEngine.ts');
const operationCatalog = source('src/shared/agent/v1/operationCatalog.ts');

const migratedWrites = [
  'questions.create',
  'questions.update',
  'questions.delete',
  'questions.remove_image',
  'questions.mark_mastery',
  'questions.submit_review',
  'tasks.create',
  'tasks.update',
  'tasks.complete',
  'tasks.uncomplete',
  'tasks.delete',
  'focus.sessions.create'
];

test('all migrated Renderer question, task, and focus writes construct fixed Gateway commands', () => {
  for (const operation of migratedWrites) {
    const adapter = operation.startsWith('questions.') ? questionAdapter : tickTickAdapter;
    assert.match(adapter, new RegExp(`type: '${operation.replace('.', '\\.')}'`), operation);
  }
  for (const adapter of [questionAdapter, tickTickAdapter]) {
    assert.match(adapter, /controlPlane\.gateway\.execute\(/);
    assert.doesNotMatch(adapter, /(?:CommandBus|QueryBus|executeLegacyQuestionCommand|executeTickTickCommand|persistDatabase|runSql|transaction)/);
  }
});

test('migrated Renderer adapters cannot receive caller authority material', () => {
  assert.match(rendererAdapter, /principal\(\): AgentPrincipal/);
  assert.doesNotMatch(rendererAdapter, /principal\([^)]/);
  for (const adapter of [questionAdapter, tickTickAdapter]) {
    assert.doesNotMatch(adapter, /\b(?:principal|credentials?|credential|session|scopes|trust|clientId)\s*[:=]/i);
    assert.doesNotMatch(adapter, /event\.sender|RawClientCredentials|authenticate\(/);
  }
});

test('AgentGateway has only execute/query externally and no persistence capability', () => {
  assert.match(contracts, /export const agentGatewayMethodNames = Object\.freeze\(\['execute', 'query'\] as const\)/);
  const interfaceBody = contracts.match(/export interface AgentGateway \{([\s\S]*?)\n\}/);
  assert.ok(interfaceBody, 'AgentGateway contract is missing');
  assert.deepEqual([...interfaceBody[1].matchAll(/^\s*(\w+)\(/gm)].map((match) => match[1]), ['execute', 'query']);

  const classBody = gateway.match(/export class AgentGateway[\s\S]*?\{([\s\S]*)\n\}/);
  assert.ok(classBody, 'AgentGateway implementation is missing');
  assert.deepEqual(
    [...classBody[1].matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]).filter((name) => name !== 'constructor'),
    ['execute', 'query']
  );
  assert.doesNotMatch(gateway, /DatabaseCoordinator|databaseCoordinator|executeControlWrite|executeBusinessWrite|getDatabase\(|getReadOnlyDatabase|\.exec\(|\.run\(|\btransaction\b|node:fs|node:path|sql\.js/i);
});

test('external business exposure is a catalog-owned boundary evaluated before workflow admission', () => {
  assert.match(operationCatalog, /export const externalPhaseBBusinessOperations = Object\.freeze\(/);
  assert.match(operationCatalog, /const externalPhaseBBusinessOperationSet = new Set<OperationName>\(externalPhaseBBusinessOperations\)/);
  assert.match(operationCatalog, /export function isExternalPhaseBBusinessOperation\(name: OperationName\): boolean/);
  assert.match(policyEngine, /!principal\.renderer && descriptor\.domain !== 'management' && !isExternalPhaseBBusinessOperation\(descriptor\.name\)/);
  assert.match(policyEngine, /'EXTERNAL_PHASE_B_BOUNDARY'/);
});
