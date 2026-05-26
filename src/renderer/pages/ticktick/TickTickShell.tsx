import type { ReactNode } from 'react';
import type { FocusTimerControls, FocusTimerState } from '../../types/focusTimer';
import { formatSeconds } from '../../utils/formatTime';
import { TickTickSidebar } from './TickTickSidebar';

type TickTickPageKey = 'today' | 'calendar' | 'inbox' | 'list' | 'focus' | 'settings' | 'kanban' | 'eisenhower' | 'habits';

interface TickTickShellProps {
  page: TickTickPageKey;
  selectedListId?: string | null;
  onNavigate: (page: TickTickPageKey, listId?: string) => void;
  onModeChange: () => void;
  children: ReactNode;
  focusTimer?: FocusTimerState;
  focusTimerControls?: FocusTimerControls;
}

export function TickTickShell({ page, selectedListId, onNavigate, onModeChange, children, focusTimer, focusTimerControls }: TickTickShellProps) {
  const showTimer = focusTimer && focusTimerControls && (focusTimer.status !== 'idle' || focusTimerControls.elapsedSeconds > 0);
  const timerLabel = focusTimer?.taskTitle || focusTimer?.subjectName || '专注计时';

  return (
    <div className="ticktick-app-shell">
      <TickTickSidebar page={page} selectedListId={selectedListId} onNavigate={onNavigate} onModeChange={onModeChange} />
      <div className="ticktick-main">
        {showTimer ? (
          <div style={{ padding: '8px 24px', background: 'var(--tt-bg-hover)', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--tt-border-light)' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tt-accent)' }}>
              {focusTimer.status === 'running' ? '🍅 专注中' : '⏸ 已暂停'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--tt-text-secondary)' }}>{timerLabel}</span>
            <span style={{ marginLeft: 'auto', fontFamily: 'monospace', fontWeight: 700 }}>{formatSeconds(focusTimerControls.elapsedSeconds)}</span>
            {focusTimer.status === 'running' ? (
              <button onClick={focusTimerControls.pause} style={{ padding: '4px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12 }} type="button">暂停</button>
            ) : (
              <button onClick={focusTimerControls.start} style={{ padding: '4px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12 }} type="button">继续</button>
            )}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
