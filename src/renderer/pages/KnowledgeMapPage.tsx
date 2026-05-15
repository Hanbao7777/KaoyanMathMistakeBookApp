import '@xyflow/react/dist/style.css';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Link2,
  Network,
  RefreshCw,
  Search
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MATH_SUBJECTS } from '../../shared/options';
import type { KnowledgePointDetail, KnowledgePointReviewStats, KnowledgePointTreeNode, TextbookPdfStatus } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import { FormulaText } from '../components/FormulaText';

interface KnowledgeMapPageProps {
  selectedNodeId?: string | null;
  onOpenQuestion: (id: number) => void;
  onReviewKnowledgePoint?: (nodeId: string) => void;
}

type KnowledgeView = 'directory' | 'graph';

interface KnowledgeFlowNodeData extends Record<string, unknown> {
  node: KnowledgePointTreeNode;
  stats?: KnowledgePointReviewStats;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}

type KnowledgeFlowNode = Node<KnowledgeFlowNodeData, 'knowledgeNode'>;

function hasPage(page?: number | null) {
  return typeof page === 'number' && Number.isFinite(page) && page > 0;
}

function formatPdfPage(page?: number | null) {
  return hasPage(page) ? `PDF 第 ${page} 页` : 'PDF 页码：需人工确认';
}

function formatBookPage(page?: number | null) {
  return hasPage(page) ? `书本第 ${page} 页` : '书本页码：需人工确认';
}

function parseList(value?: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    // Legacy rows may store comma-separated text instead of JSON arrays.
  }
  return value
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectNodeIds(nodes: KnowledgePointTreeNode[], onlyWithChildren = false) {
  const ids: string[] = [];
  const visit = (node: KnowledgePointTreeNode) => {
    if (!onlyWithChildren || node.children.length) ids.push(node.node_id);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return ids;
}

function countNodes(nodes: KnowledgePointTreeNode[]) {
  let count = 0;
  const visit = (node: KnowledgePointTreeNode) => {
    count += 1;
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return count;
}

function countNodesWithQuestions(nodes: KnowledgePointTreeNode[]) {
  let count = 0;
  const visit = (node: KnowledgePointTreeNode) => {
    if (node.questionCount > 0) count += 1;
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return count;
}

function firstNodeId(nodes: KnowledgePointTreeNode[]): string | null {
  return nodes[0]?.node_id ?? null;
}

function searchableText(node: KnowledgePointTreeNode) {
  return [
    node.subject,
    node.title,
    node.category,
    ...parseList(node.tags),
    ...parseList(node.common_question_types)
  ]
    .join(' ')
    .toLowerCase();
}

function filterKnowledgeTree(nodes: KnowledgePointTreeNode[], query: string, onlyWithQuestions: boolean, subject: string): KnowledgePointTreeNode[] {
  const keyword = query.trim().toLowerCase();

  return nodes.flatMap((node) => {
    const children = filterKnowledgeTree(node.children, query, onlyWithQuestions, subject);
    const matchesSubject = !subject || (node.subject || '高等数学') === subject || children.length > 0;
    const matchesSearch = !keyword || searchableText(node).includes(keyword) || children.length > 0;
    const matchesQuestions = !onlyWithQuestions || node.questionCount > 0 || children.length > 0;

    if (!matchesSubject || !matchesSearch || !matchesQuestions) return [];
    return [{ ...node, children }];
  });
}

function getQuestionSeverity(count: number) {
  if (count >= 10) return 'high';
  if (count >= 5) return 'medium';
  if (count > 0) return 'low';
  return 'none';
}

function getMasteryTone(score?: number | null) {
  if (score === null || score === undefined) return 'muted';
  if (score <= 30) return 'danger';
  if (score <= 60) return 'warning';
  if (score <= 80) return 'primary';
  return 'success';
}

function formatMastery(score?: number | null) {
  return score === null || score === undefined ? '暂无' : `${score}%`;
}

function summarizeReviewStats(stats: KnowledgePointReviewStats[]) {
  const withQuestions = stats.filter((item) => item.total_questions > 0);
  const due = withQuestions.filter((item) => item.due_questions > 0).length;
  const weak = withQuestions.filter((item) => item.weak_questions > 0).length;
  const scored = withQuestions.filter((item) => item.average_mastery_score !== null);
  const average = scored.length
    ? Math.round(scored.reduce((sum, item) => sum + (item.average_mastery_score || 0), 0) / scored.length)
    : null;
  return { withQuestions: withQuestions.length, due, weak, average };
}

function buildFlowElements(
  nodes: KnowledgePointTreeNode[],
  selected: string | null,
  statsByNode: Map<string, KnowledgePointReviewStats>,
  onSelect: (nodeId: string) => void
): { nodes: KnowledgeFlowNode[]; edges: Edge[] } {
  const flowNodes: KnowledgeFlowNode[] = [];
  const edges: Edge[] = [];
  const xGap = 310;
  const yGap = 112;
  let cursor = 0;

  const visit = (node: KnowledgePointTreeNode, depth: number): number => {
    const childYs = node.children.map((child) => visit(child, depth + 1));
    const y = childYs.length ? (Math.min(...childYs) + Math.max(...childYs)) / 2 : cursor++ * yGap;
    const x = depth * xGap;

    flowNodes.push({
      id: node.node_id,
      type: 'knowledgeNode',
      position: { x, y },
      data: { node, stats: statsByNode.get(node.node_id), selected: selected === node.node_id, onSelect }
    });

    node.children.forEach((child) => {
      edges.push({
        id: `${node.node_id}-${child.node_id}`,
        source: node.node_id,
        target: child.node_id,
        type: 'smoothstep',
        style: { stroke: '#b9c9da', strokeWidth: 1.6 }
      });
    });

    return y;
  };

  nodes.forEach((node, index) => {
    if (index > 0) cursor += 1;
    visit(node, 0);
  });

  return { nodes: flowNodes, edges };
}

function KnowledgeFlowNodeView(props: NodeProps) {
  const data = props.data as unknown as KnowledgeFlowNodeData;
  const node = data.node;
  const stats = data.stats;
  const severity = stats?.weak_questions ? 'high' : stats?.due_questions ? 'medium' : getQuestionSeverity(node.questionCount);
  const masteryTone = getMasteryTone(stats?.average_mastery_score);

  return (
    <button
      className={`knowledge-flow-node severity-${severity} ${data.selected ? 'selected' : ''}`}
      type="button"
      onClick={() => data.onSelect(node.node_id)}
    >
      <Handle className="flow-handle" type="target" position={Position.Left} />
      <strong title={node.title}>{node.title}</strong>
      <div className="flow-node-meta">
        <span>{node.subject || '高等数学'}</span>
        <span className={node.questionCount ? 'has-question' : ''}>错题 {node.questionCount}</span>
        {stats?.due_questions ? <span className="due-chip">待复习 {stats.due_questions}</span> : null}
        {stats?.weak_questions ? <span className="weak-chip">薄弱 {stats.weak_questions}</span> : null}
        {hasPage(node.pdf_page) ? <span>PDF {node.pdf_page}</span> : <span>PDF 待确认</span>}
        <span className={`mastery-chip tone-${masteryTone}`}>掌握 {formatMastery(stats?.average_mastery_score)}</span>
      </div>
      {node.category ? <small>{node.category}</small> : null}
      <Handle className="flow-handle" type="source" position={Position.Right} />
    </button>
  );
}

function KnowledgeTree({
  nodes,
  selected,
  expanded,
  statsByNode,
  onToggle,
  onSelect
}: {
  nodes: KnowledgePointTreeNode[];
  selected: string | null;
  expanded: Set<string>;
  statsByNode: Map<string, KnowledgePointReviewStats>;
  onToggle: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <div className="knowledge-tree-list">
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.node_id);
        const hasQuestions = node.questionCount > 0;
        const stats = statsByNode.get(node.node_id);
        return (
          <div className={`knowledge-tree-item level-${Math.min(node.level || 1, 4)}`} key={node.node_id}>
            <div className={`knowledge-tree-row ${selected === node.node_id ? 'active' : ''}`}>
              <button
                className="icon-button tree-toggle"
                type="button"
                onClick={() => (hasChildren ? onToggle(node.node_id) : onSelect(node.node_id))}
                title={hasChildren ? '展开或收起' : '选择知识点'}
              >
                {hasChildren ? isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : <BookOpen size={14} />}
              </button>
              <button className="tree-title" type="button" onClick={() => onSelect(node.node_id)}>
                <span title={node.title}>{node.title}</span>
                <div className="tree-node-meta">
                  <em className="pdf-badge">{node.subject || '高等数学'}</em>
                  {hasQuestions ? <em className="question-badge">错题 {node.questionCount}</em> : null}
                  {stats?.due_questions ? <em className="due-badge">待复习 {stats.due_questions}</em> : null}
                  {stats?.weak_questions ? <em className="weak-badge">薄弱 {stats.weak_questions}</em> : null}
                  {hasPage(node.pdf_page) ? <em className="pdf-badge">PDF {node.pdf_page}</em> : null}
                </div>
              </button>
            </div>
            {hasChildren && isExpanded ? (
              <div className="knowledge-tree-children">
                <KnowledgeTree
                  nodes={node.children}
                  selected={selected}
                  expanded={expanded}
                  statsByNode={statsByNode}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TagList({ items, variant = 'neutral' }: { items: string[]; variant?: 'neutral' | 'reason' }) {
  if (!items.length) return <p className="muted-text">暂无</p>;
  return (
    <div className="tag-row">
      {items.map((item) => (
        <span className={`tag ${variant === 'reason' ? 'tag-warning' : ''}`} key={item}>
          {item}
        </span>
      ))}
    </div>
  );
}

function PdfStatusPanel({ status, onBind }: { status: TextbookPdfStatus | null; onBind: () => void }) {
  const [showDetails, setShowDetails] = useState(false);

  if (!status) {
    return (
      <section className="knowledge-card pdf-status-card">
        <div className="knowledge-card-header">
          <h2>教材 PDF 状态</h2>
          <button className="secondary-button" type="button" onClick={onBind}>
            <Link2 size={16} />
            绑定教材 PDF
          </button>
        </div>
        <p className="muted-text">当前知识点未关联教材。</p>
      </section>
    );
  }

  return (
    <section className="knowledge-card pdf-status-card">
      <div className="knowledge-card-header">
        <h2>教材 PDF 状态</h2>
        <button className="secondary-button" type="button" onClick={onBind}>
          <Link2 size={16} />
          绑定教材 PDF
        </button>
      </div>

      <div className="pdf-status-summary">
        <span>教材文件：{status.fileName || '未设置'}</span>
        <span>文件状态：{status.exists ? '已找到' : '未找到'}</span>
        <span>教材目录：{status.textbooksDir}</span>
        <span>
          当前页码：{formatPdfPage(status.pdfPage)} / {formatBookPage(status.bookPage)}
        </span>
      </div>

      {!status.exists ? (
        <div className="warning-box">
          未找到教材 PDF。请将 PDF 放入：{status.textbooksDir}
          <br />
          并确保文件名与数据库中的 file_name 完全一致，或点击“绑定教材 PDF”手动选择文件。
        </div>
      ) : null}

      <button className="secondary-button compact-button" type="button" onClick={() => setShowDetails((value) => !value)}>
        {showDetails ? '隐藏详细路径' : '显示详细路径'}
      </button>

      {showDetails ? (
        <div className="path-list">
          <span>教材名称：{status.textbookTitle || '未设置'}</span>
          <span>数据库 file_name：{status.fileName || '未设置'}</span>
          <span>数据库 file_path：{status.filePath || '未设置'}</span>
          <span>当前查找路径：{status.lookupPath || '未设置'}</span>
          <span>实际打开路径：{status.resolvedPath || '未设置'}</span>
        </div>
      ) : null}
    </section>
  );
}

function KnowledgeDetailPanel({
  detail,
  loading,
  copyMessage,
  onCopyPdfPage,
  onOpenTextbook,
  onBindPdf,
  onOpenQuestion,
  onReviewKnowledgePoint
}: {
  detail: KnowledgePointDetail | null;
  loading: boolean;
  copyMessage: string;
  onCopyPdfPage: () => void;
  onOpenTextbook: () => void;
  onBindPdf: () => void;
  onOpenQuestion: (id: number) => void;
  onReviewKnowledgePoint?: (nodeId: string) => void;
}) {
  const jumpTip = detail ? `${formatPdfPage(detail.pdf_page)} / ${formatBookPage(detail.book_page)}` : '';
  const masteryTone = getMasteryTone(detail?.reviewStats?.average_mastery_score);

  if (loading) return <div className="knowledge-card">加载中...</div>;
  if (!detail) return <EmptyState title="请选择知识点查看详情" />;

  return (
    <>
      <section className="knowledge-card overview-card">
        <div className="knowledge-card-header">
          <div>
            <span className="knowledge-card-kicker">知识点概览</span>
            <h2>{detail.title}</h2>
            <p>学科：{detail.subject || '高等数学'} · 教材：{detail.textbook?.title || '暂无'}</p>
            <p>{detail.category || '未分类'} · level {detail.level || 1}</p>
          </div>
          <span className="large-count">{detail.questionCount} 道相关错题</span>
        </div>
        <TagList items={detail.tagList} />
        <div className="knowledge-summary">
          <FormulaText text={detail.summary || '暂无知识点说明'} />
        </div>
      </section>

      <section className="knowledge-card review-status-card">
        <div className="knowledge-card-header">
          <div>
            <span className="knowledge-card-kicker">复习状态</span>
            <h2>错题掌握情况</h2>
          </div>
          <span className={`mastery-pill tone-${masteryTone}`}>平均掌握度 {formatMastery(detail.reviewStats?.average_mastery_score)}</span>
        </div>
        {detail.reviewStats ? (
          <div className="knowledge-review-stats">
            <span>{'\u76f8\u5173\u9519\u9898'}<strong>{detail.reviewStats.total_questions}</strong></span>
            <span>{'\u5f85\u590d\u4e60'}<strong>{detail.reviewStats.due_questions}</strong></span>
            <span>{'\u8584\u5f31'}<strong>{detail.reviewStats.weak_questions}</strong></span>
            <span>{'\u5e73\u5747\u638c\u63e1\u5ea6'}<strong>{detail.reviewStats.average_mastery_score === null ? '--' : detail.reviewStats.average_mastery_score + '%'}</strong></span>
          </div>
        ) : (
          <p className="muted-text">暂无关联错题。</p>
        )}
        <div className="knowledge-mastery-bar">
          <i className={`tone-${masteryTone}`} style={{ width: `${detail.reviewStats?.average_mastery_score ?? 0}%` }} />
        </div>
        <button
          className="primary-button knowledge-review-entry"
          type="button"
          onClick={() => onReviewKnowledgePoint?.(detail.node_id)}
          disabled={!onReviewKnowledgePoint || !detail.reviewStats?.total_questions}
        >
          {'\u590d\u4e60\u8be5\u77e5\u8bc6\u70b9\u9519\u9898'}
        </button>
      </section>

      <section className="knowledge-card locator-card">
        <div className="knowledge-card-header">
          <div>
            <span className="knowledge-card-kicker">教材定位</span>
            <h2>教材定位</h2>
            <p>外部 PDF 阅读器可能不支持自动跳页，请按页码手动定位。</p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" type="button" onClick={onCopyPdfPage} disabled={!hasPage(detail.pdf_page)}>
              <Copy size={16} />
              复制 PDF 页码
            </button>
            <button className="primary-button" type="button" onClick={onOpenTextbook}>
              <ExternalLink size={16} />
              打开教材 PDF（手动跳页）
            </button>
          </div>
        </div>
        <div className="page-jump-card">
          <strong>{jumpTip}</strong>
          <span>
            {hasPage(detail.pdf_page)
              ? `如果未自动跳转，请打开 PDF 后手动跳转到 PDF 第 ${detail.pdf_page} 页。`
              : 'PDF 页码尚未确认，请根据书本页码或教材目录人工定位。'}
          </span>
          {copyMessage ? <em>{copyMessage}</em> : null}
        </div>
      </section>

      <section className="knowledge-card study-card">
        <span className="knowledge-card-kicker">题型与错因</span>
        <h2>复习信息</h2>
        <div className="study-grid">
          <div>
            <h3>常见题型</h3>
            <TagList items={detail.commonQuestionTypes} />
          </div>
          <div>
            <h3>常见错因</h3>
            <TagList items={detail.commonErrorReasons} variant="reason" />
          </div>
        </div>
      </section>

      <section className="knowledge-card related-card">
        <div className="knowledge-card-header">
          <div>
            <span className="knowledge-card-kicker">错题联动</span>
            <h2>相关错题</h2>
          </div>
          <span className="muted-text">{detail.relatedQuestions.length} 道</span>
        </div>
        {detail.relatedQuestions.length ? (
          <div className="related-question-grid">
            {detail.relatedQuestions.map((question) => (
              <button className="related-question" type="button" key={question.id} onClick={() => onOpenQuestion(question.id)}>
                <strong>{question.title}</strong>
                <span>{question.subject || '高等数学'} · {question.category} · {question.question_type}</span>
                <div className="question-chip-row">
                  <em>{question.mastery_level}</em>
                  <em className="reason-chip">{question.error_reason}</em>
                  {question.source ? <em>{question.source}</em> : null}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState title="暂无关联错题" description="可以点击“重新匹配已有错题知识点”进行自动匹配。" />
        )}
      </section>

      <PdfStatusPanel status={detail.pdfStatus} onBind={onBindPdf} />
    </>
  );
}

function KnowledgeFlowCanvas({
  flowNodes,
  flowEdges,
  onSelect
}: {
  flowNodes: KnowledgeFlowNode[];
  flowEdges: Edge[];
  onSelect: (nodeId: string) => void;
}) {
  const { fitView } = useReactFlow();
  const nodeTypes = useMemo(() => ({ knowledgeNode: KnowledgeFlowNodeView }), []);

  useEffect(() => {
    const timer = window.setTimeout(() => fitView({ padding: 0.2, duration: 250 }), 80);
    return () => window.clearTimeout(timer);
  }, [fitView, flowNodes, flowEdges]);

  return (
    <>
      <div className="flow-toolbar">
        <button className="secondary-button compact-button" type="button" onClick={() => fitView({ padding: 0.22, duration: 250 })}>
          适配视图
        </button>
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.25}
        maxZoom={1.6}
      >
        <Background color="#d8e2ec" gap={22} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as unknown as KnowledgeFlowNodeData;
            const severity = getQuestionSeverity(data?.node?.questionCount || 0);
            if (severity === 'high') return '#fecaca';
            if (severity === 'medium') return '#fed7aa';
            if (severity === 'low') return '#bfdbfe';
            return '#e5e7eb';
          }}
        />
      </ReactFlow>
    </>
  );
}

export function KnowledgeMapPage({ selectedNodeId, onOpenQuestion, onReviewKnowledgePoint }: KnowledgeMapPageProps) {
  const [tree, setTree] = useState<KnowledgePointTreeNode[]>([]);
  const [selected, setSelected] = useState<string | null>(selectedNodeId || null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<KnowledgePointDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [search, setSearch] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [onlyWithQuestions, setOnlyWithQuestions] = useState(false);
  const [view, setView] = useState<KnowledgeView>('directory');
  const [reviewStats, setReviewStats] = useState<KnowledgePointReviewStats[]>([]);

  const visibleTree = useMemo(() => filterKnowledgeTree(tree, search, onlyWithQuestions, subjectFilter), [tree, search, onlyWithQuestions, subjectFilter]);
  const totalNodeCount = useMemo(() => countNodes(visibleTree), [visibleTree]);
  const questionNodeCount = useMemo(() => countNodesWithQuestions(visibleTree), [visibleTree]);
  const statsByNode = useMemo(() => new Map(reviewStats.map((item) => [item.node_id, item])), [reviewStats]);
  const filteredReviewStats = useMemo(() => subjectFilter ? reviewStats.filter((item) => (item.subject || '高等数学') === subjectFilter) : reviewStats, [reviewStats, subjectFilter]);
  const reviewSummary = useMemo(() => summarizeReviewStats(filteredReviewStats), [filteredReviewStats]);
  const currentTextbookName = detail?.textbook?.title || detail?.pdfStatus?.textbookTitle || '未选择教材';
  const flowElements = useMemo(() => buildFlowElements(visibleTree, selected, statsByNode, setSelected), [visibleTree, selected, statsByNode]);

  async function loadTree(nextSelected?: string | null) {
    const [nodes, stats] = await Promise.all([window.api.listKnowledgeTree(), window.api.listKnowledgeReviewStats()]);
    setTree(nodes);
    setReviewStats(stats);
    const allExpandableIds = collectNodeIds(nodes, true);
    setExpanded((current) => {
      const next = new Set(current);
      if (nodes.length < 80) allExpandableIds.forEach((id) => next.add(id));
      else if (nextSelected) next.add(nextSelected);
      return next;
    });
    setSelected(nextSelected || selected || firstNodeId(nodes));
  }

  async function loadDetail(nodeId: string) {
    setLoading(true);
    try {
      setDetail(await window.api.getKnowledgeDetail(nodeId));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTree(selectedNodeId).catch((error) => alert(error.message));
  }, [selectedNodeId]);

  useEffect(() => {
    setCopyMessage('');
    if (!selected) {
      setDetail(null);
      return;
    }
    loadDetail(selected).catch((error) => alert(error.message));
  }, [selected]);

  useEffect(() => {
    if (!search.trim()) return;
    setExpanded(new Set(collectNodeIds(visibleTree, true)));
  }, [search, visibleTree]);

  useEffect(() => {
    const visibleIds = collectNodeIds(visibleTree);
    if (visibleIds.length && (!selected || !visibleIds.includes(selected))) {
      setSelected(firstNodeId(visibleTree));
    }
    if (!visibleIds.length) setSelected(null);
  }, [visibleTree, selected]);

  async function openTextbook() {
    if (!detail) return;
    try {
      const result = await window.api.openTextbookPage(detail.node_id);
      alert(result.message);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      await loadDetail(detail.node_id);
    }
  }

  async function bindPdf() {
    if (!detail) return;
    try {
      const result = await window.api.bindTextbookPdf(detail.node_id);
      if (result?.bound) {
        alert('教材 PDF 已绑定。');
        await loadDetail(detail.node_id);
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyPdfPage() {
    if (!hasPage(detail?.pdf_page)) {
      alert('PDF 页码尚未确认，无法复制。');
      return;
    }
    try {
      await navigator.clipboard.writeText(String(detail?.pdf_page));
      setCopyMessage(`已复制 PDF 页码：${detail?.pdf_page}`);
      window.setTimeout(() => setCopyMessage(''), 2400);
    } catch {
      alert('复制失败。当前系统或运行环境不支持剪贴板权限。');
    }
  }

  async function rematch() {
    if (!confirm('确定重新匹配已有错题知识点吗？已有关系不会重复插入。')) return;
    try {
      const result = await window.api.rematchKnowledgePoints();
      alert(
        `匹配完成：扫描 ${result.scannedQuestions} 道错题，新增关联 ${result.insertedCount} 条，已存在跳过 ${result.skippedExistingCount} 条，未匹配 ${result.unmatchedQuestions} 道。`
      );
      await loadTree(selected);
      setReviewStats(await window.api.listKnowledgeReviewStats());
      if (selected) await loadDetail(selected);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  function toggle(nodeId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(collectNodeIds(visibleTree, true)));
  }

  function collapseAll() {
    const topExpandable = visibleTree.filter((node) => node.children.length).map((node) => node.node_id);
    setExpanded(new Set(topExpandable));
  }

  const detailPanel = (
    <KnowledgeDetailPanel
      detail={detail}
      loading={loading}
      copyMessage={copyMessage}
      onCopyPdfPage={copyPdfPage}
      onOpenTextbook={openTextbook}
      onBindPdf={bindPdf}
      onOpenQuestion={onOpenQuestion}
      onReviewKnowledgePoint={onReviewKnowledgePoint}
    />
  );

  return (
    <div className="page knowledge-map-page">
      <header className="knowledge-hero">
        <div>
          <span className="eyebrow">Knowledge Map V2</span>
          <h1>知识地图</h1>
          <p>按教材知识点连接错题、复习状态与教材页码。</p>
          <div className="hero-meta">
            <span>当前教材：{currentTextbookName}</span>
            <span>知识点 {totalNodeCount}</span>
            <span>有错题 {questionNodeCount}</span>
          </div>
        </div>
        <div className="knowledge-hero-actions">
          <div className="knowledge-view-tabs">
            <button className={view === 'directory' ? 'active' : ''} type="button" onClick={() => setView('directory')}>
              <BookOpen size={16} />
              目录视图
            </button>
            <button className={view === 'graph' ? 'active' : ''} type="button" onClick={() => setView('graph')}>
              <Network size={16} />
              图谱视图
            </button>
          </div>
          <button className="secondary-button" type="button" onClick={rematch}>
            <RefreshCw size={16} />
            重新匹配错题知识点
          </button>
        </div>
      </header>

      <section className="knowledge-stat-grid">
        <div className="knowledge-stat-card tone-primary">
          <span>知识点总数</span>
          <strong>{totalNodeCount}</strong>
          <em>教材目录节点</em>
        </div>
        <div className="knowledge-stat-card tone-info">
          <span>有错题知识点</span>
          <strong>{reviewSummary.withQuestions || questionNodeCount}</strong>
          <em>已建立错题关联</em>
        </div>
        <div className="knowledge-stat-card tone-warning">
          <span>今日待复习</span>
          <strong>{reviewSummary.due}</strong>
          <em>知识点有到期错题</em>
        </div>
        <div className="knowledge-stat-card tone-danger">
          <span>薄弱知识点</span>
          <strong>{reviewSummary.weak}</strong>
          <em>存在薄弱或错题</em>
        </div>
        <div className="knowledge-stat-card tone-success">
          <span>平均掌握度</span>
          <strong>{formatMastery(reviewSummary.average)}</strong>
          <em>按有关联错题节点计算</em>
        </div>
      </section>

      {!tree.length ? (
        <EmptyState title="暂无知识点数据" description="请先导入 knowledge_map_import.zip。" />
      ) : (
        <>
          <section className="knowledge-toolbar">
            <label>
              学科
              <select value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}>
                <option value="">全部</option>
                {MATH_SUBJECTS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label className="knowledge-search">
              <Search size={16} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索知识点 / 章节 / 标签" />
            </label>
            <label className="toggle-line">
              <input checked={onlyWithQuestions} onChange={(event) => setOnlyWithQuestions(event.target.checked)} type="checkbox" />
              只看有错题
            </label>
            <div className="toolbar-spacer" />
            {view === 'directory' ? (
              <>
                <button className="secondary-button compact-button" type="button" onClick={expandAll}>
                  展开全部
                </button>
                <button className="secondary-button compact-button" type="button" onClick={collapseAll}>
                  收起全部
                </button>
              </>
            ) : (
              <button className="secondary-button compact-button" type="button" onClick={() => setView('directory')}>
                返回目录视图
              </button>
            )}
          </section>

          {view === 'directory' ? (
            <section className="knowledge-layout">
              <aside className="knowledge-sidebar">
                <div className="sidebar-title-row">
                  <div>
                    <h2>知识点目录</h2>
                    <p>{totalNodeCount} 个知识点 / {questionNodeCount} 个有错题</p>
                  </div>
                </div>
                {visibleTree.length ? (
                  <KnowledgeTree
                    nodes={visibleTree}
                    selected={selected}
                    expanded={expanded}
                    statsByNode={statsByNode}
                    onToggle={toggle}
                    onSelect={setSelected}
                  />
                ) : (
                  <EmptyState title="没有找到相关知识点" />
                )}
              </aside>

              <main className="knowledge-detail">{detailPanel}</main>
            </section>
          ) : (
            <section className="knowledge-graph-layout">
              <div className="knowledge-flow-panel">
                <div className="flow-panel-header">
                  <div>
                    <h2>图谱视图</h2>
                    <p>支持缩放、拖拽画布和点击节点查看详情。移动端建议横屏或在桌面端查看。</p>
                  </div>
                  <span>{flowElements.nodes.length} 个节点 / {flowElements.edges.length} 条关系</span>
                </div>
                {visibleTree.length ? (
                  <ReactFlowProvider>
                    <KnowledgeFlowCanvas flowNodes={flowElements.nodes} flowEdges={flowElements.edges} onSelect={setSelected} />
                  </ReactFlowProvider>
                ) : (
                  <EmptyState title="没有找到相关知识点" />
                )}
              </div>
              <main className="knowledge-detail graph-detail">{detailPanel}</main>
            </section>
          )}
        </>
      )}
    </div>
  );
}
