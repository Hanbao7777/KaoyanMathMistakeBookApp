import { ArrowLeft, CheckCircle2, FileUp, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { AiStructuredQuestion, OcrResult } from '../../shared/types';
import { QuestionForm } from '../components/QuestionForm';
import { useToast } from '../components/Toast';

type WizardStep = 'select' | 'ocr' | 'review' | 'done';

export function AiImportPage() {
  const { toast } = useToast();
  const [step, setStep] = useState<WizardStep>('select');
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [ocrResults, setOcrResults] = useState<OcrResult[]>([]);
  const [aiResult, setAiResult] = useState<AiStructuredQuestion | null>(null);
  const [processing, setProcessing] = useState(false);
  const [statusText, setStatusText] = useState('');

  async function pickImages() {
    const files = await window.api.chooseImages();
    if (files.length) setImagePaths(files);
  }

  async function startProcessing() {
    if (!imagePaths.length) {
      toast('请先选择错题图片', 'warning');
      return;
    }
    setStep('ocr');
    setProcessing(true);

    try {
      setStatusText('正在识别图片文字...');
      const ocr = await window.api.runOcr(imagePaths);
      setOcrResults(ocr);

      setStatusText('AI 正在分析并结构化错题信息...');
      const texts = ocr.map((r) => r.text).filter(Boolean);
      if (!texts.length) {
        toast('OCR 未能识别到文字，请确认图片清晰度', 'warning');
        setStep('select');
        setProcessing(false);
        return;
      }
      const structured = await window.api.structureQuestion(texts);
      setAiResult(structured);
      setStep('review');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      setStep('select');
    } finally {
      setProcessing(false);
    }
  }

  function reset() {
    setStep('select');
    setImagePaths([]);
    setOcrResults([]);
    setAiResult(null);
    setStatusText('');
  }

  // Step: 选择图片
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
              className={`primary-button ${processing ? 'button-loading' : ''}`}
              type="button"
              onClick={startProcessing}
              disabled={processing || !imagePaths.length}
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

  // Step: 处理中
  if (step === 'ocr') {
    return (
      <div className="page">
        <header className="library-hero app-card">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> AI 智能导入</span>
            <h1>正在处理...</h1>
            <p>{statusText}</p>
          </div>
        </header>
        <section className="section-card" style={{ marginTop: 20, padding: 48, textAlign: 'center' }}>
          <Loader2 size={48} style={{ animation: 'btn-spin 1s linear infinite', color: 'var(--color-primary)' }} />
          <h2 style={{ marginTop: 20 }}>{statusText}</h2>
          <p className="muted-text" style={{ marginTop: 8 }}>OCR 文字识别 + AI 结构化处理，请稍候...</p>
        </section>
      </div>
    );
  }

  // Step: 校对
  if (step === 'review' && aiResult) {
    return (
      <div className="page">
        <header className="library-hero app-card">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> AI 智能导入</span>
            <h1>校对并保存</h1>
            <p>AI 已自动填充表单。请仔细核对，特别是数学公式和分类。</p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" type="button" onClick={reset}>
              <ArrowLeft size={16} /> 重新开始
            </button>
          </div>
        </header>

        {ocrResults.some((r) => r.text) ? (
          <details className="section-card" style={{ marginTop: 16, padding: 14 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 700 }}>OCR 原始识别文本（点击展开核对）</summary>
            {ocrResults.map((r, i) => (
              <div key={i} style={{ marginTop: 10, padding: 10, background: '#f8fafc', borderRadius: 8, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                <strong>图片 {i + 1}</strong>（置信度：{Math.round(r.confidence)}%）
                <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{r.text || '（未识别到文字）'}</pre>
              </div>
            ))}
          </details>
        ) : null}

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

  // Step: 完成
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
