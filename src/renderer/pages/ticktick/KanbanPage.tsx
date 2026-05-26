import { useEffect, useState } from 'react';
import type { TickTickList, TickTickTask } from '../../../shared/types';
import { TaskDetailPanel } from '../../components/TickTick/TaskDetailPanel';

export function KanbanPage() {
  const [lists, setLists] = useState<TickTickList[]>([]);
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<TickTickTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragOverListId, setDragOverListId] = useState<string | null>(null);

  async function load() {
    const [l, t] = await Promise.all([
      window.api.listTickTickLists(),
      window.api.listTickTickTasks({ includeCompleted: false }),
    ]);
    setLists(l);
    setTasks(t.filter(t => !t.parent_id));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function moveTask(taskId: string, toListId: string) {
    await window.api.updateTickTickTask(taskId, { list_id: toListId } as any);
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, list_id: toListId } : t));
  }

  function handleDragStart(e: React.DragEvent, taskId: string) {
    e.dataTransfer.setData('taskId', taskId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragEnd() {
    setDragOverListId(null);
  }

  function handleDragOver(e: React.DragEvent, listId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverListId(listId);
  }

  function handleDragLeave() {
    setDragOverListId(null);
  }

  function handleDrop(e: React.DragEvent, listId: string) {
    e.preventDefault();
    setDragOverListId(null);
    const taskId = e.dataTransfer.getData('taskId');
    if (taskId) moveTask(taskId, listId);
  }

  function handleCardClick(e: React.MouseEvent, task: TickTickTask) {
    e.stopPropagation();
    setSelectedTask(task);
  }

  if (loading) return <div className="ticktick-main-content"><div className="tt-spinner" /></div>;

  return (
    <div className="ticktick-main-content" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 12, flex: 1, overflow: 'auto', paddingBottom: 16 }}>
        {lists.map(list => {
          const listTasks = tasks.filter(t => t.list_id === list.id);
          return (
            <div
              key={list.id}
              style={{
                flex: '0 0 280px', background: 'var(--tt-bg-sidebar)', borderRadius: 'var(--tt-radius-md)', padding: 12,
                maxHeight: '100%', overflow: 'auto', transition: 'box-shadow 0.2s',
                boxShadow: dragOverListId === list.id ? '0 0 0 2px var(--tt-accent)' : 'none',
              }}
              onDragOver={e => handleDragOver(e, list.id)}
              onDragLeave={handleDragLeave}
              onDrop={e => handleDrop(e, list.id)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '0 4px' }}>
                <span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', background: list.color, flexShrink: 0 }} />
                <strong style={{ fontSize: 13 }}>{list.name}</strong>
                <span style={{ fontSize: 11, color: 'var(--tt-text-muted)', marginLeft: 'auto' }}>{listTasks.length}</span>
              </div>
              {listTasks.map(task => (
                <div
                  key={task.id}
                  draggable
                  onDragStart={e => handleDragStart(e, task.id)}
                  onDragEnd={handleDragEnd}
                  style={{ background: 'var(--tt-bg)', borderRadius: 'var(--tt-radius-sm)', padding: '10px 12px', marginBottom: 6, cursor: 'grab', border: '1px solid var(--tt-border-light)', fontSize: 13, userSelect: 'none' }}
                  className="tt-kanban-card"
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <span style={{ flex: 1 }}>{task.title}</span>
                    <button
                      onClick={(e) => handleCardClick(e, task)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-muted)', padding: '0 0 0 8px', fontSize: 14, flexShrink: 0, lineHeight: 1 }}
                      type="button"
                      title="编辑任务"
                    >⋯</button>
                  </div>
                  {task.tags_list && task.tags_list.length > 0 ? (
                    <div style={{ fontSize: 10, color: 'var(--tt-accent)', marginTop: 4 }}>
                      {task.tags_list.slice(0, 3).map(t => `#${t}`).join(' ')}
                    </div>
                  ) : null}
                  {task.due_date ? <div style={{ fontSize: 10, color: 'var(--tt-text-muted)', marginTop: 2 }}>{task.due_date}</div> : null}
                </div>
              ))}
              {listTasks.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--tt-text-muted)', textAlign: 'center', padding: 12 }}>拖拽任务到此处</div>
              ) : null}
            </div>
          );
        })}
      </div>
      {selectedTask ? (
        <TaskDetailPanel task={selectedTask} lists={lists} onClose={() => setSelectedTask(null)} onUpdated={() => { setSelectedTask(null); load(); }} />
      ) : null}
    </div>
  );
}
