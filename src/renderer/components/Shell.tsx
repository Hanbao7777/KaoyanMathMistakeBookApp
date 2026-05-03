import { BarChart3, BookMarked, BookOpen, FileUp, Home, Library, PlusCircle, RotateCcw, Settings } from 'lucide-react';
import type { ReactNode } from 'react';

export type PageKey = 'dashboard' | 'add' | 'library' | 'detail' | 'review' | 'knowledgeMap' | 'stats' | 'import' | 'settings';

interface ShellProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  children: ReactNode;
}

const navGroups = [
  {
    title: '\u5b66\u4e60',
    items: [
      { key: 'dashboard', label: '\u9996\u9875', icon: Home },
      { key: 'review', label: '\u590d\u4e60', icon: RotateCcw },
      { key: 'knowledgeMap', label: '\u77e5\u8bc6\u5730\u56fe', icon: BookMarked }
    ]
  },
  {
    title: '\u7ba1\u7406',
    items: [
      { key: 'add', label: '\u6dfb\u52a0\u9519\u9898', icon: PlusCircle },
      { key: 'library', label: '\u9519\u9898\u5e93', icon: Library },
      { key: 'stats', label: '\u7edf\u8ba1', icon: BarChart3 }
    ]
  },
  {
    title: '\u5de5\u5177',
    items: [
      { key: 'import', label: '\u5bfc\u5165\u6570\u636e', icon: FileUp },
      { key: 'settings', label: '\u8bbe\u7f6e', icon: Settings }
    ]
  }
] as const;

export function Shell({ page, onNavigate, children }: ShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BookOpen size={22} /></div>
          <div>
            <strong>{'\u8003\u7814\u9ad8\u6570\u9519\u9898\u672c'}</strong>
            <span>Mistake Review System</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="\u4e3b\u5bfc\u822a">
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
      <main className="main-panel">{children}</main>
    </div>
  );
}
