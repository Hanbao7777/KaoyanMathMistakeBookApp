import { AlertTriangle, ArrowRight, BookOpenCheck, CalendarClock, CheckCircle2, Clock3, Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DailyReview, StudyQuality, StudyRiskLevel, StudySupervisorDashboard } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import type { PageKey } from '../components/Shell';
import { useToast } from '../components/Toast';

interface StudySupervisorPageProps {
  onNavigate: (page: PageKey) => void;
}

const riskText: Record<StudyRiskLevel, string> = {
  normal: '正常',
  warning: '注意',
  danger: '高压预警',
  critical: '严重拖延'
};

function todayText() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function minutesText(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  if (!rest) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

function unitOf(material: { custom_unit_name?: string | null; progress_unit: string }) {
  return material.custom_unit_name || material.progress_unit;
}

export function StudySupervisorPage({ onNavigate }: StudySupervisorPageProps) {
  const { toast } = useToast();
  const [data, setData] = useState<StudySupervisorDashboard | null>(null);
  const [review, setReview] = useState<DailyReview | null>(null);
  const [mood, setMood] = useState<StudyQuality>('一般');
  const [todaySummary, setTodaySummary] = useState('');
  const [mainProblem, setMainProblem] = useState('');
  const [tomorrowPriority, setTomorrowPriority] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const dashboard = await window.api.getStudySupervisorDashboard();
    const dailyReview = await window.api.getDailyReview(dashboard.today);
    setData(dashboard);
    setReview(dailyReview);
    setMood((dailyReview?.mood as StudyQuality) || '一般');
    setTodaySummary(dailyReview?.today_summary || '');
    setMainProblem(dailyReview?.main_problem || '');
    setTomorrowPriority(dailyReview?.tomorrow_priority || '');
  }

  useEffect(() => {
    load().catch((error) => toast(error.message, 'error'));
  }, []);

  async function saveReview() {
    if (!data) return;
    const saved = await window.api.saveDailyReview({
      review_date: data.today,
      mood,
      today_summary: todaySummary,
      main_problem: mainProblem,
      tomorrow_priority: tomorrowPriority
    });
    setReview(saved);
    setMessage('每日复盘已保存');
    await load();
  }

  if (!data) return <div className="page study-page">加载中...</div>;

  const overview = [
    { label: '考研倒计时', value: data.daysUntilExam === null ? '未设置' : `${data.daysUntilExam} 天`, tone: 'primary' },
    { label: '今日目标', value: minutesText(data.dailyTargetMinutes), tone: 'primary' },
    { label: '已学习', value: minutesText(data.todayStudyMinutes), tone: 'success' },
    { label: '任务完成', value: `${data.todayTaskCompleted}/${data.todayTaskTotal}`, tone: data.todayCompletionRate >= 80 ? 'success' : 'warning' },
    { label: '未完成任务', value: data.todayUnfinishedTaskCount, tone: data.todayUnfinishedTaskCount ? 'danger' : 'success' },
    { label: '监督状态', value: riskText[data.supervisionStatus], tone: data.supervisionStatus }
  ];

  return (
    <div className="page study-page">
      <header className="study-hero app-card">
        <div>
          <span className="eyebrow">{todayText()}</span>
          <h1>备考监督中心</h1>
          <p>把每日计划、资料进度、专注记录和复盘拢在一个驾驶舱里。</p>
        </div>
        <div className="header-actions">
          <button className="primary-button" type="button" onClick={() => onNavigate('dailyPlan')}><Target size={16} />每日计划</button>
          <button className="secondary-button" type="button" onClick={() => onNavigate('focusTimer')}><Clock3 size={16} />专注计时</button>
          <button className="secondary-button" type="button" onClick={() => onNavigate('studyMaterials')}><BookOpenCheck size={16} />资料进度</button>
        </div>
      </header>

      <section className="study-overview-grid">
        {overview.map((item) => (
          <article className={`study-stat-card tone-${item.tone}`} key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <section className="study-subject-grid">
        {data.subjectStats.map((subject) => (
          <article className={`study-subject-card tone-${subject.status}`} key={subject.subjectId}>
            <div className="study-card-head">
              <h2>{subject.subjectName}</h2>
              <em>{riskText[subject.status]}</em>
            </div>
            <div className="study-mini-grid">
              <span>本周学习<strong>{minutesText(subject.weekStudyMinutes)}</strong></span>
              <span>今日任务<strong>{subject.todayTaskCompleted}/{subject.todayTaskTotal}</strong></span>
              <span>未完成<strong>{subject.unfinishedTaskCount}</strong></span>
              <span>连续未学<strong>{subject.consecutiveNoStudyDays} 天</strong></span>
              <span>资料<strong>{subject.materialCount}</strong></span>
              <span>进度风险<strong>{subject.delayedMaterialCount}</strong></span>
            </div>
          </article>
        ))}
      </section>

      <section className="study-two-column">
        <article className="section-card study-card">
          <div className="dashboard-card-header"><div><h2>强度监督</h2><p>拖延和进度风险会在这里集中暴露。</p></div><AlertTriangle size={20} /></div>
          {data.delayedTasks.length || data.riskyMaterials.length || data.noStudySubjects.length ? (
            <div className="risk-list">
              {data.delayedTasks.slice(0, 6).map((task) => (
                <button type="button" key={task.id} onClick={() => onNavigate('dailyPlan')} className={`risk-row tone-${task.delayLevel || 'normal'}`}>
                  <strong>{task.title}</strong>
                  <span>{task.subject_name} · 已拖延 {task.defer_count} 天</span>
                  <ArrowRight size={16} />
                </button>
              ))}
              {data.riskyMaterials.slice(0, 6).map((material) => (
                <button type="button" key={material.id} onClick={() => onNavigate('studyMaterials')} className={`risk-row tone-${material.riskLevel || 'normal'}`}>
                  <strong>{material.name}</strong>
                  <span>{material.subject_name} · 落后 {material.lagAmount || 0} {unitOf(material)}</span>
                  <ArrowRight size={16} />
                </button>
              ))}
              {data.noStudySubjects.map((subject) => (
                <div className={`risk-row tone-${subject.status}`} key={subject.subjectId}>
                  <strong>{subject.subjectName} 已连续未学习</strong>
                  <span>{subject.consecutiveNoStudyDays} 天未记录专注学习</span>
                  <CalendarClock size={16} />
                </div>
              ))}
            </div>
          ) : <EmptyState title="暂无风险" description="当前没有拖延任务或资料进度风险。" />}
        </article>

        <article className="section-card study-card">
          <div className="dashboard-card-header"><div><h2>今日建议</h2><p>基于拖延、资料进度和错题复习的规则建议。</p></div><CheckCircle2 size={20} /></div>
          <ol className="suggestion-list">
            {data.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
          </ol>
          <div className="review-snapshot">
            <strong>数学今日待复习错题：{data.dueReviewCount} 道</strong>
            <span>如果数量较多，建议先去复习页清掉一轮。</span>
          </div>
        </article>
      </section>

      <section className="section-card daily-review-card">
        <div className="section-header compact">
          <div>
            <h2>每日复盘</h2>
            <p className="muted-text">复盘会记录今天的完成率、学习时长和你写下的问题。</p>
          </div>
          {review ? <span className="status-pill tone-success">已保存</span> : <span className="status-pill tone-muted">未保存</span>}
        </div>
        <div className="review-metric-row">
          <span>完成率<strong>{data.todayCompletionRate}%</strong></span>
          <span>学习时长<strong>{minutesText(data.todayStudyMinutes)}</strong></span>
          <span>完成任务<strong>{data.todayTaskCompleted}/{data.todayTaskTotal}</strong></span>
          <span>拖延任务<strong>{data.delayedTasks.length}</strong></span>
        </div>
        <div className="form-grid review-form-grid">
          <label>今日状态
            <select value={mood} onChange={(event) => setMood(event.target.value as StudyQuality)}>
              {['很差', '一般', '良好', '很好'].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>今天完成得怎么样？
            <textarea rows={3} value={todaySummary} onChange={(event) => setTodaySummary(event.target.value)} />
          </label>
          <label>今天最大问题是什么？
            <textarea rows={3} value={mainProblem} onChange={(event) => setMainProblem(event.target.value)} />
          </label>
          <label>明天最重要的一件事
            <textarea rows={3} value={tomorrowPriority} onChange={(event) => setTomorrowPriority(event.target.value)} />
          </label>
        </div>
        <button className="primary-button" type="button" onClick={saveReview}>保存复盘</button>
      </section>

      {message ? <div className="success-box">{message}</div> : null}
    </div>
  );
}
