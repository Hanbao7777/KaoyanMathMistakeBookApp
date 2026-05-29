import { CheckCircle2, Edit3, Eye, RotateCcw, Trash2, XCircle } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { REVIEW_RESULTS } from '../../shared/options';
import type { MasteryLevel, Question, ReviewLog, ReviewResult } from '../../shared/types';
import { AiDiagnosisPanel } from '../components/AiDiagnosisPanel';
import { EmptyState } from '../components/EmptyState';
import { FormulaText } from '../components/FormulaText';
import { ImageGallery } from '../components/ImageGallery';
import { useModal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { formatDate, today } from '../utils/date';

interface DetailPageProps {
  questionId: number | null;
  reviewMode?: boolean;
  onBack: () => void;
  onEdit: (id: number) => void;
  onOpenKnowledgePoint?: (nodeId: string) => void;
}

function masteryBadge(level: string) {
  if (level === '未掌握') return 'badge-danger';
  if (level === '较弱') return 'badge-warning';
  if (level === '已掌握' || level === '较好') return 'badge-success';
  return 'badge-primary';
}

function difficultyBadge(difficulty: string) {
  if (difficulty === '简单') return 'badge-success';
  if (difficulty === '困难' || difficulty === '压轴') return 'badge-danger';
  if (difficulty === '中等') return 'badge-warning';
  return 'badge-muted';
}

function reviewResultLabel(result: ReviewLog['result']) {
  if (result === 'correct') return '做对了';
  if (result === 'wrong') return '做错了';
  if (result === 'no_idea') return '没思路';
  return result;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <span><b>{label}</b><em>{children || '暂无'}</em></span>;
}

function FormulaCard({ title, text, tone = 'plain' }: { title: string; text?: string; tone?: 'plain' | 'warning' | 'success' | 'answer' }) {
  return (
    <article className={`detail-study-card tone-${tone}`}>
      <h2>{title}</h2>
      <div className="long-text">
        <FormulaText text={text?.trim() || '暂无'} />
      </div>
    </article>
  );
}

export function DetailPage({ questionId, reviewMode = false, onBack, onEdit, onOpenKnowledgePoint }: DetailPageProps) {
  const { toast } = useToast();
  const modal = useModal();
  const [question, setQuestion] = useState<Question | null>(null);
  const [logs, setLogs] = useState<ReviewLog[]>([]);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [showAnswer, setShowAnswer] = useState(!reviewMode);
  const [reviewDate, setReviewDate] = useState(today());
  const [result, setResult] = useState<ReviewResult>('做对了');
  const [duration, setDuration] = useState(20);
  const [note, setNote] = useState('');

  async function load() {
    if (!questionId) return;
    const current = await window.api.getQuestion(questionId);
    setQuestion(current);
    setLogs(await window.api.listReviewLogs(questionId));
  }

  useEffect(() => {
    setShowAnswer(!reviewMode);
    load().catch((error) => toast(error.message, 'error'));
  }, [questionId, reviewMode]);

  if (!questionId) return <div className="page">未选择错题</div>;
  if (!question) return <div className="page">加载中...</div>;

  async function remove() {
    if (!question) return;
    const confirmed = await modal.confirm({ title: '操作确认', message: '确定删除这道错题吗？', confirmLabel: '删除', danger: true });
    if (!confirmed) return;
    const deleteImages = await modal.confirm({ title: '删除图片', message: '是否同时删除对应图片文件？', confirmLabel: '是' });
    await window.api.deleteQuestion(question.id, deleteImages);
    onBack();
  }

  async function mark(mastery: MasteryLevel) {
    if (!question) return;
    await window.api.markMastery(question.id, mastery);
    await load();
    try {
      const score = ({ '未掌握': 1, '较弱': 2, '一般': 3, '较好': 4, '已掌握': 5 } as Record<string, number>)[mastery] || 3;
      for (const kp of question.knowledge_points || []) {
        await window.api.syncMasteryToTickTick(kp.node_id, score);
      }
    } catch {}
  }

  async function submitReview(event: FormEvent) {
    event.preventDefault();
    if (!question) return;
    await addReview(result, duration, note, reviewDate);
    setShowReviewForm(false);
    setNote('');
  }

  async function addReview(reviewResult: ReviewResult, minutes = 0, reviewNote = '', date = today()) {
    if (!question) return;
    await window.api.addReviewLog({
      questionId: question.id,
      review_date: date,
      result: reviewResult,
      duration_minutes: minutes,
      note: reviewNote
    });
    await load();
    try {
      await window.api.syncReviewToTickTick('question', String(question.id));
    } catch {}
  }

  const metaTags = [question.subject || '高等数学', question.category, question.question_type, question.error_reason].filter(Boolean);

  return (
    <div className="page detail-page-modern">
      <header className="detail-hero app-card">
        <div>
          <button className="ghost-button compact-button detail-back-link" type="button" onClick={onBack}>返回错题库</button>
          <h1>{question.title || '未命名错题'}</h1>
          <div className="detail-hero-tags">
            {metaTags.map((item) => <span key={item} className="badge-primary">{item}</span>)}
            <span className={masteryBadge(question.mastery_level)}>{question.mastery_level || '未掌握'}</span>
            <span className={difficultyBadge(question.difficulty)}>{question.difficulty || '中等'}</span>
          </div>
        </div>
        <div className="header-actions">
          {!reviewMode ? <button className="secondary-button" type="button" onClick={() => onEdit(question.id)}><Edit3 size={16} />编辑错题</button> : null}
          <button className="secondary-button danger" type="button" onClick={remove}><Trash2 size={16} />删除错题</button>
        </div>
      </header>

      <section className="detail-layout-grid">
        <div className="detail-main-stack">
          <article className="detail-panel detail-info-card">
            <h2>基本信息</h2>
            <div className="detail-info-grid">
              <Field label="分类">{question.category}</Field>
              <Field label="学科">{question.subject || '高等数学'}</Field>
              <Field label="题型">{question.question_type}</Field>
              <Field label="错因">{question.error_reason}</Field>
              <Field label="难度"><span className={difficultyBadge(question.difficulty)}>{question.difficulty}</span></Field>
              <Field label="掌握程度"><span className={masteryBadge(question.mastery_level)}>{question.mastery_level}</span></Field>
              <Field label="来源">{question.source}</Field>
              <Field label="创建时间">{formatDate(question.created_at)}</Field>
              <Field label="更新时间">{formatDate(question.updated_at)}</Field>
            </div>
            {question.tags.length ? <div className="tag-row">{question.tags.map((tag) => <span key={tag} className="tag">#{tag}</span>)}</div> : null}
            {question.note ? <p className="long-text detail-note">备注：{question.note}</p> : null}
          </article>

          <FormulaCard title="题目内容" text={question.content || '暂无题目内容'} />

          {showAnswer ? (
            <>
              <FormulaCard title="我的错误思考" text={question.wrong_thinking || question.wrong_solution} tone="warning" />
              <FormulaCard title="正确解析" text={question.correct_solution} tone="success" />
              <FormulaCard title="答案" text={question.answer} tone="answer" />
            </>
          ) : null}

          {reviewMode ? (
            <section className="content-section review-mode-card">
              <div className="section-header">
                <h2>本次复习</h2>
                {!showAnswer ? (
                  <button className="primary-button" type="button" onClick={() => setShowAnswer(true)}><Eye size={16} />显示答案</button>
                ) : (
                  <div className="header-actions">
                    <button className="primary-button" type="button" onClick={() => addReview('做对了')}>做对了</button>
                    <button className="secondary-button danger" type="button" onClick={() => addReview('做错了')}>做错了</button>
                    <button className="secondary-button" type="button" onClick={() => addReview('仍然没思路')}>没思路</button>
                  </div>
                )}
              </div>
              {!showAnswer ? <p className="muted-text">先独立完成题目，再点击“显示答案”核对解析。</p> : null}
            </section>
          ) : null}
        </div>

        <aside className="detail-side-stack">
          <section className="content-section detail-image-card">
            <h2>错题原图</h2>
            <ImageGallery images={question.question_images} emptyText="暂无错题原图" />
          </section>

          {showAnswer ? (
            <section className="content-section detail-image-card">
              <h2>解析图片</h2>
              <ImageGallery images={question.solution_images} emptyText="暂无解析图片" />
            </section>
          ) : null}

          {showAnswer ? (
            <section className="content-section knowledge-link-card">
              <h2>所属知识点</h2>
              {question.knowledge_points?.length ? (
                <div className="tag-row">
                  {question.knowledge_points.map((point) => (
                    <button className="tag tag-button" type="button" key={point.node_id} onClick={() => onOpenKnowledgePoint?.(point.node_id)}>{point.title}</button>
                  ))}
                </div>
              ) : <p className="muted-text">暂无关联知识点，可在知识地图中重新匹配已有错题知识点。</p>}
            </section>
          ) : null}

          {showAnswer ? (
            <section className="detail-panel review-state-card">
              <h2>复习状态</h2>
              {question.review_count ? (
                <div className="review-state-grid">
                  <span><b>掌握程度</b><strong className={masteryBadge(question.mastery_level)}>{question.mastery_level}</strong></span>
                  <span><b>复习次数</b><strong>{question.review_count}</strong></span>
                  <span><b>做对次数</b><strong>{question.correct_count}</strong></span>
                  <span><b>做错次数</b><strong>{question.wrong_count}</strong></span>
                  <span><b>没思路次数</b><strong>{question.no_idea_count}</strong></span>
                  <span><b>连续做对</b><strong>{question.consecutive_correct}</strong></span>
                  <span><b>上次复习</b><strong>{formatDate(question.last_reviewed_at)}</strong></span>
                  <span><b>下次复习</b><strong>{formatDate(question.next_review_at)}</strong></span>
                </div>
              ) : <p className="muted-text">暂无复习记录</p>}
            </section>
          ) : null}

          {showAnswer ? (
            <AiDiagnosisPanel questionId={question.id} />
          ) : null}
        </aside>
      </section>

      {showAnswer ? (
        <section className="content-section review-log-card">
          <div className="section-header">
            <h2>复习记录</h2>
            <div className="header-actions">
              <button className="secondary-button" type="button" onClick={() => mark('已掌握')}><CheckCircle2 size={16} />标记为已掌握</button>
              <button className="secondary-button" type="button" onClick={() => mark('未掌握')}><XCircle size={16} />标记为仍然不会</button>
              {!reviewMode ? <button className="primary-button" type="button" onClick={() => setShowReviewForm((value) => !value)}><RotateCcw size={16} />添加复习记录</button> : null}
            </div>
          </div>

          {showReviewForm ? (
            <form className="review-form" onSubmit={submitReview}>
              <label>复习日期<input type="date" value={reviewDate} onChange={(event) => setReviewDate(event.target.value)} /></label>
              <label>本次结果<select value={result} onChange={(event) => setResult(event.target.value as ReviewResult)}>{REVIEW_RESULTS.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label>本次用时<input type="number" min={0} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>
              <label>本次备注<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
              <button className="primary-button" type="submit">保存记录</button>
            </form>
          ) : null}

          {logs.length ? (
            <div className="table-list review-log-list">
              {logs.map((log) => (
                <div className="table-row" key={log.id}>
                  <span>{formatDate(log.reviewed_at || log.review_date || '')}</span>
                  <span>{log.review_round ? `第 ${log.review_round} 刷` : '复习记录'}</span>
                  <span>{reviewResultLabel(log.result)}</span>
                  <span>{log.next_review_at ? `下次 ${formatDate(log.next_review_at)}` : `${log.duration_minutes || 0} 分钟`}</span>
                  <span>{log.note || '无备注'}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState title="还没有复习记录" />}
        </section>
      ) : null}

      <div className="detail-bottom-actions">
        <button className="secondary-button" type="button" onClick={onBack}>返回错题库</button>
      </div>
    </div>
  );
}

