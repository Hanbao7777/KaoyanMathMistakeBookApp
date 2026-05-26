import { useEffect, useMemo, useState } from 'react';
import type { QuestionFilters } from '../shared/types';
import { Shell, type PageKey } from './components/Shell';
import { GlobalSearch } from './components/GlobalSearch';
import { ModalProvider } from './components/Modal';
import { ToastProvider } from './components/Toast';
import { AddEditPage } from './pages/AddEditPage';
import { AiImportPage } from './pages/AiImportPage';
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
import { TickTickSidebar } from './pages/ticktick/TickTickSidebar';
import { TickTickShell } from './pages/ticktick/TickTickShell';
import { TodayPage } from './pages/ticktick/TodayPage';
import { CalendarPage } from './pages/ticktick/CalendarPage';
import { ListDetailPage } from './pages/ticktick/ListDetailPage';
import { FocusTimerPage as TickTickFocusTimerPage } from './pages/ticktick/FocusTimerPage';
import { TickTickSettingsPage } from './pages/ticktick/TickTickSettingsPage';
import { InboxPage } from './pages/ticktick/InboxPage';
import { formatSeconds } from './utils/formatTime';
import 'katex/dist/katex.min.css';
import './styles/global.css';
import './styles/modal.css';
import './styles/toast.css';
import './styles/ticktick.css';

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

type TickTickPageKey = 'today' | 'calendar' | 'inbox' | 'list' | 'focus' | 'settings';

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
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [mode, setMode] = useState<'mistake' | 'ticktick'>('mistake');
  const [ttPage, setTtPage] = useState<TickTickPageKey>('today');
  const [selectedListId, setSelectedListId] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(focusTimerStorageKey, JSON.stringify(focusTimer));
  }, [focusTimer]);

  useEffect(() => {
    if (focusTimer.status !== 'running') return undefined;
    const timer = window.setInterval(() => setTimerTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [focusTimer.status]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        setGlobalSearchOpen(true);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    window.api.triggerReviewTaskGeneration().catch((e) => { console.error('triggerReviewTaskGeneration', e); });
  }, []);

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

  const showTimer = focusTimer.status !== 'idle' || focusTimerControls.elapsedSeconds > 0;
  const timerLabel = focusTimer.taskTitle || focusTimer.subjectName || '专注计时';

  return (
    <ToastProvider>
      <ModalProvider>
      {mode === 'ticktick' ? (
        <div className="ticktick-root">
          <TickTickShell
            page={ttPage}
            selectedListId={selectedListId}
            onNavigate={(nextPage, listId) => { setTtPage(nextPage); setSelectedListId(listId || null); }}
            onModeChange={() => setMode('mistake')}
            focusTimer={focusTimer}
            focusTimerControls={focusTimerControls}
          >
            {ttPage === 'today' && <TodayPage />}
            {ttPage === 'calendar' && <CalendarPage />}
            {ttPage === 'list' && (selectedListId ? (
              <ListDetailPage listId={selectedListId} onBack={() => { setTtPage('today'); setSelectedListId(null); }} />
            ) : (
              <div className="ticktick-main-content"><div className="tt-empty">请从侧边栏选择一个清单</div></div>
            ))}
            {ttPage === 'inbox' && <InboxPage />}
            {ttPage === 'focus' && <TickTickFocusTimerPage />}
            {ttPage === 'settings' && <TickTickSettingsPage />}
          </TickTickShell>
        </div>
      ) : (
        <Shell page={page} onNavigate={navigate} focusTimer={focusTimer} focusTimerControls={focusTimerControls} mode={mode} onModeChange={setMode}>
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
        {page === 'aiImport' ? <AiImportPage /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
        </Shell>
      )}
      <GlobalSearch
        open={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
        onOpenQuestion={openQuestion}
        onOpenKnowledgePoint={openKnowledgePoint}
      />
      </ModalProvider>
    </ToastProvider>
  );
}
