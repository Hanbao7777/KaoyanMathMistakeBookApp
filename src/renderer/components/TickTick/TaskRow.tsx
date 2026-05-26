import type { TickTickTask } from '../../../shared/types';

interface TaskRowProps {
  task: TickTickTask;
  onClick: (task: TickTickTask) => void;
  onToggle: (task: TickTickTask) => void;
}

export function TaskRow({ task, onClick, onToggle }: TaskRowProps) {
  const tagsList = task.tags_list || [];
  const subtaskInfo = task.subtask_count ? `子 ${task.subtask_completed || 0}/${task.subtask_count}` : null;

  return (
    <div
      className={`tt-task-row ${task.is_completed ? 'completed' : ''}`}
      onClick={() => onClick(task)}
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
  );
}
