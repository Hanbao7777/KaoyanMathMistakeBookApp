import { CalendarClock, Edit3, Eye, Image as ImageIcon, Trash2 } from 'lucide-react';
import type { Question } from '../../shared/types';
import { formatDate } from '../utils/date';
import { FormulaText } from './FormulaText';

interface QuestionCardProps {
  question: Question;
  onOpen: (id: number) => void;
  onEdit?: (id: number) => void;
  onDelete?: (id: number) => void;
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

function isDue(value?: string | null) {
  if (!value) return false;
  return value.slice(0, 10) <= new Date().toISOString().slice(0, 10);
}

export function QuestionCard({ question, onOpen, onEdit, onDelete }: QuestionCardProps) {
  const knowledge = question.knowledge_points?.map((point) => point.title).filter(Boolean) ?? [];
  const due = isDue(question.next_review_at);

  return (
    <article className="question-card library-question-card" onClick={() => onOpen(question.id)}>
      <div className="card-main">
        <div className="question-card-body">
          <div className="question-card-title-row">
            <h3>{question.title || '未命名错题'}</h3>
            {due ? <span className="badge-primary">今日待复习</span> : null}
          </div>
          <p>
            <FormulaText text={question.content || question.answer || question.correct_solution || '暂无题目内容'} compact />
          </p>
          <div className="meta-grid question-meta-grid">
            <span className="badge-primary">{question.category || '其他'}</span>
            <span className="badge-primary">{question.question_type || '其他'}</span>
            <span className="badge-warning">{question.error_reason || '其他'}</span>
            <span className={masteryBadge(question.mastery_level)}>{question.mastery_level || '未掌握'}</span>
            <span className={difficultyBadge(question.difficulty)}>{question.difficulty || '中等'}</span>
            <span className="badge-muted"><ImageIcon size={13} />{question.question_images.length ? '有原图' : '无原图'}</span>
          </div>
          {knowledge.length ? (
            <div className="tag-row knowledge-chip-row">
              {knowledge.slice(0, 4).map((item) => <span key={item} className="tag">{item}</span>)}
              {knowledge.length > 4 ? <span className="tag">+{knowledge.length - 4}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="question-card-side">
          <span><CalendarClock size={14} />{question.next_review_at ? formatDate(question.next_review_at) : '暂无计划'}</span>
          <small>添加 {formatDate(question.created_at)}</small>
          <small>复习 {formatDate(question.last_reviewed_at)}</small>
          <button className="secondary-button compact-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen(question.id); }}>
            <Eye size={15} />查看详情
          </button>
        </div>
        <div className="card-actions" onClick={(event) => event.stopPropagation()}>
          {onEdit ? (
            <button className="icon-button" type="button" title="编辑错题" onClick={() => onEdit(question.id)}>
              <Edit3 size={16} />
            </button>
          ) : null}
          {onDelete ? (
            <button className="icon-button danger" type="button" title="删除错题" onClick={() => onDelete(question.id)}>
              <Trash2 size={16} />
            </button>
          ) : null}
        </div>
      </div>
      {question.tags.length ? (
        <div className="tag-row">
          {question.tags.map((tag) => <span key={tag} className="tag">#{tag}</span>)}
        </div>
      ) : null}
    </article>
  );
}
