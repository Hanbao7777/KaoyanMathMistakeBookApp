import { Pause, Play, SkipForward, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TickTickTask, TickTickSettings } from '../../../shared/types';

type TimerStatus = 'idle' | 'running' | 'paused' | 'break';

export function FocusTimerPage() {
  const [settings, setSettings] = useState<TickTickSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [status, setStatus] = useState<TimerStatus>('idle');
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [totalSeconds, setTotalSeconds] = useState(25 * 60);
  const [completedSessions, setCompletedSessions] = useState(0);
  const [currentSession, setCurrentSession] = useState(1);
  const [whiteNoise, setWhiteNoise] = useState<string>('none');
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [boundTaskId, setBoundTaskId] = useState<string | null>(null);

  // Refs hold latest values for the interval callback to read
  const statusRef = useRef<TimerStatus>('idle');
  const currentSessionRef = useRef(1);
  const whiteNoiseRef = useRef('none');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const breakTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync with state
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { currentSessionRef.current = currentSession; }, [currentSession]);
  useEffect(() => { whiteNoiseRef.current = whiteNoise; }, [whiteNoise]);

  const focusMinutes = settings?.pomodoro?.focusMinutes || 25;
  const shortBreak = settings?.pomodoro?.shortBreakMinutes || 5;
  const longBreak = settings?.pomodoro?.longBreakMinutes || 15;
  const sessionsBeforeLong = settings?.pomodoro?.sessionsBeforeLongBreak || 4;

  // Track last saved session to avoid double-save
  const lastSavedSession = useRef(-1);

  // Track actual session start time for precision and persistence
  const sessionStartRef = useRef<number>(0);
  const breakTotalRef = useRef(0);

  useEffect(() => {
    window.api.getTickTickSettings().then(s => { setSettings(s); setSettingsLoaded(true); });
    window.api.listTickTickTasks({ includeCompleted: false }).then(setTasks);
  }, []);

  // Restore timer state from localStorage on mount
  const TIMER_STORAGE_KEY = 'kaoyan-ticktick-timer-state';
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TIMER_STORAGE_KEY);
      if (saved) {
        const state = JSON.parse(saved);
        setStatus(state.status || 'idle');
        if (state.status === 'running') {
          // Timer was running - recompute remaining time
          const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000);
          const remaining = Math.max(0, state.totalSeconds - elapsed);
          setSecondsLeft(remaining);
          if (remaining > 0) {
            // Resume the running timer
            sessionStartRef.current = state.sessionStartTime;
            // Auto-resume the countdown interval
            const interval = setInterval(() => {
              const elapsed = Math.floor((Date.now() - sessionStartRef.current) / 1000);
              const totalSecs = statusRef.current === 'break' ? state.totalSeconds : (settings?.pomodoro?.focusMinutes || 25) * 60;
              const rem = Math.max(0, totalSecs - elapsed);
              setSecondsLeft(rem);
              if (rem <= 0) {
                clearInterval(interval);
                intervalRef.current = null;
                handleSessionEnd();
              }
            }, 250);
            intervalRef.current = interval;
          }
        } else {
          setSecondsLeft(state.secondsLeft);
        }
        setTotalSeconds(state.totalSeconds);
        setCompletedSessions(state.completedSessions || 0);
        setCurrentSession(state.currentSession || 1);
        setWhiteNoise(state.whiteNoise || 'none');
        setBoundTaskId(state.boundTaskId || null);
        if (state.sessionStartTime) sessionStartRef.current = state.sessionStartTime;
      }
    } catch {}
  }, []);

  // Save timer state to localStorage on changes and unmount
  useEffect(() => {
    return () => {
      const state = { status, secondsLeft, totalSeconds, completedSessions, currentSession, whiteNoise, boundTaskId, sessionStartTime: sessionStartRef.current };
      localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(state));
    };
  }, [status, secondsLeft, totalSeconds, completedSessions, currentSession, whiteNoise, boundTaskId]);

  // Sync to shared state for desktop widget
  useEffect(() => {
    window.api.setSharedTimerState?.({
      status,
      secondsLeft,
      totalSeconds,
      completedSessions,
      currentSession,
      sessionStartTime: sessionStartRef.current,
      boundTaskId,
    }).catch(() => {});
  }, [status, secondsLeft, totalSeconds, completedSessions, currentSession, boundTaskId]);

  function clearTimer() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (breakTimeoutRef.current) { clearTimeout(breakTimeoutRef.current); breakTimeoutRef.current = null; }
  }

  function handleSessionEnd() {
    clearTimer();
    const prevStatus = statusRef.current;
    const sess = currentSessionRef.current;

    if (prevStatus === 'running') {
      // Focus session ended → save and start break
      const actualDuration = Math.round((Date.now() - sessionStartRef.current) / 60000);
      window.api.createTickTickFocusSession({
        task_id: boundTaskId,
        start_time: new Date(sessionStartRef.current).toISOString(),
        end_time: new Date().toISOString(),
        duration_minutes: Math.max(1, actualDuration),
        session_type: 'focus',
        completed: 1,
        white_noise: whiteNoiseRef.current as any,
      }).catch((e) => { console.error('FocusTimer:saveSession', e); });

      setCompletedSessions(prev => prev + 1);

      const isLastInSet = sess % sessionsBeforeLong === 0;
      const breakSecs = isLastInSet ? longBreak * 60 : shortBreak * 60;
      breakTotalRef.current = breakSecs;
      setStatus('break');
      setSecondsLeft(breakSecs);
      setTotalSeconds(breakSecs);

      // Auto-start break after a tick
      breakTimeoutRef.current = setTimeout(() => {
        if (statusRef.current !== 'break') return; // guard against skip
        sessionStartRef.current = Date.now();
        const interval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - sessionStartRef.current) / 1000);
          const remaining = Math.max(0, breakTotalRef.current - elapsed);
          setSecondsLeft(remaining);
          if (remaining <= 0) {
            clearInterval(interval);
            intervalRef.current = null;
            handleSessionEnd();
          }
        }, 250);
        intervalRef.current = interval;
      }, 500);

    } else if (prevStatus === 'break') {
      // Break ended → prepare next focus
      const nextSession = sess + 1;
      setCurrentSession(nextSession);
      setStatus('idle');
      setSecondsLeft(focusMinutes * 60);
      setTotalSeconds(focusMinutes * 60);
    }
  }

  function startTimer() {
    clearTimer();
    if (secondsLeft <= 0) {
      setSecondsLeft(focusMinutes * 60);
      setTotalSeconds(focusMinutes * 60);
    }
    sessionStartRef.current = Date.now();
    setStatus('running');
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - sessionStartRef.current) / 1000);
      const totalSecs = statusRef.current === 'break' ? breakTotalRef.current : focusMinutes * 60;
      const remaining = Math.max(0, totalSecs - elapsed);
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        intervalRef.current = null;
        handleSessionEnd();
      }
    }, 250);
    intervalRef.current = interval;
  }

  function pauseTimer() {
    setStatus('paused');
    clearTimer();
  }

  function skipBreak() {
    clearTimer();
    const nextSession = currentSessionRef.current + 1;
    setCurrentSession(nextSession);
    setStatus('idle');
    setSecondsLeft(focusMinutes * 60);
    setTotalSeconds(focusMinutes * 60);
  }

  function resetTimer() {
    clearTimer();
    setStatus('idle');
    setSecondsLeft(focusMinutes * 60);
    setTotalSeconds(focusMinutes * 60);
    setCompletedSessions(0);
    setCurrentSession(1);
    lastSavedSession.current = -1;
  }

  // Cleanup on unmount
  useEffect(() => () => clearTimer(), []);

  const minutes = Math.floor(Math.max(0, secondsLeft) / 60);
  const secs = Math.max(0, secondsLeft) % 60;
  const progress = totalSeconds > 0 ? Math.max(0, secondsLeft) / totalSeconds : 0;
  const circumference = 2 * Math.PI * 52;
  const dashOffset = circumference * (1 - progress);

  const ringColor = status === 'break' ? 'break' : status === 'paused' ? 'paused' : 'focus';

  if (!settingsLoaded) return <div className="ticktick-main-content"><div className="tt-empty">加载中...</div></div>;

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
              {' · '}第 {currentSession} 轮
            </span>
          </div>
        </div>

        <div className="tt-timer-controls">
          {status === 'running' || status === 'break' ? (
            <button className="btn-pause" onClick={pauseTimer} type="button"><Pause size={16} /> 暂停</button>
          ) : (
            <button className="btn-start" onClick={startTimer} type="button"><Play size={16} /> 开始</button>
          )}
          {status === 'break' ? (
            <button className="btn-skip" onClick={skipBreak} type="button"><SkipForward size={16} /> 跳过休息</button>
          ) : null}
          <button className="btn-skip" onClick={resetTimer} type="button"><Square size={14} /> 重置</button>
        </div>

        <div className="tt-timer-pomodoro-dots">
          {Array.from({ length: sessionsBeforeLong }, (_, i) => (
            <div key={i} className={`dot ${i < completedSessions % sessionsBeforeLong ? 'done' : ''}`} />
          ))}
        </div>

        <div style={{ width: '100%', maxWidth: 400 }}>
          <label style={{ fontSize: 11, color: 'var(--tt-text-muted)', display: 'block', marginBottom: 4 }}>绑定任务</label>
          <select
            value={boundTaskId || ''}
            onChange={e => setBoundTaskId(e.target.value || null)}
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
