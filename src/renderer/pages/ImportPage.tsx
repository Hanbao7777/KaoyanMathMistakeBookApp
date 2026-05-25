import { BookOpen, CheckCircle2, Download, FileJson, FileQuestion, FileSpreadsheet, FileUp, PackageOpen, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { KnowledgeMapImportResult, QuestionBankImportResult, StructuredImportPreview, StructuredImportResult } from '../../shared/types';
import { useToast } from '../components/Toast';

function FileStructure({ lines }: { lines: string[] }) {
  return (
    <pre className="file-structure">
      {lines.join('\n')}
    </pre>
  );
}

function ImportGuideCard({
  title,
  fileName,
  description,
  status
}: {
  title: string;
  fileName: string;
  description: string;
  status: string;
}) {
  return (
    <article className="import-guide-card">
      <span className="import-guide-status">{status}</span>
      <h2>{title}</h2>
      <code>{fileName}</code>
      <p>{description}</p>
    </article>
  );
}

function ResultPanel({ result }: { result: StructuredImportResult }) {
  return (
    <section className={`import-result-card ${result.failCount ? 'tone-warning' : 'tone-success'}`}>
      <div className="import-result-header">
        <CheckCircle2 size={20} />
        <div>
          <h2>{result.failCount ? '导入完成，部分行需要检查' : '导入成功'}</h2>
          <p>已完成结构化错题写入，失败行不会影响已成功导入的数据。</p>
        </div>
      </div>
      <div className="stats-grid three">
        <div className="stat-card">
          <span>成功导入</span>
          <strong>{result.successCount}</strong>
        </div>
        <div className="stat-card">
          <span>失败数量</span>
          <strong>{result.failCount}</strong>
        </div>
        <div className="stat-card">
          <span>图片复制</span>
          <strong>{result.imageCopiedCount}</strong>
        </div>
      </div>
      {result.warnings?.length ? (
        <div className="warning-box">
          {result.warnings.map((warning) => (
            <p key={`${warning.rowNumber}-${warning.message}`}>
              第 {warning.rowNumber} 行：{warning.title}，{warning.message}
            </p>
          ))}
        </div>
      ) : null}
      {result.failures.length ? (
        <div className="table-list">
          {result.failures.map((failure) => (
            <div className="import-failure" key={`${failure.rowNumber}-${failure.title}`}>
              <strong>第 {failure.rowNumber} 行：{failure.title}</strong>
              <span>{failure.reason}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function KnowledgeResultPanel({ result }: { result: KnowledgeMapImportResult }) {
  return (
    <section className={`import-result-card ${result.failedCount ? 'tone-warning' : 'tone-success'}`}>
      <div className="import-result-header">
        <BookOpen size={20} />
        <div>
          <h2>{result.failedCount ? '知识地图导入完成，部分节点失败' : '知识地图导入成功'}</h2>
          <p>教材：{result.textbookTitle}</p>
        </div>
      </div>
      <div className="stats-grid three">
        <div className="stat-card">
          <span>新增知识点</span>
          <strong>{result.importedCount}</strong>
        </div>
        <div className="stat-card">
          <span>更新知识点</span>
          <strong>{result.updatedCount}</strong>
        </div>
        <div className="stat-card">
          <span>失败数量</span>
          <strong>{result.failedCount}</strong>
        </div>
      </div>
      {result.copiedPdfPath ? <p className="success-box">教材 PDF 已复制：{result.copiedPdfPath}</p> : null}
      {result.failures.length ? (
        <div className="table-list">
          {result.failures.map((failure) => (
            <div className="import-failure" key={`${failure.node_id}-${failure.title}-${failure.reason}`}>
              <strong>{failure.node_id || failure.title || '未命名知识点'}</strong>
              <span>{failure.reason}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function QuestionBankResultPanel({ result }: { result: QuestionBankImportResult }) {
  return (
    <section className={`import-result-card ${result.failedCount ? 'tone-warning' : 'tone-success'}`}>
      <div className="import-result-header">
        <FileQuestion size={20} />
        <div>
          <h2>{result.failedCount ? '题库导入完成，部分题目失败' : '题库导入成功'}</h2>
          <p>题库：{result.bankName}{result.version ? `，版本：${result.version}` : ''}</p>
        </div>
      </div>
      <div className="stats-grid three">
        <div className="stat-card">
          <span>新增题目</span>
          <strong>{result.addedCount}</strong>
        </div>
        <div className="stat-card">
          <span>跳过重复</span>
          <strong>{result.skippedCount}</strong>
        </div>
        <div className="stat-card">
          <span>复制图片</span>
          <strong>{result.copiedImageCount || 0}</strong>
        </div>
        <div className="stat-card">
          <span>复制 PDF</span>
          <strong>{result.copiedPaperCount || 0}</strong>
        </div>
        <div className="stat-card">
          <span>图片引用</span>
          <strong>{result.imageReferenceCount || 0}</strong>
        </div>
        <div className="stat-card">
          <span>解析 PDF 引用</span>
          <strong>{result.solutionPdfReferenceCount || 0}</strong>
        </div>
      </div>
      {result.importBatchId ? <p className="success-box">导入批次：{result.importBatchId}</p> : null}
      {result.paperPdfReferenceCount || result.solutionPdfReferenceCount ? <p className="success-box">试卷 PDF 引用：{result.paperPdfReferenceCount || 0} 个；解析 PDF 引用：{result.solutionPdfReferenceCount || 0} 个</p> : null}
      {result.missingImageReferences?.length ? <p className="warning-box">缺失图片：{result.missingImageReferences.join('；')}</p> : null}
      {result.missingPdfReferences?.length ? <p className="warning-box">缺失 PDF：{result.missingPdfReferences.join('；')}</p> : null}
      {result.failedCount ? <p className="warning-box">失败数量：{result.failedCount}</p> : null}
      {result.failures.length ? (
        <div className="table-list">
          {result.failures.map((failure) => (
            <div className="import-failure" key={`${failure.rowNumber}-${failure.title}-${failure.reason}`}>
              <strong>第 {failure.rowNumber} 行：{failure.title || '未命名题目'}</strong>
              <span>{failure.reason}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ImportPage() {
  const { toast } = useToast();
  const [preview, setPreview] = useState<StructuredImportPreview | null>(null);
  const [result, setResult] = useState<StructuredImportResult | null>(null);
  const [knowledgeResult, setKnowledgeResult] = useState<KnowledgeMapImportResult | null>(null);
  const [questionBankResult, setQuestionBankResult] = useState<QuestionBankImportResult | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function runPrepare(kind: 'excel' | 'json' | 'zip') {
    setLoading(true);
    setResult(null);
    setKnowledgeResult(null);
    setQuestionBankResult(null);
    setMessage('');
    try {
      const next =
        kind === 'excel'
          ? await window.api.prepareExcelImport()
          : kind === 'json'
            ? await window.api.prepareJsonStructuredImport()
            : await window.api.prepareZipImport();
      if (next) setPreview(next);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function downloadTemplate() {
    const file = await window.api.createImportTemplate();
    setMessage(`模板已生成：${file}`);
  }

  async function importKnowledgeMap() {
    setLoading(true);
    setPreview(null);
    setResult(null);
    setKnowledgeResult(null);
    setQuestionBankResult(null);
    setMessage('');
    try {
      const next = await window.api.importKnowledgeMapZip();
      if (next) setKnowledgeResult(next);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setLoading(true);
    try {
      const next = await window.api.confirmStructuredImport(preview.sessionId);
      setResult(next);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  async function importQuestionBank() {
    setLoading(true);
    setPreview(null);
    setResult(null);
    setKnowledgeResult(null);
    setQuestionBankResult(null);
    setMessage('');
    try {
      const next = await window.api.importQuestionBankZip();
      if (next) setQuestionBankResult(next);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function cancelImport() {
    if (preview) await window.api.cancelStructuredImport(preview.sessionId);
    setPreview(null);
  }

  return (
    <div className="page import-page">
      <header className="import-hero app-card">
        <div>
          <span className="eyebrow">Data Import Center</span>
          <h1>导入数据</h1>
          <p>导入错题包、知识地图包或完整备份数据。App 只读取已整理好的结构化文件，不接入 AI 或 OCR。</p>
        </div>
      </header>

      <section className="import-guide-grid">
        <ImportGuideCard title="错题包" fileName="wrong_questions_import.zip" description="包含 import.xlsx 和 images 文件夹，用于批量导入错题原图与结构化字段。" status="推荐" />
        <ImportGuideCard title="知识地图包" fileName="knowledge_map_import.zip" description="包含 textbooks.json 和 knowledge_points.json，用于导入教材知识点结构。" status="稳定" />
        <ImportGuideCard title="外部题库包" fileName="question_bank_import.zip" description="包含 external_questions.xlsx 和 metadata.json，用于导入本地真题或练习题题库。" status="新增" />
        <ImportGuideCard title="JSON 数据" fileName="*.json" description="用于完整数据迁移或恢复部分结构化数据，导入前请确认文件来源可靠。" status="谨慎" />
      </section>

      <section className="import-action-grid">
        <article className="import-action-card">
          <div className="import-action-icon tone-primary"><PackageOpen size={22} /></div>
          <div>
            <h2>导入错题包</h2>
            <p>用于导入 ChatGPT 错题整理专家生成的 wrong_questions_import.zip。</p>
            <FileStructure lines={['wrong_questions_import.zip', '├── import.xlsx', '└── images/']} />
          </div>
          <div className="import-card-actions">
            <button className="primary-button" type="button" onClick={() => runPrepare('zip')} disabled={loading}>
              <PackageOpen size={16} />
              选择错题包并导入
            </button>
            <button className="secondary-button" type="button" onClick={() => runPrepare('excel')} disabled={loading}>
              <FileSpreadsheet size={16} />
              只导入 Excel
            </button>
            <button className="secondary-button" type="button" onClick={downloadTemplate} disabled={loading}>
              <Download size={16} />
              下载 Excel 模板
            </button>
          </div>
        </article>

        <article className="import-action-card">
          <div className="import-action-icon tone-primary"><FileQuestion size={22} /></div>
          <div>
            <h2>导入外部题库</h2>
            <p>用于导入本地标准题库包 question_bank_import.zip，题目会进入 external_questions，不会直接写入错题本。</p>
            <FileStructure lines={['question_bank_import.zip', '├── external_questions.xlsx', '├── metadata.json', '└── assets/']} />
          </div>
          <div className="import-card-actions">
            <button className="primary-button" type="button" onClick={importQuestionBank} disabled={loading}>
              <FileQuestion size={16} />
              选择题库包并导入
            </button>
          </div>
        </article>

        <article className="import-action-card">
          <div className="import-action-icon tone-success"><BookOpen size={22} /></div>
          <div>
            <h2>导入知识地图包</h2>
            <p>用于导入教材识别专家生成的 knowledge_map_import.zip。</p>
            <FileStructure lines={['knowledge_map_import.zip', '├── textbooks.json', '└── knowledge_points.json']} />
            <p className="muted-text">如果包内不包含 PDF，请将教材 PDF 放入 D:\KaoyanMathMistakeBook\textbooks。</p>
          </div>
          <div className="import-card-actions">
            <button className="primary-button" type="button" onClick={importKnowledgeMap} disabled={loading}>
              <BookOpen size={16} />
              选择知识地图包并导入
            </button>
          </div>
        </article>

        <article className="import-action-card">
          <div className="import-action-icon tone-warning"><FileJson size={22} /></div>
          <div>
            <h2>完整数据导入 / 导出</h2>
            <p>JSON 可用于迁移或恢复 App 内部结构化数据。日常数据安全建议优先使用设置页的数据库备份。</p>
            <div className="warning-note">JSON 导入会影响现有数据，请谨慎操作。</div>
          </div>
          <div className="import-card-actions">
            <button className="secondary-button" type="button" onClick={() => runPrepare('json')} disabled={loading}>
              <FileUp size={16} />
              导入结构化 JSON
            </button>
          </div>
        </article>
      </section>

      <section className="import-prompt-card">
        <h2>导入包来源提示</h2>
        <p>导入包通常由两个 GPT 提示词生成：考研数学教材识别专家生成知识地图包，考研高数错题整理专家 V2 生成错题包。App 只负责导入、保存和展示。</p>
      </section>

      {message ? <div className="success-box">{message}</div> : null}
      {loading ? <div className="import-processing-card">正在处理文件，请稍候...</div> : null}
      {result ? <ResultPanel result={result} /> : null}
      {knowledgeResult ? <KnowledgeResultPanel result={knowledgeResult} /> : null}
      {questionBankResult ? <QuestionBankResultPanel result={questionBankResult} /> : null}

      {preview ? (
        <section className="content-section import-preview-card">
          <div className="section-header">
            <div>
              <span className="eyebrow">Import Preview</span>
              <h2>导入预览</h2>
              <p className="muted-text">
                共 {preview.totalRows} 行，可导入 {preview.validRows} 行，存在问题 {preview.invalidRows} 行。
              </p>
            </div>
            <div className="header-actions">
              <button className="secondary-button" type="button" onClick={cancelImport}>
                <XCircle size={16} />
                取消导入
              </button>
              <button className="primary-button" type="button" onClick={confirmImport} disabled={loading || preview.validRows === 0}>
                <CheckCircle2 size={16} />
                确认导入
              </button>
            </div>
          </div>

          <div className="import-table">
            <div className="import-row header">
              <span>学科</span>
              <span>行号</span>
              <span>标题</span>
              <span>章节</span>
              <span>题型</span>
              <span>错误原因</span>
              <span>难度</span>
              <span>掌握</span>
              <span>标签</span>
              <span>图片</span>
              <span>状态</span>
            </div>
            {preview.rows.map((row) => (
              <div className={`import-row ${row.isValid ? '' : 'invalid'}`} key={row.rowNumber}>
                <span>{row.subject || '高等数学'}</span>
                <span>{row.rowNumber}</span>
                <span>{row.title}</span>
                <span>{row.category}</span>
                <span>{row.question_type}</span>
                <span>{row.error_reason}</span>
                <span>{row.difficulty}</span>
                <span>{row.mastery_level}</span>
                <span>{[...row.tags, ...row.knowledge_points.map((item) => `知识点：${item}`)].join('、') || '无'}</span>
                <span>{row.hasImage ? '检测到' : '无'}</span>
                <span>{row.isValid ? '可导入' : row.errors.join('；')}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
