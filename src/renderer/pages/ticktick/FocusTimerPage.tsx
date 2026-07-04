import { Pause, Play, SkipForward, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TickTickTask, TickTickSettings } from '../../../shared/types';
import { useToast } from '../../components/Toast';
import { runCommand, runLoad } from '../../../shared/loadState';

type TimerStatus = 'idle' | 'running' | 'paused' | 'break';

interface SharedTimerState {
  status: string;
  secondsLeft: number;
  totalSeconds: number;
  completedSessions: number;
  currentSession: number;
  sessionStartTime: number | null;
  boundTaskId: string | null;
}

export function FocusTimerPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<TickTickSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timerState, setTimerState] = useState<SharedTimerState>({
    status: 'idle',
    secondsLeft: 25 * 60,
    totalSeconds: 25 * 60,
    completedSessions: 0,
    currentSession: 1,
    sessionStartTime: null,
    boundTaskId: null,
  });
  const [whiteNoise, setWhiteNoise] = useState<string>('none');
  const [tasks, setTasks] = useState<TickTickTask[]>([]);

  const focusMinutes = settings?.pomodoro?.focusMinutes || 25;
  const shortBreak = settings?.pomodoro?.shortBreakMinutes || 5;
  const longBreak = settings?.pomodoro?.longBreakMinutes || 15;
  const sessionsBeforeLong = settings?.pomodoro?.sessionsBeforeLongBreak || 4;

  async function loadSettings() {
    setLoadError(null);
    const outcome = await runLoad(async () => {
      const s = await window.api.getTickTickSettings();
      await window.api.setTimerConfig({
        focusMinutes: s.pomodoro?.focusMinutes || 25,
        shortBreakMinutes: s.pomodoro?.shortBreakMinutes || 5,
        longBreakMinutes: s.pomodoro?.longBreakMinutes || 15,
        sessionsBeforeLongBreak: s.pomodoro?.sessionsBeforeLongBreak || 4,
      });
      return s;
    }, '设置加载失败，请重试');
    if (outcome.ok) {
      setSettings(outcome.value);
      setSettingsLoaded(true);
    } else {
      setLoadError(outcome.message);
      setSettingsLoaded(true);
    }
    window.api.listTickTickTasks({ includeCompleted: false }).then(setTasks).catch(() => {});
  }

  useEffect(() => { loadSettings(); }, []);

  // Poll shared timer state for display (read-only, does not advance time)
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const state = await window.api.getSharedTimerState();
        if (!cancelled) setTimerState(state);
      } catch {}
    }
    poll();
    const interval = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const status = timerState.status as TimerStatus;

  function handleStart() { runCommand(() => window.api.startSharedTimer(), '计时器启动失败').then(r => { if (!r.ok) toast(r.message, 'error'); }); }
  function handlePause() { runCommand(() => window.api.pauseSharedTimer(), '计时器暂停失败').then(r => { if (!r.ok) toast(r.message, 'error'); }); }
  function handleReset() { runCommand(() => window.api.resetSharedTimer(), '计时器重置失败').then(r => { if (!r.ok) toast(r.message, 'error'); }); }
  function handleSkipBreak() { runCommand(() => window.api.skipBreakSharedTimer(), '跳过休息失败').then(r => { if (!r.ok) toast(r.message, 'error'); }); }

  function handleBindTask(taskId: string | null) {
    runCommand(() => window.api.bindTimerTask(taskId), '绑定任务失败').then(r => { if (!r.ok) toast(r.message, 'error'); });
  }

  const secondsLeft = Math.max(0, timerState.secondsLeft);
  const minutes = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const progress = timerState.totalSeconds > 0 ? secondsLeft / timerState.totalSeconds : 0;
  const circumference = 2 * Math.PI * 52;
  const dashOffset = circumference * (1 - progress);

  const ringColor = status === 'break' ? 'break' : status === 'paused' ? 'paused' : 'focus';

  if (!settingsLoaded) return <div className="ticktick-main-content"><div className="tt-empty">加载中...</div></div>;
  if (loadError) return (
    <div className="ticktick-main-content">
      <div className="tt-empty tt-load-error" role="alert">
        <div>{loadError}</div>
        <button type="button" className="tt-retry-btn" onClick={() => { setSettingsLoaded(false); loadSettings(); }}>重试</button>
      </div>
    </div>
  );

  const noiseOptions = [
    { key: 'none', label: '无' },
    { key: 'rain', label: '雨声' },
    { key: 'stream', label: '溪流' },
    { key: 'cafe', label: '咖啡馆' },
    { key: 'white', label: '白噪音' },
    { key: 'forest', label: '森林' },
  ];

  return (
    <div className="ticktick-main-content">
      <div className="tt-timer-page">
        <div className="tt-ring-timer">
          <svg viewBox="0 0 120 120" width="220" height="220">
            <circle className="bg-ring" cx="60" cy="60" r="52" />
            <circle
              className={`fg-ring ${ringColor}`}
              cx="60" cy="60" r="52"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </svg>
          <div className="timer-text">
            <span className="time-display">{String(minutes).padStart(2, '0')}:{String(secs).padStart(2, '0')}</span>
            <span className="session-label">
              {status === 'idle' ? '准备就绪' : status === 'running' ? '专注中' : status === 'paused' ? '已暂停' : '休息中'}
              {' · '}第 {timerState.currentSession} 轮
            </span>
          </div>
        </div>

        <div className="tt-timer-controls">
          {status === 'running' || status === 'break' ? (
            <button className="btn-pause" onClick={handlePause} type="button"><Pause size={16} /> 暂停</button>
          ) : (
            <button className="btn-start" onClick={handleStart} type="button"><Play size={16} /> 开始</button>
          )}
          {status === 'break' ? (
            <button className="btn-skip" onClick={handleSkipBreak} type="button"><SkipForward size={16} /> 跳过休息</button>
          ) : null}
          <button className="btn-skip" onClick={handleReset} type="button"><Square size={14} /> 重置</button>
        </div>

        <div className="tt-timer-pomodoro-dots">
          {Array.from({ length: sessionsBeforeLong }, (_, i) => (
            <div key={i} className={`dot ${i < timerState.completedSessions % sessionsBeforeLong ? 'done' : ''}`} />
          ))}
        </div>

        <div style={{ width: '100%', maxWidth: 400 }}>
          <label style={{ fontSize: 11, color: 'var(--tt-text-muted)', display: 'block', marginBottom: 4 }}>绑定任务</label>
          <select
            value={timerState.boundTaskId || ''}
            onChange={e => handleBindTask(e.target.value || null)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 'var(--tt-radius-sm)', border: '1px solid var(--tt-border)', background: 'var(--tt-bg)', color: 'var(--tt-text)', fontSize: 13 }}
          >
            <option value="">不绑定任务</option>
            {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>

        <div className="tt-noise-picker">
          {noiseOptions.map(opt => (
            <button
              key={opt.key}
              className={whiteNoise === opt.key ? 'active' : ''}
              onClick={() => setWhiteNoise(opt.key)}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12, color: 'var(--tt-text-muted)' }}>
          {focusMinutes} 分钟专注 / {shortBreak} 分钟短休 / {longBreak} 分钟长休 · 每 {sessionsBeforeLong} 轮长休
        </div>
      </div>
    </div>
  );
}
