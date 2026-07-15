import { FileDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, DIFFICULTIES, ERROR_REASONS, MASTERY_LEVELS, MATH_SUBJECTS, QUESTION_TYPES, SOURCES } from '../../shared/options';
import type { PdfExportMode, PdfExportResult, Question, QuestionFilters } from '../../shared/types';
import { emptyFilters, hasActiveFilters, activeFilterBadges, computeQuestionSummary } from '../../shared/questionFilters';
import { EmptyState } from '../components/EmptyState';
import { useModal } from '../components/Modal';
import { QuestionCard } from '../components/QuestionCard';
import { useToast } from '../components/Toast';

interface LibraryPageProps {
  onOpenQuestion: (id: number) => void;
  onEditQuestion: (id: number) => void;
  initialFilters?: QuestionFilters | null;
}

const T = {
  all: '全部',
  title: '错题库',
  desc: '按分类、题型、错因、掌握程度管理所有错题',
  search: '搜索题目、内容、知识点...',
  category: '章节分类',
  subject: '学科',
  type: '题型分类',
  reason: '错误原因',
  mastery: '掌握程度',
  difficulty: '难度',
  source: '来源',
  tag: '标签',
  tagPlaceholder: '输入标签关键词',
  weak: '薄弱错题',
  weakOnly: '只看薄弱错题',
  sort: '排序',
  created: '添加时间',
  lastReview: '最近复习时间',
  reviewCount: '复习次数',
  clear: '清除筛选',
  resultCount: '当前结果',
  totalCount: '全部错题',
  unmastered: '未掌握',
  dueToday: '今日待复习',
  empty: '没有找到符合条件的错题',
  emptyDesc: '请尝试清除筛选或调整关键词。',
  noData: '暂无错题',
  noDataDesc: '你可以先导入 wrong_questions_import.zip 或手动添加错题。',
  currentFilter: '当前筛选',
  deleteConfirm: '确定删除这道错题吗？',
  deleteImagesConfirm: '是否同时删除对应图片文件？',
  exportPdf: '导出 PDF 错题集',
  exportCurrent: '导出当前筛选 PDF',
  exportTitle: 'PDF 错题集导出',
  exportScope: '导出范围',
  currentFilterResult: '当前筛选结果',
  allQuestions: '全部错题',
  exportMode: '版本类型',
  fullMode: '完整版',
  practiceMode: '练习版',
  fullDesc: '包含题目、错题原图、错误思考、解析、答案和复习状态。',
  practiceDesc: '只包含题目和错题原图，不显示解析和答案。',
  cancel: '取消',
  startExport: '开始导出',
  exporting: '正在生成 PDF，请稍候...',
  exportEmpty: '当前没有可导出的错题',
  exportSuccess: 'PDF 导出成功',
  openPdf: '打开 PDF',
  openFolder: '打开导出文件夹',
  pdfBeta: 'PDF 导出功能目前为 Beta，复杂公式或长图分页可能需要后续优化。'
};

function SelectFilter({ label, value, options, onChange }: { label: string; value?: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <select value={value || ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">{T.all}</option>
        {options.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  );
}

export function LibraryPage({ onOpenQuestion, onEditQuestion, initialFilters }: LibraryPageProps) {
  const { toast } = useToast();
  const modal = useModal();
  const [filters, setFilters] = useState<QuestionFilters>(emptyFilters);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [showExport, setShowExport] = useState(false);
  const [exportScope, setExportScope] = useState<'current' | 'all'>('current');
  const [exportMode, setExportMode] = useState<PdfExportMode>('full');
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<PdfExportResult | null>(null);

  async function load() {
    const [list, all] = await Promise.all([window.api.listQuestions(filters), window.api.listQuestions({})]);
    setQuestions(list);
    setTotalCount(all.length);
  }

  useEffect(() => {
    load().catch((error) => toast(error.message, 'error'));
  }, [filters]);

  useEffect(() => {
    if (!initialFilters) return;
    setFilters({ ...emptyFilters, ...initialFilters });
  }, [initialFilters]);

  const activeBadges = useMemo(() => activeFilterBadges(filters), [filters]);
  const active = hasActiveFilters(filters);
  const summary = useMemo(() => computeQuestionSummary(questions), [questions]);

  async function remove(id: number) {
    const confirmed = await modal.confirm({ title: '操作确认', message: T.deleteConfirm, confirmLabel: '删除', danger: true });
    if (!confirmed) return;
    const deleteImages = await modal.confirm({ title: '删除图片', message: T.deleteImagesConfirm, confirmLabel: '是' });
    await window.api.deleteQuestion(id, deleteImages);
    await load();
  }

  async function exportPdf() {
    const ids = questions.map((question) => question.id);
    if (exportScope === 'current' && !ids.length) {
      toast(T.exportEmpty, 'warning');
      return;
    }
    setExporting(true);
    setExportResult(null);
    try {
      const result = await window.api.exportQuestionsToPdf({
        scope: exportScope === 'all' ? 'all' : 'questionIds',
        mode: exportMode,
        questionIds: exportScope === 'current' ? ids : undefined,
        title: exportScope === 'all' ? T.allQuestions : T.currentFilterResult
      });
      setExportResult(result);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setExporting(false);
    }
  }

  function update<K extends keyof QuestionFilters>(key: K, value: QuestionFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function removeBadge(key: keyof QuestionFilters | 'weakOnly') {
    setFilters((current) => ({ ...current, [key]: key === 'weakOnly' ? false : '' }));
  }

  return (
    <div className="page library-page">
      <header className="library-hero app-card">
        <div>
          <span className="eyebrow">错题管理中心</span>
          <h1>{T.title}</h1>
          <p>{T.desc}</p>
        </div>
        <div className="header-actions">
          <button className="primary-button" type="button" onClick={() => setShowExport(true)}>
            <FileDown size={16} />
            {T.exportPdf}
          </button>
        </div>
      </header>

      <section className="library-summary-grid">
        <button className="library-summary-card tone-primary" type="button"><span>{T.resultCount}</span><strong>{questions.length}</strong><small>筛选结果</small></button>
        <button className="library-summary-card tone-muted" type="button"><span>{T.totalCount}</span><strong>{totalCount}</strong><small>本地题库</small></button>
        <button className="library-summary-card tone-danger" type="button" onClick={() => update('masteryLevel', '未掌握')}><span>{T.unmastered}</span><strong>{summary.unmastered}</strong><small>需要重点回看</small></button>
        <button className="library-summary-card tone-warning" type="button" onClick={() => update('weakOnly', true)}><span>{T.weak}</span><strong>{summary.weak}</strong><small>反复失分点</small></button>
        <button className="library-summary-card tone-primary" type="button"><span>{T.dueToday}</span><strong>{summary.due}</strong><small>已到期复习</small></button>
      </section>

      <section className="filter-panel library-filter-panel">
        <div className="library-filter-title"><SlidersHorizontal size={18} /><strong>筛选工具</strong><span>当前显示 {questions.length} 道错题</span></div>
        <label className="search-field library-search-field">
          <Search size={16} />
          <input value={filters.search || ''} onChange={(event) => update('search', event.target.value)} placeholder={T.search} />
        </label>
        <div className="filter-grid library-filter-grid">
          <SelectFilter label={T.subject} value={filters.subject} options={[...MATH_SUBJECTS]} onChange={(value) => update('subject', value)} />
          <SelectFilter label={T.category} value={filters.category} options={CATEGORIES} onChange={(value) => update('category', value)} />
          <SelectFilter label={T.type} value={filters.questionType} options={QUESTION_TYPES} onChange={(value) => update('questionType', value)} />
          <SelectFilter label={T.reason} value={filters.errorReason} options={ERROR_REASONS} onChange={(value) => update('errorReason', value)} />
          <SelectFilter label={T.mastery} value={filters.masteryLevel} options={[...MASTERY_LEVELS]} onChange={(value) => update('masteryLevel', value)} />
          <SelectFilter label={T.difficulty} value={filters.difficulty} options={[...DIFFICULTIES]} onChange={(value) => update('difficulty', value)} />
          <SelectFilter label={T.source} value={filters.source} options={SOURCES} onChange={(value) => update('source', value)} />
          <label>{T.tag}<input value={filters.tag || ''} onChange={(event) => update('tag', event.target.value)} placeholder={T.tagPlaceholder} /></label>
          <label>{T.sort}<select value={filters.sortBy} onChange={(event) => update('sortBy', event.target.value as QuestionFilters['sortBy'])}><option value="created_at">{T.created}</option><option value="last_reviewed_at">{T.lastReview}</option><option value="review_count">{T.reviewCount}</option></select></label>
        </div>
        <div className="library-filter-actions">
          <label className="toggle-line library-toggle"><input checked={Boolean(filters.weakOnly)} onChange={(event) => update('weakOnly', event.target.checked)} type="checkbox" />{T.weakOnly}</label>
          <button className="secondary-button compact-button" type="button" onClick={() => setShowExport(true)}><FileDown size={15} />{T.exportCurrent}</button>
          <button className="ghost-button compact-button clear-library-filters" type="button" onClick={() => setFilters(emptyFilters)}>{T.clear}</button>
        </div>
        {active ? (
          <div className="active-filter-bar">
            <strong>{T.currentFilter}</strong>
            <div className="active-filter-tags">
              {activeBadges.map((badge) => (
                <button type="button" key={badge.key} onClick={() => removeBadge(badge.key)}>
                  {badge.label}<X size={13} />
                </button>
              ))}
            </div>
            <button className="secondary-button compact-button" type="button" onClick={() => setFilters(emptyFilters)}>{T.clear}</button>
          </div>
        ) : null}
        <p className="export-beta-note library-beta-note">{T.pdfBeta}</p>
      </section>

      {showExport ? (
        <div className="modal-backdrop" role="presentation">
          <section className="export-modal">
            <div className="knowledge-card-header">
              <div><h2>{T.exportTitle}</h2><p>{exporting ? T.exporting : `${T.currentFilterResult}: ${questions.length} 题`}</p></div>
              <button className="secondary-button compact-button" type="button" onClick={() => setShowExport(false)} disabled={exporting}>{T.cancel}</button>
            </div>
            <div className="export-options">
              <label><span>{T.exportScope}</span><select value={exportScope} onChange={(event) => setExportScope(event.target.value as 'current' | 'all')} disabled={exporting}><option value="current">{T.currentFilterResult}</option><option value="all">{T.allQuestions}</option></select></label>
              <label><span>{T.exportMode}</span><select value={exportMode} onChange={(event) => setExportMode(event.target.value as PdfExportMode)} disabled={exporting}><option value="full">{T.fullMode}</option><option value="practice">{T.practiceMode}</option></select></label>
            </div>
            <div className="export-mode-note">{exportMode === 'full' ? T.fullDesc : T.practiceDesc}</div>
            <p className="export-beta-note">{T.pdfBeta}</p>
            {exportResult ? <div className="success-box export-result"><strong>{T.exportSuccess}</strong><span>{exportResult.filePath}</span><div className="header-actions"><button className="primary-button compact-button" type="button" onClick={() => window.api.openExportedPdf(exportResult.filePath)}>{T.openPdf}</button><button className="secondary-button compact-button" type="button" onClick={() => window.api.openExportsFolder()}>{T.openFolder}</button></div></div> : null}
            <button className="primary-button" type="button" onClick={exportPdf} disabled={exporting || (exportScope === 'current' && !questions.length)}>{exporting ? T.exporting : T.startExport}</button>
          </section>
        </div>
      ) : null}

      {questions.length ? (
        <section className="library-list-section">
          <div className="section-header"><h2>错题列表</h2><span className="badge-muted">{questions.length} 道</span></div>
          <div className="question-list">{questions.map((question) => <QuestionCard key={question.id} question={question} onOpen={onOpenQuestion} onEdit={onEditQuestion} onDelete={remove} />)}</div>
        </section>
      ) : (
        <section className="section-card library-empty-card">
          <EmptyState title={active || totalCount ? T.empty : T.noData} description={active || totalCount ? T.emptyDesc : T.noDataDesc} />
          {active ? <button className="primary-button" type="button" onClick={() => setFilters(emptyFilters)}>{T.clear}</button> : null}
        </section>
      )}
    </div>
  );
}
