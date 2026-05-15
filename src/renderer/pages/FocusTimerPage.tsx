import { Pause, Play, RotateCcw, Save, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StudyMaterial, StudyQuality, StudySession, StudySubject, StudyTask } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import type { FocusTimerControls, FocusTimerState } from '../types/focusTimer';

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatSeconds(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':');
}

function tomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

type SettlementAction = 'completed' | 'partial' | 'record';

interface FocusTimerPageProps {
  timer: FocusTimerState;
  controls: FocusTimerControls;
}

export function FocusTimerPage({ timer, controls }: FocusTimerPageProps) {
  const [subjects, setSubjects] = useState<StudySubject[]>([]);
  const [materials, setMaterials] = useState<StudyMaterial[]>([]);
  const [tasks, setTasks] = useState<StudyTask[]>([]);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [message, setMessage] = useState('');
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [settlementAction, setSettlementAction] = useState<SettlementAction>('record');
  const [remainingWork, setRemainingWork] = useState('');
  const [createTailTask, setCreateTailTask] = useState(true);
  const [tailMinutes, setTailMinutes] = useState(30);

  async function load() {
    const [nextSubjects, nextMaterials, nextTasks, nextSessions] = await Promise.all([
      window.api.listStudySubjects(),
      window.api.listStudyMaterials(),
      window.api.listStudyTasks({ date: localDate() }),
      window.api.listStudySessions({ date: localDate() })
    ]);
    setSubjects(nextSubjects);
    setMaterials(nextMaterials);
    setTasks(nextTasks);
    setSessions(nextSessions);
    if (nextSubjects.length && !nextSubjects.some((subject) => subject.id === timer.subjectId)) {
      controls.update({ subjectId: nextSubjects[0].id, subjectName: nextSubjects[0].name });
    }
  }

  useEffect(() => {
    load().catch((error) => alert(error.message));
  }, []);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === timer.taskId), [tasks, timer.taskId]);
  const availableMaterials = useMemo(() => materials.filter((material) => material.subject_id === timer.subjectId), [materials, timer.subjectId]);
  const todayMinutes = sessions.reduce((sum, session) => sum + session.duration_minutes, 0);

  function reset() {
    if (timer.status === 'running' && !confirm('计时正在进行，确定重置吗？')) return;
    controls.reset();
  }

  async function saveSession(action: SettlementAction = 'record') {
    const duration = Math.max(1, Math.round(controls.elapsedSeconds / 60));
    if (!timer.startedAt || controls.elapsedSeconds <= 0) {
      alert('请先开始计时');
      return;
    }
    if (action === 'partial' && !remainingWork.trim()) {
      alert('请填写还剩什么没完成');
      return;
    }
    const finalMaterialId = selectedTask?.material_id || timer.materialId || null;
    await window.api.createStudySession({
      session_date: localDate(),
      subject_id: selectedTask?.subject_id || timer.subjectId,
      task_id: timer.taskId || null,
      material_id: finalMaterialId,
      start_time: timer.startedAt,
      end_time: new Date().toISOString(),
      duration_minutes: duration,
      quality: timer.quality,
      note: timer.note
    });

    if (selectedTask && action === 'completed') {
      await window.api.completeStudyTask(selectedTask.id, {
        actual_minutes: selectedTask.actual_minutes + duration,
        completion_quality: timer.quality,
        note: timer.note || selectedTask.note
      });
    }

    if (selectedTask && action === 'partial') {
      const nextNote = [
        selectedTask.note,
        `部分完成剩余：${remainingWork.trim()}`
      ].filter(Boolean).join('\n');
      await window.api.updateStudyTask(selectedTask.id, {
        task_date: selectedTask.task_date,
        subject_id: selectedTask.subject_id,
        material_id: selectedTask.material_id,
        title: selectedTask.title,
        task_type: selectedTask.task_type,
        estimated_minutes: selectedTask.estimated_minutes,
        actual_minutes: selectedTask.actual_minutes + duration,
        priority: selectedTask.priority,
        status: '部分完成',
        completion_quality: timer.quality,
        skipped_reason: selectedTask.skipped_reason,
        note: nextNote
      });

      if (createTailTask) {
        await window.api.createStudyTask({
          task_date: tomorrowDate(),
          subject_id: selectedTask.subject_id,
          material_id: selectedTask.material_id,
          title: `补完：${selectedTask.title}`,
          task_type: selectedTask.task_type,
          estimated_minutes: tailMinutes,
          actual_minutes: 0,
          priority: selectedTask.priority,
          status: '未开始',
          completion_quality: null,
          skipped_reason: null,
          note: remainingWork.trim()
        });
      }
    }

    setMessage(`已保存 ${duration} 分钟学习记录`);
    setSettlementOpen(false);
    setRemainingWork('');
    setCreateTailTask(true);
    setTailMinutes(30);
    controls.reset();
    await load();
  }

  function requestEndSession() {
    if (!timer.startedAt || controls.elapsedSeconds <= 0) {
      alert('请先开始计时');
      return;
    }
    if (timer.status === 'running') controls.pause();
    if (!selectedTask) {
      saveSession('record').catch((error) => alert(error instanceof Error ? error.message : String(error)));
      return;
    }
    const duration = Math.max(1, Math.round(controls.elapsedSeconds / 60));
    const total = selectedTask.actual_minutes + duration;
    setSettlementAction(total >= selectedTask.estimated_minutes ? 'partial' : 'record');
    setSettlementOpen(true);
  }

  function chooseTask(nextTaskId: string) {
    const task = tasks.find((item) => item.id === nextTaskId);
    if (task) {
      controls.update({
        taskId: task.id,
        taskTitle: task.title,
        subjectId: task.subject_id,
        subjectName: task.subject_name || '',
        materialId: task.material_id || '',
        materialName: task.material_name || ''
      });
    } else {
      controls.update({ taskId: '', taskTitle: '' });
    }
  }

  function chooseSubject(nextSubjectId: string) {
    const subject = subjects.find((item) => item.id === nextSubjectId);
    controls.update({
      subjectId: nextSubjectId,
      subjectName: subject?.name || '',
      taskId: '',
      taskTitle: '',
      materialId: '',
      materialName: ''
    });
  }

  function chooseMaterial(nextMaterialId: string) {
    const material = materials.find((item) => item.id === nextMaterialId);
    controls.update({ materialId: nextMaterialId, materialName: material?.name || '' });
  }

  return (
    <div className="page study-page focus-page">
      <header className="page-header">
        <div>
          <h1>专注计时</h1>
          <p>选择任务或科目开始计时，结束后写入学习记录并累计到今日学习时长。</p>
        </div>
      </header>

      <section className="focus-layout">
        <article className="section-card focus-timer-card">
          {timer.restored ? (
            <div className="warning-box compact">检测到上次未结束的专注计时，已自动恢复。可以继续、暂停、结束保存或重置。</div>
          ) : null}
          <div className="timer-display">{formatSeconds(controls.elapsedSeconds)}</div>
          <div className="timer-controls">
            {timer.status !== 'running' ? <button className="primary-button" type="button" onClick={controls.start}><Play size={16} />开始/继续</button> : <button className="secondary-button" type="button" onClick={controls.pause}><Pause size={16} />暂停</button>}
            <button className="secondary-button" type="button" onClick={requestEndSession}><Square size={16} />结束并保存</button>
            <button className="ghost-button" type="button" onClick={reset}><RotateCcw size={16} />重置</button>
          </div>
          <div className="timer-summary">
            <span>今日已记录<strong>{todayMinutes} 分钟</strong></span>
            <span>本次折算<strong>{Math.max(0, Math.round(controls.elapsedSeconds / 60))} 分钟</strong></span>
          </div>
        </article>

        <article className="section-card focus-config-card">
          <div className="study-form-grid one-column">
            <label>选择任务
              <select value={timer.taskId} onChange={(event) => chooseTask(event.target.value)}>
                <option value="">不绑定任务，直接按科目计时</option>
                {tasks.filter((task) => !['已完成', '已跳过'].includes(task.status)).map((task) => (
                  <option key={task.id} value={task.id}>{task.title} · {task.subject_name}</option>
                ))}
              </select>
            </label>
            <label>科目
              <select value={timer.subjectId} onChange={(event) => chooseSubject(event.target.value)}>
                {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </select>
            </label>
            <label>资料
              <select value={timer.materialId} onChange={(event) => chooseMaterial(event.target.value)} disabled={Boolean(selectedTask?.material_id)}>
                <option value="">不绑定资料</option>
                {availableMaterials.map((material) => <option key={material.id} value={material.id}>{material.name}</option>)}
              </select>
            </label>
            <label>完成质量
              <select value={timer.quality} onChange={(event) => controls.update({ quality: event.target.value as StudyQuality })}>
                {['很差', '一般', '良好', '很好'].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>备注<textarea rows={4} value={timer.note} onChange={(event) => controls.update({ note: event.target.value })} placeholder="例如：错了 8 道，极限部分不熟" /></label>
          </div>
        </article>
      </section>

      <section className="section-card">
        <div className="dashboard-card-header"><h2>今日专注记录</h2><Save size={20} /></div>
        {sessions.length ? (
          <div className="session-list">
            {sessions.map((session) => (
              <article className="session-row" key={session.id}>
                <strong>{session.subject_name}{session.task_title ? ` · ${session.task_title}` : ''}</strong>
                <span>{session.duration_minutes} 分钟 · 质量：{session.quality || '未填写'}{session.material_name ? ` · ${session.material_name}` : ''}</span>
                {session.note ? <p>{session.note}</p> : null}
              </article>
            ))}
          </div>
        ) : <EmptyState title="今天还没有专注记录" description="开始第一段计时，哪怕只有 25 分钟也算数。" />}
      </section>

      {message ? <div className="success-box">{message}</div> : null}

      {settlementOpen && selectedTask ? (
        <div className="study-modal-backdrop">
          <div className="study-modal">
            <div className="section-header compact">
              <div>
                <h2>任务结算</h2>
                <p className="muted-text">
                  本次学习 {Math.max(1, Math.round(controls.elapsedSeconds / 60))} 分钟，任务累计将达到 {selectedTask.actual_minutes + Math.max(1, Math.round(controls.elapsedSeconds / 60))} / {selectedTask.estimated_minutes} 分钟。
                </p>
              </div>
              <button className="secondary-button compact-button" type="button" onClick={() => setSettlementOpen(false)}>关闭</button>
            </div>

            <div className="settlement-options">
              <button className={settlementAction === 'completed' ? 'active' : ''} type="button" onClick={() => setSettlementAction('completed')}>
                <strong>已完成</strong>
                <span>保存记录，并把任务标记为已完成。</span>
              </button>
              <button className={settlementAction === 'partial' ? 'active' : ''} type="button" onClick={() => setSettlementAction('partial')}>
                <strong>部分完成</strong>
                <span>承认已投入时间，但保留任务继续监督。</span>
              </button>
              <button className={settlementAction === 'record' ? 'active' : ''} type="button" onClick={() => setSettlementAction('record')}>
                <strong>仅记录时长</strong>
                <span>只保存学习记录，不改变任务状态。</span>
              </button>
            </div>

            {settlementAction === 'partial' ? (
              <div className="study-form-grid one-column">
                <label>还剩什么没完成？
                  <textarea rows={3} value={remainingWork} onChange={(event) => setRemainingWork(event.target.value)} placeholder="例如：莱布尼茨公式和泰勒展开没看完，1000题还没复习。" />
                </label>
                <label className="setting-toggle">
                  <input type="checkbox" checked={createTailTask} onChange={(event) => setCreateTailTask(event.target.checked)} />
                  生成明日补尾任务
                </label>
                {createTailTask ? (
                  <label>补尾任务预计分钟
                    <input type="number" min={5} value={tailMinutes} onChange={(event) => setTailMinutes(Number(event.target.value) || 30)} />
                  </label>
                ) : null}
              </div>
            ) : null}

            <div className="form-actions">
              <button className="primary-button" type="button" onClick={() => saveSession(settlementAction).catch((error) => alert(error instanceof Error ? error.message : String(error)))}>确认保存</button>
              <button className="secondary-button" type="button" onClick={() => setSettlementOpen(false)}>继续调整</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
