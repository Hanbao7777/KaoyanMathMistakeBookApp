import type { ReadOnlyDatabaseFacade } from '../queryBus';
import type { StudyTask } from '../../../shared/types';
import type { StudyQuery, StudyQueryValues } from './contracts';
import { isCanonicalStudyDate } from '../../../shared/agent/v1/schemas';
function rows<T>(database: ReadOnlyDatabaseFacade, sql: string, values: readonly unknown[] = []): readonly T[] { return database.select(sql, values as never) as unknown as readonly T[]; }
function weekStart(day: string): string { if (!isCanonicalStudyDate(day)) throw new Error('Invalid study date'); const value = new Date(`${day}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7)); return value.toISOString().slice(0, 10); }
export function executeStudyQuery<Q extends StudyQuery>(query: Q, database: ReadOnlyDatabaseFacade, today: () => string): StudyQueryValues[Q['type']] {
  const selected = query.payload.date ?? today();
  if (!isCanonicalStudyDate(selected)) throw new Error('Invalid study date');
  if (query.type === 'study.get_today') {
    const unfinishedTasks = rows<StudyTask>(database, "SELECT * FROM study_tasks WHERE task_date=? AND status NOT IN ('已完成','已跳过') ORDER BY created_at, id LIMIT 50", [selected]);
    const taskStats = rows<{ totalTasks: number; completedTasks: number }>(database, "SELECT COUNT(*) AS totalTasks, COALESCE(SUM(CASE WHEN status IN ('已完成','已跳过') THEN 1 ELSE 0 END),0) AS completedTasks FROM study_tasks WHERE task_date=?", [selected])[0];
    const minutes = Number(rows<{ value: number }>(database, 'SELECT COALESCE(SUM(duration_minutes),0) AS value FROM study_sessions WHERE session_date=?', [selected])[0]?.value ?? 0);
    const target = Number(rows<{ value: number }>(database, 'SELECT daily_target_minutes AS value FROM study_settings WHERE id=1')[0]?.value ?? 240);
    return { date: selected, dailyTargetMinutes: target, totalMinutes: minutes, completedTasks: Number(taskStats?.completedTasks ?? 0), totalTasks: Number(taskStats?.totalTasks ?? 0), unfinishedTasks } as unknown as StudyQueryValues[Q['type']];
  }
  const start = weekStart(selected);
  const daily = rows<{ date: string; minutes: number; completedTasks: number; totalTasks: number }>(database, `SELECT d.date, COALESCE(s.minutes,0) AS minutes, COALESCE(t.completedTasks,0) AS completedTasks, COALESCE(t.totalTasks,0) AS totalTasks FROM (SELECT ? AS date UNION SELECT date(?, '+1 day') UNION SELECT date(?, '+2 day') UNION SELECT date(?, '+3 day') UNION SELECT date(?, '+4 day') UNION SELECT date(?, '+5 day') UNION SELECT date(?, '+6 day')) d LEFT JOIN (SELECT session_date, SUM(duration_minutes) minutes FROM study_sessions WHERE session_date BETWEEN ? AND ? GROUP BY session_date) s ON s.session_date=d.date LEFT JOIN (SELECT task_date, SUM(CASE WHEN status IN ('已完成','已跳过') THEN 1 ELSE 0 END) completedTasks, COUNT(*) totalTasks FROM study_tasks WHERE task_date BETWEEN ? AND ? GROUP BY task_date) t ON t.task_date=d.date WHERE d.date <= ? ORDER BY d.date`, [start, start, start, start, start, start, start, start, selected, start, selected, selected]);
  return { weekStart: start, weekEnd: selected, totalMinutes: daily.reduce((sum, entry) => sum + Number(entry.minutes), 0), completedTasks: daily.reduce((sum, entry) => sum + Number(entry.completedTasks), 0), totalTasks: daily.reduce((sum, entry) => sum + Number(entry.totalTasks), 0), daily } as unknown as StudyQueryValues[Q['type']];
}
