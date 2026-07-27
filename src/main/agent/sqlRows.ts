import type { Database } from 'sql.js';

export type SqlParameter = string | number | null | Uint8Array;

export function one(database: Database, sql: string, parameters: readonly SqlParameter[] = []): Record<string, unknown> | undefined {
  const statement = database.prepare(sql);
  try {
    statement.bind([...parameters]);
    return statement.step() ? statement.getAsObject() : undefined;
  } finally {
    statement.free();
  }
}

export function all(database: Database, sql: string, parameters: readonly SqlParameter[] = []): Record<string, unknown>[] {
  const statement = database.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  try {
    statement.bind([...parameters]);
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}
