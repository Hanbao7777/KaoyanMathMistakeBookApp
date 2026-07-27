const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const { all, one } = environment.requireMain('agent/sqlRows.js');

function fakeDatabase(options = {}) {
  const state = {
    bound: undefined,
    freed: 0,
    preparedSql: undefined,
    steps: 0
  };
  const rows = options.rows ?? [];
  let rowIndex = 0;
  const statement = {
    bind(parameters) {
      state.bound = parameters;
      if (options.bindError) throw options.bindError;
    },
    step() {
      state.steps += 1;
      if (options.stepError) throw options.stepError;
      return rowIndex < rows.length;
    },
    getAsObject() {
      if (options.getError) throw options.getError;
      return rows[rowIndex++];
    },
    free() {
      state.freed += 1;
    }
  };
  return {
    state,
    database: {
      prepare(sql) {
        state.preparedSql = sql;
        return statement;
      }
    }
  };
}

test('one binds a copied parameter list, returns one row, and frees the statement', () => {
  const fixture = fakeDatabase({ rows: [{ id: 1 }, { id: 2 }] });
  const parameters = ['client-one', 7];

  assert.deepEqual(one(fixture.database, 'SELECT * FROM records WHERE client_id = ? LIMIT ?', parameters), { id: 1 });
  assert.equal(fixture.state.preparedSql, 'SELECT * FROM records WHERE client_id = ? LIMIT ?');
  assert.deepEqual(fixture.state.bound, parameters);
  assert.notEqual(fixture.state.bound, parameters);
  assert.equal(fixture.state.steps, 1);
  assert.equal(fixture.state.freed, 1);
});

test('all preserves stepped row order and frees the statement', () => {
  const fixture = fakeDatabase({ rows: [{ id: 3 }, { id: 1 }, { id: 2 }] });

  assert.deepEqual(all(fixture.database, 'SELECT id FROM records ORDER BY id', []), [{ id: 3 }, { id: 1 }, { id: 2 }]);
  assert.equal(fixture.state.steps, 4);
  assert.equal(fixture.state.freed, 1);
});

test('one frees the statement when binding, stepping, or row conversion throws', () => {
  const failures = [
    ['bind', new Error('bind failed'), { bindError: new Error('bind failed') }],
    ['step', new Error('step failed'), { stepError: new Error('step failed') }],
    ['getAsObject', new Error('row failed'), { rows: [{ id: 1 }], getError: new Error('row failed') }]
  ];

  for (const [phase, expected, options] of failures) {
    const fixture = fakeDatabase(options);
    assert.throws(() => one(fixture.database, `SELECT '${phase}'`, ['bound']), expected);
    assert.equal(fixture.state.freed, 1, `statement must be freed after ${phase} failure`);
  }
});

test('all frees the statement when binding, stepping, or row conversion throws', () => {
  const failures = [
    ['bind', new Error('bind failed'), { bindError: new Error('bind failed') }],
    ['step', new Error('step failed'), { stepError: new Error('step failed') }],
    ['getAsObject', new Error('row failed'), { rows: [{ id: 1 }], getError: new Error('row failed') }]
  ];

  for (const [phase, expected, options] of failures) {
    const fixture = fakeDatabase(options);
    assert.throws(() => all(fixture.database, `SELECT '${phase}'`, ['bound']), expected);
    assert.equal(fixture.state.freed, 1, `statement must be freed after ${phase} failure`);
  }
});
