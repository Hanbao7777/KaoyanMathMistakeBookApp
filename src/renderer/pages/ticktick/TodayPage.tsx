import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TickTickList, TickTickTask } from '../../../shared/types';
import { QuickAddBar } from '../../components/TickTick/QuickAddBar';
import { TaskRow } from '../../components/TickTick/TaskRow';
import { TaskDetailPanel } from '../../components/TickTick/TaskDetailPanel';
import { AiDecompositionPanel, AiDailyPlanPanel, AiReviewPanel } from '../../components/TickTick/AiPanel';
import { useToast } from '../../components/Toast';

type GroupKey = 'overdue' | 'today' | 'upcoming' | 'completed';

export function TodayPage() {
  const { toast } = useToast();
  const [lists, setLists] = useState<TickTickList[]>([]);
  const [overdue, setOverdue] = useState<TickTickTask[]>([]);
  const [today, setToday] = useState<TickTickTask[]>([]);
  const [upcoming, setUpcoming] = useState<TickTickTask[]>([]);
  const [completed, setCompleted] = useState<TickTickTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<TickTickTask | null>(null);
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(new Set(['completed']));
  const [loading, setLoading] = useState(true);

  const versionRef = useRef(0);
  const togglingRef = useRef(false);

  async function load() {
    const version = ++versionRef.current;
    try {
      const [l, todayData] = await Promise.all([
        window.api.listTickTickLists(),
        window.api.getTodayTickTickTasks(),
      ]);
      if (version !== versionRef.current) return;
      setLists(l);
      setOverdue(todayData.overdue);
      setToday(todayData.today);
      setUpcoming(todayData.upcoming);

      // Load today's completed tasks (by completion date, not just due date)
      const todayLocal = new Date();
      const todayStr2 = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}-${String(todayLocal.getDate()).padStart(2, '0')}`;
      const allCompleted = await window.api.listTickTickTasks({ includeCompleted: true });
      if (version !== versionRef.current) return;
      setCompleted(allCompleted.filter(t => t.is_completed && !t.parent_id && t.completed_at && t.completed_at.startsWith(todayStr2)));
    } catch (e) { console.error('TodayPage', e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleToggle(task: TickTickTask) {
    if (togglingRef.current) return;
    togglingRef.current = true;

    const newCompleted = task.is_completed ? 0 : 1;
    // Optimistic update for all three groups
    setOverdue(prev => prev.map(t => t.id === task.id ? { ...t, is_completed: newCompleted } : t));
    setToday(prev => prev.map(t => t.id === task.id ? { ...t, is_completed: newCompleted } : t));
    setUpcoming(prev => prev.map(t => t.id === task.id ? { ...t, is_completed: newCompleted } : t));

    try {
      if (task.is_completed) {
        await window.api.uncompleteTickTickTask(task.id);
        // Also undo sync
        try { await window.api.undoReviewTaskSync(task.id, task.title); } catch {}
      } else {
        await window.api.completeTickTickTask(task.id);
        // Sync to mistake book review via bridge
        const bridges = await window.api.getTickTickTaskBridges(task.id);
        if (bridges.some(b => b.sync_review)) {
          try {
            await window.api.syncTickTickTaskCompletedToReview(task.id, task.title, task.estimated_minutes || 25);
          } catch (e) { console.error('Sync review failed:', e); }
        }
      }
      versionRef.current++;
      await load();
    } catch (e) {
      console.error('TodayPage:toggle', e);
      toast('操作失败，请重试', 'error');
      await load();
    } finally {
      togglingRef.current = false;
    }
  }

  function toggleCollapse(group: GroupKey) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function handleTaskClick(task: TickTickTask) {
    setSelectedTask(task);
  }

  async function handleTaskUpdated() {
    setSelectedTask(null);
    await load();
  }

  const todayDate = new Date();
  const todayStr = `${todayDate.getFullYear()}年${todayDate.getMonth() + 1}月${todayDate.getDate()}日`;
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekdayStr = `周${weekdays[todayDate.getDay()]}`;

  if (loading) return <div className="ticktick-main-content"><div className="tt-empty"><div className="tt-spinner" />加载中...</div></div>;

  const completedCount = completed.length;

  return (
    <>
      <div className="ticktick-main-content" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {/* Header */}
          <div style={{ padding: '14px 0 0', borderBottom: '1px solid var(--tt-border-light)', marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>今天</h1>
              <span style={{ fontSize: 12, color: 'var(--tt-text-secondary)' }}>{todayStr} {weekdayStr}</span>
              {completedCount > 0 ? <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--tt-text-secondary)' }}>{completedCount} 已完成</span> : null}
            </div>
          </div>

          {/* Quick Add */}
          <QuickAddBar defaultListId={lists.length > 0 ? lists[0].id : undefined} lists={lists} onTaskCreated={load} />

          {/* Overdue */}
          {overdue.length > 0 ? (
            <div className="tt-task-group">
              <button className={`tt-task-group-header ${collapsed.has('overdue') ? 'collapsed' : ''}`} onClick={() => toggleCollapse('overdue')} type="button">
                <ChevronDown size={12} className="chevron" />
                <span className="label overdue">过期</span>
                <span className="count">{overdue.length}</span>
              </button>
              {!collapsed.has('overdue') && overdue.map(task => (
                <TaskRow key={task.id} task={task} onClick={handleTaskClick} onToggle={handleToggle} />
              ))}
            </div>
          ) : null}

          {/* Today */}
          <div className="tt-task-group">
            <button className={`tt-task-group-header ${collapsed.has('today') ? 'collapsed' : ''}`} onClick={() => toggleCollapse('today')} type="button">
              <ChevronDown size={12} className="chevron" />
              <span className="label today">今天</span>
              <span className="count">{today.length}</span>
            </button>
            {!collapsed.has('today') && (today.length > 0 ? today.map(task => (
              <TaskRow key={task.id} task={task} onClick={handleTaskClick} onToggle={handleToggle} />
            )) : (
              <div className="tt-empty">今天还没有任务，在上方输入框添加一个吧</div>
            ))}
          </div>

          {/* Upcoming */}
          {upcoming.length > 0 ? (
            <div className="tt-task-group">
              <button className={`tt-task-group-header ${collapsed.has('upcoming') ? 'collapsed' : ''}`} onClick={() => toggleCollapse('upcoming')} type="button">
                <ChevronDown size={12} className="chevron" />
                <span className="label upcoming">即将到来</span>
                <span className="count">{upcoming.length}</span>
              </button>
              {!collapsed.has('upcoming') && upcoming.map(task => (
                <TaskRow key={task.id} task={task} onClick={handleTaskClick} onToggle={handleToggle} />
              ))}
            </div>
          ) : null}

          {/* Completed */}
          {completed.length > 0 ? (
            <div className="tt-task-group" style={{ opacity: 0.6 }}>
              <button className={`tt-task-group-header ${collapsed.has('completed') ? 'collapsed' : ''}`} onClick={() => toggleCollapse('completed')} type="button">
                <ChevronDown size={12} className="chevron" />
                <span className="label">已完成</span>
                <span className="count">{completed.length}</span>
              </button>
              {!collapsed.has('completed') && completed.map(task => (
                <TaskRow key={task.id} task={task} onClick={handleTaskClick} onToggle={handleToggle} />
              ))}
            </div>
          ) : null}
          {/* AI Panels */}
          <AiDecompositionPanel lists={lists} onTasksCreated={load} />
          <AiDailyPlanPanel lists={lists} onTasksCreated={load} />
          <AiReviewPanel />
        </div>

        {/* Detail Panel */}
        {selectedTask ? (
          <TaskDetailPanel
            task={selectedTask}
            lists={lists}
            onClose={() => setSelectedTask(null)}
            onUpdated={handleTaskUpdated}
          />
        ) : null}
      </div>
    </>
  );
}
