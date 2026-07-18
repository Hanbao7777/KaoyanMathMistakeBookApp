import type { ReadOnlyDatabaseFacade } from '../queryBus';
import type { KnowledgePoint, KnowledgePointReviewStats, SafeKnowledgeNode, SafeTextbook } from '../../../shared/types';
import type { KnowledgeQuery, KnowledgeQueryValues } from './contracts';

function list<T>(database: ReadOnlyDatabaseFacade, sql: string, values: readonly unknown[] = []): readonly T[] { return database.select(sql, values as never) as unknown as readonly T[]; }
function one<T>(database: ReadOnlyDatabaseFacade, sql: string, values: readonly unknown[] = []): T | null { return list<T>(database, sql, values)[0] ?? null; }
function parse(value: string): string[] { try { const result = JSON.parse(value || '[]'); return Array.isArray(result) ? result.map(String) : []; } catch { return []; } }

export function executeKnowledgeQuery<Q extends KnowledgeQuery>(query: Q, database: ReadOnlyDatabaseFacade): KnowledgeQueryValues[Q['type']] {
  switch (query.type) {
    case 'knowledge.list_nodes': {
      const where = ['(deleted_at IS NULL OR deleted_at = "")']; const values: unknown[] = [];
      if (query.payload.parentNodeId !== undefined) { where.push('parent_node_id = ?'); values.push(query.payload.parentNodeId); }
      if (query.payload.subject !== undefined) { where.push('subject = ?'); values.push(query.payload.subject); }
      values.push(query.payload.limit);
      return list<KnowledgePoint>(database, `SELECT * FROM knowledge_points WHERE ${where.join(' AND ')} ORDER BY level, sort_order, title, node_id LIMIT ?`, values) as unknown as KnowledgeQueryValues[Q['type']];
    }
    case 'knowledge.get_node': {
      const point = one<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ? AND (deleted_at IS NULL OR deleted_at = "")', [query.payload.nodeId]);
      if (!point) return null as KnowledgeQueryValues[Q['type']];
      const textbook = point.textbook_id ? one<SafeTextbook>(database, 'SELECT id, title, subject, edition, file_name, note, created_at, updated_at FROM textbooks WHERE id = ?', [point.textbook_id]) : null;
      const links = list<{ id: number }>(database, 'SELECT question_id AS id FROM question_knowledge_points WHERE knowledge_node_id = ? ORDER BY question_id DESC LIMIT 200', [point.node_id]);
      const { core_formulas, common_question_types, common_error_reasons, tags, ...safePoint } = point;
      return { ...safePoint, textbook, coreFormulas: parse(core_formulas), commonQuestionTypes: parse(common_question_types), commonErrorReasons: parse(common_error_reasons), tagList: parse(tags), questionCount: links.length } as SafeKnowledgeNode as unknown as KnowledgeQueryValues[Q['type']];
    }
    case 'knowledge.list_links': {
      const where: string[] = []; const values: unknown[] = [];
      if (query.payload.nodeId !== undefined) { where.push('knowledge_node_id = ?'); values.push(query.payload.nodeId); }
      if (query.payload.questionId !== undefined) { where.push('question_id = ?'); values.push(query.payload.questionId); }
      values.push(query.payload.limit);
      return list(database, `SELECT question_id, knowledge_node_id, match_type, created_at FROM question_knowledge_points WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, values) as unknown as KnowledgeQueryValues[Q['type']];
    }
    case 'textbooks.list': {
      const subject = query.payload.subject;
      return list<SafeTextbook>(database, `SELECT id, title, subject, edition, file_name, note, created_at, updated_at FROM textbooks ${subject ? 'WHERE subject = ?' : ''} ORDER BY title, edition, id LIMIT ?`, subject ? [subject, query.payload.limit] : [query.payload.limit]) as unknown as KnowledgeQueryValues[Q['type']];
    }
    case 'textbooks.get': return one<SafeTextbook>(database, `SELECT id, title, subject, edition, file_name, note, created_at, updated_at FROM textbooks WHERE id = ?`, [query.payload.textbookId]) as KnowledgeQueryValues[Q['type']];
    case 'analytics.get_weak_areas': {
      const where = ['(kp.deleted_at IS NULL OR kp.deleted_at = "")']; const values: unknown[] = [];
      if (query.payload.subject !== undefined) { where.push('kp.subject = ?'); values.push(query.payload.subject); }
      values.push(query.payload.limit);
      return list<KnowledgePointReviewStats>(database, `SELECT kp.node_id, kp.title, kp.subject, kp.category, kp.level, kp.sort_order, kp.book_page, kp.pdf_page, kp.tags,
        kp.common_question_types AS commonQuestionTypes, COUNT(DISTINCT q.id) AS total_questions,
        SUM(CASE WHEN q.mastery_level IN ('未掌握', '较弱') OR COALESCE(q.wrong_count, 0) > COALESCE(q.correct_count, 0) OR COALESCE(q.no_idea_count, 0) > 0 THEN 1 ELSE 0 END) AS weak_questions,
        0 AS due_questions, NULL AS average_mastery_score
        FROM knowledge_points kp LEFT JOIN question_knowledge_points l ON l.knowledge_node_id = kp.node_id LEFT JOIN questions q ON q.id = l.question_id
        WHERE ${where.join(' AND ')} GROUP BY kp.node_id HAVING COUNT(DISTINCT q.id) > 0 ORDER BY weak_questions DESC, total_questions DESC, kp.level, kp.sort_order LIMIT ?`, values).map((row) => ({ ...row, tags: parse(String(row.tags)), commonQuestionTypes: parse(String(row.commonQuestionTypes)) })) as unknown as KnowledgeQueryValues[Q['type']];
    }
  }
}
