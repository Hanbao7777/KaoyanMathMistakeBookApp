import { BookOpen, CheckCircle2, Eye, HelpCircle, Search, Shuffle, Target, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { KnowledgePointReviewStats, KnowledgeReviewMode, Question, ReviewBuckets, ReviewResultV2 } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import { FormulaText } from '../components/FormulaText';
import { ImageGallery } from '../components/ImageGallery';
import { useToast } from '../components/Toast';
import { formatDate } from '../utils/date';

interface ReviewPageProps {
  onOpenQuestion: (id: number, reviewMode?: boolean) => void;
  knowledgeNodeId?: string | null;
  onKnowledgeTargetConsumed?: () => void;
}

type ReviewMode = 'due' | 'weak' | 'random' | 'knowledge';

interface SessionStats {
  correct: number;
  wrong: number;
  no_idea: number;
}

interface SessionMeta {
  knowledgeTitle?: string;
  modeLabel?: string;
}

interface SubmitFeedback {
  result: ReviewResultV2;
  message: string;
  masteryBefore?: string | null;
  masteryAfter?: string | null;
  nextReviewAt?: string | null;
}

const T = {
  loading: '加载中...',
  questionUnit: '题',
  dueTitle: '今日待复习',
  weakTitle: '薄弱错题',
  randomTitle: '随机复习',
  knowledgeTitle: '按知识点复习',
  reviewCenter: '复习中心',
  reviewCenterDesc: '按照今日待复习、薄弱错题和知识点进行高效复盘',
  unmastered: '未掌握错题',
  weakCount: '薄弱错题',
  weekReviewed: '本周已复习',
  dueDesc: '优先复习到期和新导入的错题。',
  weakDesc: '集中处理未掌握、较弱和经常错的题。',
  randomDesc: '从错题库中随机抽题保持手感。',
  knowledgeDesc: '选择知识点后只复习相关错题。',
  noQuestions: '暂无可复习题目',
  preview: '今日待复习预览',
  noDueToday: '今天暂无待复习错题，可以进行随机复习或复习薄弱错题。',
  nextReview: '下次复习',
  summaryTitle: '本轮复习完成',
  summaryDesc: '继续保持，薄弱知识点会越来越少。系统已根据本轮结果更新下次复习时间。',
  total: '总题数',
  correct: '做对',
  wrong: '做错',
  noIdea: '没思路',
  accuracy: '正确率',
  backCenter: '返回复习中心',
  currentPrefix: '第 ',
  currentMiddle: ' / ',
  question: '题目',
  noOriginalImage: '暂无错题原图',
  noContent: '暂无题目内容',
  wrongThinking: '我的错误思考',
  correctSolution: '正确解析',
  answer: '答案',
  empty: '暂无',
  independent: '先独立完成',
  independentDesc: '默认隐藏解析和答案。做完后再显示答案，按真实结果记录。',
  showAnswer: '显示答案',
  recordResult: '记录本题结果',
  recordDesc: '系统会自动更新掌握程度、复习次数和下次复习时间。',
  correctButton: '做对了',
  wrongButton: '做错了',
  noIdeaButton: '没思路',
  nextQuestion: '下一题',
  viewSummary: '查看总结',
  endSession: '结束本轮',
  openDetail: '打开详情页',
  knowledgePickerTitle: '按知识点复习',
  knowledgePickerDesc: '选择一个知识点，复习它及子知识点下的相关错题。',
  searchPlaceholder: '搜索知识点 / 章节 / 标签',
  onlyDue: '只看待复习',
  onlyWeak: '只看薄弱',
  includeChildren: '包含子知识点错题',
  noKnowledge: '暂无可按知识点复习的错题',
  noKnowledgeDesc: '请先导入带 knowledge_points 字段的错题包，或在知识地图中重新匹配已有错题知识点。',
  noKnowledgeResult: '没有找到相关知识点',
  related: '相关错题',
  due: '待复习',
  weak: '薄弱',
  mastery: '掌握度',
  pdf: 'PDF',
  dueMode: '待复习错题',
  allMode: '全部相关错题',
  startDue: '复习待复习错题',
  startAll: '复习全部相关错题',
  noDueForPoint: '该知识点暂无待复习错题，可以选择复习全部相关错题。',
  knowledgeSessionPrefix: '按知识点复习：',
  modePrefix: '模式：',
  start: '开始复习',
  choose: '选择知识点',
  progress: '复习进度',
  recorded: '已记录',
  masteryChange: '掌握程度',
  next: '下次复习',
  shortcutHint: '快捷键：空格 显示答案 · 1 做对 · 2 做错 · 3 没思路 · N 下一题'
};

const emptyStats: SessionStats = { correct: 0, wrong: 0, no_idea: 0 };

function resultText(result: ReviewResultV2) {
  if (result === 'correct') return T.correctButton;
  if (result === 'wrong') return T.wrongButton;
  return T.noIdeaButton;
}

function resultTone(result: ReviewResultV2) {
  if (result === 'correct') return 'success';
  if (result === 'wrong') return 'warning';
  return 'danger';
}

function accuracy(stats: SessionStats) {
  const total = stats.correct + stats.wrong + stats.no_idea;
  if (!total) return 0;
  return Math.round((stats.correct / total) * 100);
}

function pickRandom(questions: Question[], count = 12) {
  return [...questions].sort(() => Math.random() - 0.5).slice(0, count);
}

function averageText(value: number | null) {
  return value === null ? '--' : value + '%';
}

function masteryTone(value: number | null) {
  if (value === null) return 'muted';
  if (value <= 30) return 'danger';
  if (value <= 60) return 'warning';
  if (value <= 80) return 'primary';
  return 'success';
}

function knowledgeSearchText(point: KnowledgePointReviewStats) {
  return [point.title, point.category, ...point.tags, ...point.commonQuestionTypes].join(' ').toLowerCase();
}

function ModeCard({ title, description, count, icon, tone, actionText, onStart, disabled }: { title: string; description: string; count?: number; icon: ReactNode; tone: 'primary' | 'warning' | 'success' | 'muted'; actionText: string; onStart: () => void; disabled?: boolean; }) {
  return (
    <article className={`review-mode-card tone-${tone}`}>
      <span className="review-mode-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {typeof count === 'number' ? <em>{count} {T.questionUnit}</em> : null}
      <button className={tone === 'muted' ? 'secondary-button' : 'primary-button'} type="button" onClick={onStart} disabled={disabled}>{actionText}</button>
    </article>
  );
}

function AnswerCard({ title, text, tone }: { title: string; text?: string; tone: 'warning' | 'success' | 'answer' }) {
  return (
    <article className={`review-answer-card tone-${tone}`}>
      <h2>{title}</h2>
      <FormulaText text={text?.trim() || T.empty} />
    </article>
  );
}

export function ReviewPage({ onOpenQuestion, knowledgeNodeId, onKnowledgeTargetConsumed }: ReviewPageProps) {
  const { toast } = useToast();
  const [buckets, setBuckets] = useState<ReviewBuckets | null>(null);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgePointReviewStats[]>([]);
  const [knowledgePicker, setKnowledgePicker] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [onlyDueKnowledge, setOnlyDueKnowledge] = useState(false);
  const [onlyWeakKnowledge, setOnlyWeakKnowledge] = useState(false);
  const [includeChildren, setIncludeChildren] = useState(true);
  const [activeKnowledge, setActiveKnowledge] = useState<KnowledgePointReviewStats | null>(null);
  const [knowledgeMessage, setKnowledgeMessage] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({});
  const [sessionQuestions, setSessionQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [feedback, setFeedback] = useState<SubmitFeedback | null>(null);
  const [undoData, setUndoData] = useState<{ questionId: number; previousMastery: string | null } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const nextQuestionRef = useRef(nextQuestion);
  nextQuestionRef.current = nextQuestion;
  const [stats, setStats] = useState<SessionStats>(emptyStats);
  const [finished, setFinished] = useState(false);

  const current = sessionQuestions[currentIndex] ?? null;
  const inSession = Boolean(sessionQuestions.length) || finished;

  async function load() {
    const [nextBuckets, nextKnowledgeStats] = await Promise.all([window.api.getReviewBuckets(), window.api.listKnowledgeReviewStats()]);
    setBuckets(nextBuckets);
    setKnowledgeStats(nextKnowledgeStats);
  }

  useEffect(() => {
    load().catch((error) => toast(error.message, 'error'));
  }, []);

  useEffect(() => {
    if (!knowledgeNodeId) return;
    setKnowledgePicker(true);
    setKnowledgeMessage('');
    window.api.getKnowledgePointReviewStats(knowledgeNodeId, includeChildren)
      .then((statsValue) => {
        if (statsValue) setActiveKnowledge(statsValue);
      })
      .catch((error) => toast(error.message, 'error'))
      .finally(() => onKnowledgeTargetConsumed?.());
  }, [knowledgeNodeId, includeChildren, onKnowledgeTargetConsumed]);

  const filteredKnowledgeStats = useMemo(() => {
    const keyword = knowledgeSearch.trim().toLowerCase();
    return knowledgeStats.filter((point) => {
      if (keyword && !knowledgeSearchText(point).includes(keyword)) return false;
      if (onlyDueKnowledge && point.due_questions <= 0) return false;
      if (onlyWeakKnowledge && point.weak_questions <= 0) return false;
      return point.total_questions > 0;
    });
  }, [knowledgeStats, knowledgeSearch, onlyDueKnowledge, onlyWeakKnowledge]);

  async function beginSession(title: string, questions: Question[], meta: SessionMeta = {}) {
    if (!questions.length) {
      toast(title + ' ' + T.noQuestions, 'warning');
      return;
    }
    setSessionTitle(title);
    setSessionMeta(meta);
    setSessionQuestions(questions);
    setCurrentIndex(0);
    setShowAnswer(false);
    setFeedback(null);
    setStats(emptyStats);
    setFinished(false);
    setKnowledgePicker(false);
    setKnowledgeMessage('');
  }

  async function start(mode: ReviewMode) {
    if (!buckets) return;
    if (mode === 'due') return beginSession(T.dueTitle, buckets.due);
    if (mode === 'weak') return beginSession(T.weakTitle, buckets.weak);
    if (mode === 'random') {
      const all = await window.api.listQuestions({ sortBy: 'review_count', sortOrder: 'asc' });
      const candidates = all.filter((question) => question.mastery_level !== '已掌握' || !question.next_review_at || new Date(question.next_review_at) <= new Date());
      return beginSession(T.randomTitle, pickRandom(candidates.length ? candidates : all));
    }
    setKnowledgePicker(true);
    setActiveKnowledge(null);
    setKnowledgeMessage('');
  }

  async function startKnowledgeSession(point: KnowledgePointReviewStats, mode: KnowledgeReviewMode) {
    try {
      const response = await window.api.getKnowledgeReviewQuestions(point.node_id, mode, includeChildren);
      if (!response.questions.length) {
        setActiveKnowledge(response.stats);
        setKnowledgeMessage(mode === 'due' ? T.noDueForPoint : T.noQuestions);
        return;
      }
      await beginSession(T.knowledgeSessionPrefix + response.stats.title, response.questions, {
        knowledgeTitle: response.stats.title,
        modeLabel: mode === 'due' ? T.dueMode : T.allMode
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function submit(result: ReviewResultV2) {
    if (!current) return;
    setUndoData({
      questionId: current.id,
      previousMastery: current.mastery_level
    });

    try {
      const response = await window.api.submitReviewResult({ questionId: current.id, result });
      setFeedback({
        result,
        message: response.message || resultText(result),
        masteryBefore: response.log.mastery_before,
        masteryAfter: response.log.mastery_after,
        nextReviewAt: response.log.next_review_at
      });
      setSessionQuestions((items) => items.map((item) => (item.id === current.id ? response.question : item)));
      setStats((value) => ({ ...value, [result]: value[result] + 1 }));
      await load();
      if (activeKnowledge) {
        const refreshed = await window.api.getKnowledgePointReviewStats(activeKnowledge.node_id, includeChildren);
        if (refreshed) setActiveKnowledge(refreshed);
      }

      try {
        await window.api.syncReviewToTickTick('question', String(current.id));
      } catch {}

      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => setUndoData(null), 5000);
    } catch (error) {
      setUndoData(null);
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function nextQuestion() {
    if (currentIndex >= sessionQuestions.length - 1) {
      setFinished(true);
      setSessionQuestions([]);
      setShowAnswer(false);
      setFeedback(null);
      return;
    }
    setCurrentIndex((value) => value + 1);
    setShowAnswer(false);
    setFeedback(null);
  }

  function backToCenter() {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoData(null);
    setSessionTitle('');
    setSessionMeta({});
    setSessionQuestions([]);
    setCurrentIndex(0);
    setShowAnswer(false);
    setFeedback(null);
    setStats(emptyStats);
    setFinished(false);
    setKnowledgePicker(false);
    setKnowledgeMessage('');
    load().catch((error) => toast(error.message, 'error'));
  }

  const overview = useMemo(() => {
    if (!buckets) return [];
    return [
      { label: T.dueTitle, value: buckets.counts.due, tone: 'primary' },
      { label: T.weakCount, value: buckets.counts.weak, tone: 'warning' },
      { label: T.unmastered, value: buckets.counts.unmastered, tone: 'danger' },
      { label: T.weekReviewed, value: buckets.counts.weekReviewed, tone: 'success' }
    ];
  }, [buckets]);

  useEffect(() => {
    if (!inSession || finished) return;

    function handleKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (event.key === ' ') {
        event.preventDefault();
        if (!showAnswer) {
          setShowAnswer(true);
        }
      } else if (event.key === '1' && showAnswer && !feedback) {
        submitRef.current('correct');
      } else if (event.key === '2' && showAnswer && !feedback) {
        submitRef.current('wrong');
      } else if (event.key === '3' && showAnswer && !feedback) {
        submitRef.current('no_idea');
      } else if ((event.key === 'n' || event.key === 'N') && feedback) {
        nextQuestionRef.current();
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [inSession, finished, showAnswer, feedback, currentIndex]);

  if (!buckets) return <div className="page">{T.loading}</div>;

  if (finished) {
    const total = stats.correct + stats.wrong + stats.no_idea;
    return (
      <div className="page review-page review-finish-page">
        <section className="review-summary-card app-card">
          <span className="eyebrow">{sessionTitle}</span>
          <h1>{T.summaryTitle}</h1>
          <p>{T.summaryDesc}</p>
          {sessionMeta.knowledgeTitle ? <p className="muted-text">{T.knowledgeTitle}: {sessionMeta.knowledgeTitle} · {T.modePrefix}{sessionMeta.modeLabel}</p> : null}
          <div className="review-stat-grid">
            <span>{T.total}<strong>{total}</strong></span>
            <span>{T.correct}<strong>{stats.correct}</strong></span>
            <span>{T.wrong}<strong>{stats.wrong}</strong></span>
            <span>{T.noIdea}<strong>{stats.no_idea}</strong></span>
            <span>{T.accuracy}<strong>{accuracy(stats)}%</strong></span>
          </div>
          <button className="primary-button" type="button" onClick={backToCenter}>{T.backCenter}</button>
        </section>
      </div>
    );
  }

  if (inSession && current) {
    const hasSubmitted = Boolean(feedback);
    const progress = Math.round(((currentIndex + 1) / sessionQuestions.length) * 100);
    return (
      <div className="page review-page review-session-page">
        <header className="review-session-header app-card">
          <div>
            <span className="eyebrow">{sessionTitle}</span>
            <h1>{current.title}</h1>
            <p>{T.currentPrefix}{currentIndex + 1}{T.currentMiddle}{sessionQuestions.length} {T.questionUnit}</p>
            {sessionMeta.modeLabel ? <p className="muted-text">{T.modePrefix}{sessionMeta.modeLabel}</p> : null}
          </div>
          <div className="session-score"><span>{T.correct} {stats.correct}</span><span>{T.wrong} {stats.wrong}</span><span>{T.noIdea} {stats.no_idea}</span></div>
          <div className="review-progress"><i style={{ width: `${progress}%` }} /></div>
        </header>

        <section className="review-question-layout">
          <main className="review-question-main">
            <section className="review-question-card section-card">
              <div className="knowledge-card-header"><div><h2>{T.question}</h2><p>{current.category} · {current.question_type} · {current.error_reason}</p></div><span className="badge-primary">{current.mastery_level}</span></div>
              <ImageGallery images={current.question_images} emptyText={T.noOriginalImage} />
              <div className="long-text review-content"><FormulaText text={current.content || T.noContent} /></div>
              <div className="tag-row">
                <span className="tag">{current.category}</span>
                <span className="tag">{current.question_type}</span>
                <span className="tag">{current.error_reason}</span>
                <span className="tag">{current.mastery_level}</span>
                {current.knowledge_points?.map((point) => <span className="tag" key={point.node_id}>{point.title}</span>)}
              </div>
            </section>

            {showAnswer ? (
              <>
                <section className="review-answer-grid">
                  <AnswerCard title={T.wrongThinking} text={current.wrong_thinking || current.wrong_solution} tone="warning" />
                  <AnswerCard title={T.correctSolution} text={current.correct_solution} tone="success" />
                  <AnswerCard title={T.answer} text={current.answer} tone="answer" />
                </section>
                {current.solution_images.length ? (
                  <section className="review-question-card section-card">
                    <div className="knowledge-card-header"><div><h2>解析图片</h2><p>来自错题本解析资源</p></div></div>
                    <ImageGallery images={current.solution_images} emptyText="暂无解析图片" />
                  </section>
                ) : null}
              </>
            ) : null}
          </main>

          <aside className="review-action-panel section-card">
            {!showAnswer ? (
              <><h2>{T.independent}</h2><p>{T.independentDesc}</p><button className="primary-button review-show-answer-button" type="button" onClick={() => setShowAnswer(true)}><Eye size={16} />{T.showAnswer}</button><small>{T.shortcutHint}</small></>
            ) : (
              <>
                <h2>{T.recordResult}</h2><p>{T.recordDesc}</p>
                <div className="review-result-buttons">
                  <button className="review-result-button result-correct" type="button" onClick={() => submit('correct')} disabled={hasSubmitted}><CheckCircle2 size={16} />{T.correctButton}</button>
                  <button className="review-result-button result-wrong" type="button" onClick={() => submit('wrong')} disabled={hasSubmitted}><XCircle size={16} />{T.wrongButton}</button>
                  <button className="review-result-button result-no-idea" type="button" onClick={() => submit('no_idea')} disabled={hasSubmitted}><HelpCircle size={16} />{T.noIdeaButton}</button>
                </div>
                {feedback ? (
                  <div className={`review-feedback-card tone-${resultTone(feedback.result)}`}>
                    <strong>{T.recorded}：{resultText(feedback.result)}</strong>
                    <span>{T.masteryChange}：{feedback.masteryBefore || '暂无'} → {feedback.masteryAfter || current.mastery_level}</span>
                    <span>{T.next}：{formatDate(feedback.nextReviewAt)}</span>
                    <small>{feedback.message}</small>
                    {undoData ? (
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={async () => {
                          if (!undoData) return;
                          await window.api.markMastery(undoData.questionId, (undoData.previousMastery as '未掌握' | '较弱' | '一般' | '较好' | '已掌握') || '未掌握');
                          setUndoData(null);
                          if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
                          setFeedback(null);
                          setStats((value) => {
                            const next = { ...value };
                            if (feedback.result === 'correct') next.correct -= 1;
                            else if (feedback.result === 'wrong') next.wrong -= 1;
                            else next.no_idea -= 1;
                            return next;
                          });
                        }}
                      >
                        撤销 (5秒内)
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {feedback ? <button className="primary-button" type="button" onClick={nextQuestion}>{currentIndex >= sessionQuestions.length - 1 ? T.viewSummary : T.nextQuestion}</button> : null}
              </>
            )}
            <button className="secondary-button" type="button" onClick={backToCenter}>{T.endSession}</button>
            <button className="secondary-button" type="button" onClick={() => onOpenQuestion(current.id, true)}>{T.openDetail}</button>
          </aside>
        </section>
      </div>
    );
  }

  if (knowledgePicker) {
    return (
      <div className="page review-page knowledge-review-page">
        <header className="review-hero app-card"><div><span className="eyebrow">{T.knowledgeTitle}</span><h1>{T.knowledgePickerTitle}</h1><p>{T.knowledgePickerDesc}</p></div><button className="secondary-button" type="button" onClick={backToCenter}>{T.backCenter}</button></header>
        <section className="knowledge-review-toolbar section-card">
          <label className="knowledge-search"><Search size={16} /><input value={knowledgeSearch} onChange={(event) => setKnowledgeSearch(event.target.value)} placeholder={T.searchPlaceholder} /></label>
          <label className="toggle-line"><input checked={onlyDueKnowledge} onChange={(event) => setOnlyDueKnowledge(event.target.checked)} type="checkbox" />{T.onlyDue}</label>
          <label className="toggle-line"><input checked={onlyWeakKnowledge} onChange={(event) => setOnlyWeakKnowledge(event.target.checked)} type="checkbox" />{T.onlyWeak}</label>
          <label className="toggle-line"><input checked={includeChildren} onChange={(event) => setIncludeChildren(event.target.checked)} type="checkbox" />{T.includeChildren}</label>
        </section>
        {knowledgeMessage ? <div className="warning-box">{knowledgeMessage}</div> : null}
        {activeKnowledge ? <section className="knowledge-review-selected section-card"><div><span className="eyebrow">{T.knowledgeTitle}</span><h2>{activeKnowledge.title}</h2><p>{activeKnowledge.category || '--'} · {T.related}: {activeKnowledge.total_questions} · {T.due}: {activeKnowledge.due_questions} · {T.weak}: {activeKnowledge.weak_questions}</p></div><div className="header-actions"><button className="secondary-button" type="button" onClick={() => startKnowledgeSession(activeKnowledge, 'due')} disabled={activeKnowledge.due_questions <= 0}>{T.startDue}</button><button className="primary-button" type="button" onClick={() => startKnowledgeSession(activeKnowledge, 'all')} disabled={activeKnowledge.total_questions <= 0}>{T.startAll}</button></div></section> : null}
        {!knowledgeStats.length ? <EmptyState title={T.noKnowledge} description={T.noKnowledgeDesc} /> : filteredKnowledgeStats.length ? (
          <section className="knowledge-review-grid">
            {filteredKnowledgeStats.map((point) => {
              const tone = masteryTone(point.average_mastery_score);
              const score = point.average_mastery_score ?? 0;
              return (
                <article className={'knowledge-review-card ' + (activeKnowledge?.node_id === point.node_id ? 'active' : '')} key={point.node_id}>
                  <button className="knowledge-review-card-main" type="button" onClick={() => setActiveKnowledge(point)}>
                    <h2>{point.title}</h2><p>{point.category || '--'}</p>
                    <div className="knowledge-review-metrics"><span>{T.related}<strong>{point.total_questions}</strong></span><span>{T.due}<strong>{point.due_questions}</strong></span><span>{T.weak}<strong>{point.weak_questions}</strong></span><span>{T.mastery}<strong>{averageText(point.average_mastery_score)}</strong></span></div>
                    <div className={`mastery-bar tone-${tone}`}><i style={{ width: `${Math.max(4, Math.min(100, score))}%` }} /></div>
                    {point.pdf_page ? <em>{T.pdf} {point.pdf_page}</em> : null}
                  </button>
                  <div className="knowledge-card-actions"><button className="secondary-button compact-button" type="button" onClick={() => startKnowledgeSession(point, 'due')} disabled={point.due_questions <= 0}>{T.startDue}</button><button className="primary-button compact-button" type="button" onClick={() => startKnowledgeSession(point, 'all')}>{T.startAll}</button></div>
                </article>
              );
            })}
          </section>
        ) : <EmptyState title={T.noKnowledgeResult} />}
      </div>
    );
  }

  return (
    <div className="page review-page review-center-page">
      <header className="review-hero app-card"><div><span className="eyebrow">专注复习中心</span><h1>{T.reviewCenter}</h1><p>{T.reviewCenterDesc}</p></div></header>
      <section className="review-overview-grid">{overview.map((item) => <article className={`review-overview-card tone-${item.tone}`} key={item.label}><span>{item.label}</span><strong>{item.value}</strong></article>)}</section>
      <section className="review-mode-grid">
        <ModeCard title={T.dueTitle} description={T.dueDesc} count={buckets.due.length} icon={<Target size={20} />} tone="primary" actionText={T.start} onStart={() => start('due')} disabled={!buckets.due.length} />
        <ModeCard title={T.weakTitle} description={T.weakDesc} count={buckets.weak.length} icon={<XCircle size={20} />} tone="warning" actionText={T.start} onStart={() => start('weak')} disabled={!buckets.weak.length} />
        <ModeCard title={T.randomTitle} description={T.randomDesc} icon={<Shuffle size={20} />} tone="success" actionText="开始随机复习" onStart={() => start('random')} />
        <ModeCard title={T.knowledgeTitle} description={T.knowledgeDesc} count={knowledgeStats.length} icon={<BookOpen size={20} />} tone="muted" actionText={T.choose} onStart={() => start('knowledge')} disabled={!knowledgeStats.length} />
      </section>
      <section className="content-section review-preview-card"><h2>{T.preview}</h2>{buckets.due.length ? <div className="question-list compact">{buckets.due.slice(0, 6).map((question) => <button className="related-question" type="button" key={question.id} onClick={() => onOpenQuestion(question.id, true)}><strong>{question.title}</strong><span>{question.category} · {question.question_type} · {T.nextReview} {formatDate(question.next_review_at)}</span></button>)}</div> : <EmptyState title={T.noDueToday} />}</section>
    </div>
  );
}
