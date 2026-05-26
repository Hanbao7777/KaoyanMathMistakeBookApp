import { useEffect, useState } from 'react';
import type { TickTickTask } from '../../../shared/types';
import { TaskRow } from '../../components/TickTick/TaskRow';

const quadrants = [
  { key: 'q1', title: '重要且紧急', subtitle: '立即处理', priority: '高' as const, color: '#e53935' },
  { key: 'q2', title: '重要不紧急', subtitle: '计划安排', priority: '中' as const, color: '#ff9800' },
  { key: 'q3', title: '不重要但紧急', subtitle: '委派处理', priority: '低' as const, color: '#4a90d9' },
  { key: 'q4', title: '不重要不紧急', subtitle: '最后处理', priority: 'none' as const, color: '#999999' },
];

export function EisenhowerPage() {
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const t = await window.api.listTickTickTasks({ includeCompleted: false });
    setTasks(t.filter(t => !t.parent_id));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleToggle(task: TickTickTask) {
    if (task.is_completed) await window.api.uncompleteTickTickTask(task.id);
    else await window.api.completeTickTickTask(task.id);
    await load();
  }

  if (loading) return <div className="ticktick-main-content"><div className="tt-spinner" /></div>;

  return (
    <div className="ticktick-main-content">
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>艾森豪威尔矩阵</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, flex: 1 }}>
        {quadrants.map(q => {
          const qTasks = tasks.filter(t => t.priority === q.priority);
          return (
            <div key={q.key} style={{ border: `2px solid ${q.color}20`, borderRadius: 'var(--tt-radius-lg)', padding: 16, background: 'var(--tt-bg)' }}>
              <div style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 14, color: q.color }}>{q.title}</strong>
                <span style={{ fontSize: 11, color: 'var(--tt-text-muted)', marginLeft: 8 }}>{q.subtitle}</span>
                <span style={{ float: 'right', fontSize: 12, color: 'var(--tt-text-secondary)' }}>{qTasks.length}</span>
              </div>
              {qTasks.length > 0 ? qTasks.map(task => (
                <TaskRow key={task.id} task={task} onClick={() => {}} onToggle={handleToggle} />
              )) : (
                <div style={{ fontSize: 12, color: 'var(--tt-text-muted)', padding: 20, textAlign: 'center' }}>暂无该优先级任务</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
