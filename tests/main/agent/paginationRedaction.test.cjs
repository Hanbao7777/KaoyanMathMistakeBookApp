const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const paginationModule = environment.requireMain('agent/pagination.js');

const profile = {
  apiVersion: 1,
  kind: 'redaction-profile',
  detail: 'standard',
  includeUserContent: true,
  includeAffectedEntities: true,
  fields: []
};

test('issues deterministic query-bound cursors and rejects tampering or page changes', () => {
  const pagination = new paginationModule.PaginationService('z'.repeat(32));
  const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
  const first = pagination.paginate(items, { query: { clientId: 'one' }, pageSize: 2, maxPageSize: 2 }, (item) => item.id);
  assert.deepEqual(first.items, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.page.nextCursor.split('.').length, 3);
  assert.throws(() => JSON.parse(Buffer.from(first.page.nextCursor.split('.')[0], 'base64url').toString('utf8')));
  assert.equal(
    pagination.paginate(items, { query: { clientId: 'one' }, pageSize: 2, maxPageSize: 2 }, (item) => item.id).page.nextCursor,
    first.page.nextCursor
  );
  const second = pagination.paginate(items, {
    query: { clientId: 'one' }, cursor: first.page.nextCursor, pageSize: 2, maxPageSize: 2
  }, (item) => item.id);
  assert.deepEqual(second.items, [{ id: 'c' }]);
  assert.equal(second.page.hasMore, false);
  const tampered = `${first.page.nextCursor.slice(0, -1)}x`;
  assert.throws(() => pagination.paginate(items, { query: { clientId: 'one' }, cursor: tampered, pageSize: 2, maxPageSize: 2 }, (item) => item.id), (error) => error.code === 'CURSOR_INVALID');
  assert.throws(() => pagination.paginate(items, { query: { clientId: 'two' }, cursor: first.page.nextCursor, pageSize: 2, maxPageSize: 2 }, (item) => item.id), (error) => error.code === 'CURSOR_INVALID');
  assert.throws(() => pagination.paginate(items, { query: { clientId: 'one' }, cursor: first.page.nextCursor, pageSize: 1, maxPageSize: 2 }, (item) => item.id), (error) => error.code === 'CURSOR_INVALID');
  assert.throws(() => pagination.paginate(items, { query: {}, pageSize: 3, maxPageSize: 2 }, (item) => item.id), (error) => error.code === 'VALIDATION_ERROR');
});

test('rejects nondeterministic duplicate sort keys', () => {
  const pagination = new paginationModule.PaginationService('z'.repeat(32));
  assert.throws(() => pagination.paginate([{ id: 'a' }, { id: 'a' }], { query: {}, pageSize: 1, maxPageSize: 2 }, (item) => item.id), (error) => error.code === 'CURSOR_INVALID');
});

test('redacts credentials, tokens, session material, and absolute sensitive paths recursively', () => {
  const redacted = paginationModule.redactSensitiveValue({
    clientId: 'safe-client',
    accessToken: 'raw-token',
    credentialFingerprint: 'fingerprint',
    nested: {
      sessionId: 'raw-session',
      note: 'safe note',
      pathAlias: 'D:\\private\\mistakes.db',
      values: ['safe', '/private/absolute/path']
    }
  }, profile);
  assert.deepEqual(redacted, {
    clientId: 'safe-client',
    nested: { note: 'safe note', values: ['safe'] }
  });
  const serialized = JSON.stringify(redacted);
  for (const secret of ['raw-token', 'fingerprint', 'raw-session', 'D:\\private', '/private/absolute/path']) {
    assert.equal(serialized.includes(secret), false);
  }
});
