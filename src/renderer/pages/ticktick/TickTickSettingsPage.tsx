import { useEffect, useState } from 'react';
import type { TickTickSettings } from '../../../shared/types';
import { useToast } from '../../components/Toast';

const DARK_KEY = 'kaoyan-dark-mode';

function getDarkMode(): boolean {
  try { return localStorage.getItem(DARK_KEY) === 'true'; } catch { return false; }
}
function setDarkMode(on: boolean) {
  try { localStorage.setItem(DARK_KEY, String(on)); } catch {}
  document.documentElement.classList.toggle('dark', on);
}

const defaultSettings: TickTickSettings = {
  pomodoro: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4 },
  autoCreateReviewTasks: true,
  whiteNoise: 'none',
  defaultListId: null,
};

export function TickTickSettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<TickTickSettings>(defaultSettings);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [dark, setDark] = useState(getDarkMode);

  useEffect(() => {
    Promise.all([
      window.api.getTickTickSettings(),
      window.api.listTickTickLists(),
    ]).then(([s, l]) => {
      setSettings(s);
      setLists(l);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function handleSave() {
    try {
      await window.api.saveTickTickSettings(settings);
      toast('设置已保存', 'success');
    } catch (e: any) {
      toast(e.message || '保存失败', 'error');
    }
  }

  if (loading) return <div className="ticktick-main-content"><div className="tt-empty">加载中...</div></div>;

  const p = settings.pomodoro;

  return (
    <div className="ticktick-main-content">
      <div className="tt-settings-page">
        <h2>TickTick 设置</h2>

        <div className="tt-settings-section">
          <h3>番茄钟</h3>
          <div className="tt-setting-row">
            <label>专注时长（分钟）</label>
            <input type="number" min={1} max={120} value={p.focusMinutes} onChange={e => setSettings({ ...settings, pomodoro: { ...p, focusMinutes: parseInt(e.target.value) || 0 } })} />
          </div>
          <div className="tt-setting-row">
            <label>短休息（分钟）</label>
            <input type="number" min={1} max={30} value={p.shortBreakMinutes} onChange={e => setSettings({ ...settings, pomodoro: { ...p, shortBreakMinutes: parseInt(e.target.value) || 0 } })} />
          </div>
          <div className="tt-setting-row">
            <label>长休息（分钟）</label>
            <input type="number" min={1} max={60} value={p.longBreakMinutes} onChange={e => setSettings({ ...settings, pomodoro: { ...p, longBreakMinutes: parseInt(e.target.value) || 0 } })} />
          </div>
          <div className="tt-setting-row">
            <label>每 N 轮后长休息</label>
            <input type="number" min={1} max={8} value={p.sessionsBeforeLongBreak} onChange={e => setSettings({ ...settings, pomodoro: { ...p, sessionsBeforeLongBreak: parseInt(e.target.value) || 0 } })} />
          </div>
        </div>

        <div className="tt-settings-section">
          <h3>错题本关联</h3>
          <div className="tt-setting-row">
            <label>自动创建错题复习任务</label>
            <input type="checkbox" checked={settings.autoCreateReviewTasks} onChange={e => setSettings({ ...settings, autoCreateReviewTasks: e.target.checked })} />
          </div>
          <div className="tt-setting-row">
            <label>默认清单（自动复习任务创建到）</label>
            <select value={settings.defaultListId || ''} onChange={e => setSettings({ ...settings, defaultListId: e.target.value || null })}>
              <option value="">选择清单...</option>
              {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>

        <div className="tt-settings-section">
          <h3>默认白噪音</h3>
          <div className="tt-setting-row">
            <label>计时器默认音效</label>
            <select value={settings.whiteNoise} onChange={e => setSettings({ ...settings, whiteNoise: e.target.value as any })}>
              <option value="none">无</option>
              <option value="rain">雨声</option>
              <option value="stream">溪流</option>
              <option value="cafe">咖啡馆</option>
              <option value="white">白噪音</option>
              <option value="forest">森林鸟鸣</option>
            </select>
          </div>
        </div>

        <div className="tt-settings-section">
          <h3>外观</h3>
          <div className="tt-setting-row">
            <label>深色模式</label>
            <input type="checkbox" checked={dark} onChange={e => { setDark(e.target.checked); setDarkMode(e.target.checked); }} />
          </div>
        </div>

        <button onClick={handleSave} style={{ padding: '10px 32px', borderRadius: 'var(--tt-radius-md)', border: 'none', background: 'var(--tt-accent)', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 14, marginTop: 16 }} type="button">
          保存设置
        </button>
      </div>
    </div>
  );
}
