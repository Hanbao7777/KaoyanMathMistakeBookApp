import { CheckCircle2, ClipboardList, Plus, SkipForward, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StudyMaterial, StudyPriority, StudySubject, StudyTask, StudyTaskInput, StudyTaskStatus } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import { useModal } from '../components/Modal';
import { useToast } from '../components/Toast';

const taskTypes = ['看课', '刷题', '整理错题', '复习错题', '背诵', '阅读', '做笔记', '模拟测试', '整理资料', '其他'];
const statuses: StudyTaskStatus[] = ['未开始', '进行中', '部分完成', '已完成', '已跳过'];
const skipReasons = ['太难', '没时间', '不想做', '计划太多', '身体/状态不好', '资料没准备好', '其他'];
type CompletionRecordMode = 'estimated' | 'manual' | 'none';

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const emptyForm: StudyTaskInput = {
  task_date: localDate(),
  subject_id: 'math',
  material_id: null,
  title: '',
  task_type: '刷题',
  estimated_minutes: 60,
  actual_minutes: 0,
  priority: '中',
  status: '未开始',
  completion_quality: null,
  skipped_reason: null,
  note: ''
};

function statusTone(status: StudyTaskStatus) {
  if (status === '已完成') return 'success';
  if (status === '已跳过') return 'danger';
  if (status === '部分完成') return 'warning';
  if (status === '进行中') return 'primary';
  return 'muted';
}

export function DailyPlanPage() {
  const { toast } = useToast();
  const modal = useModal();
  const [subjects, setSubjects] = useState<StudySubject[]>([]);
  const [materials, setMaterials] = useState<StudyMaterial[]>([]);
  const [tasks, setTasks] = useState<StudyTask[]>([]);
  const [form, setForm] = useState<StudyTaskInput>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [pendingCompleteTask, setPendingCompleteTask] = useState<StudyTask | null>(null);
  const [completionRecordMode, setCompletionRecordMode] = useState<CompletionRecordMode>('estimated');
  const [manualMinutes, setManualMinutes] = useState(30);

  async function load() {
    const [nextSubjects, nextMaterials, nextTasks] = await Promise.all([
      window.api.listStudySubjects(),
      window.api.listStudyMaterials(),
      window.api.listStudyTasks({ date: localDate(), includeBeforeDate: true })
    ]);
    setSubjects(nextSubjects);
    setMaterials(nextMaterials);
    setTasks(nextTasks);
    if (nextSubjects.length && !nextSubjects.some((subject) => subject.id === form.subject_id)) {
      setForm((current) => ({ ...current, subject_id: nextSubjects[0].id }));
    }
  }

  useEffect(() => {
    load().catch((error) => toast(error.message, 'error'));
  }, []);

  const availableMaterials = useMemo(
    () => materials.filter((material) => material.subject_id === form.subject_id),
    [materials, form.subject_id]
  );

  async function saveTask() {
    if (!form.title.trim()) {
      toast('请填写任务标题', 'warning');
      return;
    }
    try {
      if (editingId) await window.api.updateStudyTask(editingId, form);
      else await window.api.createStudyTask(form);
      setForm({ ...emptyForm, task_date: localDate(), subject_id: subjects[0]?.id || 'math' });
      setEditingId(null);
      setMessage(editingId ? '任务已更新' : '任务已添加');
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function editTask(task: StudyTask) {
    setEditingId(task.id);
    setForm({
      task_date: task.task_date,
      subject_id: task.subject_id,
      material_id: task.material_id,
      title: task.title,
      task_type: task.task_type,
      estimated_minutes: task.estimated_minutes,
      actual_minutes: task.actual_minutes,
      priority: task.priority,
      status: task.status,
      completion_quality: task.completion_quality,
      skipped_reason: task.skipped_reason,
      note: task.note
    });
  }

  function openCompleteDialog(task: StudyTask) {
    const suggested = Math.max(1, task.estimated_minutes - task.actual_minutes || task.estimated_minutes || 30);
    setPendingCompleteTask(task);
    setCompletionRecordMode('estimated');
    setManualMinutes(suggested);
  }

  async function completeTask() {
    if (!pendingCompleteTask) return;
    const task = pendingCompleteTask;
    let addedMinutes = 0;
    if (completionRecordMode === 'estimated') addedMinutes = Math.max(1, task.estimated_minutes - task.actual_minutes || task.estimated_minutes || 30);
    if (completionRecordMode === 'manual') addedMinutes = Math.max(1, manualMinutes);

    if (completionRecordMode !== 'none') {
      const end = new Date();
      const start = new Date(end.getTime() - addedMinutes * 60000);
      await window.api.createStudySession({
        session_date: localDate(),
        subject_id: task.subject_id,
        task_id: task.id,
        material_id: task.material_id,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        duration_minutes: addedMinutes,
        quality: '良好',
        note: `每日计划直接完成：${task.title}`
      });
    }

    await window.api.completeStudyTask(task.id, {
      actual_minutes: task.actual_minutes + addedMinutes,
      completion_quality: '良好',
      note: task.note
    });
    setPendingCompleteTask(null);
    setMessage(completionRecordMode === 'none' ? '任务已完成，未计入学习时长' : `任务已完成，并计入 ${addedMinutes} 分钟学习时长`);
    await load();
  }

  async function skipTask(task: StudyTask) {
    const reason = prompt('强度监督模式下，跳过任务必须填写原因：', task.skipped_reason || skipReasons[0]);
    if (!reason) return;
    await window.api.skipStudyTask(task.id, reason);
    await load();
  }

  async function deleteTask(task: StudyTask) {
    const confirmed = await modal.confirm({ title: '操作确认', message: `确定删除任务「${task.title}」吗？`, confirmLabel: '删除', danger: true });
    if (!confirmed) return;
    await window.api.deleteStudyTask(task.id);
    await load();
  }

  const unfinished = tasks.filter((task) => !['已完成', '已跳过'].includes(task.status));
  const completed = tasks.filter((task) => ['已完成', '已跳过'].includes(task.status));

  return (
    <div className="page study-page daily-plan-page">
      <header className="page-header">
        <div>
          <h1>每日计划</h1>
          <p>今天的任务要具体、可执行；跳过必须留下原因。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => window.api.rolloverStudyTasks().then(load)}>执行自动延期</button>
      </header>

      <section className="section-card study-form-card">
        <div className="section-header compact">
          <h2><Plus size={18} /> {editingId ? '编辑任务' : '添加今日任务'}</h2>
          {editingId ? <button className="secondary-button compact-button" type="button" onClick={() => { setEditingId(null); setForm({ ...emptyForm, subject_id: subjects[0]?.id || 'math' }); }}>取消编辑</button> : null}
        </div>
        <div className="study-form-grid">
          <label>日期<input type="date" value={form.task_date} onChange={(event) => setForm({ ...form, task_date: event.target.value })} /></label>
          <label>科目
            <select value={form.subject_id} onChange={(event) => setForm({ ...form, subject_id: event.target.value, material_id: null })}>
              {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
            </select>
          </label>
          <label>关联资料
            <select value={form.material_id || ''} onChange={(event) => setForm({ ...form, material_id: event.target.value || null })}>
              <option value="">不关联资料</option>
              {availableMaterials.map((material) => <option key={material.id} value={material.id}>{material.name}</option>)}
            </select>
          </label>
          <label>任务类型
            <select value={form.task_type} onChange={(event) => setForm({ ...form, task_type: event.target.value })}>
              {taskTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label className="wide">任务标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：660题 极限部分 15 题" /></label>
          <label>预计分钟<input type="number" min={0} value={form.estimated_minutes} onChange={(event) => setForm({ ...form, estimated_minutes: Number(event.target.value) })} /></label>
          <label>实际分钟<input type="number" min={0} value={form.actual_minutes || 0} onChange={(event) => setForm({ ...form, actual_minutes: Number(event.target.value) })} /></label>
          <label>优先级
            <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as StudyPriority })}>
              {['高', '中', '低'].map((priority) => <option key={priority} value={priority}>{priority}</option>)}
            </select>
          </label>
          <label>状态
            <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as StudyTaskStatus })}>
              {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          {form.status === '已跳过' ? (
            <label>跳过原因
              <select value={form.skipped_reason || ''} onChange={(event) => setForm({ ...form, skipped_reason: event.target.value })}>
                <option value="">请选择原因</option>
                {skipReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
              </select>
            </label>
          ) : null}
          <label className="wide">备注<textarea rows={2} value={form.note || ''} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
        </div>
        <button className="primary-button" type="button" onClick={saveTask}>{editingId ? '保存修改' : '添加任务'}</button>
      </section>

      <section className="study-two-column">
        <article className="section-card">
          <div className="dashboard-card-header"><h2>今日必须任务</h2><ClipboardList size={20} /></div>
          {unfinished.length ? (
            <div className="task-list">
              {unfinished.map((task) => (
                <article className={`task-row tone-${task.delayLevel || 'normal'}`} key={task.id}>
                  <button type="button" onClick={() => editTask(task)}>
                    <strong>{task.title}</strong>
                    <span>{task.subject_name} · {task.task_type} · {task.estimated_minutes} 分钟 · 拖延 {task.defer_count} 天</span>
                  </button>
                  <em className={`status-pill tone-${statusTone(task.status)}`}>{task.status}</em>
                  <div className="task-actions">
                    <button className="icon-button" title="完成" type="button" onClick={() => openCompleteDialog(task)}><CheckCircle2 size={16} /></button>
                    <button className="icon-button" title="跳过" type="button" onClick={() => skipTask(task)}><SkipForward size={16} /></button>
                    <button className="icon-button danger" title="删除" type="button" onClick={() => deleteTask(task)}><Trash2 size={16} /></button>
                  </div>
                </article>
              ))}
            </div>
          ) : <EmptyState title="今日没有未完成任务" description="可以添加一个具体任务，或者进入专注计时开始记录。" />}
        </article>

        <article className="section-card">
          <div className="dashboard-card-header"><h2>已完成 / 已跳过</h2><CheckCircle2 size={20} /></div>
          {completed.length ? (
            <div className="task-list compact">
              {completed.map((task) => (
                <article className="task-row completed" key={task.id}>
                  <button type="button" onClick={() => editTask(task)}>
                    <strong>{task.title}</strong>
                    <span>{task.subject_name} · {task.status}{task.skipped_reason ? ` · 原因：${task.skipped_reason}` : ''}</span>
                  </button>
                  <em className={`status-pill tone-${statusTone(task.status)}`}>{task.status}</em>
                </article>
              ))}
            </div>
          ) : <EmptyState title="还没有完成记录" />}
        </article>
      </section>

      {message ? <div className="success-box">{message}</div> : null}

      {pendingCompleteTask ? (
        <div className="study-modal-backdrop">
          <div className="study-modal">
            <div className="section-header compact">
              <div>
                <h2>完成任务</h2>
                <p className="muted-text">如果这项任务没有开专注计时，可以在这里补记学习时长。</p>
              </div>
              <button className="secondary-button compact-button" type="button" onClick={() => setPendingCompleteTask(null)}>关闭</button>
            </div>

            <div className="completion-summary">
              <strong>{pendingCompleteTask.title}</strong>
              <span>{pendingCompleteTask.subject_name} · 预计 {pendingCompleteTask.estimated_minutes} 分钟 · 已记录 {pendingCompleteTask.actual_minutes} 分钟</span>
            </div>

            <div className="settlement-options">
              <button className={completionRecordMode === 'estimated' ? 'active' : ''} type="button" onClick={() => setCompletionRecordMode('estimated')}>
                <strong>按预计补记</strong>
                <span>按剩余预计时长计入今日学习目标。</span>
              </button>
              <button className={completionRecordMode === 'manual' ? 'active' : ''} type="button" onClick={() => setCompletionRecordMode('manual')}>
                <strong>手动填写</strong>
                <span>自己输入实际花了多少分钟。</span>
              </button>
              <button className={completionRecordMode === 'none' ? 'active' : ''} type="button" onClick={() => setCompletionRecordMode('none')}>
                <strong>只标记完成</strong>
                <span>不生成学习记录，不计入今日学习时长。</span>
              </button>
            </div>

            {completionRecordMode === 'manual' ? (
              <label>实际学习分钟
                <input type="number" min={1} value={manualMinutes} onChange={(event) => setManualMinutes(Number(event.target.value) || 1)} />
              </label>
            ) : null}

            <div className="form-actions">
              <button className="primary-button" type="button" onClick={() => completeTask().catch((error) => toast(error instanceof Error ? error.message : String(error), 'error'))}>确认完成</button>
              <button className="secondary-button" type="button" onClick={() => setPendingCompleteTask(null)}>取消</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
