import { useState } from 'react';
import type { QuestionFilters } from '../shared/types';
import { Shell, type PageKey } from './components/Shell';
import { AddEditPage } from './pages/AddEditPage';
import { DashboardPage } from './pages/DashboardPage';
import { DetailPage } from './pages/DetailPage';
import { ImportPage } from './pages/ImportPage';
import { KnowledgeMapPage } from './pages/KnowledgeMapPage';
import { LibraryPage } from './pages/LibraryPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatsPage } from './pages/StatsPage';
import 'katex/dist/katex.min.css';
import './styles/global.css';

export default function App() {
  const [page, setPage] = useState<PageKey>('dashboard');
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedKnowledgeNodeId, setSelectedKnowledgeNodeId] = useState<string | null>(null);
  const [reviewKnowledgeNodeId, setReviewKnowledgeNodeId] = useState<string | null>(null);
  const [libraryFilters, setLibraryFilters] = useState<QuestionFilters | null>(null);
  const [reviewMode, setReviewMode] = useState(false);

  function openQuestion(id: number, nextReviewMode = false) {
    setSelectedQuestionId(id);
    setEditingId(null);
    setReviewMode(nextReviewMode);
    setPage('detail');
  }

  function editQuestion(id: number) {
    setEditingId(id);
    setPage('add');
  }

  function navigate(next: PageKey) {
    if (next !== 'detail') setSelectedQuestionId(null);
    if (next !== 'add') setEditingId(null);
    if (next !== 'detail') setReviewMode(false);
    if (next !== 'knowledgeMap') setSelectedKnowledgeNodeId(null);
    if (next !== 'library') setLibraryFilters(null);
    setReviewKnowledgeNodeId(null);
    setPage(next);
  }

  function openKnowledgePoint(nodeId: string) {
    setSelectedKnowledgeNodeId(nodeId);
    setSelectedQuestionId(null);
    setEditingId(null);
    setReviewMode(false);
    setPage('knowledgeMap');
  }

  function openKnowledgeReview(nodeId: string) {
    setReviewKnowledgeNodeId(nodeId);
    setSelectedQuestionId(null);
    setEditingId(null);
    setReviewMode(false);
    setPage('review');
  }

  function openLibraryWithFilters(filters: QuestionFilters = {}) {
    setLibraryFilters(filters);
    setSelectedQuestionId(null);
    setEditingId(null);
    setReviewMode(false);
    setPage('library');
  }

  return (
    <Shell page={page} onNavigate={navigate}>
      {page === 'dashboard' ? <DashboardPage onAdd={() => navigate('add')} onReview={() => navigate('review')} onOpenQuestion={openQuestion} onReviewKnowledgePoint={openKnowledgeReview} onOpenKnowledgePoint={openKnowledgePoint} onOpenKnowledgeMap={() => navigate('knowledgeMap')} onOpenImport={() => navigate('import')} onOpenLibrary={openLibraryWithFilters} /> : null}
      {page === 'add' ? <AddEditPage editingId={editingId} onSaved={openQuestion} onCancel={() => navigate('library')} /> : null}
      {page === 'library' ? <LibraryPage onOpenQuestion={openQuestion} onEditQuestion={editQuestion} initialFilters={libraryFilters} /> : null}
      {page === 'detail' ? <DetailPage questionId={selectedQuestionId} reviewMode={reviewMode} onBack={() => navigate(reviewMode ? 'review' : 'library')} onEdit={editQuestion} onOpenKnowledgePoint={openKnowledgePoint} /> : null}
      {page === 'review' ? <ReviewPage onOpenQuestion={openQuestion} knowledgeNodeId={reviewKnowledgeNodeId} onKnowledgeTargetConsumed={() => setReviewKnowledgeNodeId(null)} /> : null}
      {page === 'knowledgeMap' ? <KnowledgeMapPage selectedNodeId={selectedKnowledgeNodeId} onOpenQuestion={openQuestion} onReviewKnowledgePoint={openKnowledgeReview} /> : null}
      {page === 'stats' ? <StatsPage onOpenLibrary={openLibraryWithFilters} onOpenKnowledgePoint={openKnowledgePoint} onOpenQuestion={openQuestion} onOpenImport={() => navigate('import')} onOpenReview={() => navigate('review')} /> : null}
      {page === 'import' ? <ImportPage /> : null}
      {page === 'settings' ? <SettingsPage /> : null}
    </Shell>
  );
}
