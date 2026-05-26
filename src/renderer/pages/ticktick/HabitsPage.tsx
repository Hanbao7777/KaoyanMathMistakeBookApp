import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TickTickHabit } from '../../../shared/types';
import { useToast } from '../../components/Toast';

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function HabitsPage() {
  const { toast } = useToast();
  const [habits, setHabits] = useState<TickTickHabit[]>([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const h = await window.api.listTickTickHabits();
      setHabits(h);
    } catch (e) { console.error('HabitsPage', e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function addHabit() {
    if (!newName.trim()) return;
    try {
      await window.api.createTickTickHabit({ name: newName.trim() });
      setNewName('');
      await load();
    } catch (e: any) { toast(e.message, 'error'); }
  }

  async function toggleHabit(habit: TickTickHabit) {
    try {
      await window.api.toggleTickTickHabit(habit.id, localDate());
      await load();
    } catch (e: any) { toast(e.message, 'error'); }
  }

  async function deleteHabit(id: string) {
    try {
      await window.api.deleteTickTickHabit(id);
      await load();
    } catch (e: any) { toast(e.message, 'error'); }
  }

  if (loading) return <div className="ticktick-main-content"><div className="tt-spinner" /></div>;

  const today = localDate();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const todayLabel = `${today} 周${weekdays[new Date().getDay()]}`;

  return (
    <div className="ticktick-main-content">
      <div style={{ maxWidth: 600 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>习惯打卡</h1>
        <p style={{ fontSize: 12, color: 'var(--tt-text-secondary)', marginBottom: 16 }}>{todayLabel}</p>

        {/* Add form */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addHabit(); }}
            placeholder="新习惯名称..."
            style={{ flex: 1, padding: '8px 12px', borderRadius: 'var(--tt-radius-sm)', border: '1px solid var(--tt-border)', background: 'var(--tt-bg)', color: 'var(--tt-text)', fontSize: 13, outline: 'none' }}
          />
          <button onClick={addHabit} style={{ padding: '8px 16px', borderRadius: 'var(--tt-radius-sm)', border: 'none', background: 'var(--tt-accent)', color: '#fff', cursor: 'pointer', fontWeight: 600 }} type="button">
            <Plus size={14} /> 添加
          </button>
        </div>

        {/* Habit list */}
        {habits.length > 0 ? habits.map(habit => (
          <div key={habit.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 'var(--tt-radius-md)', marginBottom: 4, background: 'var(--tt-bg-hover)' }}>
            <div
              role="checkbox"
              aria-checked={(habit.today_completed || 0) >= habit.target_count}
              tabIndex={0}
              onClick={() => toggleHabit(habit)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHabit(habit); } }}
              style={{
                width: 22, height: 22, borderRadius: '50%', border: `2px solid ${(habit.today_completed || 0) >= habit.target_count ? habit.color : 'var(--tt-border)'}`,
                background: (habit.today_completed || 0) >= habit.target_count ? habit.color : 'transparent',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                color: '#fff', fontSize: 11, fontWeight: 700
              }}
            >
              {(habit.today_completed || 0) >= habit.target_count ? '✓' : ''}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>{habit.name}</div>
              {habit.goal_description ? <div style={{ fontSize: 11, color: 'var(--tt-text-muted)' }}>{habit.goal_description}</div> : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
              {habit.streak ? <span style={{ fontSize: 11, color: 'var(--tt-accent)', fontWeight: 600 }}>{'🔥'} {habit.streak} 天</span> : null}
              <button onClick={() => deleteHabit(habit.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tt-text-muted)', padding: 2 }} type="button" title="删除">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        )) : (
          <div className="tt-empty">还没有习惯。添加一个开始打卡吧！</div>
        )}
      </div>
    </div>
  );
}
