import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Eye, FileUp, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { AiStructuredQuestion, OcrResult } from '../../shared/types';
import { QuestionForm } from '../components/QuestionForm';
import { FormulaText } from '../components/FormulaText';
import { useToast } from '../components/Toast';

type WizardStep = 'select' | 'processing' | 'confirm' | 'edit' | 'done';

interface ProgressItem {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}

export function AiImportPage() {
  const { toast } = useToast();
  const [step, setStep] = useState<WizardStep>('select');
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [ocrResults, setOcrResults] = useState<OcrResult[]>([]);
  const [aiResult, setAiResult] = useState<AiStructuredQuestion | null>(null);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  async function pickImages() {
    const files = await window.api.chooseImages();
    if (files.length) {
      setImagePaths(files);
      setErrorMessage('');
    }
  }

  async function startProcessing() {
    if (!imagePaths.length) {
      toast('请先选择错题图片', 'warning');
      return;
    }
    setStep('processing');
    setErrorMessage('');

    const steps: ProgressItem[] = [
      { label: '启动 PaddleOCR 引擎', status: 'running' },
      ...imagePaths.map((_, i) => ({ label: `识别图片 ${i + 1}/${imagePaths.length}`, status: 'pending' as const })),
      { label: 'DeepSeek AI 结构化', status: 'pending' as const }
    ];
    setProgress(steps);

    try {
      // Step 1: OCR
      updateProgress(0, 'done');

      const ocr: OcrResult[] = [];
      for (let i = 0; i < imagePaths.length; i++) {
        updateProgress(i + 1, 'running');
        const results = await window.api.runOcr([imagePaths[i]]);
        ocr.push(results[0]);
        const conf = Math.round(results[0].confidence);
        updateProgress(i + 1, 'done', `置信度 ${conf}%，${results[0].text.length} 字`);
      }
      setOcrResults(ocr);

      // Step 2: DeepSeek
      const ocrIndex = imagePaths.length + 1;
      updateProgress(ocrIndex, 'running');

      const texts = ocr.map((r) => r.text).filter(Boolean);
      if (!texts.length) {
        updateProgress(ocrIndex, 'error', 'OCR 未识别到文字');
        setErrorMessage('OCR 未能识别到任何文字。请确认图片清晰度足够，或尝试重新拍摄。');
        return;
      }

      const structured = await window.api.structureQuestion(texts);
      updateProgress(ocrIndex, 'done');
      setAiResult(structured);
      setStep('confirm');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(msg);
      // Mark current running step as error
      setProgress((prev) => prev.map((p) => (p.status === 'running' ? { ...p, status: 'error' as const } : p)));
    }
  }

  function updateProgress(index: number, status: ProgressItem['status'], detail?: string) {
    setProgress((prev) => prev.map((p, i) => (i === index ? { ...p, status, detail } : p)));
  }

  function reset() {
    setStep('select');
    setImagePaths([]);
    setOcrResults([]);
    setAiResult(null);
    setProgress([]);
    setErrorMessage('');
  }

  // ====== Step: select ======
  if (step === 'select') {
    return (
      <div className="page">
        <header className="library-hero app-card">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> AI 智能导入</span>
            <h1>拍照导入错题</h1>
            <p>拍照或选择错题图片，AI 自动识别题目文字并填入表单。OCR 本地运行，AI 结构化使用 DeepSeek。</p>
          </div>
        </header>

        <section className="section-card" style={{ marginTop: 20, padding: 28 }}>
          <div className="ai-import-upload-zone" onClick={pickImages}>
            {imagePaths.length ? (
              <div className="ai-import-preview">
                <CheckCircle2 size={42} />
                <strong>已选择 {imagePaths.length} 张图片</strong>
                <span>点击重新选择</span>
                <div className="ai-import-file-list">
                  {imagePaths.map((p, i) => <code key={i}>{p.split(/[\\/]/).pop()}</code>)}
                </div>
              </div>
            ) : (
              <div className="ai-import-drop-hint">
                <FileUp size={48} />
                <strong>点击选择错题图片</strong>
                <span>支持 JPG、PNG 格式，建议拍摄清晰的错题原图</span>
              </div>
            )}
          </div>

          <div className="form-actions" style={{ marginTop: 20, justifyContent: 'center' }}>
            <button className="secondary-button" type="button" onClick={pickImages}>
              <FileUp size={16} />
              {imagePaths.length ? '重新选择' : '选择图片'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={startProcessing}
              disabled={!imagePaths.length}
            >
              <Sparkles size={16} />
              开始 AI 识别
            </button>
          </div>
        </section>

        <section className="section-card" style={{ marginTop: 16 }}>
          <h2>使用提示</h2>
          <ul className="ai-import-tips-list">
            <li>建议每次导入 1-3 张图片</li>
            <li>OCR 在本地运行（PaddleOCR），图片不会上传</li>
            <li>AI 结构化需要 DeepSeek API Key，请在设置中配置</li>
            <li>AI 填充后请仔细校对，特别是数学公式</li>
          </ul>
        </section>
      </div>
    );
  }

  // ====== Step: processing ======
  if (step === 'processing') {
    const hasError = Boolean(errorMessage);
    return (
      <div className="page">
        <header className="library-hero app-card">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> AI 智能导入</span>
            <h1>正在处理...</h1>
            <p>{hasError ? '处理过程中出现错误' : 'OCR 文字识别 + AI 结构化处理'}</p>
          </div>
        </header>

        <section className="section-card" style={{ marginTop: 20, padding: 24 }}>
          <div className="ai-progress-list">
            {progress.map((item, i) => (
              <div key={i} className={`ai-progress-item status-${item.status}`}>
                <span className="ai-progress-icon">
                  {item.status === 'running' ? <Loader2 size={16} className="spin" /> : null}
                  {item.status === 'done' ? <CheckCircle2 size={16} /> : null}
                  {item.status === 'error' ? <AlertTriangle size={16} /> : null}
                  {item.status === 'pending' ? <span className="ai-progress-dot" /> : null}
                </span>
                <span className="ai-progress-label">{item.label}</span>
                {item.detail ? <span className="ai-progress-detail">{item.detail}</span> : null}
              </div>
            ))}
          </div>

          {hasError ? (
            <div className="ai-error-card">
              <div className="ai-error-header">
                <AlertTriangle size={20} />
                <strong>识别失败</strong>
              </div>
              <pre className="ai-error-message">{errorMessage}</pre>
              <div className="form-actions" style={{ marginTop: 14 }}>
                <button className="primary-button" type="button" onClick={reset}>
                  <ArrowLeft size={16} /> 返回重新选择
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  // ====== Step: confirm ======
  if (step === 'confirm' && aiResult) {
    return (
      <div className="page">
        <header className="library-hero app-card">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> AI 智能导入</span>
            <h1>确认 AI 识别结果</h1>
            <p>请核对 AI 自动填充的内容。确认无误后导入，或选择手动修改。</p>
          </div>
        </header>

        <section className="section-card" style={{ marginTop: 20, padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>AI 结构化预览</h2>

          <div className="ai-confirm-grid">
            <div className="ai-confirm-field">
              <strong>标题</strong>
              <span>{aiResult.title || '（未识别）'}</span>
            </div>
            <div className="ai-confirm-field">
              <strong>学科</strong>
              <span className={`badge-${aiResult.subject === '高等数学' ? 'primary' : 'muted'}`}>{aiResult.subject}</span>
            </div>
            <div className="ai-confirm-field">
              <strong>章节</strong>
              <span>{aiResult.category}</span>
            </div>
            <div className="ai-confirm-field">
              <strong>题型</strong>
              <span>{aiResult.question_type}</span>
            </div>
            <div className="ai-confirm-field">
              <strong>难度</strong>
              <span className={`badge-${aiResult.difficulty === '困难' ? 'danger' : aiResult.difficulty === '中等' ? 'warning' : 'success'}`}>{aiResult.difficulty}</span>
            </div>
            <div className="ai-confirm-field">
              <strong>错因</strong>
              <span>{aiResult.error_reason}</span>
            </div>
            <div className="ai-confirm-field" style={{ gridColumn: '1 / -1' }}>
              <strong>题目内容</strong>
              <div className="ai-confirm-content"><FormulaText text={aiResult.content || '（未识别）'} /></div>
            </div>
            <div className="ai-confirm-field" style={{ gridColumn: '1 / -1' }}>
              <strong>正确解析</strong>
              <div className="ai-confirm-content"><FormulaText text={aiResult.correct_solution || '（未识别）'} /></div>
            </div>
            <div className="ai-confirm-field">
              <strong>答案</strong>
              <span>{aiResult.answer || '（未识别）'}</span>
            </div>
            <div className="ai-confirm-field">
              <strong>错误思考</strong>
              <span>{aiResult.wrong_thinking || '（未识别）'}</span>
            </div>
            {aiResult.tags.length ? (
              <div className="ai-confirm-field" style={{ gridColumn: '1 / -1' }}>
                <strong>标签</strong>
                <div className="tag-row" style={{ marginTop: 4 }}>
                  {aiResult.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
                </div>
              </div>
            ) : null}
            {aiResult.knowledge_points.length ? (
              <div className="ai-confirm-field" style={{ gridColumn: '1 / -1' }}>
                <strong>知识点</strong>
                <div className="tag-row" style={{ marginTop: 4 }}>
                  {aiResult.knowledge_points.map((kp) => <span key={kp} className="tag tag-warning">{kp}</span>)}
                </div>
              </div>
            ) : null}
          </div>

          {ocrResults.some((r) => r.text) ? (
            <details style={{ marginTop: 16, padding: 12, border: '1px solid var(--color-border)', borderRadius: 8 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13, color: 'var(--color-text-muted)' }}>
                <Eye size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                查看 OCR 原始文本
              </summary>
              {ocrResults.map((r, i) => (
                <div key={i} style={{ marginTop: 8, padding: 10, background: '#f8fafc', borderRadius: 8, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  <strong>图片 {i + 1}</strong>（置信度：{Math.round(r.confidence)}%）
                  <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{r.text || '（未识别）'}</pre>
                </div>
              ))}
            </details>
          ) : null}

          <div className="form-actions" style={{ marginTop: 20, justifyContent: 'center', gap: 12 }}>
            <button className="secondary-button" type="button" onClick={reset}>
              <RefreshCw size={16} /> 重新识别
            </button>
            <button className="secondary-button" type="button" onClick={() => setStep('edit')}>
              手动修改
              <ChevronRight size={16} />
            </button>
            <button className="primary-button" type="button" onClick={() => setStep('edit')}>
              <CheckCircle2 size={16} /> 确认，去编辑表单
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ====== Step: edit ======
  if (step === 'edit' && aiResult) {
    return (
      <div className="page">
        <header className="library-hero app-card">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> AI 智能导入</span>
            <h1>编辑并保存</h1>
            <p>AI 已预填表单，你可以修改任何字段后保存。</p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" type="button" onClick={() => setStep('confirm')}>
              <ArrowLeft size={16} /> 返回预览
            </button>
            <button className="secondary-button" type="button" onClick={reset}>
              <RefreshCw size={16} /> 重新开始
            </button>
          </div>
        </header>

        <div style={{ marginTop: 20 }}>
          <QuestionForm
            initial={{
              id: 0,
              title: aiResult.title,
              content: aiResult.content,
              wrong_thinking: aiResult.wrong_thinking,
              wrong_solution: '',
              correct_solution: aiResult.correct_solution,
              answer: aiResult.answer,
              subject: aiResult.subject,
              category: aiResult.category,
              question_type: aiResult.question_type,
              error_reason: aiResult.error_reason,
              difficulty: aiResult.difficulty as any,
              mastery_level: '未掌握',
              note: '',
              review_count: 0,
              correct_count: 0,
              wrong_count: 0,
              no_idea_count: 0,
              consecutive_correct: 0,
              last_reviewed_at: null,
              next_review_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              tags: aiResult.tags,
              source: 'AI 导入',
              question_images: [],
              solution_images: [],
              knowledge_points: []
            }}
            onCancel={reset}
            onSaved={() => {
              setStep('done');
              toast('错题已保存', 'success');
            }}
          />
        </div>
      </div>
    );
  }

  // ====== Step: done ======
  return (
    <div className="page">
      <section className="section-card" style={{ marginTop: 40, padding: 48, textAlign: 'center' }}>
        <CheckCircle2 size={52} style={{ color: 'var(--color-success)' }} />
        <h1 style={{ marginTop: 16 }}>导入成功</h1>
        <p className="muted-text">错题已保存到错题库。</p>
        <div className="form-actions" style={{ justifyContent: 'center', marginTop: 20 }}>
          <button className="secondary-button" type="button" onClick={reset}>
            <RefreshCw size={16} /> 继续导入
          </button>
        </div>
      </section>
    </div>
  );
}
