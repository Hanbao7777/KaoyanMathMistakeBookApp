import { Calendar, CheckCircle, ClipboardList, Clock3, Grid3X3, Hash, Inbox, Layout, Monitor, Plus, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TickTickList, TickTickTag } from '../../../shared/types';
import { runLoad } from '../../../shared/loadState';

type TickTickPageKey = 'today' | 'calendar' | 'inbox' | 'list' | 'focus' | 'settings' | 'kanban' | 'eisenhower' | 'habits';

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
  const [showAddList, setShowAddList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const outcome = await runLoad(async () => {
      const [l, t] = await Promise.all([
        window.api.listTickTickLists(),
        window.api.listTickTickTags(),
      ]);
      const todayData = await window.api.getTodayTickTickTasks();
      const allTasks = await window.api.listTickTickTasks({ includeNoDate: true });
      return { l, t, todayData, allTasks };
    }, '侧边栏加载失败');
    if (outcome.ok) {
      const { l, t, todayData, allTasks } = outcome.value;
      setLists(l);
      setTags(t);
      // Get today count
      setTodayCount(todayData.overdue.length + todayData.today.length);
      // Inbox = tasks with no due date
      setInboxCount(allTasks.filter(t => !t.due_date).length);
    } else {
      setError(outcome.message);
    }
  }

  useEffect(() => { load(); }, [page]);

  async function handleCreateList() {
    if (!newListName.trim()) return;
    try {
      await window.api.createTickTickList({ name: newListName.trim() });
      setNewListName('');
      setShowAddList(false);
      load();
    } catch (e) { /* ignore */ }
  }

  // Reload on window focus to keep counts fresh
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

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
        {error ? (
          <div className="tt-sidebar-error" role="alert" style={{ margin: '8px 10px', padding: '8px 10px', borderRadius: 'var(--tt-radius-sm)', background: 'var(--tt-bg-hover)', fontSize: 12, color: 'var(--tt-danger)' }}>
            <div>{error}（计数可能不是最新）</div>
            <button type="button" className="tt-retry-btn" onClick={load} style={{ marginTop: 4, fontSize: 11, padding: '2px 8px', border: '1px solid var(--tt-border)', borderRadius: 'var(--tt-radius-sm)', background: 'none', cursor: 'pointer', color: 'var(--tt-text-secondary)' }}>重试</button>
          </div>
        ) : null}
        {/* Smart Lists */}
        <div className="tt-sidebar-section">
          <div className="tt-sidebar-label">智能列表</div>
          <button className={`tt-sidebar-item ${page === 'today' ? 'active' : ''}`} onClick={() => onNavigate('today')} type="button">
            <ClipboardList size={14} /> 今天
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

        {/* Views */}
        <div className="tt-sidebar-section">
          <div className="tt-sidebar-label">视图</div>
          <button className={`tt-sidebar-item ${page === 'kanban' ? 'active' : ''}`} onClick={() => onNavigate('kanban')} type="button">
            <Layout size={14} /> 看板
          </button>
          <button className={`tt-sidebar-item ${page === 'eisenhower' ? 'active' : ''}`} onClick={() => onNavigate('eisenhower')} type="button">
            <Grid3X3 size={14} /> 艾森豪威尔
          </button>
        </div>

        {/* Lists */}
        <div className="tt-sidebar-section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="tt-sidebar-label" style={{ padding: 0 }}>清单</div>
            <button
              onClick={() => setShowAddList(!showAddList)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-muted)', fontSize: 14, padding: '2px 4px' }}
              type="button"
              title="创建清单"
            >
              <Plus size={14} />
            </button>
          </div>
          {showAddList ? (
            <div style={{ display: 'flex', gap: 4, padding: '4px 0', marginBottom: 4 }}>
              <input
                autoFocus
                value={newListName}
                onChange={e => setNewListName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateList(); if (e.key === 'Escape') { setShowAddList(false); setNewListName(''); } }}
                placeholder="清单名称..."
                style={{ flex: 1, padding: '4px 8px', borderRadius: 'var(--tt-radius-sm)', border: '1px solid var(--tt-border)', background: 'var(--tt-bg)', color: 'var(--tt-text)', fontSize: 12, outline: 'none' }}
              />
              <button onClick={handleCreateList} style={{ padding: '4px 8px', borderRadius: 'var(--tt-radius-sm)', border: 'none', background: 'var(--tt-accent)', color: '#fff', cursor: 'pointer', fontSize: 12 }} type="button">创建</button>
            </div>
          ) : null}
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
              <div key={tag.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 'var(--tt-radius-sm)', fontSize: 13, color: 'var(--tt-text)', cursor: 'default' }}>
                <Hash size={12} style={{ color: tag.color }} />
                {tag.name}
                {tag.task_count ? <span className="count">{tag.task_count}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Efficiency */}
      <div className="tt-sidebar-section">
        <div className="tt-sidebar-label">效率</div>
        <button className={`tt-sidebar-item ${page === 'habits' ? 'active' : ''}`} onClick={() => onNavigate('habits')} type="button">
          <CheckCircle size={14} /> 习惯打卡
        </button>
      </div>

      {/* Tools */}
      <div className="tt-sidebar-section tt-sidebar-tools">
        <div className="tt-sidebar-label">工具</div>
        <button className={`tt-sidebar-item ${page === 'focus' ? 'active' : ''}`} onClick={() => onNavigate('focus')} type="button">
          <Clock3 size={14} /> 专注计时
        </button>
        <button className="tt-sidebar-item" onClick={() => window.api.openWidget()} type="button">
          <Monitor size={14} /> 桌面悬浮窗
        </button>
        <button className={`tt-sidebar-item ${page === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')} type="button">
          <Settings size={14} /> 设置
        </button>
      </div>
    </aside>
  );
}
