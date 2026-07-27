import { AlertTriangle, BarChart3, BookOpen, CheckCircle2, Target, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DashboardData, KnowledgePointReviewStats, Question, QuestionFilters, StatsData } from '../../shared/types';
import { isDue, isWeak } from '../../shared/questionFilters';
import { useToast } from '../components/Toast';

interface StatsPageProps {
  onOpenLibrary?: (filters?: QuestionFilters) => void;
  onOpenKnowledgePoint?: (nodeId: string) => void;
  onOpenQuestion?: (id: number) => void;
  onOpenImport?: () => void;
  onOpenReview?: () => void;
}

const MASTERY_ORDER = ['未掌握', '较弱', '一般', '较好', '已掌握'];

function percent(count: number, total: number) {
  if (!total) return 0;
  return Math.round((count / total) * 100);
}

function formatRate(value: number | null | undefined) {
  return value === null || value === undefined ? '暂无' : `${value}%`;
}

function masteryTone(level: string) {
  if (level === '未掌握') return 'danger';
  if (level === '较弱') return 'warning';
  if (level === '较好' || level === '已掌握') return 'success';
  return 'primary';
}

function scoreTone(score: number | null) {
  if (score === null) return 'muted';
  if (score <= 30) return 'danger';
  if (score <= 60) return 'warning';
  if (score <= 80) return 'primary';
  return 'success';
}

function topItems(items: Array<{ name: string; count: number }>, limit = 8) {
  return [...items].sort((a, b) => b.count - a.count).slice(0, limit);
}

function BarList({
  items,
  total,
  tone = 'primary',
  emptyText = '暂无数据',
  onItemClick
}: {
  items: Array<{ name: string; count: number }>;
  total: number;
  tone?: 'primary' | 'warning' | 'danger' | 'success';
  emptyText?: string;
  onItemClick?: (name: string) => void;
}) {
  if (!items.length) return <div className="stats-empty-state">{emptyText}</div>;
  const max = Math.max(...items.map((item) => item.count), 1);

  return (
    <div className="diagnosis-bar-list">
      {items.map((item) => {
        const width = Math.max(6, Math.round((item.count / max) * 100));
        const body = (
          <>
            <div className="diagnosis-bar-head">
              <strong title={item.name}>{item.name || '未分类'}</strong>
              <span>{item.count} 道 · {percent(item.count, total)}%</span>
            </div>
            <div className="diagnosis-bar-track">
              <i className={`tone-${tone}`} style={{ width: `${width}%` }} />
            </div>
          </>
        );
        return onItemClick ? (
          <button className="diagnosis-bar-row clickable" type="button" key={item.name} onClick={() => onItemClick(item.name)}>
            {body}
          </button>
        ) : (
          <div className="diagnosis-bar-row" key={item.name}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

function MiniBars({ items, tone = 'primary' }: { items: Array<{ date: string; count: number }>; tone?: 'primary' | 'success' | 'warning' }) {
  if (!items.length) return <div className="stats-empty-state">暂无记录</div>;
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <div className="mini-bars">
      {items.map((item) => (
        <div className="mini-bar-item" key={item.date}>
          <span>{item.count}</span>
          <i className={`tone-${tone}`} style={{ height: `${Math.max(8, (item.count / max) * 100)}%` }} />
          <em>{item.date.slice(5)}</em>
        </div>
      ))}
    </div>
  );
}

function masteryDistribution(questions: Question[]) {
  return MASTERY_ORDER.map((name) => ({ name, count: questions.filter((question) => question.mastery_level === name).length }));
}

function focusQuestions(questions: Question[]) {
  return [...questions]
    .filter((question) => isWeak(question) || isDue(question))
    .sort((a, b) => {
      const dueDiff = Number(isDue(b)) - Number(isDue(a));
      if (dueDiff) return dueDiff;
      const noIdeaDiff = b.no_idea_count - a.no_idea_count;
      if (noIdeaDiff) return noIdeaDiff;
      const wrongDiff = b.wrong_count - a.wrong_count;
      if (wrongDiff) return wrongDiff;
      return a.mastery_level.localeCompare(b.mastery_level);
    })
    .slice(0, 5);
}

export function StatsPage({ onOpenLibrary, onOpenKnowledgePoint, onOpenQuestion, onOpenImport, onOpenReview }: StatsPageProps) {
  const { toast } = useToast();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgePointReviewStats[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);

  useEffect(() => {
    Promise.all([
      window.api.getStats(),
      window.api.dashboard(),
      window.api.listKnowledgeReviewStats(),
      window.api.listQuestions({})
    ])
      .then(([nextStats, nextDashboard, nextKnowledgeStats, nextQuestions]) => {
        setStats(nextStats);
        setDashboard(nextDashboard);
        setKnowledgeStats(nextKnowledgeStats);
        setQuestions(nextQuestions);
      })
      .catch((error) => toast(error.message, 'error'));
  }, []);

  const masteryItems = useMemo(() => masteryDistribution(questions), [questions]);
  const weakKnowledge = useMemo(
    () =>
      [...knowledgeStats]
        .sort((a, b) => {
          const scoreA = a.average_mastery_score ?? 101;
          const scoreB = b.average_mastery_score ?? 101;
          if (scoreA !== scoreB) return scoreA - scoreB;
          if (a.weak_questions !== b.weak_questions) return b.weak_questions - a.weak_questions;
          return b.due_questions - a.due_questions;
        })
        .slice(0, 5),
    [knowledgeStats]
  );
  const focus = useMemo(() => focusQuestions(questions), [questions]);

  if (!stats || !dashboard) return <div className="page stats-page">加载中...</div>;

  const week = dashboard.weeklyReviewSummary;

  return (
    <div className="page stats-page">
      <header className="stats-hero app-card">
        <div>
          <span className="eyebrow">Learning Diagnosis</span>
          <h1>学习统计</h1>
          <p>查看错题分布、复习表现和薄弱环节，把下一步复习方向变清楚。</p>
        </div>
      </header>

      {stats.total === 0 ? (
        <section className="stats-empty-large">
          <h2>暂无统计数据</h2>
          <p>请先导入错题包，统计页会自动汇总章节、题型、错因和复习表现。</p>
          {onOpenImport ? <button className="primary-button" type="button" onClick={onOpenImport}>导入错题</button> : null}
        </section>
      ) : null}

      <section className="diagnosis-overview-grid">
        <article className="diagnosis-stat-card tone-primary"><span>总错题数</span><strong>{stats.total}</strong><em>当前错题库规模</em></article>
        <article className="diagnosis-stat-card tone-success"><span>已复习次数</span><strong>{week.total}</strong><em>本周复习记录</em></article>
        <article className="diagnosis-stat-card tone-primary"><span>今日待复习</span><strong>{dashboard.due}</strong><em>到期或新导入</em></article>
        <article className="diagnosis-stat-card tone-danger"><span>未掌握错题</span><strong>{dashboard.unmastered}</strong><em>需要优先处理</em></article>
        <article className="diagnosis-stat-card tone-warning"><span>薄弱错题</span><strong>{dashboard.weakQuestions}</strong><em>反复错或没思路</em></article>
        <article className="diagnosis-stat-card tone-success"><span>本周正确率</span><strong>{formatRate(dashboard.correctRateThisWeek)}</strong><em>基于复习记录</em></article>
      </section>

      <section className="diagnosis-grid">
        <article className="diagnosis-card">
          <div className="diagnosis-card-header"><div><h2><BarChart3 size={18} /> 章节分布</h2><p>错题主要集中在哪些章节</p></div></div>
          <BarList items={topItems(stats.byCategory)} total={stats.total} />
        </article>
        <article className="diagnosis-card">
          <div className="diagnosis-card-header"><div><h2><BookOpen size={18} /> 题型分布</h2><p>最容易出错的题型</p></div></div>
          <BarList items={topItems(stats.byType)} total={stats.total} />
        </article>
      </section>

      <section className="diagnosis-grid">
        <article className="diagnosis-card">
          <div className="diagnosis-card-header"><div><h2><AlertTriangle size={18} /> 高频错因</h2><p>点击错因可进入错题库筛选</p></div></div>
          <BarList items={topItems(stats.byReason)} total={stats.total} tone="warning" onItemClick={(name) => onOpenLibrary?.({ errorReason: name })} />
        </article>
        <article className="diagnosis-card">
          <div className="diagnosis-card-header"><div><h2><Target size={18} /> 掌握程度</h2><p>整体掌握状态一览</p></div></div>
          <div className="mastery-diagnosis-list">
            {masteryItems.map((item) => (
              <div className="mastery-diagnosis-row" key={item.name}>
                <span className={`badge badge-${masteryTone(item.name)}`}>{item.name}</span>
                <strong>{item.count} 道</strong>
                <em>{percent(item.count, stats.total)}%</em>
                <div className="diagnosis-bar-track"><i className={`tone-${masteryTone(item.name)}`} style={{ width: `${percent(item.count, stats.total)}%` }} /></div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="diagnosis-grid">
        <article className="diagnosis-card weak-knowledge-card">
          <div className="diagnosis-card-header"><div><h2><TrendingUp size={18} /> 薄弱知识点 Top 5</h2><p>按平均掌握度、薄弱数量和待复习数量排序</p></div></div>
          {weakKnowledge.length ? (
            <div className="weak-knowledge-list">
              {weakKnowledge.map((item) => {
                const tone = scoreTone(item.average_mastery_score);
                return (
                  <button className="weak-knowledge-row" type="button" key={item.node_id} onClick={() => onOpenKnowledgePoint?.(item.node_id)}>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.category || '未分类'}</span>
                    </div>
                    <div className="weak-knowledge-meta">
                      <em>薄弱 {item.weak_questions}</em>
                      <em>待复习 {item.due_questions}</em>
                      <em className={`tone-${tone}`}>掌握 {item.average_mastery_score === null ? '暂无' : `${item.average_mastery_score}%`}</em>
                    </div>
                    <div className="diagnosis-bar-track"><i className={`tone-${tone}`} style={{ width: `${item.average_mastery_score ?? 0}%` }} /></div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="stats-empty-state">暂无知识点统计。可以先导入知识地图并重新匹配错题知识点。</div>
          )}
        </article>

        <article className="diagnosis-card">
          <div className="diagnosis-card-header"><div><h2><CheckCircle2 size={18} /> 复习表现</h2><p>本周复习结果和最近 7 天节奏</p></div></div>
          <div className="weekly-review-grid">
            <span><strong>{week.total}</strong><em>总次数</em></span>
            <span className="tone-success"><strong>{week.correct}</strong><em>做对</em></span>
            <span className="tone-warning"><strong>{week.wrong}</strong><em>做错</em></span>
            <span className="tone-danger"><strong>{week.noIdea}</strong><em>没思路</em></span>
            <span className="tone-primary"><strong>{formatRate(week.correctRate)}</strong><em>正确率</em></span>
          </div>
          {week.total ? <MiniBars items={stats.recentReviews} tone="primary" /> : (
            <div className="stats-empty-state">
              暂无复习记录。{onOpenReview ? <button className="secondary-button compact-button" type="button" onClick={onOpenReview}>开始复习</button> : null}
            </div>
          )}
        </article>
      </section>

      <section className="diagnosis-card focus-question-card">
        <div className="diagnosis-card-header"><div><h2>重点关注错题</h2><p>优先处理没思路、做错较多、未掌握或已经到期的错题</p></div></div>
        {focus.length ? (
          <div className="focus-question-list">
            {focus.map((question) => (
              <button className="focus-question-row" type="button" key={question.id} onClick={() => onOpenQuestion?.(question.id)}>
                <div>
                  <strong>{question.title}</strong>
                  <span>{question.question_type} · {question.error_reason}</span>
                </div>
                <div className="focus-question-meta">
                  <em className={`badge badge-${masteryTone(question.mastery_level)}`}>{question.mastery_level}</em>
                  <em>做错 {question.wrong_count}</em>
                  <em>没思路 {question.no_idea_count}</em>
                  <em>{isDue(question) ? '今日待复习' : `下次 ${question.next_review_at?.slice(0, 10) || '未安排'}`}</em>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="stats-empty-state">暂无需要重点关注的错题。</div>
        )}
      </section>
    </div>
  );
}
