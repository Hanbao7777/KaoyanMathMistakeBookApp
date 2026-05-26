import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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

  useEffect(() => {
    setLoading(true);
    window.api.getTickTickCalendarMonth(year, month).then(setDays).catch((e) => { console.error('CalendarPage', e); setDays([]); }).finally(() => setLoading(false));
  }, [year, month]);

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

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
          <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')} type="button" disabled>周</button>
          <button className={view === 'day' ? 'active' : ''} onClick={() => setView('day')} type="button" disabled>日</button>
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
      ) : (
        <div className="tt-empty">{view === 'week' ? '周' : '日'}视图将在后续版本中提供</div>
      )}

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
