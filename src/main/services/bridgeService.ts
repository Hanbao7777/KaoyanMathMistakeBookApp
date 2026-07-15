import crypto from 'node:crypto';
import { createInternalExecutionContext } from '../application/executionContext';
import type { AppCommand, QuestionCommandValues } from '../../shared/agent/v1/contracts';
import type { ReviewLog, ReviewResultV2, TickTickBridgeLinkedType, TickTickTask } from '../../shared/types';
import { getDatabaseCoordinator, getQuestionsApplication, getReadOnlyDatabase } from './databaseService';
import {
  completeTickTickTask,
  getBridgesForLinked,
  getTickTickSettings,
  getTickTickTask,
  uncompleteTickTickTask
} from './ticktickService';

interface BridgeRow extends Readonly<Record<string, unknown>> {
  readonly linked_type: string;
  readonly linked_id: string;
}

interface ReviewIdentityRow extends Readonly<Record<string, unknown>> {
  readonly id: number;
  readonly question_id: number;
}

interface DueQuestionRow extends Readonly<Record<string, unknown>> {
  readonly id: number;
  readonly title: string;
  readonly kp_title: string | null;
}

function todayStr(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function reviewNote(taskTitle: string): string {
  return `TickTick 任务完成: ${taskTitle}`;
}

function reviewResult(result: ReviewLog['result']): ReviewResultV2 {
  if (result === 'correct' || result === '做对了') return 'correct';
  if (result === 'wrong' || result === '做错了') return 'wrong';
  return 'no_idea';
}

async function executeQuestionCommand<C extends AppCommand>(command: C): Promise<QuestionCommandValues[C['type']]> {
  const coordinator = await getDatabaseCoordinator();
  const application = await getQuestionsApplication();
  const result = await application.execute(command, createInternalExecutionContext({
    concurrency: 'strict',
    expectedVersion: coordinator.currentVersion()
  }));
  return result.value as QuestionCommandValues[C['type']];
}

function compensationFailure(message: string, primaryError: unknown, compensationErrors: unknown[]): Error {
  const error = new Error(message);
  Object.assign(error, { cause: primaryError, compensationErrors });
  return error;
}

async function compensateSubmittedReviews(
  reviews: ReadonlyArray<{ questionId: number; reviewLogId: number }>,
  primaryError: unknown
): Promise<never> {
  const compensationErrors: unknown[] = [];
  for (const review of [...reviews].reverse()) {
    try {
      await executeQuestionCommand({ type: 'questions.undo_review', payload: review });
    } catch (error) {
      compensationErrors.push(error);
    }
  }
  if (compensationErrors.length) {
    throw compensationFailure('Review sync failed and review compensation was incomplete', primaryError, compensationErrors);
  }
  throw primaryError;
}

async function compensateUndoneReviews(
  reviews: ReadonlyArray<{ questionId: number; result: ReviewResultV2; note: string }>,
  primaryError: unknown
): Promise<never> {
  const compensationErrors: unknown[] = [];
  for (const review of [...reviews].reverse()) {
    try {
      await executeQuestionCommand({ type: 'questions.submit_review', payload: review });
    } catch (error) {
      compensationErrors.push(error);
    }
  }
  if (compensationErrors.length) {
    throw compensationFailure('Review undo failed and review restoration was incomplete', primaryError, compensationErrors);
  }
  throw primaryError;
}

export async function syncTaskCompletedToReview(ticktickTaskId: string, taskTitle: string, actualMinutes: number): Promise<void> {
  const database = await getReadOnlyDatabase();
  const bridges = database.select<BridgeRow>(
    'SELECT linked_type, linked_id FROM ticktick_bridge WHERE ticktick_task_id = ? AND sync_review = 1',
    [ticktickTaskId]
  );
  if (!bridges.length) return;

  const submitted: Array<{ questionId: number; reviewLogId: number }> = [];
  try {
    for (const bridge of bridges) {
      if (bridge.linked_type !== 'question') continue;
      const questionId = Number.parseInt(bridge.linked_id, 10);
      if (!Number.isSafeInteger(questionId) || questionId <= 0) continue;
      const existing = database.select<ReviewIdentityRow>(
        'SELECT id, question_id FROM review_logs WHERE question_id = ? AND review_date = ? AND note = ?',
        [questionId, todayStr(), reviewNote(taskTitle)]
      );
      if (existing.length) continue;
      const result = await executeQuestionCommand({
        type: 'questions.submit_review',
        payload: { questionId, result: 'correct', note: reviewNote(taskTitle) }
      });
      submitted.push({ questionId, reviewLogId: result.log.id });
    }

    const studyTaskIds = bridges
      .filter((bridge) => bridge.linked_type === 'study_task')
      .map((bridge) => bridge.linked_id);
    if (studyTaskIds.length) {
      const coordinator = await getDatabaseCoordinator();
      await coordinator.executeWrite({
        requestId: crypto.randomUUID(),
        concurrency: 'none',
        execute(writeDatabase) {
          const timestamp = new Date().toISOString();
          let changed = false;
          for (const studyTaskId of studyTaskIds) {
            writeDatabase.run(
              "UPDATE study_tasks SET status = '已完成', actual_minutes = actual_minutes + ?, completed_at = ?, updated_at = ? WHERE id = ?",
              [actualMinutes, timestamp, timestamp, studyTaskId]
            );
            changed = writeDatabase.getRowsModified() > 0 || changed;
          }
          return { changed, value: null };
        }
      });
    }
  } catch (error) {
    await compensateSubmittedReviews(submitted, error);
  }
}

export async function syncReviewToTickTickTask(linkedType: TickTickBridgeLinkedType, linkedId: string): Promise<void> {
  const bridges = await getBridgesForLinked(linkedType, linkedId);
  if (!bridges.length) return;
  const coordinator = await getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      const timestamp = new Date().toISOString();
      let changed = false;
      for (const bridge of bridges) {
        database.run(
          'UPDATE ticktick_tasks SET is_completed = 1, completed_at = ?, updated_at = ? WHERE id = ? AND is_completed = 0',
          [timestamp, timestamp, bridge.ticktick_task_id]
        );
        changed = database.getRowsModified() > 0 || changed;
      }
      return { changed, value: null };
    }
  });
}

export async function syncMasteryToTaskPriority(knowledgeNodeId: string, newMasteryScore: number): Promise<void> {
  const bridges = (await getBridgesForLinked('knowledge_point', knowledgeNodeId)).filter((bridge) => bridge.sync_mastery);
  if (!bridges.length) return;
  const coordinator = await getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      const timestamp = new Date().toISOString();
      const priority = newMasteryScore >= 4 ? '低' : newMasteryScore >= 3 ? '中' : '高';
      let changed = false;
      for (const bridge of bridges) {
        database.run(
          'UPDATE ticktick_tasks SET priority = ?, updated_at = ? WHERE id = ? AND is_completed = 0',
          [priority, timestamp, bridge.ticktick_task_id]
        );
        changed = database.getRowsModified() > 0 || changed;
      }
      return { changed, value: null };
    }
  });
}

export async function generateAutoReviewTasks(): Promise<{ created: number }> {
  const settings = await getTickTickSettings();
  if (!settings.autoCreateReviewTasks) return { created: 0 };
  const coordinator = await getDatabaseCoordinator();
  const result = await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      const today = todayStr();
      const dueResult = database.exec(
        `SELECT q.id, q.title, kp.title as kp_title
         FROM questions q
         LEFT JOIN question_knowledge_points qkp ON q.id = qkp.question_id
         LEFT JOIN knowledge_points kp ON qkp.knowledge_node_id = kp.node_id
         WHERE q.next_review_at IS NOT NULL AND date(q.next_review_at) <= ?
         ORDER BY q.next_review_at ASC
         LIMIT 20`,
        [today]
      );
      if (!dueResult.length || !dueResult[0].values.length) return { changed: false, value: { created: 0 } };

      const existingResult = database.exec(
        `SELECT linked_id FROM ticktick_bridge
         WHERE linked_type = 'question'
         AND ticktick_task_id IN (SELECT id FROM ticktick_tasks WHERE source = 'auto_review' AND is_completed = 0)`
      );
      const existingIds = new Set(
        existingResult.length ? existingResult[0].values.map((row) => String(row[0])) : []
      );
      const defaultListId = settings.defaultListId || getOrCreateDefaultList(database);
      let created = 0;
      for (const values of dueResult[0].values) {
        const row: DueQuestionRow = { id: Number(values[0]), title: String(values[1]), kp_title: values[2] === null ? null : String(values[2]) };
        const questionId = String(row.id);
        if (existingIds.has(questionId)) continue;
        const title = row.kp_title ? `复习错题: ${row.kp_title}` : `复习错题: ${row.title}`;
        const taskId = `task_${Date.now()}_${created}`;
        const timestamp = new Date().toISOString();
        database.run(
          `INSERT INTO ticktick_tasks (id, list_id, title, due_date, priority, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, '高', 'auto_review', ?, ?)`,
          [taskId, defaultListId, title, today, timestamp, timestamp]
        );
        database.run(
          'INSERT INTO ticktick_bridge (ticktick_task_id, linked_type, linked_id, sync_review, sync_mastery) VALUES (?, ?, ?, 1, 0)',
          [taskId, 'question', questionId]
        );
        created += 1;
      }
      return { changed: created > 0, value: { created } };
    }
  });
  return result.value;
}

export async function undoSyncTaskCompleted(ticktickTaskId: string, taskTitle: string): Promise<void> {
  const database = await getReadOnlyDatabase();
  const bridges = database.select<BridgeRow>(
    "SELECT linked_type, linked_id FROM ticktick_bridge WHERE ticktick_task_id = ? AND linked_type = 'question' AND sync_review = 1",
    [ticktickTaskId]
  );
  if (!bridges.length) return;

  const undone: Array<{ questionId: number; result: ReviewResultV2; note: string }> = [];
  try {
    for (const bridge of bridges) {
      const questionId = Number.parseInt(bridge.linked_id, 10);
      if (!Number.isSafeInteger(questionId) || questionId <= 0) continue;
      const matches = database.select<ReviewIdentityRow>(
        'SELECT id, question_id FROM review_logs WHERE question_id = ? AND review_date = ? AND note = ? ORDER BY id DESC',
        [questionId, todayStr(), reviewNote(taskTitle)]
      );
      if (!matches.length) continue;
      if (matches.length !== 1) throw new Error('Review undo is ambiguous for the bridged task');
      const result = await executeQuestionCommand({
        type: 'questions.undo_review',
        payload: { questionId, reviewLogId: matches[0].id }
      });
      undone.push({ questionId, result: reviewResult(result.reviewLog.result), note: result.reviewLog.note });
    }
  } catch (error) {
    await compensateUndoneReviews(undone, error);
  }
}

export async function completeTaskWithReviewSync(taskId: string): Promise<TickTickTask | null> {
  const previous = await getTickTickTask(taskId);
  const task = await completeTickTickTask(taskId);
  if (!task) return null;
  try {
    await syncTaskCompletedToReview(taskId, task.title, task.actual_minutes || task.estimated_minutes || 0);
    return task;
  } catch (error) {
    if (previous && previous.is_completed === 0) {
      try {
        await uncompleteTickTickTask(taskId);
      } catch (compensationError) {
        throw compensationFailure('Review sync failed and TickTick completion compensation failed', error, [compensationError]);
      }
    }
    throw error;
  }
}

export async function uncompleteTaskWithReviewSync(taskId: string): Promise<TickTickTask | null> {
  const previous = await getTickTickTask(taskId);
  const task = await uncompleteTickTickTask(taskId);
  if (!task) return null;
  try {
    await undoSyncTaskCompleted(taskId, task.title);
    return task;
  } catch (error) {
    if (previous && previous.is_completed === 1) {
      try {
        await completeTickTickTask(taskId);
      } catch (compensationError) {
        throw compensationFailure('Review undo failed and TickTick uncompletion compensation failed', error, [compensationError]);
      }
    }
    throw error;
  }
}

function getOrCreateDefaultList(database: import('sql.js').Database): string {
  const result = database.exec('SELECT id FROM ticktick_lists LIMIT 1');
  if (result.length && result[0].values.length) return result[0].values[0][0] as string;
  const listId = 'list_default';
  const timestamp = new Date().toISOString();
  database.run(
    "INSERT OR IGNORE INTO ticktick_lists (id, name, color, icon, sort_order, created_at, updated_at) VALUES (?, '收集箱', '#4a90d9', 'inbox', 0, ?, ?)",
    [listId, timestamp, timestamp]
  );
  return listId;
}
