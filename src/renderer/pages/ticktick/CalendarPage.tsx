import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TickTickCalendarDay, TickTickTask } from '../../../shared/types';

export function CalendarPage() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [days, setDays] = useState<TickTickCalendarDay[]>([]);
  const [view, setView] = useState<'month' | 'week' | 'day'>('month');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTasks, setSelectedTasks] = useState<TickTickTask[]>([]);
  const [showDayDetail, setShowDayDetail] = useState(false);
  const [loading, setLoading] = useState(false);
  const [weekTasks, setWeekTasks] = useState<Record<string, TickTickTask[]>>({});
  const [weekLoading, setWeekLoading] = useState(false);
  const [dayTasks, setDayTasks] = useState<TickTickTask[]>([]);
  const [dayLoading, setDayLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    window.api.getTickTickCalendarMonth(year, month).then(setDays).catch((e) => { console.error('CalendarPage', e); setDays([]); }).finally(() => setLoading(false));
  }, [year, month]);

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Compute Monday of the current week
  const currentWeekMonday = useMemo(() => {
    const dayOfWeek = today.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }, []);

  // Week date strings (Monday to Sunday)
  const weekDateStrs = useMemo(() => {
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(currentWeekMonday);
      d.setDate(currentWeekMonday.getDate() + i);
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return dates;
  }, [currentWeekMonday]);

  const loadWeekTasks = useCallback(async () => {
    setWeekLoading(true);
    try {
      const results = await Promise.all(
        weekDateStrs.map(date => window.api.listTickTickTasks({ dueDate: date, includeCompleted: false }))
      );
      const map: Record<string, TickTickTask[]> = {};
      weekDateStrs.forEach((date, i) => {
        map[date] = results[i] || [];
      });
      setWeekTasks(map);
    } catch (e) {
      console.error('CalendarPage week load', e);
      setWeekTasks({});
    } finally {
      setWeekLoading(false);
    }
  }, [weekDateStrs]);

  const loadDayTasks = useCallback(async () => {
    setDayLoading(true);
    try {
      const tasks = await window.api.listTickTickTasks({ dueDate: todayStr, includeCompleted: false });
      setDayTasks(tasks.filter(t => !t.parent_id));
    } catch (e) {
      console.error('CalendarPage day load', e);
      setDayTasks([]);
    } finally {
      setDayLoading(false);
    }
  }, [todayStr]);

  // Load week/day tasks when view changes
  useEffect(() => {
    if (view === 'week') loadWeekTasks();
    if (view === 'day') loadDayTasks();
  }, [view, loadWeekTasks, loadDayTasks]);

  // Compute grid padding for first day of month
  const firstDayOfWeek = useMemo(() => {
    const d = new Date(year, month - 1, 1);
    const dow = d.getDay();
    return dow === 0 ? 6 : dow - 1; // Convert Sunday=0 to Monday=0
  }, [year, month]);

  const daysInMonth = new Date(year, month, 0).getDate();
  const dayMap = new Map(days.map(d => [d.date, d]));

  function prevMonth() {
    if (month === 1) { setYear(year - 1); setMonth(12); }
    else setMonth(month - 1);
  }

  function nextMonth() {
    if (month === 12) { setYear(year + 1); setMonth(1); }
    else setMonth(month + 1);
  }

  async function handleDayClick(date: string) {
    setSelectedDate(date);
    setShowDayDetail(true);
    const tasks = await window.api.listTickTickTasks({ dueDate: date, includeCompleted: true });
    setSelectedTasks(tasks.filter(t => !t.parent_id));
  }

  function goToday() {
    setYear(today.getFullYear());
    setMonth(today.getMonth() + 1);
  }

  const monthLabel = `${year}年 ${month}月`;
  const weekHeaders = ['一', '二', '三', '四', '五', '六', '日'];

  const cells: (TickTickCalendarDay | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push(dayMap.get(dateStr) || { date: dateStr, task_count: 0, completed_count: 0, review_due_count: 0, pomodoro_count: 0, has_ai_plan: false, tasks: [] });
  }

  return (
    <div className="ticktick-main-content">
      <div className="tt-calendar-header">
        <div className="tt-calendar-nav">
          <button onClick={prevMonth} type="button"><ChevronLeft size={16} /></button>
          <span className="month-label">{monthLabel}</span>
          <button onClick={nextMonth} type="button"><ChevronRight size={16} /></button>
          <button onClick={goToday} type="button" style={{ fontSize: 11, color: 'var(--tt-accent)', background: 'none', border: '1px solid var(--tt-accent)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>今天</button>
        </div>
        <div className="tt-calendar-view-toggle">
          <button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')} type="button">月</button>
          <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')} type="button">周</button>
          <button className={view === 'day' ? 'active' : ''} onClick={() => setView('day')} type="button">日</button>
        </div>
      </div>

      {view === 'month' ? (
        <div className="tt-month-grid" style={{ opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          {weekHeaders.map(h => <div key={h} className="day-header">{h}</div>)}
          {cells.map((day, i) => {
            if (!day) return <div key={`empty-${i}`} className="day-cell" style={{ background: 'var(--tt-bg-hover)' }} />;
            const isToday = day.date === todayStr;
            return (
              <div key={day.date} className={`day-cell ${isToday ? 'today' : ''}`} onClick={() => handleDayClick(day.date)}>
                <span className="day-num">{parseInt(day.date.split('-')[2], 10)}</span>
                {day.task_count > 0 ? <span className="day-badge tasks">{day.completed_count}/{day.task_count} 任务</span> : null}
                {day.review_due_count > 0 ? <span className="day-badge reviews">{day.review_due_count} 复习</span> : null}
                {day.pomodoro_count > 0 ? <span className="day-badge pomo">🍅 {day.pomodoro_count}</span> : null}
                {day.has_ai_plan ? <span className="day-badge pomo">🤖 AI</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {view === 'week' ? (
        <div style={{ display: 'flex', gap: 4, flex: 1, overflow: 'auto', opacity: weekLoading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          {weekDateStrs.map((dateStr, i) => {
            const isToday = dateStr === todayStr;
            const tasks = (weekTasks[dateStr] || []).filter(t => !t.parent_id && !t.is_completed);
            const dayDate = parseInt(dateStr.split('-')[2], 10);
            return (
              <div key={i} style={{ flex: '1 1 0', minWidth: 100, background: isToday ? 'var(--tt-bg-active)' : 'var(--tt-bg-sidebar)', borderRadius: 'var(--tt-radius-md)', padding: 10, border: isToday ? '1px solid var(--tt-accent)' : '1px solid transparent' }}>
                <div style={{ textAlign: 'center', marginBottom: 8, fontWeight: isToday ? 700 : 400, fontSize: 12 }}>
                  <div style={{ color: 'var(--tt-text-muted)', fontSize: 10 }}>{['一','二','三','四','五','六','日'][i]}</div>
                  <div style={{ fontSize: 16, color: isToday ? 'var(--tt-accent)' : 'var(--tt-text)' }}>{dayDate}</div>
                </div>
                {tasks.slice(0, 10).map(task => (
                  <div key={task.id} style={{ fontSize: 11, padding: '3px 6px', background: 'var(--tt-bg)', borderRadius: 3, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }} title={task.title} onClick={() => handleDayClick(dateStr)}>
                    {task.priority === '高' ? <span style={{ color: 'var(--tt-danger)', fontWeight: 600 }}>!! </span> : null}
                    {task.title}
                  </div>
                ))}
                {tasks.length > 10 ? <div style={{ fontSize: 10, color: 'var(--tt-text-muted)', textAlign: 'center' }}>+{tasks.length - 10} 更多</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {view === 'day' ? (
        <div style={{ flex: 1, overflow: 'auto', opacity: dayLoading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
            {today.getFullYear()}年{today.getMonth() + 1}月{today.getDate()}日
            <span style={{ fontSize: 12, color: 'var(--tt-text-secondary)', marginLeft: 8, fontWeight: 400 }}>
              周{['日','一','二','三','四','五','六'][today.getDay()]}
            </span>
          </div>
          {dayTasks.length > 0 ? dayTasks.map(task => (
            <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--tt-border-light)' }}>
              <span style={{ fontSize: 12, color: 'var(--tt-text-muted)', minWidth: 50 }}>{task.due_time || '全天'}</span>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: task.priority === '高' ? 'var(--tt-danger)' : task.priority === '中' ? 'var(--tt-warning)' : 'var(--tt-border)' }} />
              <span style={{ fontSize: 13, textDecoration: task.is_completed ? 'line-through' : 'none' }}>{task.title}</span>
            </div>
          )) : (
            <div className="tt-empty">今天没有安排任务</div>
          )}
        </div>
      ) : null}

      {showDayDetail && selectedDate ? (
        <div style={{ marginTop: 16, padding: 16, background: 'var(--tt-bg-sidebar)', borderRadius: 'var(--tt-radius-md)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>{selectedDate}</strong>
            <button onClick={() => setShowDayDetail(false)} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-secondary)' }}>✕</button>
          </div>
          {selectedTasks.length > 0 ? selectedTasks.map(t => (
            <div key={t.id} style={{ padding: '6px 0', fontSize: 13, borderBottom: '1px solid var(--tt-border-light)' }}>
              <span style={{ textDecoration: t.is_completed ? 'line-through' : 'none', color: t.is_completed ? 'var(--tt-text-muted)' : 'var(--tt-text)' }}>{t.title}</span>
            </div>
          )) : <div style={{ fontSize: 12, color: 'var(--tt-text-muted)' }}>当天没有任务</div>}
        </div>
      ) : null}
    </div>
  );
}
