import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '../Toast';
import type { TickTickAiDailyPlanResult, TickTickAiDecompositionResult, TickTickAiReviewResult, TickTickList } from '../../../shared/types';

export function AiDecompositionPanel({ lists, onTasksCreated }: { lists: TickTickList[]; onTasksCreated: () => void }) {
  const { toast } = useToast();
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [goal, setGoal] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TickTickAiDecompositionResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  async function handleDecompose() {
    if (!goal.trim()) { toast('请输入学习目标', 'warning'); return; }
    setLoading(true);
    try {
      const res = await window.api.aiDecomposeTask({ goal: goal.trim() });
      if (!mountedRef.current) return;
      setResult(res);
      setSelected(new Set(res.subtasks.map((_, i) => i)));
    } catch (e: any) { if (mountedRef.current) toast(e.message || 'AI 请求失败', 'error'); }
    if (mountedRef.current) setLoading(false);
  }

  async function handleCreate() {
    if (!result) return;
    const listId = lists.length > 0 ? lists[0].id : '';
    let created = 0;
    for (const i of selected) {
      const subtask = result.subtasks[i];
      try {
        // Compute due_date from deadline_days
        let due_date: string | null = null;
        if (subtask.deadline_days != null && subtask.deadline_days >= 0) {
          const d = new Date();
          d.setDate(d.getDate() + subtask.deadline_days);
          due_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
        await window.api.createTickTickTask({
          list_id: listId,
          title: subtask.title,
          estimated_minutes: subtask.estimated_minutes || (subtask.estimated_days * 60),
          priority: subtask.priority || 'none',
          due_date: due_date,
          tags: subtask.tags,
          source: 'ai_plan',
        });
        created++;
      } catch { /* skip failures */ }
    }
    if (!mountedRef.current) return;
    toast(`已创建 ${created} 个任务`, 'success');
    setResult(null);
    setGoal('');
    onTasksCreated();
  }

  return (
    <div className="tt-ai-panel">
      <h3><Sparkles size={16} style={{ marginRight: 6 }} />AI 任务拆解</h3>
      {!result ? (
        <>
          <input
            type="text"
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder="例如：复习完高数上册"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 'var(--tt-radius-sm)', border: '1px solid var(--tt-border)', background: 'var(--tt-bg)', color: 'var(--tt-text)', fontSize: 13, marginBottom: 8, boxSizing: 'border-box' }}
            onKeyDown={e => { if (e.key === 'Enter') handleDecompose(); }}
          />
          <button onClick={handleDecompose} disabled={loading} style={{ padding: '8px 16px', borderRadius: 'var(--tt-radius-sm)', border: 'none', background: 'var(--tt-accent)', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 }} type="button">
            {loading ? '拆解中...' : '拆解任务'}
          </button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: 'var(--tt-text-secondary)', marginBottom: 8 }}>
            共 {result.total_days} 天 · {result.subtasks.length} 个子任务
          </p>
          <div className="tt-ai-plan-tasks">
            {result.subtasks.map((task, i) => (
              <div key={i} className="tt-ai-plan-task" style={{ cursor: 'pointer' }} onClick={() => {
                const next = new Set(selected);
                if (next.has(i)) next.delete(i); else next.add(i);
                setSelected(next);
              }}>
                <input type="checkbox" checked={selected.has(i)} readOnly style={{ accentColor: 'var(--tt-accent)' }} />
                <span style={{ flex: 1 }}>{task.title}</span>
                <span className="time-block">{task.estimated_days}天</span>
              </div>
            ))}
          </div>
          <button onClick={handleCreate} style={{ padding: '8px 16px', borderRadius: 'var(--tt-radius-sm)', border: 'none', background: 'var(--tt-accent)', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 }} type="button">
            创建选中任务 ({selected.size})
          </button>
        </>
      )}
    </div>
  );
}

export function AiDailyPlanPanel({ lists, onTasksCreated }: { lists: TickTickList[]; onTasksCreated: () => void }) {
  const { toast } = useToast();
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TickTickAiDailyPlanResult | null>(null);

  async function handleGenerate() {
    setLoading(true);
    try {
      const res = await window.api.aiGenerateDailyPlan();
      if (!mountedRef.current) return;
      setResult(res);
    } catch (e: any) { if (mountedRef.current) toast(e.message || 'AI 请求失败', 'error'); }
    if (mountedRef.current) setLoading(false);
  }

  async function handleAccept() {
    if (!result) return;
    const listId = lists.length > 0 ? lists[0].id : '';
    let created = 0;
    for (const task of result.suggested_tasks) {
      try {
        await window.api.createTickTickTask({
          list_id: listId,
          title: task.title,
          priority: task.priority,
          estimated_minutes: task.estimated_minutes,
          source: 'ai_plan',
        });
        created++;
      } catch { /* skip */ }
    }
    if (!mountedRef.current) return;
    toast(`已添加 ${created} 个建议任务`, 'success');
    setResult(null);
    onTasksCreated();
  }

  return (
    <div className="tt-ai-panel">
      <h3><Sparkles size={16} style={{ marginRight: 6 }} />AI 今日计划</h3>
      {!result ? (
        <button onClick={handleGenerate} disabled={loading} style={{ padding: '8px 16px', borderRadius: 'var(--tt-radius-sm)', border: 'none', background: 'var(--tt-accent)', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 }} type="button">
          {loading ? '生成中...' : '生成今日计划'}
        </button>
      ) : (
        <>
          <p style={{ fontSize: 12, color: 'var(--tt-text-secondary)', marginBottom: 8 }}>{result.summary}</p>
          <div className="tt-ai-plan-tasks">
            {result.suggested_tasks.map((task, i) => (
              <div key={i} className="tt-ai-plan-task">
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13 }}>{task.title}</div>
                  <div style={{ fontSize: 10, color: 'var(--tt-text-muted)' }}>{task.reason}</div>
                </div>
                <span className="time-block">{task.time_block}</span>
                <span style={{ fontSize: 11, color: 'var(--tt-text-secondary)' }}>{task.estimated_minutes}分</span>
              </div>
            ))}
          </div>
          <button onClick={handleAccept} style={{ padding: '8px 16px', borderRadius: 'var(--tt-radius-sm)', border: 'none', background: 'var(--tt-accent)', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 }} type="button">
            全部添加到今天
          </button>
        </>
      )}
    </div>
  );
}

export function AiReviewPanel() {
  const { toast } = useToast();
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TickTickAiReviewResult | null>(null);
  const [type, setType] = useState<'daily' | 'weekly'>('daily');

  async function handleReview(reviewType: 'daily' | 'weekly') {
    setType(reviewType);
    setLoading(true);
    try {
      const res = await window.api.aiGenerateReview(reviewType);
      if (!mountedRef.current) return;
      setResult(res);
    } catch (e: any) { if (mountedRef.current) toast(e.message || 'AI 请求失败', 'error'); }
    if (mountedRef.current) setLoading(false);
  }

  return (
    <div className="tt-ai-panel">
      <h3><Sparkles size={16} style={{ marginRight: 6 }} />AI 复盘</h3>
      {!result ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => handleReview('daily')} disabled={loading} style={{ padding: '8px 16px', borderRadius: 'var(--tt-radius-sm)', border: 'none', background: 'var(--tt-accent)', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 }} type="button">
            {loading && type === 'daily' ? '分析中...' : '今日复盘'}
          </button>
          <button onClick={() => handleReview('weekly')} disabled={loading} style={{ padding: '8px 16px', borderRadius: 'var(--tt-radius-sm)', border: '1px solid var(--tt-border)', background: 'var(--tt-bg)', color: 'var(--tt-text)', cursor: 'pointer', fontSize: 13 }} type="button">
            {loading && type === 'weekly' ? '分析中...' : '本周复盘'}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <div><strong>{result.completion_rate}%</strong><br /><span style={{ fontSize: 10, color: 'var(--tt-text-muted)' }}>完成率</span></div>
            <div><strong>{result.total_focus_minutes}分</strong><br /><span style={{ fontSize: 10, color: 'var(--tt-text-muted)' }}>专注时长</span></div>
            <div><strong>{result.correct_rate}%</strong><br /><span style={{ fontSize: 10, color: 'var(--tt-text-muted)' }}>正确率</span></div>
          </div>
          {result.weak_points.length > 0 ? (
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--tt-text-muted)' }}>薄弱点: </span>
              {result.weak_points.map((p, i) => <span key={i} style={{ fontSize: 11, background: 'var(--tt-bg-input)', padding: '1px 6px', borderRadius: 3, marginRight: 4 }}>{p}</span>)}
            </div>
          ) : null}
          <p style={{ color: 'var(--tt-text-secondary)', lineHeight: 1.6 }}>{result.suggestion}</p>
          <button onClick={() => setResult(null)} style={{ marginTop: 8, padding: '4px 12px', borderRadius: 'var(--tt-radius-sm)', border: '1px solid var(--tt-border)', background: 'var(--tt-bg)', color: 'var(--tt-text-secondary)', cursor: 'pointer', fontSize: 12 }} type="button">关闭</button>
        </div>
      )}
    </div>
  );
}
