import { useEffect, useState } from 'react';
import type { TickTickTask } from '../../../shared/types';

function formatSeconds(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

const TIMER_KEY = 'kaoyan-ticktick-timer-state';
const WIDGET_KEY = 'kaoyan-widget-settings';

interface WidgetSettings {
  opacity: number;
  fontSize: 'small' | 'medium' | 'large';
}

function loadSettings(): WidgetSettings {
  try {
    const saved = localStorage.getItem(WIDGET_KEY);
    return saved ? JSON.parse(saved) : { opacity: 1, fontSize: 'medium' as const };
  } catch { return { opacity: 1, fontSize: 'medium' }; }
}

export function DesktopWidget() {
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [totalSeconds, setTotalSeconds] = useState(25 * 60);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'break'>('idle');
  const [pinned, setPinned] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<WidgetSettings>(loadSettings);
  const [dark, setDark] = useState(() => localStorage.getItem('kaoyan-dark-mode') === 'true');

  const fontSizeMap = { small: 11, medium: 13, large: 15 };

  // Load tasks
  async function loadTasks() {
    try {
      const data = await window.api.getTodayTickTickTasks();
      const uncompleted = [...data.overdue, ...data.today].filter(t => !t.is_completed && !t.parent_id);
      setTasks(uncompleted);
    } catch { /* ignore */ }
  }

  // Sync timer state via localStorage polling
  useEffect(() => {
    loadTasks();
    const taskInterval = setInterval(loadTasks, 30000); // Refresh every 30s
    return () => clearInterval(taskInterval);
  }, []);

  // Read timer state from localStorage (shared with main app)
  useEffect(() => {
    const check = () => {
      try {
        const saved = localStorage.getItem(TIMER_KEY);
        if (saved) {
          const state = JSON.parse(saved);
          setStatus(state.status || 'idle');
          if (state.status === 'running' && state.sessionStartTime) {
            const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000);
            setTotalSeconds(state.totalSeconds || 25 * 60);
            setSecondsLeft(Math.max(0, state.totalSeconds - elapsed));
          } else {
            setSecondsLeft(state.secondsLeft || 25 * 60);
            setTotalSeconds(state.totalSeconds || 25 * 60);
          }
        }
      } catch { /* ignore */ }
    };
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, []);

  // Save settings
  function updateSettings(patch: Partial<WidgetSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    localStorage.setItem(WIDGET_KEY, JSON.stringify(next));
  }

  const progress = totalSeconds > 0 ? Math.max(0, secondsLeft) / totalSeconds : 0;
  const circumference = 2 * Math.PI * 42;
  const dashOffset = circumference * (1 - progress);
  const minutes = Math.floor(Math.max(0, secondsLeft) / 60);
  const secs = Math.max(0, secondsLeft) % 60;

  return (
    <div className={`ticktick-widget ${dark ? 'dark' : ''}`} style={{ height: '100vh', background: 'var(--tt-bg)', color: 'var(--tt-text)', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', opacity: settings.opacity, fontSize: fontSizeMap[settings.fontSize], display: 'flex', flexDirection: 'column', overflow: 'hidden', userSelect: 'none' }}>
      {/* Pin + Settings buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', WebkitAppRegion: 'drag', background: 'var(--tt-bg-sidebar)' } as any}>
        <button onClick={() => { setPinned(!pinned); window.api.toggleWidgetPin(!pinned); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: pinned ? 'var(--tt-accent)' : 'var(--tt-text-muted)', fontSize: 14, WebkitAppRegion: 'no-drag' } as any} type="button" title={pinned ? '已置顶' : '未置顶'}>&#x1F4CC;</button>
        <button onClick={() => setShowSettings(!showSettings)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-secondary)', fontSize: 14, WebkitAppRegion: 'no-drag' } as any} type="button" title="设置">&#x2699;&#xFE0F;</button>
      </div>

      {/* Settings panel */}
      {showSettings ? (
        <div style={{ padding: '12px 14px', background: 'var(--tt-bg-sidebar)', borderBottom: '1px solid var(--tt-border-light)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: 'var(--tt-text-muted)' }}>设置</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 12 }}>深色模式</span>
            <input type="checkbox" checked={dark} onChange={e => { setDark(e.target.checked); localStorage.setItem('kaoyan-dark-mode', String(e.target.checked)); }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 12 }}>透明度</span>
            <input type="range" min={0.3} max={1} step={0.1} value={settings.opacity} onChange={e => updateSettings({ opacity: parseFloat(e.target.value) })} style={{ width: 80 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>字体大小</span>
            <select value={settings.fontSize} onChange={e => updateSettings({ fontSize: e.target.value as any })} style={{ fontSize: 11, padding: '2px 4px' }}>
              <option value="small">小</option>
              <option value="medium">中</option>
              <option value="large">大</option>
            </select>
          </div>
        </div>
      ) : null}

      {/* Timer ring */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0 8px' }}>
        <div style={{ position: 'relative', width: 120, height: 120 }}>
          <svg viewBox="0 0 100 100" width="120" height="120" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--tt-border)" strokeWidth="6" />
            <circle cx="50" cy="50" r="42" fill="none" stroke={status === 'break' ? 'var(--tt-success)' : status === 'paused' ? 'var(--tt-text-muted)' : 'var(--tt-accent)'} strokeWidth="6" strokeDasharray={circumference} strokeDashoffset={dashOffset} strokeLinecap="round" />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{String(minutes).padStart(2, '0')}:{String(secs).padStart(2, '0')}</span>
            <span style={{ fontSize: 10, color: 'var(--tt-text-muted)' }}>{status === 'running' ? '专注中' : status === 'break' ? '休息中' : status === 'paused' ? '已暂停' : '就绪'}</span>
          </div>
        </div>
      </div>

      {/* Task list header */}
      <div style={{ padding: '0 14px 6px', fontSize: 11, fontWeight: 600, color: 'var(--tt-text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
        <span>今日任务</span>
        <span>{tasks.length} 项</span>
      </div>

      {/* Task list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 10px' }}>
        {tasks.length > 0 ? tasks.map(task => (
          <div key={task.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 4px', fontSize: 'inherit', borderBottom: '1px solid var(--tt-border-light)' }}>
            <span style={{ color: task.priority === '高' ? 'var(--tt-danger)' : 'var(--tt-text-muted)', fontWeight: 600, flexShrink: 0, fontSize: 10 }}>{task.priority === '高' ? '!!' : task.priority === '中' ? '!' : ''}</span>
            <span style={{ flex: 1, lineHeight: 1.3 }}>{task.title}</span>
            {task.due_time ? <span style={{ fontSize: 10, color: 'var(--tt-text-muted)', flexShrink: 0 }}>{task.due_time}</span> : null}
          </div>
        )) : (
          <div style={{ textAlign: 'center', padding: 20, color: 'var(--tt-text-muted)', fontSize: 12 }}>今天没有待办任务</div>
        )}
      </div>
    </div>
  );
}
