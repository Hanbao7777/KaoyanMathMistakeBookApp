import { Database, Download, FileSpreadsheet, FolderCog, FolderOpen, HardDriveDownload, Info, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppPaths, DatabaseBackupInfo } from '../../shared/types';

const T = {
  loading: '\u52a0\u8f7d\u4e2d...',
  title: '\u8bbe\u7f6e',
  desc: '\u7ba1\u7406\u672c\u5730\u6570\u636e\u3001\u5bfc\u5165\u5bfc\u51fa\u3001\u5907\u4efd\u548c\u4fdd\u5b58\u8def\u5f84\u3002',
  exportJson: '\u5bfc\u51fa\u5168\u90e8\u6570\u636e\u4e3a JSON',
  exportDesc: '\u9ed8\u8ba4\u4fdd\u5b58\u5230 exports \u6587\u4ef6\u5939',
  template: '\u4e0b\u8f7d Excel \u5bfc\u5165\u6a21\u677f',
  templateDesc: '\u9ed8\u8ba4\u4fdd\u5b58\u5230 exports \u6587\u4ef6\u5939',
  importJson: '\u6062\u590d\u5b8c\u6574\u5907\u4efd JSON',
  importDesc: '\u4f1a\u8986\u76d6\u5f53\u524d\u6570\u636e\u5e93\uff0c\u5bfc\u5165\u524d\u81ea\u52a8\u5907\u4efd',
  clear: '\u6e05\u7a7a\u6240\u6709\u6570\u636e',
  clearDesc: '\u6267\u884c\u524d\u4f1a\u4e8c\u6b21\u786e\u8ba4',
  changeRoot: '\u66f4\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e',
  changeRootDesc: '\u53ef\u9009\u62e9\u662f\u5426\u8fc1\u79fb\u65e7\u6570\u636e',
  dataSafety: '\u6570\u636e\u5b89\u5168\u4e0e\u5907\u4efd',
  manualBackup: '\u4e00\u952e\u5907\u4efd\u6570\u636e\u5e93',
  openBackups: '\u6253\u5f00\u5907\u4efd\u6587\u4ef6\u5939',
  backupList: '\u6700\u8fd1\u5907\u4efd',
  noBackups: '\u6682\u65e0\u5907\u4efd\u6587\u4ef6',
  restore: '\u6062\u590d\u6b64\u5907\u4efd',
  delete: '\u5220\u9664',
  manual: '\u624b\u52a8\u5907\u4efd',
  auto: '\u81ea\u52a8\u5907\u4efd',
  beforeRestore: '\u6062\u590d\u524d\u4fdd\u62a4\u5907\u4efd',
  paths: '\u672c\u5730\u8def\u5f84',
  about: '\u5173\u4e8e\u672c App',
  restoreConfirm: '\u6062\u590d\u5907\u4efd\u4f1a\u8986\u76d6\u5f53\u524d\u6570\u636e\u5e93\u3002\u7cfb\u7edf\u4f1a\u5148\u81ea\u52a8\u4fdd\u5b58\u5f53\u524d\u6570\u636e\u5e93\u526f\u672c\u3002\u662f\u5426\u7ee7\u7eed\uff1f',
  deleteConfirm: '\u786e\u5b9a\u5220\u9664\u8fd9\u4e2a\u5907\u4efd\u6587\u4ef6\u5417\uff1f',
  jsonImportConfirm: '\u5bfc\u5165\u4f1a\u8986\u76d6\u5f53\u524d\u6570\u636e\u5e93\uff0c\u5bfc\u5165\u524d\u4f1a\u81ea\u52a8\u5907\u4efd\u3002\u786e\u5b9a\u7ee7\u7eed\u5417\uff1f',
  clearConfirm: '\u786e\u5b9a\u6e05\u7a7a\u6240\u6709\u9519\u9898\u3001\u6807\u7b7e\u548c\u590d\u4e60\u8bb0\u5f55\u5417\uff1f',
  clearImagesConfirm: '\u662f\u5426\u540c\u65f6\u5220\u9664\u5168\u90e8\u56fe\u7247\u6587\u4ef6\uff1f',
  migrateConfirm: '\u662f\u5426\u8fc1\u79fb\u5df2\u6709\u6570\u636e\u5e93\u3001\u56fe\u7247\u3001\u5bfc\u51fa\u548c\u5907\u4efd\u6587\u4ef6\u5230\u65b0\u4f4d\u7f6e\uff1f'
};

function backupTypeLabel(type: DatabaseBackupInfo['type']) {
  if (type === 'auto') return T.auto;
  if (type === 'before_restore') return T.beforeRestore;
  return T.manual;
}

function backupTypeClass(type: DatabaseBackupInfo['type']) {
  if (type === 'auto') return 'type-auto';
  if (type === 'before_restore') return 'type-before-restore';
  return 'type-manual';
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}

export function SettingsPage() {
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [backups, setBackups] = useState<DatabaseBackupInfo[]>([]);
  const [message, setMessage] = useState('');

  async function load() {
    const [nextPaths, nextBackups] = await Promise.all([window.api.getPaths(), window.api.listDatabaseBackups()]);
    setPaths(nextPaths);
    setBackups(nextBackups);
  }

  useEffect(() => {
    load().catch((error) => alert(error.message));
  }, []);

  async function exportJson() {
    const file = await window.api.exportData();
    setMessage(`已导出到：${file}`);
  }

  async function downloadTemplate() {
    const file = await window.api.createImportTemplate();
    setMessage(`Excel 导入模板已生成：${file}`);
  }

  async function importJson() {
    const file = await window.api.chooseJson();
    if (!file) return;
    if (!confirm(T.jsonImportConfirm)) return;
    const result = await window.api.importData(file);
    setMessage(`导入完成，已创建备份：${result.backup}`);
    await load();
  }

  async function clearData() {
    if (!confirm(T.clearConfirm)) return;
    const deleteImages = confirm(T.clearImagesConfirm);
    await window.api.clearAllData(deleteImages);
    setMessage('已清空全部数据');
    await load();
  }

  async function changeRoot() {
    const root = await window.api.chooseRoot();
    if (!root) return;
    const migrate = confirm(T.migrateConfirm);
    const next = await window.api.setRoot(root, migrate);
    setPaths(next);
    setMessage(`数据保存位置已更改为：${next.root}`);
    await load();
  }

  async function createBackup() {
    const result = await window.api.createDatabaseBackup('manual');
    setMessage(`备份成功：${result.filePath}`);
    await load();
  }

  async function openBackups() {
    await window.api.openBackupsFolder();
  }

  async function restoreBackup(fileName: string) {
    if (!confirm(T.restoreConfirm)) return;
    const result = await window.api.restoreDatabaseBackup(fileName);
    setMessage(`${result.message} 恢复来源：${result.restoredFrom}；恢复前保护备份：${result.beforeRestoreBackup}`);
    await load();
  }

  async function deleteBackup(fileName: string) {
    if (!confirm(T.deleteConfirm)) return;
    await window.api.deleteDatabaseBackup(fileName);
    setMessage(`已删除备份：${fileName}`);
    await load();
  }

  if (!paths) return <div className="page settings-page">{T.loading}</div>;

  return (
    <div className="page settings-page">
      <header className="settings-hero app-card">
        <div>
          <span className="eyebrow">System Settings</span>
          <h1>{T.title}</h1>
          <p>{T.desc}</p>
        </div>
      </header>

      {paths.warning ? <div className="warning-box">{paths.warning}</div> : null}

      <section className="settings-section">
        <div className="section-header">
          <div>
            <h2>常用数据工具</h2>
            <p className="muted-text">JSON 导入会覆盖当前数据，请优先使用数据库备份保护当前状态。</p>
          </div>
        </div>
        <div className="settings-grid">
          <button className="settings-card" type="button" onClick={exportJson}><Download size={22} /><strong>{T.exportJson}</strong><span>{T.exportDesc}</span></button>
          <button className="settings-card" type="button" onClick={downloadTemplate}><FileSpreadsheet size={22} /><strong>{T.template}</strong><span>{T.templateDesc}</span></button>
          <button className="settings-card warning" type="button" onClick={importJson}><Upload size={22} /><strong>{T.importJson}</strong><span>{T.importDesc}</span></button>
          <button className="settings-card" type="button" onClick={changeRoot}><FolderCog size={22} /><strong>{T.changeRoot}</strong><span>{T.changeRootDesc}</span></button>
          <button className="settings-card danger" type="button" onClick={clearData}><Trash2 size={22} /><strong>{T.clear}</strong><span>{T.clearDesc}</span></button>
        </div>
      </section>

      <section className="settings-section backup-panel">
        <div className="knowledge-card-header">
          <div><h2><HardDriveDownload size={18} /> {T.dataSafety}</h2><p className="muted-text">自动备份每天最多一次，手动备份不会被自动清理。恢复前会自动创建 before_restore 保护备份。</p></div>
          <div className="header-actions">
            <button className="primary-button" type="button" onClick={createBackup}><Database size={16} />{T.manualBackup}</button>
            <button className="secondary-button" type="button" onClick={openBackups}><FolderOpen size={16} />{T.openBackups}</button>
          </div>
        </div>
        <div className="backup-risk-note">
          恢复备份会覆盖当前数据库。恢复完成后建议重启 App，以确保所有页面重新加载最新数据。
        </div>
        <h3>{T.backupList}</h3>
        {backups.length ? (
          <div className="backup-list">
            {backups.map((backup) => (
              <article className="backup-item" key={backup.fileName}>
                <div>
                  <strong>{backup.fileName}</strong>
                  <span>
                    <em className={`backup-type-badge ${backupTypeClass(backup.type)}`}>{backupTypeLabel(backup.type)}</em>
                    {formatTime(backup.createdAt)} · {backup.sizeText}
                  </span>
                </div>
                <div className="backup-actions">
                  <button className="secondary-button warning compact-button" type="button" onClick={() => restoreBackup(backup.fileName)}><RotateCcw size={14} />{T.restore}</button>
                  <button className="secondary-button danger compact-button" type="button" onClick={() => deleteBackup(backup.fileName)}><Trash2 size={14} />{T.delete}</button>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="settings-empty-state">{T.noBackups}</div>}
      </section>

      <section className="settings-section">
        <h2><Database size={18} /> {T.paths}</h2>
        <div className="settings-path-grid">
          <div><span>App 数据目录</span><code>{paths.root}</code></div>
          <div><span>数据库</span><code>{paths.database}</code></div>
          <div><span>图片目录</span><code>{paths.images}</code></div>
          <div><span>教材目录</span><code>{paths.textbooks}</code></div>
          <div><span>导出目录</span><code>{paths.exports}</code></div>
          <div><span>备份目录</span><code>{paths.backups}</code></div>
          <div><span>临时目录</span><code>{paths.temp}</code></div>
        </div>
      </section>

      <section className="settings-section about-card">
        <h2><Info size={18} /> {T.about}</h2>
        <p className="long-text">考研高数错题本是一个仅在本机保存数据的桌面 App。它不接入云端、登录、AI 或 OCR，重点是稳定记录、复习计划、知识地图和薄弱项统计。</p>
        <div className="about-meta">
          <span>版本：0.1.0</span>
          <span>本地优先</span>
          <span>数据目录：{paths.root}</span>
        </div>
      </section>

      {message ? <div className="success-box">{message}</div> : null}
    </div>
  );
}
