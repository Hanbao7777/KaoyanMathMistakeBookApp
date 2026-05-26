import { X } from 'lucide-react';
import { useState } from 'react';
import type { TickTickList, TickTickTask } from '../../../shared/types';
import { useToast } from '../Toast';

interface TaskDetailPanelProps {
  task: TickTickTask;
  lists: TickTickList[];
  onClose: () => void;
  onUpdated: () => void;
}

export function TaskDetailPanel({ task, lists, onClose, onUpdated }: TaskDetailPanelProps) {
  const { toast } = useToast();
  const [title, setTitle] = useState(task.title);
  const [dueDate, setDueDate] = useState(task.due_date || '');
  const [dueTime, setDueTime] = useState(task.due_time || '');
  const [priority, setPriority] = useState(task.priority);
  const [listId, setListId] = useState(task.list_id);
  const [note, setNote] = useState(task.note);
  const [tags, setTags] = useState((task.tags_list || []).join(', '));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
      await window.api.updateTickTickTask(task.id, {
        title,
        due_date: dueDate || null,
        due_time: dueTime || null,
        priority: priority as any,
        list_id: listId,
        note,
        tags: tagList,
      });
      toast('任务已保存', 'success');
      onUpdated();
    } catch (e: any) {
      toast(e.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tt-detail-panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3>任务详情</h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-secondary)' }} type="button">
          <X size={18} />
        </button>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
        <div className="tt-detail-field">
          <label>任务标题</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} />
        </div>

        <div className="tt-detail-field">
          <label>截止日期</label>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
        </div>

        <div className="tt-detail-field">
          <label>截止时间</label>
          <input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} />
        </div>

        <div className="tt-detail-field">
          <label>优先级</label>
          <select value={priority} onChange={e => setPriority(e.target.value as any)}>
            <option value="none">无</option>
            <option value="低">低</option>
            <option value="中">中</option>
            <option value="高">高</option>
          </select>
        </div>

        <div className="tt-detail-field">
          <label>清单</label>
          <select value={listId} onChange={e => setListId(e.target.value)}>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>

        <div className="tt-detail-field">
          <label>备注</label>
          <textarea rows={4} value={note} onChange={e => setNote(e.target.value)} />
        </div>

        <div className="tt-detail-field">
          <label>标签（逗号分隔）</label>
          <input type="text" value={tags} onChange={e => setTags(e.target.value)} placeholder="考研, 数学, 复习" />
        </div>

        {task.source === 'auto_review' ? (
          <div style={{ fontSize: 12, color: 'var(--tt-accent)' }}>
            此任务关联错题本复习，完成时将自动记录复习日志
          </div>
        ) : null}

        <button
          style={{ padding: '10px', borderRadius: 'var(--tt-radius-md)', border: 'none', background: 'var(--tt-accent)', color: '#fff', fontWeight: 600, cursor: 'pointer', marginTop: 8, opacity: saving ? 0.6 : 1 }}
          type="submit"
          disabled={saving}
        >
          {saving ? '保存中...' : '保存修改'}
        </button>
      </form>
    </div>
  );
}
