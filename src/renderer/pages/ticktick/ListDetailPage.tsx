import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TickTickList, TickTickTask } from '../../../shared/types';
import { QuickAddBar } from '../../components/TickTick/QuickAddBar';
import { TaskRow } from '../../components/TickTick/TaskRow';
import { TaskDetailPanel } from '../../components/TickTick/TaskDetailPanel';

interface ListDetailPageProps {
  listId: string;
  onBack: () => void;
}

export function ListDetailPage({ listId, onBack }: ListDetailPageProps) {
  const [list, setList] = useState<TickTickList | null>(null);
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [allLists, setAllLists] = useState<TickTickList[]>([]);
  const [selectedTask, setSelectedTask] = useState<TickTickTask | null>(null);
  const [loading, setLoading] = useState(true);
  const versionRef = useRef(0);

  async function load() {
    const version = ++versionRef.current;
    setLoading(true);
    const [l, t, al] = await Promise.all([
      window.api.getTickTickList(listId),
      window.api.listTickTickTasks({ listId, includeCompleted: true }),
      window.api.listTickTickLists(),
    ]);
    if (version !== versionRef.current) return;
    setList(l);
    setTasks(t.filter(t => !t.parent_id));
    setAllLists(al);
    setLoading(false);
  }

  useEffect(() => { load(); }, [listId]);

  async function handleToggle(task: TickTickTask) {
    if (task.is_completed) await window.api.uncompleteTickTickTask(task.id);
    else await window.api.completeTickTickTask(task.id);
    await load();
  }

  if (loading) return <div className="ticktick-main-content"><div className="tt-empty">加载中...</div></div>;
  if (!list) return <div className="ticktick-main-content"><div className="tt-empty">清单不存在</div></div>;

  return (
    <>
      <div className="ticktick-main-content" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ padding: '14px 0 0', borderBottom: '1px solid var(--tt-border-light)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-secondary)' }} type="button">
                <ArrowLeft size={16} />
              </button>
              <span className="dot" style={{ width: 10, height: 10, borderRadius: '50%', background: list.color }} />
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{list.name}</h1>
              <span style={{ fontSize: 12, color: 'var(--tt-text-secondary)' }}>{tasks.length} 项任务</span>
            </div>
          </div>

          <QuickAddBar defaultListId={listId} lists={allLists} onTaskCreated={load} />

          {tasks.filter(t => !t.is_completed).map(task => (
            <TaskRow key={task.id} task={task} onClick={setSelectedTask} onToggle={handleToggle} />
          ))}
          {tasks.filter(t => t.is_completed).length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--tt-text-muted)', padding: '8px 0' }}>
                已完成 · {tasks.filter(t => t.is_completed).length}
              </div>
              {tasks.filter(t => t.is_completed).map(task => (
                <TaskRow key={task.id} task={task} onClick={setSelectedTask} onToggle={handleToggle} />
              ))}
            </div>
          ) : null}
          {tasks.length === 0 ? <div className="tt-empty">这个清单还没有任务</div> : null}
        </div>

        {selectedTask ? (
          <TaskDetailPanel task={selectedTask} lists={allLists} onClose={() => setSelectedTask(null)} onUpdated={load} />
        ) : null}
      </div>
    </>
  );
}
