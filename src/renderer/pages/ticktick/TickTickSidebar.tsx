import { Calendar, Clock3, Hash, Inbox, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TickTickList, TickTickTag } from '../../../shared/types';

type TickTickPageKey = 'today' | 'calendar' | 'inbox' | 'list' | 'focus' | 'settings';

interface TickTickSidebarProps {
  page: TickTickPageKey;
  selectedListId?: string | null;
  onNavigate: (page: TickTickPageKey, listId?: string) => void;
  onModeChange: () => void;
}

export function TickTickSidebar({ page, selectedListId, onNavigate, onModeChange }: TickTickSidebarProps) {
  const [lists, setLists] = useState<TickTickList[]>([]);
  const [tags, setTags] = useState<TickTickTag[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [inboxCount, setInboxCount] = useState(0);

  async function load() {
    try {
      const [l, t] = await Promise.all([
        window.api.listTickTickLists(),
        window.api.listTickTickTags(),
      ]);
      setLists(l);
      setTags(t);

      // Get today count
      const todayData = await window.api.getTodayTickTickTasks();
      setTodayCount(todayData.overdue.length + todayData.today.length);

      // Inbox = tasks with no due date
      const allTasks = await window.api.listTickTickTasks({ includeNoDate: true });
      setInboxCount(allTasks.filter(t => !t.due_date).length);
    } catch (e) { console.error('TickTickSidebar', e); }
  }

  useEffect(() => { load(); }, [page]);

  return (
    <aside className="ticktick-sidebar">
      {/* User area */}
      <div style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--tt-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>H</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 12 }}>Hanbao7777</div>
          <div style={{ fontSize: 10, color: 'var(--tt-text-muted)' }}>考研加油</div>
        </div>
        <button
          onClick={onModeChange}
          style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', border: '1px solid var(--tt-border)', borderRadius: 'var(--tt-radius-sm)', background: 'none', cursor: 'pointer', color: 'var(--tt-text-secondary)' }}
          type="button"
        >
          错题本
        </button>
      </div>

      <div className="tt-sidebar-scroll">
        {/* Smart Lists */}
        <div className="tt-sidebar-section">
          <div className="tt-sidebar-label">智能列表</div>
          <button className={`tt-sidebar-item ${page === 'today' ? 'active' : ''}`} onClick={() => onNavigate('today')} type="button">
            <span style={{ fontSize: 14 }}>📋</span> 今天
            {todayCount > 0 ? <span className="badge">{todayCount}</span> : null}
          </button>
          <button className={`tt-sidebar-item ${page === 'calendar' ? 'active' : ''}`} onClick={() => onNavigate('calendar')} type="button">
            <Calendar size={14} /> 日历
          </button>
          <button className={`tt-sidebar-item ${page === 'inbox' ? 'active' : ''}`} onClick={() => onNavigate('inbox')} type="button">
            <Inbox size={14} /> 收集箱
            {inboxCount > 0 ? <span className="count">{inboxCount}</span> : null}
          </button>
        </div>

        {/* Lists */}
        <div className="tt-sidebar-section">
          <div className="tt-sidebar-label">清单</div>
          {lists.map((list) => (
            <button
              key={list.id}
              className={`tt-sidebar-item ${page === 'list' && selectedListId === list.id ? 'active' : ''}`}
              onClick={() => onNavigate('list', list.id)}
              type="button"
            >
              <span className="dot" style={{ background: list.color }} />
              {list.name}
              {list.task_count ? <span className="count">{list.task_count}</span> : null}
            </button>
          ))}
        </div>

        {/* Tags */}
        {tags.length > 0 ? (
          <div className="tt-sidebar-section">
            <div className="tt-sidebar-label">标签</div>
            {tags.slice(0, 10).map((tag) => (
              <button key={tag.id} className="tt-sidebar-item" type="button">
                <Hash size={12} style={{ color: tag.color }} />
                {tag.name}
                {tag.task_count ? <span className="count">{tag.task_count}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Tools */}
      <div className="tt-sidebar-section tt-sidebar-tools">
        <div className="tt-sidebar-label">工具</div>
        <button className={`tt-sidebar-item ${page === 'focus' ? 'active' : ''}`} onClick={() => onNavigate('focus')} type="button">
          <Clock3 size={14} /> 专注计时
        </button>
        <button className={`tt-sidebar-item ${page === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')} type="button">
          <Settings size={14} /> 设置
        </button>
      </div>
    </aside>
  );
}
