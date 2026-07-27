import type { Database, SqlValue } from 'sql.js';
import { assertDatabaseMutationScope, type DatabaseMutationScope } from '../../persistence/databaseCoordinator';
import type { KnowledgeCommand, KnowledgeCommandValues } from './contracts';

function one<T>(database: Database, sql: string, values: readonly SqlValue[]): T | undefined {
  const statement = database.prepare(sql);
  try { statement.bind([...values]); return statement.step() ? statement.getAsObject() as T : undefined; } finally { statement.free(); }
}

function run(database: Database, sql: string, values: readonly SqlValue[]): boolean {
  const statement = database.prepare(sql);
  try { statement.bind([...values]); statement.step(); return database.getRowsModified() > 0; } finally { statement.free(); }
}

export function executeKnowledgeCommand<C extends KnowledgeCommand>(
  command: C, database: Database, scope: DatabaseMutationScope, now = () => new Date().toISOString()
): { changed: boolean; value: KnowledgeCommandValues[C['type']]; eventType: string; eventPayload: Record<string, unknown> } {
  assertDatabaseMutationScope(scope, database);
  switch (command.type) {
    case 'knowledge.link_question': {
      const { questionId, nodeId, matchType } = command.payload;
      if (!one(database, 'SELECT id FROM questions WHERE id = ?', [questionId])) throw new Error('Question not found');
      if (!one(database, 'SELECT node_id FROM knowledge_points WHERE node_id = ? AND (deleted_at IS NULL OR deleted_at = "")', [nodeId])) throw new Error('Knowledge node not found');
      const existing = one(database, 'SELECT id FROM question_knowledge_points WHERE question_id = ? AND knowledge_node_id = ?', [questionId, nodeId]);
      const changed = !existing && run(database, 'INSERT INTO question_knowledge_points (question_id, knowledge_node_id, match_type, created_at) VALUES (?, ?, ?, ?)', [questionId, nodeId, matchType, now()]);
      return { changed, value: { linked: changed, questionId, nodeId } as KnowledgeCommandValues[C['type']], eventType: 'knowledge.question_linked', eventPayload: { questionId, nodeId } };
    }
    case 'knowledge.unlink_question': {
      const { questionId, nodeId } = command.payload;
      const changed = run(database, 'DELETE FROM question_knowledge_points WHERE question_id = ? AND knowledge_node_id = ?', [questionId, nodeId]);
      return { changed, value: { unlinked: changed, questionId, nodeId } as KnowledgeCommandValues[C['type']], eventType: 'knowledge.question_unlinked', eventPayload: { questionId, nodeId } };
    }
    case 'knowledge.bind_textbook': {
      const { nodeId, textbookId } = command.payload;
      if (!one(database, 'SELECT node_id FROM knowledge_points WHERE node_id = ? AND (deleted_at IS NULL OR deleted_at = "")', [nodeId])) throw new Error('Knowledge node not found');
      if (!one(database, 'SELECT id FROM textbooks WHERE id = ?', [textbookId])) throw new Error('Textbook not found');
      const changed = run(database, 'UPDATE knowledge_points SET textbook_id = ?, updated_at = ? WHERE node_id = ? AND COALESCE(textbook_id, -1) != ?', [textbookId, now(), nodeId, textbookId]);
      return { changed, value: { bound: changed, nodeId, textbookId } as KnowledgeCommandValues[C['type']], eventType: 'knowledge.textbook_bound', eventPayload: { nodeId, textbookId } };
    }
  }
}
