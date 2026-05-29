import { useEffect, useRef, useState } from 'react';
import type { TickTickTask } from '../../../shared/types';

const TIMER_KEY = 'kaoyan-ticktick-timer-state';
const WIDGET_KEY = 'kaoyan-widget-settings';
const DARK_KEY = 'kaoyan-dark-mode';

interface WidgetSettings {
  fontSize: 'small' | 'medium' | 'large';
  glassIntensity: 'light' | 'medium' | 'heavy';
}

function loadSettings(): WidgetSettings {
  try {
    const saved = localStorage.getItem(WIDGET_KEY);
    return saved ? JSON.parse(saved) : { fontSize: 'medium', glassIntensity: 'medium' };
  } catch { return { fontSize: 'medium', glassIntensity: 'medium' }; }
}

export function DesktopWidget() {
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [totalSeconds, setTotalSeconds] = useState(25 * 60);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'break'>('idle');
  const [pinned, setPinned] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<WidgetSettings>(loadSettings);
  const [dark, setDark] = useState(() => localStorage.getItem(DARK_KEY) === 'true');
  const sessionStartRef = useRef(0);

  const fontSizeMap = { small: 11, medium: 13, large: 15 };
  const glassMap = { light: 0.2, medium: 0.35, heavy: 0.5 };

  // ── Data loading ──
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

  // ── Timer sync via localStorage ──
  useEffect(() => {
    const check = () => {
      try {
        const saved = localStorage.getItem(TIMER_KEY);
        if (!saved) return;
        const state = JSON.parse(saved);
        setStatus(state.status || 'idle');
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

  // ── Pin state from main process on mount ──
  useEffect(() => {
    window.api.isWidgetOpen?.().then((open: boolean) => {
      if (open) setPinned(true);
    }).catch(() => {});
  }, []);

  // ── Settings ──
  function updateSettings(patch: Partial<WidgetSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    localStorage.setItem(WIDGET_KEY, JSON.stringify(next));
  }

  // ── Render ──
  const progress = totalSeconds > 0 ? Math.max(0, secondsLeft) / totalSeconds : 0;
  const circumference = 2 * Math.PI * 42;
  const dashOffset = circumference * (1 - progress);
  const minutes = Math.floor(Math.max(0, secondsLeft) / 60);
  const secs = Math.max(0, secondsLeft) % 60;

  const glassBg = dark
    ? `rgba(20,20,30,${glassMap[settings.glassIntensity]})`
    : `rgba(255,255,255,${glassMap[settings.glassIntensity] + 0.05})`;
  const textColor = dark ? '#f5f5f7' : '#1d1d1f';
  const textMuted = dark ? '#86868b' : '#6e6e73';
  const separatorColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const accentColor = '#ff6b35';
  const successColor = '#34c759';

  return (
    <div
      className="ticktick-widget"
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        userSelect: 'none',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif",
        background: glassBg,
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        color: textColor,
        fontSize: fontSizeMap[settings.fontSize],
        border: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.3)'}`,
        boxShadow: dark
          ? '0 25px 50px -12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)'
          : '0 25px 50px -12px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.4)',
        borderRadius: 16,
      }}
    >
      {/* ── Control bar ── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 14px',
          WebkitAppRegion: 'drag',
          borderBottom: `1px solid ${separatorColor}`,
          background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.15)',
          backdropFilter: 'blur(20px)',
        } as any}
      >
        <button
          onClick={() => {
            const next = !pinned;
            setPinned(next);
            window.api.toggleWidgetPin?.(next);
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            WebkitAppRegion: 'no-drag',
            color: pinned ? accentColor : textMuted,
            opacity: pinned ? 1 : 0.5,
            padding: '4px 8px',
            borderRadius: 6,
            transition: 'all 0.2s',
          } as any}
          type="button"
          title={pinned ? '已置顶 — 点击取消' : '未置顶 — 点击置顶'}
        >
          📌
        </button>
        <span style={{ fontSize: 11, fontWeight: 500, color: textMuted, letterSpacing: '0.5px' }}>
          {new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' })}
        </span>
        <button
          onClick={() => setShowSettings(!showSettings)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            color: textMuted,
            WebkitAppRegion: 'no-drag',
            padding: '4px 8px',
            borderRadius: 6,
            transition: 'all 0.2s',
          } as any}
          type="button"
          title="设置"
        >
          ⚙️
        </button>
      </div>

      {/* ── Settings panel ── */}
      {showSettings ? (
        <div
          style={{
            padding: '14px 16px',
            borderBottom: `1px solid ${separatorColor}`,
            background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.12)',
            backdropFilter: 'blur(20px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            fontSize: 12,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: textMuted, marginBottom: 2 }}>
            外观
          </div>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: textColor }}>
            深色模式
            <input type="checkbox" checked={dark} onChange={e => {
              setDark(e.target.checked);
              localStorage.setItem(DARK_KEY, String(e.target.checked));
            }} style={{ accentColor }} />
          </label>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: textColor }}>
            玻璃强度
            <select
              value={settings.glassIntensity}
              onChange={e => updateSettings({ glassIntensity: e.target.value as WidgetSettings['glassIntensity'] })}
              style={{
                background: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                border: `1px solid ${separatorColor}`,
                borderRadius: 6,
                padding: '3px 8px',
                color: textColor,
                fontSize: 11,
                outline: 'none',
              }}
            >
              <option value="light">轻薄</option>
              <option value="medium">适中</option>
              <option value="heavy">厚重</option>
            </select>
          </label>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: textColor }}>
            字体大小
            <select
              value={settings.fontSize}
              onChange={e => updateSettings({ fontSize: e.target.value as WidgetSettings['fontSize'] })}
              style={{
                background: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                border: `1px solid ${separatorColor}`,
                borderRadius: 6,
                padding: '3px 8px',
                color: textColor,
                fontSize: 11,
                outline: 'none',
              }}
            >
              <option value="small">小</option>
              <option value="medium">中</option>
              <option value="large">大</option>
            </select>
          </label>
        </div>
      ) : null}

      {/* ── Timer ring ── */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0 12px' }}>
        <div style={{ position: 'relative', width: 140, height: 140 }}>
          <svg viewBox="0 0 100 100" width="140" height="140" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="50" cy="50" r="42" fill="none" stroke={separatorColor} strokeWidth="5" />
            <circle
              cx="50" cy="50" r="42"
              fill="none"
              stroke={status === 'break' ? successColor : status === 'paused' ? textMuted : accentColor}
              strokeWidth="5"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
            />
          </svg>
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{
              fontSize: 26,
              fontWeight: 300,
              letterSpacing: '1px',
              color: textColor,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {String(minutes).padStart(2, '0')}<span style={{ opacity: 0.3, margin: '0 1px' }}>:</span>{String(secs).padStart(2, '0')}
            </span>
            <span style={{ fontSize: 10, color: status === 'running' ? accentColor : textMuted, marginTop: 2, fontWeight: 500 }}>
              {status === 'running' ? '专注中' : status === 'break' ? '休息中' : status === 'paused' ? '已暂停' : '就绪'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Divider ── */}
      <div style={{
        margin: '0 20px',
        height: 1,
        background: separatorColor,
      }} />

      {/* ── Task list ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        <div style={{
          padding: '4px 18px 6px',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: textMuted,
          display: 'flex',
          justifyContent: 'space-between',
        }}>
          <span>今日待办</span>
          <span>{tasks.length} 项</span>
        </div>

        {tasks.length > 0 ? tasks.map(task => (
          <div
            key={task.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '7px 18px',
              fontSize: 'inherit',
              borderBottom: `1px solid ${separatorColor}`,
              transition: 'background 0.15s',
            }}
          >
            <span style={{
              color: task.priority === '高' ? '#ff453a' : task.priority === '中' ? accentColor : textMuted,
              fontWeight: task.priority === '高' ? 600 : 400,
              flexShrink: 0,
              fontSize: 10,
              width: 16,
              textAlign: 'center',
            }}>
              {task.priority === '高' ? '!!' : task.priority === '中' ? '!' : '·'}
            </span>
            <span style={{ flex: 1, lineHeight: 1.4, opacity: 0.9 }}>{task.title}</span>
            {task.due_time ? (
              <span style={{ fontSize: 10, color: textMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {task.due_time}
              </span>
            ) : null}
          </div>
        )) : (
          <div style={{ textAlign: 'center', padding: 24, color: textMuted, fontSize: 12, opacity: 0.6 }}>
            今天没有待办
          </div>
        )}
      </div>

      {/* ── Bottom bar ── */}
      <div style={{
        padding: '6px 14px',
        borderTop: `1px solid ${separatorColor}`,
        fontSize: 9,
        color: textMuted,
        textAlign: 'center',
        opacity: 0.5,
        letterSpacing: '0.3px',
      }}>
        考研高数错题本
      </div>
    </div>
  );
}
