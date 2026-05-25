import { ArrowLeft, BookOpenCheck, CalendarDays, CheckCircle2, Eye, FileText, Filter, Layers, PlusCircle, RotateCcw, SearchX, Shuffle, Target, Trash2, Trophy, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CATEGORIES, DIFFICULTIES, MATH_SUBJECTS, QUESTION_TYPES } from '../../shared/options';
import type { ExternalQuestion, ExternalQuestionFilters, ExternalQuestionResult, ExternalQuestionStats } from '../../shared/types';
import { MarkdownFormulaPreview, MarkdownFormulaText, countMarkdownImages } from '../components/MarkdownFormulaText';
import { useModal } from '../components/Modal';
import { useToast } from '../components/Toast';

const QUESTION_FORMATS = ['选择题', '填空题', '解答题'];
const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'unattempted', label: '未练习' },
  { value: 'attempted', label: '已练习' },
  { value: 'added', label: '已加入错题本' }
] as const;

const RESULT_LABEL: Record<ExternalQuestionResult, string> = {
  correct: '做对',
  wrong: '做错',
  no_idea: '没思路'
};

type PracticeMode = 'random' | 'year' | 'category' | 'unattempted' | 'weak';
type PracticeScope = 'all' | 'unattempted' | 'attempted' | 'weak' | 'not_added';
type PracticeOrder = 'random' | 'sequence';

interface PracticeSettings {
  mode: PracticeMode;
  scope: PracticeScope;
  count: number;
  order: PracticeOrder;
  subject: string;
  year: string;
  questionFormat: string;
  category: string;
  questionType: string;
  difficulty: string;
}

interface PracticeSummaryData {
  questions: ExternalQuestion[];
  results: Record<number, ExternalQuestionResult>;
  addedIds: Set<number>;
}

function emptyStats(): ExternalQuestionStats {
  return { total: 0, attempted: 0, wrong: 0, noIdea: 0, added: 0, years: [], questionTypes: [] };
}

function badgeTone(value?: string | null) {
  if (value === 'correct') return 'tone-success';
  if (value === 'wrong' || value === 'no_idea') return 'tone-danger';
  return 'tone-muted';
}

function parseOptions(options: string) {
  const text = options.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([key, value]) => `${key}. ${String(value)}`);
    }
  } catch {
    // Plain text options are still valid for the first local-bank version.
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function latestStatus(question: ExternalQuestion) {
  if (question.added_to_mistakes || question.latest_added_to_mistakes) return '已加入错题本';
  if (question.latest_result) return RESULT_LABEL[question.latest_result] || '已练习';
  return '未练习';
}

function isAddedToMistakes(question: ExternalQuestion) {
  return Boolean(question.added_to_mistakes || question.latest_added_to_mistakes || question.created_question_id || question.latest_created_question_id);
}

function isWeakResult(result?: string | null) {
  return result === 'wrong' || result === 'no_idea';
}

function shuffleQuestions(questions: ExternalQuestion[]) {
  const next = [...questions];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function sortQuestions(questions: ExternalQuestion[]) {
  return [...questions].sort((a, b) => {
    const yearDiff = (Number(b.year) || 0) - (Number(a.year) || 0);
    if (yearDiff) return yearDiff;
    const numberDiff = (Number(a.question_number) || 999) - (Number(b.question_number) || 999);
    if (numberDiff) return numberDiff;
    return a.id - b.id;
  });
}

function defaultPracticeSettings(mode: PracticeMode, stats: ExternalQuestionStats): PracticeSettings {
  return {
    mode,
    scope: mode === 'unattempted' ? 'unattempted' : mode === 'weak' ? 'weak' : 'all',
    count: 10,
    order: mode === 'random' ? 'random' : 'sequence',
    subject: '全部',
    year: mode === 'year' && stats.years[0] ? String(stats.years[0]) : '全部',
    questionFormat: '全部',
    category: '全部',
    questionType: '全部',
    difficulty: '全部'
  };
}

function filterPracticeCandidates(questions: ExternalQuestion[], settings: PracticeSettings) {
  return questions.filter((question) => {
    if (settings.subject !== '全部' && question.subject !== settings.subject) return false;
    if (settings.year !== '全部' && String(question.year || '') !== settings.year) return false;
    if (settings.questionFormat !== '全部' && question.question_format !== settings.questionFormat) return false;
    if (settings.category !== '全部' && question.category !== settings.category) return false;
    if (settings.questionType !== '全部' && question.question_type !== settings.questionType) return false;
    if (settings.difficulty !== '全部' && question.difficulty !== settings.difficulty) return false;
    if (settings.scope === 'unattempted' && question.latest_result) return false;
    if (settings.scope === 'attempted' && !question.latest_result) return false;
    if (settings.scope === 'weak' && !isWeakResult(question.latest_result)) return false;
    if (settings.scope === 'not_added' && isAddedToMistakes(question)) return false;
    return true;
  });
}

function pickPracticeQuestions(questions: ExternalQuestion[], settings: PracticeSettings) {
  const ordered = settings.order === 'random' ? shuffleQuestions(questions) : sortQuestions(questions);
  return ordered.slice(0, Math.max(1, settings.count));
}

function summarizeResults(results: Record<number, ExternalQuestionResult>, total: number) {
  const values = Object.values(results);
  const correct = values.filter((result) => result === 'correct').length;
  const wrong = values.filter((result) => result === 'wrong').length;
  const noIdea = values.filter((result) => result === 'no_idea').length;
  const answered = values.length;
  return {
    total,
    answered,
    correct,
    wrong,
    noIdea,
    unanswered: Math.max(0, total - answered),
    accuracy: answered ? Math.round((correct / answered) * 100) : 0
  };
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`question-bank-stat ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value?: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value || '全部'} onChange={(event) => onChange(event.target.value)}>
        <option value="全部">全部</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function QuestionCard({ question, onOpen }: { question: ExternalQuestion; onOpen: (id: number) => void }) {
  const status = latestStatus(question);
  const imageCount = countMarkdownImages(question.content);
  return (
    <button className="external-question-card" type="button" onClick={() => onOpen(question.id)}>
      <div className="external-question-card-head">
        <h3>{question.title || '未命名题目'}</h3>
        <span className={`status-pill ${badgeTone(question.latest_result)}`}>{status}</span>
      </div>
      <MarkdownFormulaPreview questionId={question.id} text={question.content} />
      {imageCount > 1 ? <span className="multi-image-hint">共 {imageCount} 张题图 / 多图题</span> : null}
      <div className="external-question-meta">
        <span>{question.year || '未知年份'}</span>
        <span>{question.exam_type || '考试类型未填'}</span>
        <span>第 {question.question_number || '-'} 题</span>
        <span>{question.subject || '高等数学'}</span>
        <span>{question.question_format || '解答题'}</span>
        <span>{question.question_type || '其他'}</span>
        <span>{question.difficulty || '中等'}</span>
      </div>
    </button>
  );
}

interface DetailProps {
  question: ExternalQuestion;
  onBack: () => void;
  onReload: () => Promise<void>;
  onBatchDeleted: () => Promise<void>;
  onOpenQuestion: (id: number) => void;
}

function QuestionBankDetail({ question, onBack, onReload, onBatchDeleted, onOpenQuestion }: DetailProps) {
  const { toast } = useToast();
  const modal = useModal();
  const [showAnswer, setShowAnswer] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => parseOptions(question.options || ''), [question.options]);
  const addedQuestionId = question.created_question_id || question.latest_created_question_id;

  async function record(result: ExternalQuestionResult) {
    setBusy(true);
    try {
      await window.api.recordExternalQuestionAttempt({ externalQuestionId: question.id, result, note });
      await onReload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addToMistakes() {
    setBusy(true);
    try {
      const result = await window.api.addExternalQuestionToMistakes(question.id);
      await onReload();
      toast('已加入错题本', 'success');
      onOpenQuestion(result.question.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openPaper() {
    try {
      await window.api.openExternalQuestionPaper(question.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function openSolutionPdf() {
    try {
      await window.api.openExternalQuestionSolutionPdf(question.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function deleteBatch() {
    if (!question.import_batch_id) return;
    const confirmed = await modal.confirm({ title: '操作确认', message: '确定删除这个题库导入批次吗？该批次的题目和练习记录会被删除。若该批次已有题目加入错题本，App 会保留相关图片/PDF 资源，避免错题图片丢失；否则资源会移入 trash。', confirmLabel: '删除批次', danger: true });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await window.api.deleteImportBatch(question.import_batch_id, { deleteAssets: true });
      toast(`已删除题目 ${result.deletedExternalQuestions} 道，练习记录 ${result.deletedAttempts} 条，移动资源 ${result.movedAssets} 个。${result.failedAssets.length ? `\n${result.failedAssets.join('\n')}` : ''}\n删除前备份：${result.backupPath}`, 'success');
      await onBatchDeleted();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="question-bank-detail">
      <button className="secondary-button" type="button" onClick={onBack}>
        <ArrowLeft size={16} />
        返回题库列表
      </button>

      <section className="question-bank-detail-card">
        <div className="question-bank-detail-head">
          <div>
            <span className="eyebrow">Training Detail</span>
            <h1>{question.title}</h1>
          </div>
          <span className={`status-pill ${badgeTone(question.latest_result)}`}>{latestStatus(question)}</span>
        </div>
        <div className="external-question-meta large">
          <span>学科：{question.subject || '高等数学'}</span>
          <span>分类：{question.category || '其他'}</span>
          <span>题型：{question.question_type || '其他'}</span>
          <span>形式：{question.question_format || '解答题'}</span>
          <span>年份：{question.year || '-'}</span>
          <span>题号：{question.question_number || '-'}</span>
        </div>

        <div className="question-bank-block">
          <h2>题干</h2>
          <MarkdownFormulaText questionId={question.id} text={question.content} missingImageLabel="题目图片" emptyText="题干暂未转写，请查看原卷 PDF" />
        </div>

        {options.length ? (
          <div className="question-bank-block">
            <h2>选项</h2>
            <div className="option-list">
              {options.map((option, index) => (
                <div className="option-item" key={`${option}-${index}`}>
                  <MarkdownFormulaText questionId={question.id} text={option} missingImageLabel="选项图片" />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="training-note-row">
          <label>
            本次备注
            <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="可记录卡住的位置或自己的判断" />
          </label>
        </div>

        <div className="training-actions">
          <button className="secondary-button" type="button" onClick={() => setShowAnswer((value) => !value)}>
            <Eye size={16} />
            {showAnswer ? '隐藏答案' : '显示答案'}
          </button>
          <button className="primary-button tone-success-button" type="button" onClick={() => record('correct')} disabled={busy}>
            <CheckCircle2 size={16} />
            做对了
          </button>
          <button className="secondary-button danger" type="button" onClick={() => record('wrong')} disabled={busy}>
            <XCircle size={16} />
            做错了
          </button>
          <button className="secondary-button warning" type="button" onClick={() => record('no_idea')} disabled={busy}>
            <RotateCcw size={16} />
            没思路
          </button>
          {question.paper_pdf_path ? (
            <button className="secondary-button" type="button" onClick={openPaper}>
              <FileText size={16} />
              打开原试卷 PDF
            </button>
          ) : null}
          {question.solution_pdf_path ? (
            <button className="secondary-button" type="button" onClick={openSolutionPdf}>
              <FileText size={16} />
              打开解析 PDF
            </button>
          ) : null}
        </div>

        {showAnswer ? (
          <div className="answer-panel">
            <div>
              <h2>答案</h2>
              <MarkdownFormulaText questionId={question.id} text={question.answer} missingImageLabel="答案图片" emptyText="暂无答案" />
            </div>
            <div>
              <h2>解析</h2>
              <MarkdownFormulaText questionId={question.id} text={question.solution} missingImageLabel="解析图片" emptyText="暂无解析" />
            </div>
          </div>
        ) : null}

        <div className="mistake-action-panel">
          <div>
            <strong>{question.added_to_mistakes ? '这道题已加入错题本' : '需要进入复习系统？'}</strong>
            <p>加入错题本后会复制到现有 questions 表，并继续使用当前复习系统。</p>
          </div>
          {addedQuestionId ? (
            <button className="secondary-button" type="button" onClick={() => onOpenQuestion(addedQuestionId)}>
              <BookOpenCheck size={16} />
              查看错题详情
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={addToMistakes} disabled={busy}>
              <PlusCircle size={16} />
              加入错题本
            </button>
          )}
        </div>

        {question.import_batch_id ? (
          <div className="batch-danger-panel">
            <div>
              <strong>当前导入批次</strong>
              <p>{question.import_batch_id}</p>
            </div>
            <button className="secondary-button danger" type="button" onClick={deleteBatch} disabled={busy}>
              <Trash2 size={16} />
              删除该题库批次
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function PracticeModePanel({ onSelect }: { onSelect: (mode: PracticeMode) => void }) {
  const modes: Array<{ mode: PracticeMode; icon: ReactNode; title: string; desc: string }> = [
    { mode: 'random', icon: <Shuffle size={20} />, title: '随机刷题', desc: '从题库中随机抽题，适合日常混合练习。' },
    { mode: 'year', icon: <CalendarDays size={20} />, title: '按年份刷题', desc: '按真题年份练习，例如 2025 / 2024 / 2023。' },
    { mode: 'category', icon: <Layers size={20} />, title: '按分类刷题', desc: '按知识分类或题型练习，聚焦薄弱模块。' },
    { mode: 'unattempted', icon: <Target size={20} />, title: '未练习题', desc: '优先练习还没有做过的外部题库题目。' },
    { mode: 'weak', icon: <RotateCcw size={20} />, title: '错题重练', desc: '重练最近一次标记为做错或没思路的题。' }
  ];
  return (
    <section className="practice-mode-panel">
      <div className="section-header compact">
        <div>
          <h2><Trophy size={18} /> 连续刷题模式</h2>
          <p className="muted-text">选择范围后连续做题，结果写入外部题库练习记录，必要时一键加入错题本。</p>
        </div>
      </div>
      <div className="practice-mode-grid">
        {modes.map((mode) => (
          <button className="practice-mode-card" type="button" key={mode.mode} onClick={() => onSelect(mode.mode)}>
            {mode.icon}
            <strong>{mode.title}</strong>
            <span>{mode.desc}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PracticeSetupPanel({
  settings,
  stats,
  questionTypeOptions,
  onChange,
  onStart,
  onCancel
}: {
  settings: PracticeSettings;
  stats: ExternalQuestionStats;
  questionTypeOptions: string[];
  onChange: (next: PracticeSettings) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const update = <K extends keyof PracticeSettings>(key: K, value: PracticeSettings[K]) => onChange({ ...settings, [key]: value });
  return (
    <section className="practice-setup-panel">
      <div className="section-header compact">
        <div>
          <h2>刷题设置</h2>
          <p className="muted-text">V1 使用前端临时 session，不新增数据库 session 表。</p>
        </div>
        <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
      </div>
      <div className="practice-setup-grid">
        <label>
          题目范围
          <select value={settings.scope} onChange={(event) => update('scope', event.target.value as PracticeScope)}>
            <option value="all">全部题目</option>
            <option value="unattempted">未练习题</option>
            <option value="attempted">已练习题</option>
            <option value="weak">做错 / 没思路</option>
            <option value="not_added">未加入错题本</option>
          </select>
        </label>
        <label>
          题目数量
          <input type="number" min={1} max={100} value={settings.count} onChange={(event) => update('count', Math.max(1, Number(event.target.value) || 1))} />
        </label>
        <label>
          出题顺序
          <select value={settings.order} onChange={(event) => update('order', event.target.value as PracticeOrder)}>
            <option value="random">随机</option>
            <option value="sequence">顺序</option>
          </select>
        </label>
        <SelectFilter label="学科" value={settings.subject} options={[...MATH_SUBJECTS]} onChange={(value) => update('subject', value)} />
        <SelectFilter label="年份" value={settings.year} options={stats.years.map(String)} onChange={(value) => update('year', value)} />
        <SelectFilter label="题目形式" value={settings.questionFormat} options={QUESTION_FORMATS} onChange={(value) => update('questionFormat', value)} />
        <SelectFilter label="分类" value={settings.category} options={[...CATEGORIES]} onChange={(value) => update('category', value)} />
        <SelectFilter label="题型" value={settings.questionType} options={questionTypeOptions} onChange={(value) => update('questionType', value)} />
        <SelectFilter label="难度" value={settings.difficulty} options={[...DIFFICULTIES]} onChange={(value) => update('difficulty', value)} />
      </div>
      <div className="training-actions">
        <button className="primary-button" type="button" onClick={onStart}>开始练习</button>
        <button className="secondary-button" type="button" onClick={onCancel}>返回题库列表</button>
      </div>
    </section>
  );
}

function PracticeSummaryPanel({
  summary,
  onRestart,
  onBack,
  onOpenQuestion
}: {
  summary: PracticeSummaryData;
  onRestart: () => void;
  onBack: () => void;
  onOpenQuestion: (id: number) => void;
}) {
  const data = summarizeResults(summary.results, summary.questions.length);
  const bySubject = summary.questions.reduce<Record<string, { correct: number; wrong: number; noIdea: number }>>((acc, question) => {
    const subject = question.subject || '其他';
    acc[subject] ||= { correct: 0, wrong: 0, noIdea: 0 };
    const result = summary.results[question.id];
    if (result === 'correct') acc[subject].correct += 1;
    if (result === 'wrong') acc[subject].wrong += 1;
    if (result === 'no_idea') acc[subject].noIdea += 1;
    return acc;
  }, {});
  return (
    <div className="page question-bank-page">
      <section className="practice-summary-card">
        <span className="eyebrow">Practice Summary</span>
        <h1>本次刷题完成</h1>
        <div className="review-stat-grid">
          <span>总题数<strong>{data.total}</strong></span>
          <span>已完成<strong>{data.answered}</strong></span>
          <span>做对<strong>{data.correct}</strong></span>
          <span>做错<strong>{data.wrong}</strong></span>
          <span>没思路<strong>{data.noIdea}</strong></span>
          <span>未作答<strong>{data.unanswered}</strong></span>
          <span>加入错题本<strong>{summary.addedIds.size}</strong></span>
          <span>正确率<strong>{data.accuracy}%</strong></span>
        </div>
        <div className="practice-subject-summary">
          {Object.entries(bySubject).map(([subject, row]) => (
            <span key={subject}>{subject}: 做对 {row.correct}，做错 {row.wrong}，没思路 {row.noIdea}</span>
          ))}
        </div>
        <div className="training-actions">
          <button className="primary-button" type="button" onClick={onRestart}>再来一组</button>
          <button className="secondary-button" type="button" onClick={onBack}>返回题库训练</button>
          {summary.addedIds.size ? (
            <button className="secondary-button" type="button" onClick={() => onOpenQuestion(Array.from(summary.addedIds)[0])}>查看错题详情</button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function PracticeSession({
  initialQuestions,
  onFinish,
  onExit,
  onOpenQuestion
}: {
  initialQuestions: ExternalQuestion[];
  onFinish: (summary: PracticeSummaryData) => void;
  onExit: () => void;
  onOpenQuestion: (id: number) => void;
}) {
  const { toast } = useToast();
  const [sessionQuestions, setSessionQuestions] = useState(initialQuestions);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [note, setNote] = useState('');
  const [results, setResults] = useState<Record<number, ExternalQuestionResult>>({});
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const current = sessionQuestions[currentIndex];
  const options = useMemo(() => parseOptions(current?.options || ''), [current]);
  const progress = current ? Math.round(((currentIndex + 1) / sessionQuestions.length) * 100) : 0;
  const stats = summarizeResults(results, sessionQuestions.length);
  const addedQuestionId = current?.created_question_id || current?.latest_created_question_id || 0;

  function goTo(index: number) {
    setCurrentIndex(Math.min(sessionQuestions.length - 1, Math.max(0, index)));
    setShowAnswer(false);
    setNote('');
  }

  async function record(result: ExternalQuestionResult) {
    if (!current) return;
    if (results[current.id] === result) return;
    setBusy(true);
    try {
      await window.api.recordExternalQuestionAttempt({ externalQuestionId: current.id, result, note });
      setResults((existing) => ({ ...existing, [current.id]: result }));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addToMistakes() {
    if (!current) return;
    setBusy(true);
    try {
      const result = await window.api.addExternalQuestionToMistakes(current.id);
      setAddedIds((existing) => new Set(existing).add(result.question.id));
      setSessionQuestions((existing) => existing.map((question) => question.id === current.id ? { ...question, added_to_mistakes: 1, created_question_id: result.question.id } : question));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openPaper() {
    if (!current) return;
    try {
      await window.api.openExternalQuestionPaper(current.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function openSolutionPdf() {
    if (!current) return;
    try {
      await window.api.openExternalQuestionSolutionPdf(current.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function finish() {
    onFinish({ questions: sessionQuestions, results, addedIds });
  }

  if (!current) return null;

  return (
    <div className="page question-bank-page practice-session-page">
      <header className="review-session-header app-card">
        <div>
          <span className="eyebrow">Question Bank Practice</span>
          <h1>{current.title}</h1>
          <p>第 {currentIndex + 1} / {sessionQuestions.length} 题</p>
        </div>
        <div className="session-score"><span>做对 {stats.correct}</span><span>做错 {stats.wrong}</span><span>没思路 {stats.noIdea}</span></div>
        <div className="review-progress"><i style={{ width: `${progress}%` }} /></div>
      </header>

      <section className="question-bank-detail-card">
        <div className="external-question-meta large">
          <span>{current.subject || '高等数学'}</span>
          <span>{current.category || '其他'}</span>
          <span>{current.question_type || '其他'}</span>
          <span>{current.question_format || '解答题'}</span>
          <span>{current.year || '-'}</span>
          <span>第 {current.question_number || '-'} 题</span>
          {results[current.id] ? <span>{RESULT_LABEL[results[current.id]]}</span> : null}
        </div>
        <div className="question-bank-block">
          <h2>题干</h2>
          <MarkdownFormulaText questionId={current.id} text={current.content} missingImageLabel="题目图片" emptyText="题干暂未转写，请查看原卷 PDF" />
        </div>
        {options.length ? (
          <div className="question-bank-block">
            <h2>选项</h2>
            <div className="option-list">
              {options.map((option, index) => <div className="option-item" key={`${option}-${index}`}><MarkdownFormulaText questionId={current.id} text={option} missingImageLabel="选项图片" /></div>)}
            </div>
          </div>
        ) : null}

        <div className="training-note-row">
          <label>
            本次备注
            <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="可记录卡住的位置或自己的判断" />
          </label>
        </div>

        <div className="training-actions">
          <button className="secondary-button" type="button" onClick={() => setShowAnswer((value) => !value)}>
            <Eye size={16} />{showAnswer ? '隐藏答案' : '显示答案'}
          </button>
          <button className="secondary-button" type="button" onClick={() => goTo(currentIndex - 1)} disabled={currentIndex === 0}>上一题</button>
          <button className="secondary-button" type="button" onClick={() => goTo(currentIndex + 1)} disabled={currentIndex >= sessionQuestions.length - 1}>下一题</button>
          <button className="secondary-button danger" type="button" onClick={finish}>结束练习</button>
        </div>

        {showAnswer ? (
          <>
            <div className="answer-panel">
              <div>
                <h2>答案</h2>
                <MarkdownFormulaText questionId={current.id} text={current.answer} missingImageLabel="答案图片" emptyText="暂无答案" />
              </div>
              <div>
                <h2>解析</h2>
                <MarkdownFormulaText questionId={current.id} text={current.solution} missingImageLabel="解析图片" emptyText="暂无解析" />
              </div>
            </div>
            <div className="training-actions">
              {current.paper_pdf_path ? <button className="secondary-button" type="button" onClick={openPaper}><FileText size={16} />打开原试卷 PDF</button> : null}
              {current.solution_pdf_path ? <button className="secondary-button" type="button" onClick={openSolutionPdf}><FileText size={16} />打开解析 PDF</button> : null}
              <button className="primary-button tone-success-button" type="button" onClick={() => record('correct')} disabled={busy}><CheckCircle2 size={16} />做对了</button>
              <button className="secondary-button danger" type="button" onClick={() => record('wrong')} disabled={busy}><XCircle size={16} />做错了</button>
              <button className="secondary-button warning" type="button" onClick={() => record('no_idea')} disabled={busy}><RotateCcw size={16} />没思路</button>
              {addedQuestionId ? (
                <button className="secondary-button" type="button" onClick={() => onOpenQuestion(addedQuestionId)}><BookOpenCheck size={16} />查看错题详情</button>
              ) : (
                <button className="primary-button" type="button" onClick={addToMistakes} disabled={busy}><PlusCircle size={16} />加入错题本</button>
              )}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

export function QuestionBankPage({ onOpenQuestion }: { onOpenQuestion: (id: number) => void }) {
  const { toast } = useToast();
  const [stats, setStats] = useState<ExternalQuestionStats>(emptyStats);
  const [filters, setFilters] = useState<ExternalQuestionFilters>({ status: 'all' });
  const [questions, setQuestions] = useState<ExternalQuestion[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<ExternalQuestion | null>(null);
  const [practiceSettings, setPracticeSettings] = useState<PracticeSettings | null>(null);
  const [practiceQuestions, setPracticeQuestions] = useState<ExternalQuestion[]>([]);
  const [practiceSummary, setPracticeSummary] = useState<PracticeSummaryData | null>(null);
  const [practiceStage, setPracticeStage] = useState<'list' | 'setup' | 'session' | 'summary'>('list');
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStats, nextQuestions] = await Promise.all([
        window.api.getExternalQuestionStats(),
        window.api.listExternalQuestions(filters)
      ]);
      setStats(nextStats);
      setQuestions(nextQuestions);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const loadSelected = useCallback(async () => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const detail = await window.api.getExternalQuestion(selectedId);
    setSelected(detail);
  }, [selectedId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadSelected();
  }, [loadSelected]);

  async function reloadAll() {
    await loadList();
    await loadSelected();
  }

  function updateFilter(key: keyof ExternalQuestionFilters, value: string) {
    setFilters((current) => ({
      ...current,
      [key]: value === '全部' || value === 'all' ? undefined : value
    }));
  }

  function clearFilters() {
    setFilters({ status: 'all' });
  }

  function openPracticeSetup(mode: PracticeMode) {
    setSelectedId(null);
    setPracticeSummary(null);
    setPracticeQuestions([]);
    setPracticeSettings(defaultPracticeSettings(mode, stats));
    setPracticeStage('setup');
  }

  async function startPractice() {
    if (!practiceSettings) return;
    setLoading(true);
    try {
      const allQuestions = await window.api.listExternalQuestions({});
      const candidates = filterPracticeCandidates(allQuestions, practiceSettings);
      if (!candidates.length) {
        toast('暂无符合条件的题目，可以放宽筛选条件后再试。', 'warning');
        return;
      }
      const picked = pickPracticeQuestions(candidates, practiceSettings);
      if (picked.length < practiceSettings.count) {
        toast(`符合条件的题目只有 ${picked.length} 道，本次将使用全部可用题目。`, 'warning');
      }
      setPracticeQuestions(picked);
      setPracticeSummary(null);
      setPracticeStage('session');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function finishPractice(summary: PracticeSummaryData) {
    setPracticeSummary(summary);
    setPracticeStage('summary');
    await loadList();
  }

  function resetPractice() {
    setPracticeStage('list');
    setPracticeQuestions([]);
    setPracticeSummary(null);
  }

  const questionTypeOptions = useMemo(() => {
    const merged = new Set([...QUESTION_TYPES, ...stats.questionTypes]);
    return [...merged];
  }, [stats.questionTypes]);

  if (practiceStage === 'session' && practiceQuestions.length) {
    return (
      <PracticeSession
        initialQuestions={practiceQuestions}
        onFinish={finishPractice}
        onExit={resetPractice}
        onOpenQuestion={onOpenQuestion}
      />
    );
  }

  if (practiceStage === 'summary' && practiceSummary) {
    return (
      <PracticeSummaryPanel
        summary={practiceSummary}
        onRestart={startPractice}
        onBack={resetPractice}
        onOpenQuestion={onOpenQuestion}
      />
    );
  }

  if (selected) {
    return (
      <QuestionBankDetail
        question={selected}
        onBack={() => setSelectedId(null)}
        onReload={reloadAll}
        onBatchDeleted={async () => {
          setSelectedId(null);
          await loadList();
        }}
        onOpenQuestion={onOpenQuestion}
      />
    );
  }

  return (
    <div className="page question-bank-page">
      <header className="question-bank-hero">
        <div>
          <span className="eyebrow">Question Bank Training</span>
          <h1>题库训练</h1>
          <p>导入本地标准题库包后，在这里按年份、学科和题型筛选刷题。做错或没思路的题可以一键进入错题本。</p>
        </div>
      </header>

      <section className="question-bank-stat-grid">
        <StatCard label="外部题库总题数" value={stats.total} />
        <StatCard label="已练习题数" value={stats.attempted} tone="tone-primary" />
        <StatCard label="未练习题数" value={Math.max(0, stats.total - stats.attempted)} tone="tone-muted" />
        <StatCard label="做错题数" value={stats.wrong} tone="tone-danger" />
        <StatCard label="没思路题数" value={stats.noIdea} tone="tone-warning" />
        <StatCard label="已加入错题本" value={stats.added} tone="tone-success" />
      </section>

      <PracticeModePanel onSelect={openPracticeSetup} />

      {practiceStage === 'setup' && practiceSettings ? (
        <PracticeSetupPanel
          settings={practiceSettings}
          stats={stats}
          questionTypeOptions={questionTypeOptions}
          onChange={setPracticeSettings}
          onStart={startPractice}
          onCancel={resetPractice}
        />
      ) : null}

      <section className="question-bank-filter-panel">
        <div className="section-header compact">
          <div>
            <h2><Filter size={18} /> 筛选</h2>
            <p className="muted-text">筛选会与练习状态叠加，默认显示全部题目。</p>
          </div>
          <button className="secondary-button" type="button" onClick={clearFilters}>清除筛选</button>
        </div>
        <div className="question-bank-filter-grid">
          <SelectFilter label="年份" value={filters.year} options={stats.years.map(String)} onChange={(value) => updateFilter('year', value)} />
          <SelectFilter label="学科" value={filters.subject} options={[...MATH_SUBJECTS]} onChange={(value) => updateFilter('subject', value)} />
          <SelectFilter label="题目形式" value={filters.questionFormat} options={QUESTION_FORMATS} onChange={(value) => updateFilter('questionFormat', value)} />
          <SelectFilter label="题型" value={filters.questionType} options={questionTypeOptions} onChange={(value) => updateFilter('questionType', value)} />
          <label>
            状态
            <select value={filters.status || 'all'} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as ExternalQuestionFilters['status'] }))}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {loading ? <div className="import-processing-card">正在读取题库...</div> : null}
      {questions.length ? (
        <section className="external-question-grid">
          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} onOpen={setSelectedId} />
          ))}
        </section>
      ) : (
        <section className="empty-state">
          <SearchX size={24} />
          <strong>暂无符合条件的题目</strong>
          <span>可以先在导入页导入 question_bank_import.zip，或清除当前筛选。</span>
        </section>
      )}
    </div>
  );
}
