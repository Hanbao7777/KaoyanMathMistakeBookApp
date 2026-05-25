import { useEffect, useMemo, useState } from 'react';
import type { QuestionFilters } from '../shared/types';
import { Shell, type PageKey } from './components/Shell';
import { ModalProvider } from './components/Modal';
import { ToastProvider } from './components/Toast';
import { AddEditPage } from './pages/AddEditPage';
import { DashboardPage } from './pages/DashboardPage';
import { DetailPage } from './pages/DetailPage';
import { DailyPlanPage } from './pages/DailyPlanPage';
import { FocusTimerPage } from './pages/FocusTimerPage';
import { ImportPage } from './pages/ImportPage';
import { KnowledgeMapPage } from './pages/KnowledgeMapPage';
import { LibraryPage } from './pages/LibraryPage';
import { QuestionBankPage } from './pages/QuestionBankPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatsPage } from './pages/StatsPage';
import { StudyMaterialsPage } from './pages/StudyMaterialsPage';
import { StudySupervisorPage } from './pages/StudySupervisorPage';
import { defaultFocusTimerState, type FocusTimerPatch, type FocusTimerState } from './types/focusTimer';
import 'katex/dist/katex.min.css';
import './styles/global.css';
import './styles/modal.css';
import './styles/toast.css';

const focusTimerStorageKey = 'kaoyan-focus-timer-state-v1';

function readFocusTimerState(): FocusTimerState {
  try {
    const raw = window.localStorage.getItem(focusTimerStorageKey);
    if (!raw) return defaultFocusTimerState;
    const parsed = JSON.parse(raw) as Partial<FocusTimerState>;
    const status = parsed.status === 'running' || parsed.status === 'paused' ? parsed.status : 'idle';
    return {
      ...defaultFocusTimerState,
      ...parsed,
      status,
      restored: status !== 'idle'
    };
  } catch {
    return defaultFocusTimerState;
  }
}

function getElapsedSeconds(timer: FocusTimerState) {
  if (timer.status !== 'running' || !timer.lastStartedAt) return Math.max(0, Math.floor(timer.accumulatedSeconds));
  const extra = Math.max(0, Math.floor((Date.now() - new Date(timer.lastStartedAt).getTime()) / 1000));
  return Math.max(0, Math.floor(timer.accumulatedSeconds + extra));
}

export default function App() {
  const [page, setPage] = useState<PageKey>('dashboard');
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedKnowledgeNodeId, setSelectedKnowledgeNodeId] = useState<string | null>(null);
  const [reviewKnowledgeNodeId, setReviewKnowledgeNodeId] = useState<string | null>(null);
  const [libraryFilters, setLibraryFilters] = useState<QuestionFilters | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [focusTimer, setFocusTimer] = useState<FocusTimerState>(() => readFocusTimerState());
  const [timerTick, setTimerTick] = useState(0);

  useEffect(() => {
    window.localStorage.setItem(focusTimerStorageKey, JSON.stringify(focusTimer));
  }, [focusTimer]);

  useEffect(() => {
    if (focusTimer.status !== 'running') return undefined;
    const timer = window.setInterval(() => setTimerTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [focusTimer.status]);

  const elapsedSeconds = useMemo(() => {
    void timerTick;
    return getElapsedSeconds(focusTimer);
  }, [focusTimer, timerTick]);

  const focusTimerControls = {
    start: () => {
      setFocusTimer((current) => {
        const now = new Date().toISOString();
        return {
          ...current,
          status: 'running',
          startedAt: current.startedAt || now,
          lastStartedAt: now,
          restored: false
        };
      });
    },
    pause: () => {
      setFocusTimer((current) => ({
        ...current,
        status: current.status === 'idle' ? 'idle' : 'paused',
        accumulatedSeconds: getElapsedSeconds(current),
        lastStartedAt: null,
        restored: false
      }));
    },
    reset: () => {
      setFocusTimer({ ...defaultFocusTimerState, subjectId: focusTimer.subjectId, subjectName: focusTimer.subjectName });
    },
    update: (patch: FocusTimerPatch) => {
      setFocusTimer((current) => ({ ...current, ...patch, restored: false }));
    },
    clearRestored: () => {
      setFocusTimer((current) => ({ ...current, restored: false }));
    },
    elapsedSeconds
  };

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
    <ToastProvider>
      <ModalProvider>
      <Shell page={page} onNavigate={navigate} focusTimer={focusTimer} focusTimerControls={focusTimerControls}>
        {page === 'dashboard' ? <DashboardPage onAdd={() => navigate('add')} onReview={() => navigate('review')} onOpenQuestion={openQuestion} onReviewKnowledgePoint={openKnowledgeReview} onOpenKnowledgePoint={openKnowledgePoint} onOpenKnowledgeMap={() => navigate('knowledgeMap')} onOpenImport={() => navigate('import')} onOpenLibrary={openLibraryWithFilters} onOpenStudyPage={navigate} /> : null}
        {page === 'studySupervisor' ? <StudySupervisorPage onNavigate={navigate} /> : null}
        {page === 'dailyPlan' ? <DailyPlanPage /> : null}
        {page === 'studyMaterials' ? <StudyMaterialsPage /> : null}
        {page === 'focusTimer' ? <FocusTimerPage timer={focusTimer} controls={focusTimerControls} /> : null}
        {page === 'add' ? <AddEditPage editingId={editingId} onSaved={openQuestion} onCancel={() => navigate('library')} /> : null}
        {page === 'library' ? <LibraryPage onOpenQuestion={openQuestion} onEditQuestion={editQuestion} initialFilters={libraryFilters} /> : null}
        {page === 'detail' ? <DetailPage questionId={selectedQuestionId} reviewMode={reviewMode} onBack={() => navigate(reviewMode ? 'review' : 'library')} onEdit={editQuestion} onOpenKnowledgePoint={openKnowledgePoint} /> : null}
        {page === 'review' ? <ReviewPage onOpenQuestion={openQuestion} knowledgeNodeId={reviewKnowledgeNodeId} onKnowledgeTargetConsumed={() => setReviewKnowledgeNodeId(null)} /> : null}
        {page === 'knowledgeMap' ? <KnowledgeMapPage selectedNodeId={selectedKnowledgeNodeId} onOpenQuestion={openQuestion} onReviewKnowledgePoint={openKnowledgeReview} /> : null}
        {page === 'questionBank' ? <QuestionBankPage onOpenQuestion={openQuestion} /> : null}
        {page === 'stats' ? <StatsPage onOpenLibrary={openLibraryWithFilters} onOpenKnowledgePoint={openKnowledgePoint} onOpenQuestion={openQuestion} onOpenImport={() => navigate('import')} onOpenReview={() => navigate('review')} /> : null}
        {page === 'import' ? <ImportPage /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </Shell>
      </ModalProvider>
    </ToastProvider>
  );
}
