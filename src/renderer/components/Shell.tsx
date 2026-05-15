import { BarChart3, BookMarked, BookOpen, BookOpenCheck, Clock3, FileQuestion, FileUp, Home, Library, ListTodo, PlusCircle, RotateCcw, Settings, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FocusTimerControls, FocusTimerState } from '../types/focusTimer';

export type PageKey = 'dashboard' | 'studySupervisor' | 'dailyPlan' | 'studyMaterials' | 'focusTimer' | 'add' | 'library' | 'detail' | 'review' | 'knowledgeMap' | 'questionBank' | 'stats' | 'import' | 'settings';

interface ShellProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  children: ReactNode;
  focusTimer?: FocusTimerState;
  focusTimerControls?: FocusTimerControls;
}

const navGroups = [
  {
    title: '学习',
    items: [
      { key: 'dashboard', label: '首页', icon: Home },
      { key: 'studySupervisor', label: '备考监督', icon: ShieldCheck },
      { key: 'dailyPlan', label: '每日计划', icon: ListTodo },
      { key: 'focusTimer', label: '专注计时', icon: Clock3 },
      { key: 'review', label: '复习', icon: RotateCcw },
      { key: 'knowledgeMap', label: '知识地图', icon: BookMarked },
      { key: 'questionBank', label: '题库训练', icon: FileQuestion }
    ]
  },
  {
    title: '管理',
    items: [
      { key: 'add', label: '添加错题', icon: PlusCircle },
      { key: 'library', label: '错题库', icon: Library },
      { key: 'studyMaterials', label: '资料进度', icon: BookOpenCheck },
      { key: 'stats', label: '统计', icon: BarChart3 }
    ]
  },
  {
    title: '工具',
    items: [
      { key: 'import', label: '导入数据', icon: FileUp },
      { key: 'settings', label: '设置', icon: Settings }
    ]
  }
] as const;

function formatSeconds(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':');
}

export function Shell({ page, onNavigate, children, focusTimer, focusTimerControls }: ShellProps) {
  const showTimer = focusTimer && focusTimerControls && (focusTimer.status !== 'idle' || focusTimerControls.elapsedSeconds > 0);
  const timerLabel = focusTimer?.taskTitle || focusTimer?.subjectName || '专注计时';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BookOpen size={22} /></div>
          <div>
            <strong>考研数学错题本</strong>
            <span>Mistake Review System</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <p>{group.title}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    className={`nav-item ${page === item.key ? 'active' : ''}`}
                    onClick={() => onNavigate(item.key)}
                    type="button"
                  >
                    <Icon size={18} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main-panel">
        {showTimer ? (
          <div className={`focus-mini-bar status-${focusTimer.status}`}>
            <button className="focus-mini-main" type="button" onClick={() => onNavigate('focusTimer')}>
              <Clock3 size={16} />
              <strong>{focusTimer.status === 'running' ? '专注中' : '已暂停'}</strong>
              <span>{timerLabel}</span>
              <em>{formatSeconds(focusTimerControls.elapsedSeconds)}</em>
            </button>
            {focusTimer.status === 'running' ? (
              <button className="secondary-button compact-button" type="button" onClick={focusTimerControls.pause}>暂停</button>
            ) : (
              <button className="primary-button compact-button" type="button" onClick={focusTimerControls.start}>继续</button>
            )}
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
