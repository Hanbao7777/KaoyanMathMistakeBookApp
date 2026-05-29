import { useState } from 'react';
import { CheckCircle2, Edit3, MoveRight, Trash2, XCircle } from 'lucide-react';
import type { TickTickList, TickTickTask } from '../../../shared/types';
import { ContextMenu } from './ContextMenu';

interface TaskRowProps {
  task: TickTickTask;
  onClick: (task: TickTickTask) => void;
  onToggle: (task: TickTickTask) => void;
  onEdit?: (task: TickTickTask) => void;
  onDelete?: (task: TickTickTask) => void;
  onMove?: (task: TickTickTask, toListId: string) => void;
  lists?: TickTickList[];
}

export function TaskRow({ task, onClick, onToggle, onEdit, onDelete, onMove, lists }: TaskRowProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const tagsList = task.tags_list || [];
  const subtaskInfo = task.subtask_count ? `子 ${task.subtask_completed || 0}/${task.subtask_count}` : null;

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  const otherLists = (lists || []).filter(l => l.id !== task.list_id);

  return (
    <>
      <div
        className={`tt-task-row ${task.is_completed ? 'completed' : ''}`}
        onClick={() => onClick(task)}
        onContextMenu={handleContextMenu}
      >
        <div
          className={`checkbox-circle ${task.is_completed ? 'checked' : ''}`}
          role="checkbox"
          aria-checked={task.is_completed ? true : false}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(task);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggle(task); } }}
        />
        <div className="task-body">
          <div className="task-title">{task.title}</div>
          <div className="task-meta">
            {task.list_color ? <span className="list-dot" style={{ background: task.list_color }} /> : null}
            {task.list_name ? <span>{task.list_name}</span> : null}
            {task.due_date ? <span>{task.due_date}</span> : null}
            {subtaskInfo ? <span style={{ background: 'var(--tt-bg-input)', padding: '1px 5px', borderRadius: 3, fontSize: 10 }}>{subtaskInfo}</span> : null}
            {tagsList.slice(0, 3).map(tag => (
              <span key={tag} style={{ color: 'var(--tt-accent)', fontSize: 10 }}>#{tag}</span>
            ))}
            {task.source === 'auto_review' ? <span style={{ color: 'var(--tt-accent)', fontSize: 10 }}>🔗 错题复习</span> : null}
            {task.source === 'ai_plan' ? <span style={{ color: '#7c4dff', fontSize: 10 }}>🤖 AI</span> : null}
          </div>
        </div>
        <div className="task-right">
          {task.pomodoro_sessions > 0 ? <span className="pomodoro-icon">🍅{task.pomodoro_sessions}</span> : null}
          {task.priority === '高' ? <span className="priority-dot high" /> : null}
          {task.priority === '中' ? <span className="priority-dot medium" /> : null}
          {task.due_time ? <span>{task.due_time}</span> : null}
        </div>
      </div>
      {contextMenu ? (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} actions={[
          { label: task.is_completed ? '取消完成' : '完成任务', icon: task.is_completed ? <XCircle size={14} /> : <CheckCircle2 size={14} />, onClick: () => onToggle(task) },
          { label: '编辑', icon: <Edit3 size={14} />, onClick: () => { if (onEdit) onEdit(task); else onClick(task); } },
          { label: '移动清单', icon: <MoveRight size={14} />, children: otherLists.length > 0 ? otherLists.map(l => ({
              label: l.name,
              icon: <span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', background: l.color, flexShrink: 0 }} />,
              onClick: () => { if (onMove) onMove(task, l.id); },
            })) : undefined,
            onClick: otherLists.length === 0 ? undefined : undefined,
          },
          { label: '删除', icon: <Trash2 size={14} />, danger: true, onClick: () => { if (onDelete) onDelete(task); } },
        ]} />
      ) : null}
    </>
  );
}
