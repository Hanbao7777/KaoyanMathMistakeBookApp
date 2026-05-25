import { AlertTriangle, ArrowRight, BookMarked, CalendarDays, CheckCircle2, FileUp, Flame, Library, PlusCircle, RotateCcw, Target, TrendingDown } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DashboardData, KnowledgePointReviewStats, QuestionFilters, StudySupervisorDashboard } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import type { PageKey } from '../components/Shell';
import { useToast } from '../components/Toast';

interface DashboardPageProps {
  onAdd: () => void;
  onReview: () => void;
  onOpenQuestion: (id: number) => void;
  onReviewKnowledgePoint: (nodeId: string) => void;
  onOpenKnowledgePoint: (nodeId: string) => void;
  onOpenKnowledgeMap: () => void;
  onOpenImport: () => void;
  onOpenLibrary: (filters?: QuestionFilters) => void;
  onOpenStudyPage?: (page: PageKey) => void;
}

const T = {
  loading: '加载中...',
  title: '学习总览',
  subtitle: '今天从待复习错题和薄弱知识点开始',
  heroNote: '让错题、知识点和复习计划连在一起，今天只推进最重要的几步。',
  total: '总错题数',
  calculus: '高等数学',
  linear: '线性代数',
  due: '今日待复习',
  weak: '薄弱错题',
  unmastered: '未掌握错题',
  weekReviewed: '本周已复习',
  weekAccuracy: '本周正确率',
  none: '暂无',
  questionUnit: '题',
  suggested: '今日建议复习',
  suggestedDesc: '优先处理到期、薄弱和平均掌握度较低的知识点。',
  weakPoints: '薄弱知识点',
  topReasons: '高频错因',
  weekly: '本周复习概览',
  quick: '快捷入口',
  startReview: '开始今日复习',
  reviewWeak: '复习薄弱错题',
  openMap: '查看知识地图',
  importNew: '导入新错题',
  addQuestion: '添加错题',
  start: '开始复习',
  related: '相关错题',
  weakLabel: '薄弱',
  mastery: '掌握度',
  correct: '做对',
  wrong: '做错',
  noIdea: '没思路',
  recent: '最近添加错题',
  noSuggestion: '暂无建议复习知识点',
  noSuggestionDesc: '可以先导入错题或在知识地图中重新匹配知识点。',
  noWeek: '本周暂无复习记录',
  noReasons: '暂无错因统计',
  emptyRecent: '还没有错题',
  emptyRecentDesc: '先添加或导入一批错题，复习系统就会开始工作。'
};

function formatDate() {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}

function formatShortDate(value?: string | null) {
  if (!value) return T.none;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return T.none;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date);
}

function rateText(value: number | null) {
  return value === null ? T.none : value + '%';
}

function masteryText(value: number | null) {
  return value === null ? '--' : value + '%';
}

function masteryTone(value: number | null) {
  if (value === null) return 'muted';
  if (value <= 30) return 'danger';
  if (value <= 60) return 'warning';
  if (value <= 80) return 'primary';
  return 'success';
}

function sortSuggested(points: KnowledgePointReviewStats[]) {
  return [...points]
    .filter((point) => point.due_questions > 0 || point.weak_questions > 0)
    .sort((a, b) => b.due_questions - a.due_questions || b.weak_questions - a.weak_questions || (a.average_mastery_score ?? 101) - (b.average_mastery_score ?? 101))
    .slice(0, 5);
}

function sortWeak(points: KnowledgePointReviewStats[]) {
  return [...points]
    .filter((point) => point.total_questions > 0)
    .sort((a, b) => b.weak_questions - a.weak_questions || (a.average_mastery_score ?? 101) - (b.average_mastery_score ?? 101) || b.total_questions - a.total_questions)
    .slice(0, 5);
}

export function DashboardPage({
  onAdd,
  onReview,
  onOpenQuestion,
  onReviewKnowledgePoint,
  onOpenKnowledgePoint,
  onOpenKnowledgeMap,
  onOpenImport,
  onOpenLibrary,
  onOpenStudyPage
}: DashboardPageProps) {
  const { toast } = useToast();
  const [data, setData] = useState<DashboardData | null>(null);
  const [studyData, setStudyData] = useState<StudySupervisorDashboard | null>(null);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgePointReviewStats[]>([]);

  useEffect(() => {
    Promise.all([window.api.dashboard(), window.api.listKnowledgeReviewStats(), window.api.getStudySupervisorDashboard()])
      .then(([dashboard, points, study]) => {
        setData(dashboard);
        setKnowledgeStats(points);
        setStudyData(study);
      })
      .catch((error) => toast(error.message, 'error'));
  }, []);

  const suggested = useMemo(() => sortSuggested(knowledgeStats), [knowledgeStats]);
  const weakPoints = useMemo(() => sortWeak(knowledgeStats), [knowledgeStats]);

  if (!data) return <div className="page">{T.loading}</div>;

  const actionMetrics = [
    { label: T.due, value: data.due, hint: '优先完成今天到期的复习', tone: 'primary', icon: RotateCcw, onClick: onReview },
    { label: T.weak, value: data.weakQuestions, hint: '集中处理反复失分点', tone: 'warning', icon: TrendingDown, onClick: () => onOpenLibrary({ weakOnly: true }) },
    { label: T.unmastered, value: data.unmastered, hint: '还没有真正拿下的题', tone: 'danger', icon: AlertTriangle, onClick: () => onOpenLibrary({ masteryLevel: '未掌握' }) }
  ];

  const statMetrics = [
    { label: T.total, value: data.total, hint: '进入全部错题', tone: 'primary', onClick: () => onOpenLibrary({}) },
    { label: T.calculus, value: data.subjectCounts?.find((item) => item.name === '高等数学')?.count ?? 0, hint: '高数错题数', tone: 'primary', onClick: () => onOpenLibrary({ subject: '高等数学' }) },
    { label: T.linear, value: data.subjectCounts?.find((item) => item.name === '线性代数')?.count ?? 0, hint: '线代错题数', tone: 'success', onClick: () => onOpenLibrary({ subject: '线性代数' }) },
    { label: T.weekReviewed, value: data.reviewedThisWeek, hint: '本周复习动作', tone: 'success' },
    { label: T.weekAccuracy, value: rateText(data.correctRateThisWeek), hint: data.correctRateThisWeek === null ? '本周暂无记录' : '本周做对比例', tone: 'primary' }
  ];

  const maxReasonCount = Math.max(1, ...data.topErrorReasons.map((item) => item.count));

  return (
    <div className="page dashboard-page">
      <header className="dashboard-hero app-card">
        <div className="dashboard-hero-copy">
          <span className="eyebrow">{formatDate()}</span>
          <h1>{T.title}</h1>
          <p>{T.subtitle}</p>
          <small>{T.heroNote}</small>
        </div>
        <div className="dashboard-hero-actions">
          <button className="primary-button" type="button" onClick={onReview}><RotateCcw size={16} />{T.startReview}</button>
          <button className="secondary-button" type="button" onClick={onOpenKnowledgeMap}><BookMarked size={16} />{T.openMap}</button>
          <button className="ghost-button" type="button" onClick={onAdd}><PlusCircle size={16} />{T.addQuestion}</button>
        </div>
      </header>

      <section className="dashboard-action-grid" aria-label="今日行动">
        {actionMetrics.map((item) => {
          const Icon = item.icon;
          return (
            <button className={`dashboard-action-card tone-${item.tone}`} type="button" key={item.label} onClick={item.onClick}>
              <span className="metric-icon"><Icon size={20} /></span>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.hint}</small>
            </button>
          );
        })}
      </section>

      <section className="dashboard-stat-grid" aria-label="核心统计">
        {statMetrics.map((item) => (
          <button className={`dashboard-stat-card tone-${item.tone}`} type="button" key={item.label} onClick={item.onClick} disabled={!item.onClick}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.hint}</small>
          </button>
        ))}
      </section>

      {studyData ? (
        <section className="dashboard-study-panel section-card">
          <div className="dashboard-card-header">
            <div>
              <h2>备考监督</h2>
              <p>今日学习、任务完成和拖延风险。</p>
            </div>
            <Target size={20} />
          </div>
          <div className="dashboard-study-grid">
            <span>距离考试<strong>{studyData.daysUntilExam === null ? '未设置' : `${studyData.daysUntilExam} 天`}</strong></span>
            <span>今日学习<strong>{studyData.todayStudyMinutes} / {studyData.dailyTargetMinutes} 分钟</strong></span>
            <span>任务完成<strong>{studyData.todayTaskCompleted} / {studyData.todayTaskTotal}</strong></span>
            <span>严重拖延<strong>{studyData.criticalDelayedTasks.length} 项</strong></span>
            <span>进度风险<strong>{studyData.riskyMaterials.length} 项</strong></span>
          </div>
          <div className="dashboard-study-actions">
            <button className="primary-button compact-button" type="button" onClick={() => onOpenStudyPage?.('studySupervisor')}>进入备考监督</button>
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenStudyPage?.('dailyPlan')}>每日计划</button>
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenStudyPage?.('studyMaterials')}>资料进度</button>
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenStudyPage?.('focusTimer')}>专注计时</button>
          </div>
        </section>
      ) : null}

      <section className="dashboard-main-grid">
        <article className="dashboard-card dashboard-card-large section-card">
          <div className="dashboard-card-header"><div><h2>{T.suggested}</h2><p>{T.suggestedDesc}</p></div><Target size={20} /></div>
          {suggested.length ? (
            <div className="dashboard-knowledge-list">
              {suggested.map((point) => (
                <div className="dashboard-knowledge-item" key={point.node_id}>
                  <button type="button" onClick={() => onOpenKnowledgePoint(point.node_id)}>
                    <strong>{point.title}</strong>
                    <span>{point.category || '--'}</span>
                  </button>
                  <div className="dashboard-knowledge-meta">
                    <em className="badge-primary">{T.due} {point.due_questions}</em>
                    <em className="badge-warning">{T.weakLabel} {point.weak_questions}</em>
                    <em className={`badge-${masteryTone(point.average_mastery_score)}`}>{T.mastery} {masteryText(point.average_mastery_score)}</em>
                  </div>
                  <button className="primary-button compact-button" type="button" onClick={() => onReviewKnowledgePoint(point.node_id)}>{T.start}</button>
                </div>
              ))}
            </div>
          ) : <EmptyState title={T.noSuggestion} description={T.noSuggestionDesc} />}
        </article>

        <article className="dashboard-card section-card">
          <div className="dashboard-card-header"><h2>{T.weakPoints}</h2><TrendingDown size={20} /></div>
          {weakPoints.length ? (
            <div className="weak-point-list">
              {weakPoints.map((point) => {
                const score = point.average_mastery_score ?? 0;
                const tone = masteryTone(point.average_mastery_score);
                return (
                  <button type="button" key={point.node_id} onClick={() => onOpenKnowledgePoint(point.node_id)}>
                    <div><strong>{point.title}</strong><span>{T.weakLabel} {point.weak_questions}/{point.total_questions}</span></div>
                    <em>{masteryText(point.average_mastery_score)}</em>
                    <div className={`mastery-bar tone-${tone}`}><i style={{ width: `${Math.max(4, Math.min(100, score))}%` }} /></div>
                  </button>
                );
              })}
            </div>
          ) : <EmptyState title={T.noSuggestion} />}
        </article>

        <article className="dashboard-card section-card">
          <div className="dashboard-card-header"><h2>{T.topReasons}</h2><Library size={20} /></div>
          {data.topErrorReasons.length ? (
            <div className="reason-list-modern">
              {data.topErrorReasons.map((item, index) => (
                <button type="button" key={item.name} onClick={() => onOpenLibrary({ errorReason: item.name })}>
                  <span>{index + 1}</span>
                  <strong>{item.name}</strong>
                  <em>{item.count} {T.questionUnit}</em>
                  <div><i style={{ width: `${Math.max(8, Math.round((item.count / maxReasonCount) * 100))}%` }} /></div>
                </button>
              ))}
            </div>
          ) : <EmptyState title={T.noReasons} />}
        </article>

        <article className="dashboard-card section-card">
          <div className="dashboard-card-header"><h2>{T.weekly}</h2><CalendarDays size={20} /></div>
          {data.weeklyReviewSummary.total ? (
            <div className="weekly-review-grid">
              <span>{T.weekReviewed}<strong>{data.weeklyReviewSummary.total}</strong></span>
              <span>{T.correct}<strong>{data.weeklyReviewSummary.correct}</strong></span>
              <span>{T.wrong}<strong>{data.weeklyReviewSummary.wrong}</strong></span>
              <span>{T.noIdea}<strong>{data.weeklyReviewSummary.noIdea}</strong></span>
              <span className="wide">{T.weekAccuracy}<strong>{rateText(data.weeklyReviewSummary.correctRate)}</strong></span>
            </div>
          ) : <EmptyState title={T.noWeek} />}
        </article>
      </section>

      <section className="dashboard-quick-grid" aria-label={T.quick}>
        <button className="dashboard-action" type="button" onClick={onReview}><RotateCcw size={18} /><strong>{T.startReview}</strong><span>{T.due} {data.due}</span><ArrowRight size={16} /></button>
        <button className="dashboard-action" type="button" onClick={() => onOpenLibrary({ weakOnly: true })}><Flame size={18} /><strong>{T.reviewWeak}</strong><span>{T.weak} {data.weakQuestions}</span><ArrowRight size={16} /></button>
        <button className="dashboard-action" type="button" onClick={onOpenKnowledgeMap}><BookMarked size={18} /><strong>{T.openMap}</strong><span>教材页码与错题联动</span><ArrowRight size={16} /></button>
        <button className="dashboard-action" type="button" onClick={onOpenImport}><FileUp size={18} /><strong>{T.importNew}</strong><span>wrong_questions_import.zip</span><ArrowRight size={16} /></button>
      </section>

      <section className="dashboard-recent section-card">
        <div className="dashboard-card-header"><h2>{T.recent}</h2><CheckCircle2 size={20} /></div>
        {data.recent.length ? (
          <div className="recent-question-list">
            {data.recent.map((question) => (
              <button type="button" key={question.id} onClick={() => onOpenQuestion(question.id)}>
                <div>
                  <strong>{question.title || '未命名错题'}</strong>
                  <span>{question.subject || '高等数学'} · {question.category || '其他'} · {question.question_type || '其他'}</span>
                </div>
                <em className={`badge-${question.mastery_level === '已掌握' ? 'success' : question.mastery_level === '未掌握' ? 'danger' : 'primary'}`}>{question.mastery_level || '未掌握'}</em>
                <small>{formatShortDate(question.created_at)}</small>
              </button>
            ))}
          </div>
        ) : <EmptyState title={T.emptyRecent} description={T.emptyRecentDesc} />}
      </section>
    </div>
  );
}
