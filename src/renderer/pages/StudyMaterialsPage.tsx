import { BookOpenCheck, Edit3, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { StudyMaterial, StudyMaterialInput, StudyMaterialStatus, StudyPriority, StudySubject } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import { useModal } from '../components/Modal';
import { useToast } from '../components/Toast';

const materialTypes = ['教材', '题册', '真题', '背诵', '笔记', '课程', '讲义', '习题集', '教辅', '其他'];
const units = ['页', '章', '题', '讲', '篇', '单元', '年份', '自定义'];

const emptyForm: StudyMaterialInput = {
  subject_id: 'math',
  name: '',
  material_type: '题册',
  progress_unit: '题',
  custom_unit_name: '',
  total_amount: 0,
  current_amount: 0,
  start_date: '',
  target_date: '',
  priority: '中',
  status: '进行中',
  note: ''
};

function unitOf(material: StudyMaterial) {
  return material.custom_unit_name || material.progress_unit;
}

function riskText(level?: string) {
  if (level === 'danger') return '红色预警';
  if (level === 'warning') return '橙色警告';
  if ((level || 'normal') === 'normal') return '正常';
  return '严重风险';
}

export function StudyMaterialsPage() {
  const { toast } = useToast();
  const modal = useModal();
  const [subjects, setSubjects] = useState<StudySubject[]>([]);
  const [materials, setMaterials] = useState<StudyMaterial[]>([]);
  const [form, setForm] = useState<StudyMaterialInput>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');

  async function load() {
    const [nextSubjects, nextMaterials] = await Promise.all([
      window.api.listStudySubjects(),
      window.api.listStudyMaterials({ subjectId: subjectFilter, risk: riskFilter })
    ]);
    setSubjects(nextSubjects);
    setMaterials(nextMaterials);
    if (nextSubjects.length && !nextSubjects.some((subject) => subject.id === form.subject_id)) {
      setForm((current) => ({ ...current, subject_id: nextSubjects[0].id }));
    }
  }

  useEffect(() => {
    load().catch((error) => toast(error.message, 'error'));
  }, [subjectFilter, riskFilter]);

  async function saveMaterial() {
    if (!form.name.trim()) {
      toast('请填写资料名称', 'warning');
      return;
    }
    if (form.total_amount <= 0) {
      toast('总量必须大于 0', 'warning');
      return;
    }
    if (form.current_amount > form.total_amount) {
      toast('当前进度不能超过总量', 'warning');
      return;
    }
    if (form.progress_unit === '自定义' && !form.custom_unit_name?.trim()) {
      toast('自定义进度单位不能为空', 'warning');
      return;
    }
    if (editingId) await window.api.updateStudyMaterial(editingId, form);
    else await window.api.createStudyMaterial(form);
    setForm({ ...emptyForm, subject_id: subjects[0]?.id || 'math' });
    setEditingId(null);
    toast(editingId ? '资料已更新' : '资料已添加', 'success');
    await load();
  }

  function edit(material: StudyMaterial) {
    setEditingId(material.id);
    setForm({
      subject_id: material.subject_id,
      name: material.name,
      material_type: material.material_type,
      progress_unit: material.progress_unit,
      custom_unit_name: material.custom_unit_name || '',
      total_amount: material.total_amount,
      current_amount: material.current_amount,
      start_date: material.start_date || '',
      target_date: material.target_date || '',
      priority: material.priority,
      status: material.status,
      note: material.note
    });
  }

  async function remove(material: StudyMaterial) {
    const confirmed = await modal.confirm({ title: '操作确认', message: `确定删除「${material.name}」吗？关联的学习任务将保留，资料可恢复。`, confirmLabel: '删除', danger: true });
    if (!confirmed) return;
    await window.api.deleteStudyMaterial(material.id);
    await load();
  }

  return (
    <div className="page study-page materials-page">
      <header className="page-header">
        <div>
          <h1>资料进度</h1>
          <p>资料名称和进度单位完全自定义，用目标日期自动判断是否落后。</p>
        </div>
      </header>

      <section className="section-card study-form-card">
        <div className="section-header compact">
          <h2><BookOpenCheck size={18} /> {editingId ? '编辑资料' : '添加资料'}</h2>
          {editingId ? <button className="secondary-button compact-button" type="button" onClick={() => { setEditingId(null); setForm({ ...emptyForm, subject_id: subjects[0]?.id || 'math' }); }}>取消编辑</button> : null}
        </div>
        <div className="study-form-grid">
          <label>科目
            <select value={form.subject_id} onChange={(event) => setForm({ ...form, subject_id: event.target.value })}>
              {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
            </select>
          </label>
          <label className="wide">资料名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：660题、红宝书、专业课教材" /></label>
          <label>类型
            <select value={form.material_type} onChange={(event) => setForm({ ...form, material_type: event.target.value })}>
              {materialTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label>进度单位
            <select value={form.progress_unit} onChange={(event) => setForm({ ...form, progress_unit: event.target.value })}>
              {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>
          {form.progress_unit === '自定义' ? <label>自定义单位<input value={form.custom_unit_name || ''} onChange={(event) => setForm({ ...form, custom_unit_name: event.target.value })} /></label> : null}
          <label>总量<input type="number" min={0} value={form.total_amount} onChange={(event) => setForm({ ...form, total_amount: Number(event.target.value) })} /></label>
          <label>当前进度<input type="number" min={0} value={form.current_amount} onChange={(event) => setForm({ ...form, current_amount: Number(event.target.value) })} /></label>
          <label>开始日期<input type="date" value={form.start_date || ''} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></label>
          <label>目标日期<input type="date" value={form.target_date || ''} onChange={(event) => setForm({ ...form, target_date: event.target.value })} /></label>
          <label>优先级
            <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as StudyPriority })}>
              {['高', '中', '低'].map((priority) => <option key={priority} value={priority}>{priority}</option>)}
            </select>
          </label>
          <label>状态
            <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as StudyMaterialStatus })}>
              {['未开始', '进行中', '已完成', '暂停'].map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <label className="wide">备注<textarea rows={2} value={form.note || ''} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
        </div>
        <button className="primary-button" type="button" onClick={saveMaterial}><Save size={16} />保存资料</button>
      </section>

      <section className="filter-panel inline study-filter-row">
        <label>科目筛选
          <select value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}>
            <option value="all">全部科目</option>
            {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
          </select>
        </label>
        <label>风险筛选
          <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)}>
            <option value="all">全部风险等级</option>
            <option value="critical">严重风险</option>
            <option value="danger">红色预警</option>
            <option value="warning">橙色警告</option>
            <option value="normal">正常</option>
          </select>
        </label>
      </section>

      {materials.length ? (
        <section className="materials-grid">
          {materials.map((material) => (
            <article className={`material-card tone-${material.riskLevel || 'normal'}`} key={material.id}>
              <div className="study-card-head">
                <div>
                  <h2>{material.name}</h2>
                  <p>{material.subject_name} · {material.material_type} · 优先级：{material.priority}</p>
                </div>
                <em className={`status-pill tone-${material.riskLevel === 'normal' ? 'success' : (material.riskLevel === 'danger' ? 'danger' : (material.riskLevel === 'critical' ? 'danger' : 'warning'))}`}>{riskText(material.riskLevel)}</em>
              </div>
              <div className="progress-line">
                <span><strong>{material.current_amount}</strong> / {material.total_amount} {unitOf(material)}</span>
                <span>{material.completionRate || 0}%</span>
              </div>
              <div className="progress-track"><i style={{ width: `${material.completionRate || 0}%`, background: material.riskLevel === 'danger' || material.riskLevel === 'critical' ? 'var(--color-danger)' : material.riskLevel === 'warning' ? 'var(--color-warning)' : 'var(--color-primary)' }} /></div>
              {material.suggestedPaceText ? (
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-primary)', fontWeight: 600 }}>
                  {material.suggestedPaceText}
                  {material.catchUpText ? <span style={{ color: 'var(--color-warning)', marginLeft: 8, fontSize: 12 }}>{material.catchUpText}</span> : null}
                </div>
              ) : null}
              <div className="study-mini-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                <span>剩余<strong>{material.remainingAmount || 0} {unitOf(material)}</strong></span>
                <span>目标日期<strong>{material.target_date || '未设置'}</strong></span>
                <span>当前状态<strong>{material.status}</strong></span>
              </div>
              {(material.lagAmount || 0) > 0 ? (
                <div className="warning-box compact">
                  进度落后：今天理论应完成到 {material.expectedAmount} {unitOf(material)}，当前落后 {material.lagAmount} {unitOf(material)}。{material.catchUpText ? `补救建议：${material.catchUpText}。` : ''}
                </div>
              ) : null}
              <div className="material-actions">
                <label>快速更新进度</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => { const v = Math.max(0, (material.current_amount || 0) - 1); window.api.updateStudyMaterialProgress(material.id, v).then(() => { toast('进度已更新为 ' + v, 'success'); load(); }); }} className="secondary-button compact-button" type="button" style={{ padding: '4px 10px', fontSize: 14, lineHeight: 1 }}>−</button>
                  <input type="number" defaultValue={material.current_amount} onBlur={e => { const v = Math.max(0, Math.min(material.total_amount, Number(e.target.value) || 0)); window.api.updateStudyMaterialProgress(material.id, v).then(() => { toast('进度已更新为 ' + v, 'success'); load(); }); }} style={{ width: 80, textAlign: 'center' }} min={0} max={material.total_amount} />
                  <button onClick={() => { const v = Math.min(material.total_amount, (material.current_amount || 0) + 1); window.api.updateStudyMaterialProgress(material.id, v).then(() => { toast('进度已更新为 ' + v, 'success'); load(); }); }} className="secondary-button compact-button" type="button" style={{ padding: '4px 10px', fontSize: 14, lineHeight: 1 }}>+</button>
                </div>
                <button className="secondary-button compact-button" type="button" onClick={() => edit(material)}><Edit3 size={14} />编辑</button>
                <button className="secondary-button danger compact-button" type="button" onClick={() => remove(material)}><Trash2 size={14} />删除</button>
              </div>
            </article>
          ))}
        </section>
      ) : <EmptyState title="暂无资料" description="先添加一份资料，例如 660题、红宝书或专业课讲义。" />}
    </div>
  );
}
