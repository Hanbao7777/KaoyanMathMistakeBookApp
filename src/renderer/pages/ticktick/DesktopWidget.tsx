import { useEffect, useRef, useState } from 'react';
import type { TickTickTask } from '../../../shared/types';

const DARK_KEY = 'kaoyan-dark-mode';

export function DesktopWidget() {
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [totalSeconds, setTotalSeconds] = useState(25 * 60);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'break'>('idle');
  const [pinned, setPinned] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem(DARK_KEY) === 'true');
  const sessionStartRef = useRef(0);

  // ── Tasks ──
  async function loadTasks() {
    try {
      const data = await window.api.getTodayTickTickTasks();
      setTasks([...data.overdue, ...data.today].filter(t => !t.is_completed && !t.parent_id));
    } catch {}
  }

  useEffect(() => {
    loadTasks();
    const t = setInterval(loadTasks, 30000);
    return () => clearInterval(t);
  }, []);

  // ── Timer sync (read from main process shared state) ──
  useEffect(() => {
    const check = async () => {
      try {
        const state = await window.api.getSharedTimerState?.();
        if (!state) return;
        setStatus((state.status as any) || 'idle');
        if (state.status === 'running' && state.sessionStartTime) {
          const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000);
          setTotalSeconds(state.totalSeconds || 25 * 60);
          setSecondsLeft(Math.max(0, (state.totalSeconds || 25 * 60) - elapsed));
        } else {
          setSecondsLeft(state.secondsLeft || 25 * 60);
          setTotalSeconds(state.totalSeconds || 25 * 60);
        }
      } catch {}
    };
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, []);

  // ── Render ──
  const progress = totalSeconds > 0 ? Math.max(0, secondsLeft) / totalSeconds : 0;
  const circumference = 2 * Math.PI * 44;
  const dashOffset = circumference * (1 - progress);
  const minutes = Math.floor(Math.max(0, secondsLeft) / 60);
  const secs = Math.max(0, secondsLeft) % 60;

  const ringColor = status === 'break' ? '#34c759' : status === 'paused' ? '#555' : '#ff6b35';

  return (
    <div
      className="widget-root"
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
        background: dark ? 'rgba(8,8,12,0.92)' : 'rgba(248,246,240,0.92)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        color: dark ? '#c8c8c8' : '#3d3d3d',
        userSelect: 'none',
        borderRadius: 14,
      }}
    >
      {/* ── Top bar ── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 14px 6px',
        WebkitAppRegion: 'drag',
      } as any}>
        <button onClick={() => {
          const next = !pinned;
          setPinned(next);
          window.api.toggleWidgetPin?.(next);
        }} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 12, padding: '4px 6px', borderRadius: 4,
          color: pinned ? ringColor : dark ? '#555' : '#bbb',
          WebkitAppRegion: 'no-drag',
          transition: 'color 0.2s',
        } as any} type="button" title={pinned ? '已置顶' : '未置顶'}>
          &#9670;
        </button>

        <span style={{ fontSize: 10, opacity: 0.35, fontWeight: 400 }}>
          {new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' })}
        </span>

        <button onClick={() => setShowSettings(!showSettings)} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 13, padding: '4px 6px', borderRadius: 4,
          color: dark ? '#666' : '#bbb',
          WebkitAppRegion: 'no-drag',
        } as any} type="button" title="设置">
          &#8943;
        </button>
      </div>

      {/* ── Settings ── */}
      {showSettings ? (
        <div style={{
          margin: '0 14px 6px',
          padding: '10px 12px',
          borderRadius: 8,
          background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
          fontSize: 11,
          display: 'flex',
          gap: 16,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={dark} onChange={e => { setDark(e.target.checked); localStorage.setItem(DARK_KEY, String(e.target.checked)); }} style={{ accentColor: ringColor }} />
            暗色
          </label>
          <button onClick={() => { loadTasks(); setShowSettings(false); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: dark ? '#888' : '#999', fontSize: 11, fontFamily: 'inherit', padding: 0 }} type="button">刷新任务</button>
        </div>
      ) : null}

      {/* ── Ring ── */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
        <div style={{ position: 'relative', width: 124, height: 124 }}>
          <svg viewBox="0 0 100 100" width="124" height="124" style={{ transform: 'rotate(-90deg)' }}>
            {/* subtle bg ring */}
            <circle cx="50" cy="50" r="44" fill="none" stroke={dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'} strokeWidth="2" />
            {/* progress ring */}
            <circle
              cx="50" cy="50" r="44"
              fill="none"
              stroke={ringColor}
              strokeWidth="2"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              style={{
                transition: 'stroke-dashoffset 0.4s ease',
                filter: 'drop-shadow(0 0 4px currentColor)',
              }}
            />
          </svg>
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              fontSize: 30,
              fontWeight: 300,
              letterSpacing: '2px',
              color: dark ? '#ffffff' : '#1a1a1a',
            }}>
              {String(minutes).padStart(2, '0')}<span style={{ opacity: 0.2 }}>:</span>{String(secs).padStart(2, '0')}
            </span>
            <span style={{
              fontSize: 9,
              color: status === 'running' ? ringColor : dark ? '#666' : '#999',
              marginTop: 2,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}>
              {status === 'running' ? 'focus' : status === 'break' ? 'break' : status === 'paused' ? 'paused' : 'idle'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Spacer ── */}
      <div style={{ height: 12 }} />

      {/* ── Tasks ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 2px', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
        {tasks.length > 0 ? tasks.map((task, i) => (
          <div
            key={task.id}
            style={{
              padding: '5px 16px',
              fontSize: 12,
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              opacity: 0.85,
              lineHeight: 1.4,
            }}
          >
            <span style={{
              color: task.priority === '高' ? '#ff453a' : dark ? '#444' : '#ccc',
              fontSize: 10,
              flexShrink: 0,
              fontWeight: task.priority === '高' ? 600 : 400,
            }}>
              {task.priority === '高' ? '!!' : task.priority === '中' ? '!' : '·'}
            </span>
            <span style={{ flex: 1 }}>{task.title}</span>
            {task.due_time ? (
              <span style={{ fontSize: 10, opacity: 0.3, flexShrink: 0, fontFamily: 'inherit' }}>
                {task.due_time}
              </span>
            ) : null}
          </div>
        )) : (
          <div style={{ textAlign: 'center', padding: 20, fontSize: 11, opacity: 0.25, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            暂无待办
          </div>
        )}
      </div>

      {/* ── Bottom ── */}
      <div style={{
        padding: '6px 14px 8px',
        fontSize: 9,
        textAlign: 'center',
        opacity: 0.18,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        Kaoyan
      </div>
    </div>
  );
}
