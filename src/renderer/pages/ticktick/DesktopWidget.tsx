import { Check, ExternalLink, MoreHorizontal, Pause, Pin, Play, Plus, RotateCcw, X } from 'lucide-react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { TickTickList, TickTickTask } from '../../../shared/types';

const widgetSettingsKey = 'kaoyan-widget-settings-v2';
const widgetMinWidth = 280;
const widgetMinHeight = 360;
const widgetMaxWidth = 420;
const widgetMaxHeight = 680;

type WidgetTheme = 'system' | 'light' | 'dark';
type TimerStatus = 'idle' | 'running' | 'paused' | 'break';
type ResizeDirection = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'corner';

interface WidgetSettings {
  theme: WidgetTheme;
  opacity: number;
  pinned: boolean;
  restoreBounds: boolean;
}

interface SharedTimerState {
  status: string;
  secondsLeft: number;
  totalSeconds: number;
  completedSessions: number;
  currentSession: number;
  sessionStartTime: number | null;
  boundTaskId: string | null;
}

const defaultSettings: WidgetSettings = {
  theme: 'system',
  opacity: 0.82,
  pinned: true,
  restoreBounds: true,
};

const defaultTimer: SharedTimerState = {
  status: 'idle',
  secondsLeft: 25 * 60,
  totalSeconds: 25 * 60,
  completedSessions: 0,
  currentSession: 1,
  sessionStartTime: null,
  boundTaskId: null,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getEffectiveTheme(theme: WidgetTheme) {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function formatSeconds(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const min = Math.floor(safe / 60);
  const sec = safe % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getResizeCursor(direction: ResizeDirection) {
  if (direction === 'top-left' || direction === 'corner') return 'nwse-resize';
  if (direction === 'top-right' || direction === 'bottom-left') return 'nesw-resize';
  if (direction === 'left' || direction === 'right') return 'ew-resize';
  return 'ns-resize';
}

function priorityRank(task: TickTickTask) {
  if (task.priority === '高') return 0;
  if (task.priority === '中') return 1;
  if (task.priority === '低') return 2;
  return 3;
}

export function DesktopWidget() {
  const [settings, setSettings] = useState<WidgetSettings>(() => readJson(widgetSettingsKey, defaultSettings));
  const [timer, setTimer] = useState<SharedTimerState>(defaultTimer);
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [lists, setLists] = useState<TickTickList[]>([]);
  const [examDate, setExamDate] = useState<string | null>(null);
  const [daysUntilExam, setDaysUntilExam] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickTitle, setQuickTitle] = useState('');
  const resizeFrameRef = useRef<number | null>(null);

  const effectiveTheme = getEffectiveTheme(settings.theme);
  const isDark = effectiveTheme === 'dark';

  const secondsLeft = Math.max(0, timer.secondsLeft);
  const progress = timer.totalSeconds > 0 ? secondsLeft / timer.totalSeconds : 0;
  const circumference = 2 * Math.PI * 52;
  const dashOffset = circumference * (1 - progress);
  const activeTasks = tasks
    .filter((task) => !task.is_completed && !task.parent_id)
    .sort((a, b) => priorityRank(a) - priorityRank(b) || (a.due_time || '').localeCompare(b.due_time || ''))
    .slice(0, 8);
  const completedCount = tasks.filter((task) => task.is_completed && !task.parent_id).length;

  useEffect(() => {
    document.documentElement.classList.add('desktop-widget-document');
    document.body.classList.add('desktop-widget-body');
    return () => {
      document.documentElement.classList.remove('desktop-widget-document');
      document.body.classList.remove('desktop-widget-body');
      document.body.style.cursor = '';
    };
  }, []);

  async function loadData() {
    try {
      const [todayTasks, tickTickLists, studySettings] = await Promise.all([
        window.api.getTodayTickTickTasks(),
        window.api.listTickTickLists(),
        window.api.getStudySettings(),
      ]);
      setTasks([...todayTasks.overdue, ...todayTasks.today]);
      setLists(tickTickLists);
      if (studySettings.exam_date) {
        setExamDate(studySettings.exam_date);
        const target = new Date(`${studySettings.exam_date}T00:00:00`).getTime();
        const startOfToday = new Date(`${today()}T00:00:00`).getTime();
        setDaysUntilExam(Math.max(0, Math.ceil((target - startOfToday) / 86400000)));
      }
    } catch (error) {
      console.error('DesktopWidget:loadData', error);
    }
  }

  useEffect(() => {
    loadData();
    const refresh = window.setInterval(loadData, 30000);
    return () => window.clearInterval(refresh);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(widgetSettingsKey, JSON.stringify(settings));
    window.api.toggleWidgetPin(settings.pinned);
  }, [settings]);

  // Poll shared timer state for display (read-only, does not advance time)
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const state = await window.api.getSharedTimerState();
        if (!cancelled) setTimer(state);
      } catch {}
    }
    poll();
    const interval = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  function updateSettings(patch: Partial<WidgetSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function startTimer() { window.api.startSharedTimer().catch(() => {}); }
  function pauseTimer() { window.api.pauseSharedTimer().catch(() => {}); }
  function resetTimer() { window.api.resetSharedTimer().catch(() => {}); }

  async function completeTask(task: TickTickTask) {
    try {
      await window.api.completeTickTickTask(task.id);
      await loadData();
    } catch (error) {
      console.error('DesktopWidget:completeTask', error);
    }
  }

  async function addTask() {
    const title = quickTitle.trim();
    const list = lists[0];
    if (!title || !list) return;
    try {
      await window.api.createTickTickTask({
        list_id: list.id,
        title,
        due_date: today(),
        priority: 'none',
      });
      setQuickTitle('');
      setQuickAddOpen(false);
      await loadData();
    } catch (error) {
      console.error('DesktopWidget:addTask', error);
    }
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLElement>, direction: ResizeDirection) {
    event.preventDefault();
    event.stopPropagation();

    const startPointerX = event.screenX;
    const startPointerY = event.screenY;
    const startBounds = {
      x: Math.round(window.screenX),
      y: Math.round(window.screenY),
      width: window.innerWidth,
      height: window.innerHeight,
    };
    document.body.classList.add('widget-resizing');
    document.body.style.cursor = getResizeCursor(direction);

    const getNextBounds = (pointerEvent: PointerEvent) => {
      const deltaX = pointerEvent.screenX - startPointerX;
      const deltaY = pointerEvent.screenY - startPointerY;
      const resizeLeft = direction.includes('left');
      const resizeRight = direction.includes('right') || direction === 'corner';
      const resizeTop = direction.includes('top');
      const resizeBottom = direction.includes('bottom') || direction === 'corner';
      const nextWidth = Math.round(clamp(
        startBounds.width + (resizeRight ? deltaX : 0) - (resizeLeft ? deltaX : 0),
        widgetMinWidth,
        widgetMaxWidth
      ));
      const nextHeight = Math.round(clamp(
        startBounds.height + (resizeBottom ? deltaY : 0) - (resizeTop ? deltaY : 0),
        widgetMinHeight,
        widgetMaxHeight
      ));

      return {
        x: resizeLeft ? startBounds.x + (startBounds.width - nextWidth) : startBounds.x,
        y: resizeTop ? startBounds.y + (startBounds.height - nextHeight) : startBounds.y,
        width: nextWidth,
        height: nextHeight,
      };
    };

    const applyResize = (pointerEvent: PointerEvent) => {
      window.api.setWidgetBounds(getNextBounds(pointerEvent));
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = window.requestAnimationFrame(() => applyResize(moveEvent));
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      applyResize(upEvent);
      document.body.classList.remove('widget-resizing');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    window.addEventListener('pointercancel', onPointerUp, { once: true });
  }

  return (
    <div
      className={`desktop-widget ${isDark ? 'theme-dark' : 'theme-light'} status-${timer.status}`}
      style={{ '--widget-opacity': settings.opacity } as CSSProperties}
    >
      <header className="widget-titlebar widget-drag-region">
        <div className="widget-countdown">
          <span>距考研</span>
          <strong>{daysUntilExam ?? '--'}</strong>
          <span>天</span>
          {examDate ? <small>{examDate}</small> : null}
        </div>
        <div className="widget-window-actions">
          <button
            className={`widget-icon-button ${settings.pinned ? 'active' : ''}`}
            onClick={() => updateSettings({ pinned: !settings.pinned })}
            title={settings.pinned ? '取消置顶' : '始终置顶'}
            type="button"
          >
            <Pin size={14} />
          </button>
          <button
            className={`widget-icon-button ${showSettings ? 'active' : ''}`}
            onClick={() => setShowSettings((value) => !value)}
            title="设置"
            type="button"
          >
            <MoreHorizontal size={16} />
          </button>
        </div>
      </header>

      {showSettings ? (
        <section className="widget-settings-popover">
          <div className="widget-setting-group">
            <span>外观</span>
            <div className="widget-segmented">
              {(['system', 'light', 'dark'] as WidgetTheme[]).map((theme) => (
                <button
                  className={settings.theme === theme ? 'active' : ''}
                  key={theme}
                  onClick={() => updateSettings({ theme })}
                  type="button"
                >
                  {theme === 'system' ? '系统' : theme === 'light' ? '浅色' : '深色'}
                </button>
              ))}
            </div>
          </div>
          <label className="widget-setting-row">
            <span>透明度</span>
            <input
              max={0.96}
              min={0.72}
              onChange={(event) => updateSettings({ opacity: Number(event.target.value) })}
              step={0.02}
              type="range"
              value={settings.opacity}
            />
          </label>
          <label className="widget-setting-check">
            <input
              checked={settings.pinned}
              onChange={(event) => updateSettings({ pinned: event.target.checked })}
              type="checkbox"
            />
            始终置顶
          </label>
        </section>
      ) : null}

      <main className="widget-body">
        <section className="widget-timer">
          <div className="widget-ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle className="widget-ring-track" cx="60" cy="60" r="52" />
              <circle
                className="widget-ring-progress"
                cx="60"
                cy="60"
                r="52"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <div className="widget-time">
              <strong>{formatSeconds(secondsLeft)}</strong>
              <span>
                {timer.status === 'running' ? '专注中' : timer.status === 'paused' ? '已暂停' : timer.status === 'break' ? '休息中' : '准备开始'}
              </span>
            </div>
          </div>
          <div className="widget-timer-meta">
            <span>今日专注 {timer.completedSessions} 轮</span>
            <span>{completedCount} 项已完成</span>
          </div>
          <div className="widget-timer-actions">
            {timer.status === 'running' ? (
              <button className="widget-primary-button" onClick={pauseTimer} type="button">
                <Pause size={15} />
                暂停
              </button>
            ) : (
              <button className="widget-primary-button" onClick={startTimer} type="button">
                <Play size={15} />
                开始专注
              </button>
            )}
            <button className="widget-ghost-button" onClick={resetTimer} type="button">
              <RotateCcw size={14} />
              重置
            </button>
          </div>
        </section>

        <section className="widget-tasks">
          <div className="widget-section-head">
            <span>今日任务</span>
            <strong>{completedCount}/{tasks.filter((task) => !task.parent_id).length}</strong>
          </div>
          <div className="widget-task-list">
            {activeTasks.length > 0 ? activeTasks.map((task) => (
              <button className="widget-task-row" key={task.id} onClick={() => completeTask(task)} title="点击完成任务" type="button">
                <span className={`widget-checkbox priority-${task.priority === '高' ? 'high' : task.priority === '中' ? 'medium' : task.priority === '低' ? 'low' : 'none'}`}>
                  <Check size={11} />
                </span>
                <span className="widget-task-title">{task.title}</span>
                {task.estimated_minutes ? <small>{task.estimated_minutes}m</small> : null}
              </button>
            )) : (
              <div className="widget-empty">今天没有未完成任务</div>
            )}
          </div>
        </section>
      </main>

      <footer className="widget-footer">
        {quickAddOpen ? (
          <form className="widget-quick-add" onSubmit={(event) => { event.preventDefault(); addTask(); }}>
            <input
              autoFocus
              onChange={(event) => setQuickTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setQuickAddOpen(false);
                  setQuickTitle('');
                }
              }}
              placeholder={lists.length ? '添加今日任务' : '请先在主应用创建清单'}
              value={quickTitle}
            />
            <button disabled={!quickTitle.trim() || !lists.length} title="添加" type="submit"><Plus size={14} /></button>
            <button onClick={() => { setQuickAddOpen(false); setQuickTitle(''); }} title="取消" type="button"><X size={14} /></button>
          </form>
        ) : (
          <>
            <button className="widget-footer-button" onClick={() => setQuickAddOpen(true)} type="button">
              <Plus size={14} />
              添加任务
            </button>
            <button className="widget-footer-button" onClick={() => window.api.openMainWindow()} type="button">
              <ExternalLink size={14} />
              打开主应用
            </button>
          </>
        )}
      </footer>

      <button
        aria-label="从左侧调整悬浮窗宽度"
        className="widget-resize-zone widget-resize-left"
        onPointerDown={(event) => handleResizePointerDown(event, 'left')}
        type="button"
      />
      <button
        aria-label="从右侧调整悬浮窗宽度"
        className="widget-resize-zone widget-resize-right"
        onPointerDown={(event) => handleResizePointerDown(event, 'right')}
        type="button"
      />
      <button
        aria-label="从顶部调整悬浮窗高度"
        className="widget-resize-zone widget-resize-top"
        onPointerDown={(event) => handleResizePointerDown(event, 'top')}
        type="button"
      />
      <button
        aria-label="从底部调整悬浮窗高度"
        className="widget-resize-zone widget-resize-bottom"
        onPointerDown={(event) => handleResizePointerDown(event, 'bottom')}
        type="button"
      />
      <button
        aria-label="从左上角调整悬浮窗大小"
        className="widget-resize-corner widget-resize-top-left"
        onPointerDown={(event) => handleResizePointerDown(event, 'top-left')}
        type="button"
      />
      <button
        aria-label="从右上角调整悬浮窗大小"
        className="widget-resize-corner widget-resize-top-right"
        onPointerDown={(event) => handleResizePointerDown(event, 'top-right')}
        type="button"
      />
      <button
        aria-label="从左下角调整悬浮窗大小"
        className="widget-resize-corner widget-resize-bottom-left"
        onPointerDown={(event) => handleResizePointerDown(event, 'bottom-left')}
        type="button"
      />
      <button
        aria-label="从右下角调整悬浮窗大小"
        className="widget-resize-corner widget-resize-bottom-right"
        onPointerDown={(event) => handleResizePointerDown(event, 'corner')}
        type="button"
      />
    </div>
  );
}
