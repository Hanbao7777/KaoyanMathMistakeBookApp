import { getDatabase, persistDatabase, submitReviewResult } from './databaseService';
import { getTickTickSettings, getBridgesForLinked } from './ticktickService';
import type { TickTickBridgeLinkedType } from '../../shared/types';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Path 1: TickTick task completed → write review log to mistake book
export async function syncTaskCompletedToReview(ticktickTaskId: string, taskTitle: string, actualMinutes: number): Promise<void> {
  const db = await getDatabase();

  const bridgeResult = db.exec('SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? AND sync_review = 1', [ticktickTaskId]);
  if (!bridgeResult.length || !bridgeResult[0].values.length) return;

  const now = new Date().toISOString();
  const reviewDate = todayStr();

  for (const row of bridgeResult[0].values) {
    const linkedType = row[2] as string;
    const linkedId = row[3] as string;

    if (linkedType === 'question') {
      const questionId = parseInt(linkedId, 10);
      if (isNaN(questionId)) continue;

      // Check if already synced today to avoid duplicates
      const escapedTitle = taskTitle.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const existing = db.exec(
        "SELECT id FROM review_logs WHERE question_id = ? AND review_date = ? AND note LIKE ? ESCAPE '\\'",
        [questionId, reviewDate, `%TickTick 任务完成: ${escapedTitle}%`]
      );
      if (existing.length && existing[0].values.length) continue;

      // Use submitReviewResult for proper SM2 scheduling
      try {
        await submitReviewResult({
          questionId,
          result: 'correct',
          note: `TickTick 任务完成: ${taskTitle}`,
        });
      } catch (e) {
        console.error('bridgeService: submitReviewResult failed', e);
      }
    } else if (linkedType === 'study_task') {
      db.run(
        "UPDATE study_tasks SET status = '已完成', actual_minutes = actual_minutes + ?, completed_at = ?, updated_at = ? WHERE id = ?",
        [actualMinutes, now, now, linkedId]
      );
    }
  }

  persistDatabase();
}

// Path 2: Review from mistake book → update TickTick task
export async function syncReviewToTickTickTask(linkedType: TickTickBridgeLinkedType, linkedId: string): Promise<void> {
  const bridges = await getBridgesForLinked(linkedType, linkedId);
  const db = await getDatabase();
  const now = new Date().toISOString();

  for (const bridge of bridges) {
    const taskResult = db.exec(
      'SELECT * FROM ticktick_tasks WHERE id = ? AND is_completed = 0',
      [bridge.ticktick_task_id]
    );
    if (!taskResult.length || !taskResult[0].values.length) continue;

    db.run(
      'UPDATE ticktick_tasks SET is_completed = 1, completed_at = ?, updated_at = ? WHERE id = ? AND is_completed = 0',
      [now, now, bridge.ticktick_task_id]
    );
  }

  persistDatabase();
}

// Path 3: Mastery changed → adjust TickTick task priority
export async function syncMasteryToTaskPriority(knowledgeNodeId: string, newMasteryScore: number): Promise<void> {
  const bridges = await getBridgesForLinked('knowledge_point', knowledgeNodeId);
  const db = await getDatabase();
  const now = new Date().toISOString();

  for (const bridge of bridges) {
    if (!bridge.sync_mastery) continue;
    const newPriority = newMasteryScore >= 4 ? '低' : newMasteryScore >= 3 ? '中' : '高';
    db.run(
      'UPDATE ticktick_tasks SET priority = ?, updated_at = ? WHERE id = ? AND is_completed = 0',
      [newPriority, now, bridge.ticktick_task_id]
    );
  }

  persistDatabase();
}

// Path 4: Auto-create review tasks from mistake book due reviews
export async function generateAutoReviewTasks(): Promise<{ created: number }> {
  const settings = await getTickTickSettings();
  if (!settings.autoCreateReviewTasks) return { created: 0 };

  const db = await getDatabase();
  const today = todayStr();

  // Find questions due for review today
  const dueResult = db.exec(
    `SELECT q.id, q.title, q.subject, kp.node_id, kp.title as kp_title
     FROM questions q
     LEFT JOIN question_knowledge_points qkp ON q.id = qkp.question_id
     LEFT JOIN knowledge_points kp ON qkp.knowledge_node_id = kp.node_id
     WHERE q.next_review_at IS NOT NULL AND date(q.next_review_at) <= ?
     ORDER BY q.next_review_at ASC
     LIMIT 20`,
    [today]
  );

  if (!dueResult.length || !dueResult[0].values.length) return { created: 0 };

  // Check which questions already have an uncompleted auto-review task
  const existingResult = db.exec(
    `SELECT linked_id FROM ticktick_bridge
     WHERE linked_type = 'question'
     AND ticktick_task_id IN (SELECT id FROM ticktick_tasks WHERE source = 'auto_review' AND is_completed = 0)`
  );
  const existingIds = new Set(
    existingResult.length ? existingResult[0].values.map((r) => String(r[0])) : []
  );

  let created = 0;
  const defaultListId = settings.defaultListId || await getOrCreateDefaultList(db);

  for (const row of dueResult[0].values) {
    const questionId = String(row[0]);
    if (existingIds.has(questionId)) continue;

    const questionTitle = row[1] as string;
    const kpTitle = row[4] as string;
    const title = kpTitle ? `复习错题: ${kpTitle}` : `复习错题: ${questionTitle}`;

    const taskId = `task_${Date.now()}_${created}`;
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO ticktick_tasks (id, list_id, title, due_date, priority, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, '高', 'auto_review', ?, ?)`,
      [taskId, defaultListId, title, today, now, now]
    );

    db.run(
      'INSERT INTO ticktick_bridge (ticktick_task_id, linked_type, linked_id, sync_review, sync_mastery) VALUES (?, ?, ?, 1, 0)',
      [taskId, 'question', questionId]
    );

    created++;
  }

  persistDatabase();
  return { created };
}

// Path 5: Undo review sync when task is uncompleted
export async function undoSyncTaskCompleted(ticktickTaskId: string, taskTitle: string): Promise<void> {
  const db = await getDatabase();
  const today = todayStr();
  // Remove review_logs created by this task today
  db.run(
    "DELETE FROM review_logs WHERE review_date = ? AND note LIKE ? ESCAPE '\\'",
    [today, `%TickTick 任务完成: ${taskTitle.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`]
  );
  persistDatabase();
}

async function getOrCreateDefaultList(db: import('sql.js').Database): Promise<string> {
  const result = db.exec("SELECT id FROM ticktick_lists LIMIT 1");
  if (result.length && result[0].values.length) return result[0].values[0][0] as string;

  const listId = 'list_default';
  const now = new Date().toISOString();
  db.run(
    "INSERT OR IGNORE INTO ticktick_lists (id, name, color, icon, sort_order, created_at, updated_at) VALUES (?, '收集箱', '#4a90d9', 'inbox', 0, ?, ?)",
    [listId, now, now]
  );
  return listId;
}
