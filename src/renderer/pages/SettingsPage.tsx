import { Bot, Database, Download, FileSpreadsheet, FolderCog, FolderOpen, HardDriveDownload, Info, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppPaths, DatabaseBackupInfo, DeepSeekSettings, ImportBatch, ImportBatchDetail, LegacyExternalQuestionGroup, StudySettings } from '../../shared/types';
import type { ManagedBackup } from '../../shared/api';
import { useModal } from '../components/Modal';
import { useToast } from '../components/Toast';

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
  beforeDeleteImport: '删除导入前保护备份',
  paths: '\u672c\u5730\u8def\u5f84',
  about: '\u5173\u4e8e\u672c App',
  restoreConfirm: '\u6062\u590d\u5907\u4efd\u4f1a\u8986\u76d6\u5f53\u524d\u6570\u636e\u5e93\u3002\u7cfb\u7edf\u4f1a\u5148\u81ea\u52a8\u4fdd\u5b58\u5f53\u524d\u6570\u636e\u5e93\u526f\u672c\u3002\u662f\u5426\u7ee7\u7eed\uff1f',
  deleteConfirm: '\u786e\u5b9a\u5220\u9664\u8fd9\u4e2a\u5907\u4efd\u6587\u4ef6\u5417\uff1f',
  jsonImportConfirm: '\u5bfc\u5165\u4f1a\u8986\u76d6\u5f53\u524d\u6570\u636e\u5e93\uff0c\u5bfc\u5165\u524d\u4f1a\u81ea\u52a8\u5907\u4efd\u3002\u786e\u5b9a\u7ee7\u7eed\u5417\uff1f',
  clearConfirm: '\u786e\u5b9a\u6e05\u7a7a\u6240\u6709\u9519\u9898\u3001\u6807\u7b7e\u548c\u590d\u4e60\u8bb0\u5f55\u5417\uff1f',
  clearImagesConfirm: '\u662f\u5426\u540c\u65f6\u5220\u9664\u5168\u90e8\u56fe\u7247\u6587\u4ef6\uff1f',
  migrateConfirm: '\u662f\u5426\u8fc1\u79fb\u5df2\u6709\u6570\u636e\u5e93\u3001\u56fe\u7247\u3001\u5bfc\u51fa\u548c\u5907\u4efd\u6587\u4ef6\u5230\u65b0\u4f4d\u7f6e\uff1f'
};

function backupTypeLabel(type: string | undefined) {
  if (type === 'auto') return T.auto;
  if (type === 'before_restore') return T.beforeRestore;
  if (type === 'before_delete_import') return T.beforeDeleteImport;
  return T.manual;
}

function backupTypeClass(type: string | undefined) {
  if (type === 'auto') return 'type-auto';
  if (type === 'before_restore') return 'type-before-restore';
  if (type === 'before_delete_import') return 'type-before-restore';
  return 'type-manual';
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}

export function SettingsPage({ onOpenAgentControl }: { onOpenAgentControl: () => void }) {
  const { toast } = useToast();
  const modal = useModal();
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [backups, setBackups] = useState<readonly ManagedBackup[]>([]);
  const [legacyBackups, setLegacyBackups] = useState<DatabaseBackupInfo[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [legacyGroups, setLegacyGroups] = useState<LegacyExternalQuestionGroup[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<ImportBatchDetail | null>(null);
  const [message, setMessage] = useState('');
  const [pendingDeleteBatchId, setPendingDeleteBatchId] = useState<string | null>(null);
  const [pendingDeleteLegacyKey, setPendingDeleteLegacyKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [studySettings, setStudySettings] = useState<StudySettings | null>(null);
  const [deepSeekSettings, setDeepSeekSettings] = useState<DeepSeekSettings | null>(null);
  const [pythonPath, setPythonPathState] = useState('');
  const [pythonStatus, setPythonStatus] = useState<'unknown' | 'checking' | 'ok' | 'error'>('unknown');

  async function load() {
    const [nextPaths, nextBackups, nextLegacyBackups, nextBatches, nextLegacyGroups, nextStudySettings, nextDeepSeek] = await Promise.all([
      window.api.getPaths(),
      window.api.listDatabaseBackups(),
      window.api.listLegacyDatabaseBackups(),
      window.api.listImportBatches(),
      window.api.listLegacyExternalQuestionGroups(),
      window.api.getStudySettings(),
      window.api.getDeepSeekSettings()
    ]);
    setPaths(nextPaths);
    setBackups(nextBackups);
    setLegacyBackups(nextLegacyBackups);
    setBatches(nextBatches);
    setLegacyGroups(nextLegacyGroups);
    setStudySettings(nextStudySettings);
    setDeepSeekSettings(nextDeepSeek);
  }

  useEffect(() => {
    load().catch((error) => toast(error.message, 'error'));
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
    const confirmed = await modal.confirm({ title: '操作确认', message: T.jsonImportConfirm, confirmLabel: '确认导入', danger: true });
    if (!confirmed) return;
    const result = await window.api.importData(file);
    setMessage(`导入完成，已创建备份：${result.backup}`);
    await load();
  }

  async function clearData() {
    const confirmed = await modal.confirm({ title: '操作确认', message: T.clearConfirm, confirmLabel: '清空', danger: true });
    if (!confirmed) return;
    const deleteImages = await modal.confirm({ title: '删除图片', message: T.clearImagesConfirm, confirmLabel: '是' });
    await window.api.clearAllData(deleteImages);
    setMessage('已清空全部数据');
    await load();
  }

  async function changeRoot() {
    const root = await window.api.chooseRoot();
    if (!root) return;
    const migrate = await modal.confirm({ title: '迁移数据', message: T.migrateConfirm, confirmLabel: '迁移' });
    const next = await window.api.setRoot(root, migrate);
    setPaths(next);
    setMessage(`数据保存位置已更改为：${next.root}`);
    await load();
  }

  async function createBackup() {
    const result = await window.api.createDatabaseBackup();
    setMessage(`备份任务已创建：${result.assetId}`);
    await load();
  }

  async function openBackups() {
    await window.api.openBackupsFolder();
  }

  async function restoreBackup(fileName: string) {
    const confirmed = await modal.confirm({ title: '操作确认', message: T.restoreConfirm, confirmLabel: '恢复', danger: true });
    if (!confirmed) return;
    const result = await window.api.restoreDatabaseBackup(fileName);
    setMessage(`${result.message} 恢复来源：${result.restoredFrom}；恢复前保护备份：${result.beforeRestoreBackup}`);
    await load();
  }

  async function deleteBackup(fileName: string) {
    const confirmed = await modal.confirm({ title: '操作确认', message: T.deleteConfirm, confirmLabel: '删除', danger: true });
    if (!confirmed) return;
    await window.api.deleteDatabaseBackup(fileName);
    setMessage(`已删除备份：${fileName}`);
    await load();
  }

  async function viewBatch(batchId: string) {
    const detail = await window.api.getImportBatchDetail(batchId);
    setSelectedBatch(detail);
  }

  async function deleteBatch(batch: ImportBatch) {
    setDeletingKey(`batch:${batch.id}`);
    setMessage('');
    try {
      const result = await window.api.deleteImportBatch(batch.id, { deleteAssets: true });
      const assetNote = result.failedAssets.length ? `；${result.failedAssets.join('；')}` : '';
      setMessage(`已删除导入批次，备份：${result.backupPath}；删除外部题 ${result.deletedExternalQuestions} 道，错题 ${result.deletedQuestions} 道，练习记录 ${result.deletedAttempts} 条，移动资源 ${result.movedAssets} 个${assetNote}。`);
      setSelectedBatch(null);
      setPendingDeleteBatchId(null);
      await load();
    } catch (error) {
      setMessage(`删除导入批次失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingKey(null);
    }
  }

  async function deleteLegacyGroup(group: LegacyExternalQuestionGroup) {
    setDeletingKey(`legacy:${group.groupKey}`);
    setMessage('');
    try {
      const result = await window.api.deleteLegacyExternalQuestionGroup(group.groupKey);
      setMessage(`已删除历史外部题库分组，备份：${result.backupPath}；删除题目 ${result.deletedQuestions} 道，练习记录 ${result.deletedAttempts} 条。`);
      setPendingDeleteLegacyKey(null);
      await load();
    } catch (error) {
      setMessage(`删除历史外部题库分组失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingKey(null);
    }
  }

  async function openTrash() {
    await window.api.openTrashFolder();
  }

  async function saveStudySettings() {
    if (!studySettings) return;
    const saved = await window.api.updateStudySettings(studySettings);
    setStudySettings(saved);
    setMessage('备考监督设置已保存');
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
        <div className="knowledge-card-header">
          <div>
            <h2><Bot size={18} /> 外部智能体</h2>
            <p className="muted-text">查看外部智能体状态、已授权客户端、审批和本地审计记录。</p>
          </div>
          <button className="primary-button" type="button" onClick={onOpenAgentControl}>打开控制中心</button>
        </div>
      </section>

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

      {deepSeekSettings ? (
        <section className="settings-section">
          <div className="knowledge-card-header">
            <div>
              <h2>DeepSeek AI 设置</h2>
              <p className="muted-text">配置 API Key 后即可使用 AI 智能导入和错因诊断。Key 仅存储在本地数据库中，不会上传。</p>
            </div>
            <div className="header-actions">
              <button className="secondary-button" type="button" onClick={async () => {
                try {
                  await window.api.testDeepSeekConnection();
                  toast('DeepSeek 连接成功', 'success');
                } catch (error) {
                  toast(`连接失败：${error instanceof Error ? error.message : String(error)}`, 'error');
                }
              }}>测试连接</button>
              <button className="primary-button" type="button" onClick={async () => {
                if (!deepSeekSettings) return;
                if (!deepSeekSettings.apiKey.trim()) {
                  toast('请先填写 API Key', 'warning');
                  return;
                }
                try {
                  await window.api.saveDeepSeekSettings(deepSeekSettings);
                  toast('AI 设置已保存', 'success');
                } catch (error) {
                  toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
                }
              }}>保存 AI 设置</button>
            </div>
          </div>
          <div className="study-form-grid">
            <label>
              API Key
              <input
                type="password"
                value={deepSeekSettings.apiKey}
                onChange={(event) => setDeepSeekSettings({ ...deepSeekSettings, apiKey: event.target.value })}
                placeholder="sk-..."
              />
            </label>
            <label>
              模型
              <input
                value={deepSeekSettings.model}
                onChange={(event) => setDeepSeekSettings({ ...deepSeekSettings, model: event.target.value })}
                placeholder="deepseek-chat"
                list="model-suggestions"
              />
              <datalist id="model-suggestions">
                <option value="deepseek-chat" />
                <option value="deepseek-reasoner" />
                <option value="deepseek-v4-flash" />
              </datalist>
            </label>
            <label>
              API Base URL
              <input
                value={deepSeekSettings.baseUrl}
                onChange={(event) => setDeepSeekSettings({ ...deepSeekSettings, baseUrl: event.target.value })}
                placeholder="https://api.deepseek.com/v1"
              />
            </label>
          </div>
        </section>
      ) : null}

      <section className="settings-section">
        <div className="knowledge-card-header">
          <div>
            <h2>PaddleOCR 环境</h2>
            <p className="muted-text">OCR 文字识别需要 Python 3.9+ 和 PaddleOCR。请先执行 pip install paddlepaddle paddleocr。</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={async () => {
              setPythonStatus('checking');
              try {
                await window.api.checkPythonEnv();
                setPythonStatus('ok');
                toast('Python + PaddleOCR 环境正常', 'success');
              } catch (error) {
                setPythonStatus('error');
                toast(`环境检测失败：${error instanceof Error ? error.message : String(error)}`, 'error');
              }
            }}
            disabled={pythonStatus === 'checking'}
          >
            {pythonStatus === 'checking' ? '检测中...' : '检测环境'}
          </button>
        </div>
        <div className="study-form-grid">
          <label>
            Python 路径
            <input
              value={pythonPath}
              onChange={(event) => setPythonPathState(event.target.value)}
              placeholder="python（默认使用系统 PATH 中的 python）"
            />
          </label>
        </div>
        {pythonStatus === 'ok' ? <p className="success-box">PaddleOCR 环境正常，可以使用 AI 导入功能。</p> : null}
        {pythonStatus === 'error' ? (
          <div className="warning-box">
            <strong>PaddleOCR 未就绪</strong>
            <p>请确保已安装 Python 3.9+ 并添加到系统 PATH，然后执行：pip install paddlepaddle paddleocr</p>
          </div>
        ) : null}
        <p className="muted-text">OCR 完全在本地运行，图片不会离开你的电脑。</p>
      </section>

      {studySettings ? (
        <section className="settings-section study-settings-panel">
          <div className="knowledge-card-header">
            <div>
              <h2><ShieldCheck size={18} /> 备考监督设置</h2>
              <p className="muted-text">V1 使用强度监督模式，并可启用未完成任务自动延期。</p>
            </div>
            <button className="primary-button" type="button" onClick={saveStudySettings}>保存设置</button>
          </div>
          <div className="study-form-grid">
            <label>考试日期
              <input type="date" value={studySettings.exam_date || ''} onChange={(event) => setStudySettings({ ...studySettings, exam_date: event.target.value || null })} />
            </label>
            <label>每日目标学习时长（分钟）
              <input type="number" min={0} value={studySettings.daily_target_minutes} onChange={(event) => setStudySettings({ ...studySettings, daily_target_minutes: Number(event.target.value) })} />
            </label>
            <label>监督模式
              <select value={studySettings.supervision_mode} onChange={(event) => setStudySettings({ ...studySettings, supervision_mode: event.target.value })}>
                <option value="strict">强度监督</option>
              </select>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={studySettings.auto_rollover_enabled !== 0} onChange={(event) => setStudySettings({ ...studySettings, auto_rollover_enabled: event.target.checked ? 1 : 0 })} />
              启用未完成任务自动延期
            </label>
          </div>
        </section>
      ) : null}

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
        <h3>受管备份</h3>
        {backups.length ? (
          <div className="backup-list">
            {backups.map((backup) => (
              <article className="backup-item" key={backup.assetId}>
                <div>
                  <strong>受管备份 {backup.assetId}</strong>
                  <span>
                    <em className={`backup-type-badge ${backupTypeClass(backup.metadata.backupKind)}`}>{backupTypeLabel(backup.metadata.backupKind)}</em>
                    {formatTime(backup.createdAt)} · {backup.status}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="settings-empty-state">暂无受管备份</div>}
        <h3>本地旧版备份</h3>
        {legacyBackups.length ? (
          <div className="backup-list">
            {legacyBackups.map((backup) => (
              <article className="backup-item" key={backup.fileName}>
                <div><strong>{backup.fileName}</strong><span><em className={`backup-type-badge ${backupTypeClass(backup.type)}`}>{backupTypeLabel(backup.type)}</em>{formatTime(backup.createdAt)} · {backup.sizeText}</span></div>
                <div className="backup-actions"><button className="secondary-button warning compact-button" type="button" onClick={() => restoreBackup(backup.fileName)}><RotateCcw size={14} />{T.restore}</button><button className="secondary-button danger compact-button" type="button" onClick={() => deleteBackup(backup.fileName)}><Trash2 size={14} />{T.delete}</button></div>
              </article>
            ))}
          </div>
        ) : <div className="settings-empty-state">暂无本地旧版备份</div>}
      </section>

      <section className="settings-section import-history-panel">
        <div className="knowledge-card-header">
          <div>
            <h2><Database size={18} /> 导入记录管理</h2>
            <p className="muted-text">按 App 自动生成的导入批次查看和回滚数据。删除前会自动创建数据库备份，资源文件会移入 trash。</p>
          </div>
          <button className="secondary-button" type="button" onClick={openTrash}><FolderOpen size={16} />打开 trash</button>
        </div>

        {batches.length ? (
          <div className="import-batch-list">
            {batches.map((batch) => (
              <article className={`import-batch-item ${batch.status === 'deleted' ? 'is-deleted' : ''}`} key={batch.id}>
                <div>
                  <strong>{batch.name || batch.id}</strong>
                  <span>{batch.type} · {formatTime(batch.imported_at)} · 数据 {batch.item_count} 条 · 资源 {batch.asset_count} 个 · {batch.status}</span>
                  {batch.source_file_name ? <small>{batch.source_file_name}</small> : null}
                </div>
                <div className="backup-actions">
                  <button className="secondary-button compact-button" type="button" onClick={() => viewBatch(batch.id)}>查看详情</button>
                  {pendingDeleteBatchId === batch.id ? (
                    <div className="inline-confirm-actions">
                      <span>确认删除？</span>
                      <button className="secondary-button danger compact-button" type="button" onClick={() => deleteBatch(batch)} disabled={deletingKey === `batch:${batch.id}`}>
                        <Trash2 size={14} />{deletingKey === `batch:${batch.id}` ? '删除中...' : '确认删除'}
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => setPendingDeleteBatchId(null)} disabled={deletingKey === `batch:${batch.id}`}>取消</button>
                    </div>
                  ) : (
                    <button className="secondary-button danger compact-button" type="button" onClick={() => setPendingDeleteBatchId(batch.id)} disabled={batch.status === 'deleted'}><Trash2 size={14} />删除本次导入</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : <div className="settings-empty-state">暂无新导入批次记录</div>}

        {selectedBatch ? (
          <div className="import-batch-detail">
            <div className="section-header compact">
              <div>
                <h3>{selectedBatch.batch.name || selectedBatch.batch.id}</h3>
                <p className="muted-text">{selectedBatch.batch.type} · {formatTime(selectedBatch.batch.imported_at)}</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => setSelectedBatch(null)}>关闭</button>
            </div>
            <div className="import-batch-meta-grid">
              {selectedBatch.tableCounts.map((row) => <span key={row.target_table}>{row.target_table}: {row.count}</span>)}
              <span>资源文件: {selectedBatch.assets.length}</span>
            </div>
            {selectedBatch.batch.metadata_json ? <pre className="import-batch-metadata">{selectedBatch.batch.metadata_json}</pre> : null}
          </div>
        ) : null}

        <div className="legacy-import-box">
          <h3>历史外部题库分组</h3>
          <p className="muted-text">这些数据没有导入批次 ID，按 source + exam_type + year 分组删除。删除不会影响已经加入错题本的 questions。</p>
          {legacyGroups.length ? (
            <div className="import-batch-list">
              {legacyGroups.map((group) => (
                <article className="import-batch-item" key={group.groupKey}>
                  <div>
                    <strong>{group.source} / {group.exam_type} / {group.year || '未知年份'}</strong>
                    <span>题目 {group.questionCount} 道 · 已练习 {group.attemptedCount} 道 · 已加入错题本 {group.addedToMistakesCount} 道</span>
                  </div>
                  {pendingDeleteLegacyKey === group.groupKey ? (
                    <div className="inline-confirm-actions">
                      <span>确认删除？</span>
                      <button className="secondary-button danger compact-button" type="button" onClick={() => deleteLegacyGroup(group)} disabled={deletingKey === `legacy:${group.groupKey}`}>
                        <Trash2 size={14} />{deletingKey === `legacy:${group.groupKey}` ? '删除中...' : '确认删除'}
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => setPendingDeleteLegacyKey(null)} disabled={deletingKey === `legacy:${group.groupKey}`}>取消</button>
                    </div>
                  ) : (
                    <button className="secondary-button danger compact-button" type="button" onClick={() => setPendingDeleteLegacyKey(group.groupKey)}><Trash2 size={14} />删除分组</button>
                  )}
                </article>
              ))}
            </div>
          ) : <div className="settings-empty-state">暂无未绑定批次的历史外部题库</div>}
        </div>
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

