import { useEffect, useState } from 'react';
import type { TickTickList, TickTickTask } from '../../../shared/types';
import { QuickAddBar } from '../../components/TickTick/QuickAddBar';
import { TaskRow } from '../../components/TickTick/TaskRow';
import { TaskDetailPanel } from '../../components/TickTick/TaskDetailPanel';
import { runLoad } from '../../../shared/loadState';

export function InboxPage() {
  const [lists, setLists] = useState<TickTickList[]>([]);
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<TickTickTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const outcome = await runLoad(async () => {
      const [l, all] = await Promise.all([
        window.api.listTickTickLists(),
        window.api.listTickTickTasks({ includeCompleted: false }),
      ]);
      return { l, all };
    }, '收集箱加载失败，请重试');
    if (outcome.ok) {
      setLists(outcome.value.l);
      // Only show tasks with no due date, no parent (top-level only)
      setTasks(outcome.value.all.filter(t => !t.due_date && !t.parent_id));
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleToggle(task: TickTickTask) {
    try {
      if (task.is_completed) {
        await window.api.uncompleteTickTickTask(task.id);
      } else {
        await window.api.completeTickTickTask(task.id);
      }
      await load();
    } catch (e) { console.error('InboxPage', e); }
  }

  if (loading) return <div className="ticktick-main-content"><div className="tt-empty">加载中...</div></div>;
  if (error) return (
    <div className="ticktick-main-content">
      <div className="tt-empty tt-load-error" role="alert">
        <div>{error}</div>
        <button type="button" className="tt-retry-btn" onClick={() => { setLoading(true); load(); }}>重试</button>
      </div>
    </div>
  );

  return (
    <>
      <div className="ticktick-main-content" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ padding: '14px 0 0', borderBottom: '1px solid var(--tt-border-light)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>收集箱</h1>
              <span style={{ fontSize: 12, color: 'var(--tt-text-secondary)' }}>{tasks.length} 项</span>
            </div>
          </div>

          <QuickAddBar lists={lists} onTaskCreated={load} />

          {tasks.length > 0 ? tasks.map(task => (
            <TaskRow key={task.id} task={task} onClick={setSelectedTask} onToggle={handleToggle} />
          )) : (
            <div className="tt-empty">收集箱是空的。在这里快速捕获想法和任务，稍后再整理。</div>
          )}
        </div>

        {selectedTask ? (
          <TaskDetailPanel task={selectedTask} lists={lists} onClose={() => setSelectedTask(null)} onUpdated={load} />
        ) : null}
      </div>
    </>
  );
}
