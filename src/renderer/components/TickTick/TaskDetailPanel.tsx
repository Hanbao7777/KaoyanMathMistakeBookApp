import { X } from 'lucide-react';
import type { TickTickList, TickTickTask } from '../../../shared/types';

interface TaskDetailPanelProps {
  task: TickTickTask;
  lists: TickTickList[];
  onClose: () => void;
  onUpdated: () => void;
}

export function TaskDetailPanel({ task, lists, onClose, onUpdated }: TaskDetailPanelProps) {
  return (
    <div className="tt-detail-panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3>任务详情</h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-secondary)' }} type="button">
          <X size={18} />
        </button>
      </div>

      <div className="tt-detail-field">
        <label>任务标题</label>
        <input type="text" defaultValue={task.title} readOnly />
      </div>

      <div className="tt-detail-field">
        <label>截止日期</label>
        <input type="date" defaultValue={task.due_date || ''} />
      </div>

      <div className="tt-detail-field">
        <label>优先级</label>
        <select defaultValue={task.priority}>
          <option value="none">无</option>
          <option value="低">低</option>
          <option value="中">中</option>
          <option value="高">高</option>
        </select>
      </div>

      <div className="tt-detail-field">
        <label>清单</label>
        <select defaultValue={task.list_id}>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      <div className="tt-detail-field">
        <label>备注</label>
        <textarea rows={4} defaultValue={task.note} />
      </div>

      <div className="tt-detail-field">
        <label>标签</label>
        <input type="text" defaultValue={(task.tags_list || []).join(', ')} placeholder="用逗号分隔" />
      </div>

      {task.source === 'auto_review' ? (
        <div style={{ fontSize: 12, color: 'var(--tt-accent)' }}>
          🔗 此任务关联错题本复习，完成时将自动记录复习日志
        </div>
      ) : null}

      <button
        style={{ padding: '10px', borderRadius: 'var(--tt-radius-md)', border: 'none', background: 'var(--tt-accent)', color: '#fff', fontWeight: 600, cursor: 'pointer', marginTop: 8 }}
        type="button"
        onClick={onUpdated}
      >
        保存修改
      </button>
    </div>
  );
}
