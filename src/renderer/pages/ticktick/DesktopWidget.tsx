import { useEffect, useState } from 'react';
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
  const [examDate, setExamDate] = useState<string | null>(null);
  const [daysUntilExam, setDaysUntilExam] = useState<number | null>(null);

  // Exam countdown
  useEffect(() => {
    async function loadExam() {
      try {
        const settings = await window.api.getStudySettings?.();
        if (settings?.exam_date) {
          setExamDate(settings.exam_date);
          const exam = new Date(settings.exam_date);
          const today = new Date();
          const diff = Math.ceil((exam.getTime() - today.getTime()) / 86400000);
          setDaysUntilExam(diff > 0 ? diff : 0);
        }
      } catch {}
    }
    loadExam();
  }, []);

  // Tasks
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

  // Timer sync via main process IPC
  useEffect(() => {
    const check = async () => {
      try {
        const state = await window.api.getSharedTimerState?.();
        if (!state) return;
        setStatus((state.status as 'idle' | 'running' | 'paused' | 'break') || 'idle');
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

  // Render
  const progress = totalSeconds > 0 ? Math.max(0, secondsLeft) / totalSeconds : 0;
  const circumference = 2 * Math.PI * 46;
  const dashOffset = circumference * (1 - progress);
  const minutes = Math.floor(Math.max(0, secondsLeft) / 60);
  const secs = Math.max(0, secondsLeft) % 60;
  const ringColor = status === 'break' ? '#30d158' : status === 'paused' ? '#555' : '#ff6b35';

  const bgColor = dark
    ? 'rgba(22,22,24,0.82)'
    : 'rgba(250,250,252,0.75)';
  const textColor = dark ? '#f5f5f7' : '#1d1d1f';
  const mutedColor = dark ? '#86868b' : '#86868b';
  const separatorColor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: bgColor,
      backdropFilter: 'blur(28px) saturate(160%)',
      WebkitBackdropFilter: 'blur(28px) saturate(160%)',
      color: textColor,
      userSelect: 'none',
      borderRadius: 16,
      border: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.5)'}`,
      boxShadow: dark
        ? '0 0 0 0.5px rgba(255,255,255,0.08), 0 20px 60px rgba(0,0,0,0.6)'
        : '0 0 0 0.5px rgba(0,0,0,0.04), 0 20px 60px rgba(0,0,0,0.12)',
    }}>
      {/* Exam countdown bar */}
      {daysUntilExam !== null ? (
        <div style={{
          textAlign: 'center',
          padding: '6px 14px',
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '1px',
          color: mutedColor,
          fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif",
          borderBottom: `1px solid ${separatorColor}`,
          background: dark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
        }}>
          距考研还有 <span style={{ color: textColor, fontWeight: 600, fontSize: 12 }}>{daysUntilExam}</span> 天
          {examDate ? <span style={{ marginLeft: 6, opacity: 0.5 }}>{examDate}</span> : null}
        </div>
      ) : null}

      {/* Control bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 14px',
        WebkitAppRegion: 'drag',
      } as any}>
        <button onClick={() => {
          const next = !pinned;
          setPinned(next);
          window.api.toggleWidgetPin?.(next);
        }} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 12, padding: '4px 6px', borderRadius: 4,
          color: pinned ? ringColor : mutedColor,
          opacity: pinned ? 1 : 0.5,
          WebkitAppRegion: 'no-drag',
          transition: 'all 0.2s',
          fontFamily: 'inherit',
        } as any} type="button" title={pinned ? '已置顶' : '未置顶'}>
          {'◆'}
        </button>
        <span style={{ fontSize: 10, opacity: 0.35, fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif" }}>
          {new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' })}
        </span>
        <button onClick={() => setShowSettings(!showSettings)} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, padding: '4px 6px', borderRadius: 4,
          color: mutedColor, opacity: 0.5,
          WebkitAppRegion: 'no-drag',
          fontFamily: 'inherit',
        } as any} type="button">
          {'···'}
        </button>
      </div>

      {/* Settings */}
      {showSettings ? (
        <div style={{
          margin: '0 14px 4px',
          padding: '8px 12px',
          borderRadius: 10,
          background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
          fontSize: 11,
          fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif",
          display: 'flex', gap: 16, alignItems: 'center',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={dark} onChange={e => { setDark(e.target.checked); localStorage.setItem(DARK_KEY, String(e.target.checked)); }} style={{ accentColor: ringColor }} />
            暗色
          </label>
          <button onClick={() => { loadTasks(); setShowSettings(false); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: mutedColor, fontSize: 11, fontFamily: 'inherit', padding: 0 }} type="button">刷新</button>
        </div>
      ) : null}

      {/* Timer ring */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 2px' }}>
        <div style={{ position: 'relative', width: 140, height: 140 }}>
          <svg viewBox="0 0 100 100" width="140" height="140" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="50" cy="50" r="46" fill="none" stroke={separatorColor} strokeWidth="2.5" />
            <circle
              cx="50" cy="50" r="46"
              fill="none"
              stroke={ringColor}
              strokeWidth="2.5"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              style={{
                transition: 'stroke-dashoffset 0.4s ease',
                filter: status === 'running' ? `drop-shadow(0 0 6px ${ringColor})` : 'none',
              }}
            />
          </svg>
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              fontSize: 32,
              fontWeight: 300,
              letterSpacing: '2px',
              fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
              color: textColor,
            }}>
              {String(minutes).padStart(2, '0')}<span style={{ opacity: 0.18, margin: '0 1px' }}>:</span>{String(secs).padStart(2, '0')}
            </span>
            <span style={{
              fontSize: 9,
              fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif",
              color: status === 'running' ? ringColor : mutedColor,
              marginTop: 2,
              letterSpacing: '1px',
              textTransform: 'uppercase',
            }}>
              {status === 'running' ? 'Focus' : status === 'break' ? 'Break' : status === 'paused' ? 'Paused' : 'Idle'}
            </span>
          </div>
        </div>
      </div>

      {/* Spacer */}
      <div style={{ height: 8 }} />

      {/* Tasks */}
      <div className="ticktick-widget" style={{
        flex: 1, overflow: 'auto',
        fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif",
        padding: '0 4px',
      }}>
        {tasks.length > 0 ? tasks.map(task => (
          <div key={task.id} style={{
            padding: '6px 16px',
            fontSize: 12,
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            opacity: 0.85,
            lineHeight: 1.4,
            borderBottom: `1px solid ${separatorColor}`,
          }}>
            <span style={{
              color: task.priority === '高' ? '#ff453a' : task.priority === '中' ? ringColor : mutedColor,
              fontSize: 10,
              flexShrink: 0,
              fontWeight: task.priority === '高' ? 600 : 400,
            }}>
              {task.priority === '高' ? '!!' : task.priority === '中' ? '!' : '·'}
            </span>
            <span style={{ flex: 1 }}>{task.title}</span>
            {task.due_time ? (
              <span style={{ fontSize: 10, opacity: 0.3, flexShrink: 0 }}>
                {task.due_time}
              </span>
            ) : null}
          </div>
        )) : (
          <div style={{ textAlign: 'center', padding: 20, fontSize: 11, opacity: 0.25 }}>
            暂无待办
          </div>
        )}
      </div>

      {/* Bottom */}
      <div style={{
        padding: '6px 14px 8px',
        fontSize: 9,
        textAlign: 'center',
        opacity: 0.15,
        fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif",
        borderTop: `1px solid ${separatorColor}`,
      }}>
        考研高数错题本
      </div>
    </div>
  );
}
