import { contextBridge, ipcRenderer } from 'electron';
import type { AgentControlApi, AppApi, ManagedBackup, ManagedExport, ManagedGlobalJob } from '../shared/api';
import type {
  AppPaths,
  AddExternalQuestionToMistakesResult,
  AiDiagnosisResult,
  AiStructuredQuestion,
  BindTextbookPdfResult,
  DashboardData,
  DatabaseBackupInfo,
  DatabaseBackupKind,
  DatabaseBackupResult,
  DeepSeekSettings,
  DeleteExternalQuestionBatchResult,
  DeleteImportBatchOptions,
  DeleteImportBatchResult,
  DeleteLegacyExternalQuestionGroupResult,
  ExternalQuestion,
  ExternalQuestionAttempt,
  ExternalQuestionAttemptInput,
  ExternalQuestionFilters,
  ExternalQuestionStats,
  ImportBatch,
  ImportBatchDetail,
  ImageUrlResult,
  KnowledgeMapImportResult,
  KnowledgePoint,
  KnowledgePointDetail,
  KnowledgePointReviewQuestionsResult,
  KnowledgePointReviewStats,
  KnowledgePointTreeNode,
  KnowledgeRematchResult,
  KnowledgeReviewMode,
  MasteryLevel,
  OcrResult,
  OpenTextbookResult,
  PdfExportOptions,
  PdfExportResult,
  Question,
  QuestionBankImportResult,
  QuestionFilters,
  QuestionInput,
  ReviewBuckets,
  ReviewInput,
  ReviewLog,
  ReviewSubmitInput,
  ReviewSubmitResult,
  RestoreDatabaseBackupResult,
  StatsData,
  LegacyExternalQuestionGroup,
  StructuredImportPreview,
  StructuredImportResult,
  DailyReview,
  DailyReviewInput,
  StudyMaterial,
  StudyMaterialFilters,
  StudyMaterialInput,
  StudyQuality,
  StudySession,
  StudySessionFilters,
  StudySessionInput,
  StudySettings,
  StudySubject,
  StudySupervisorDashboard,
  StudyTask,
  StudyTaskFilters,
  StudyTaskInput,
  WindowState,
  TickTickList,
  TickTickListInput,
  TickTickTask,
  TickTickTaskInput,
  TickTickTaskFilters,
  TickTickTag,
  TickTickFocusSession,
  TickTickFocusSessionInput,
  TickTickBridge,
  TickTickBridgeInput,
  TickTickBridgeLinkedType,
  TickTickAiDecompositionInput,
  TickTickAiDecompositionResult,
  TickTickAiDailyPlanResult,
  TickTickAiReviewResult,
  TickTickCalendarDay,
  TickTickSettings,
  TickTickWhiteNoise,
  TickTickHabit,
  TickTickHabitInput,
  TickTickHabitLog
} from '../shared/types';

type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: string };

async function invoke<T>(channel: string, ...args: unknown[]) {
  const response = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>;
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    throw new Error('Invalid IPC response envelope');
  }
  if (!response.ok) {
    if (typeof response.error !== 'string') throw new Error('Invalid IPC error envelope');
    throw new Error(response.error);
  }
  if (!('data' in response)) throw new Error('Invalid IPC success envelope');
  return response.data;
}

const api: AppApi = {
  agentControl: {
    getStatus: () => invoke('agentControl:getStatus'),
    setExternalControlEnabled: (enabled) => invoke('agentControl:setExternalControlEnabled', enabled),
    listClients: (request = {}) => invoke('agentControl:listClients', request),
    updateClientAccess: (clientId, scopes, trust) => invoke('agentControl:updateClientAccess', { clientId, scopes, trust }),
    revokeClient: (clientId) => invoke('agentControl:revokeClient', clientId),
    listSessions: (request = {}) => invoke('agentControl:listSessions', request),
    terminateSession: (sessionId) => invoke('agentControl:terminateSession', sessionId),
    listR4Grants: (request = {}) => invoke('agentControl:listR4Grants', request),
    createR4Grant: (grant) => invoke('agentControl:createR4Grant', grant),
    revokeR4Grant: (grantId) => invoke('agentControl:revokeR4Grant', grantId),
    listApprovals: (request = {}) => invoke('agentControl:listApprovals', request),
    approve: (approvalId) => invoke('agentControl:approve', approvalId),
    rejectApproval: (approvalId, reasonCode) => invoke('agentControl:rejectApproval', approvalId, reasonCode),
    listChangeSets: (request = {}) => invoke('agentControl:listChangeSets', request),
    getChangeSet: (changeSetId) => invoke('agentControl:getChangeSet', changeSetId),
    applyChangeSet: (changeSetId) => invoke('agentControl:applyChangeSet', changeSetId),
    rejectChangeSet: (changeSetId, reasonCode) => invoke('agentControl:rejectChangeSet', changeSetId, reasonCode),
    searchAudit: (request = {}) => invoke('agentControl:searchAudit', request),
    exportAudit: (request = {}) => invoke('agentControl:exportAudit', request),
    verifyAudit: (segmentId) => invoke('agentControl:verifyAudit', segmentId),
    getPolicy: () => invoke('agentControl:getPolicy'),
    getCatalog: () => invoke('agentControl:getCatalog'),
    getPrivacyDisclosure: () => invoke('agentControl:getPrivacyDisclosure'),
    connectClient: (request) => invoke('agentControl:connectClient', request),
    getClientConnection: (request) => invoke('agentControl:getClientConnection', request),
    repairClientConnection: (request) => invoke('agentControl:repairClientConnection', request),
    rotateClientKey: (request) => invoke('agentControl:rotateClientKey', request),
    disconnectClientConnection: (request) => invoke('agentControl:disconnectClientConnection', request),
    prepareDirectHttpsTrust: () => invoke('agentControl:prepareDirectHttpsTrust'),
    confirmDirectHttpsTrust: (intentId, confirmed) => invoke('agentControl:confirmDirectHttpsTrust', intentId, confirmed),
    prepareDirectHttpsRemoval: () => invoke('agentControl:prepareDirectHttpsRemoval'),
    confirmDirectHttpsRemoval: (intentId, confirmed) => invoke('agentControl:confirmDirectHttpsRemoval', intentId, confirmed),
    listOAuthConsent: () => invoke('agentControl:listOAuthConsent'),
    decideOAuthConsent: (requestId, decision) => invoke('agentControl:decideOAuthConsent', requestId, decision),
    previewDiagnostics: () => invoke('agentControl:previewDiagnostics'),
    exportDiagnostics: () => invoke('agentControl:exportDiagnostics')
  } satisfies AgentControlApi,
  knowledge: {
    listNodes: (parentNodeId?: string, subject?: string) => invoke('knowledge:listNodes', parentNodeId, subject),
    getNode: (nodeId: string) => invoke('knowledge:getNode', nodeId),
    listLinks: (input: { nodeId?: string; questionId?: number }) => invoke('knowledge:listLinks', input),
    listTextbooks: (subject?: string) => invoke('textbooks:list', subject),
    getTextbook: (textbookId: number) => invoke('textbooks:get', textbookId),
    getWeakAreas: (subject?: string) => invoke('analytics:getWeakAreas', subject),
    linkQuestion: (questionId: number, nodeId: string, matchType: 'gpt' | 'auto' | 'manual') => invoke('knowledge:linkQuestion', questionId, nodeId, matchType),
    unlinkQuestion: (questionId: number, nodeId: string) => invoke('knowledge:unlinkQuestion', questionId, nodeId),
    bindTextbook: (nodeId: string, textbookId: number) => invoke('knowledge:bindTextbook', nodeId, textbookId)
  },
  dashboard: () => invoke<DashboardData>('dashboard:get'),
  listQuestions: (filters: QuestionFilters) => invoke<Question[]>('questions:list', filters),
  getQuestion: (id: number) => invoke<Question | null>('questions:get', id),
  createQuestion: (input: QuestionInput) => invoke<Question>('questions:create', input),
  updateQuestion: (id: number, input: QuestionInput) => invoke<Question>('questions:update', id, input),
  deleteQuestion: (id: number, deleteImages: boolean) => invoke<boolean>('questions:delete', id, deleteImages),
  markMastery: (id: number, mastery: MasteryLevel) => invoke<Question>('questions:markMastery', id, mastery),
  chooseImages: () => invoke<string[]>('images:choose'),
  getImageUrl: (imagePath: string) => invoke<ImageUrlResult>('images:getUrl', imagePath),
  checkImageExists: (imagePath: string) => invoke<boolean>('images:exists', imagePath),
  openImage: (imagePath: string) => invoke<string>('images:open', imagePath),
  revealImageInFolder: (imagePath: string) => invoke<boolean>('images:reveal', imagePath),
  removeImage: (id: number, deleteFile: boolean) => invoke<boolean>('images:remove', id, deleteFile),
  listReviewLogs: (questionId: number) => invoke<ReviewLog[]>('reviews:list', questionId),
  addReviewLog: (input: ReviewInput) => invoke<Question>('reviews:add', input),
  submitReviewResult: (input: ReviewSubmitInput) => invoke<ReviewSubmitResult>('reviews:submitResult', input),
  getReviewBuckets: () => invoke<ReviewBuckets>('review:buckets'),
  getStats: () => invoke<StatsData>('stats:get'),
  getPaths: () => invoke<AppPaths>('paths:get'),
  exportData: () => invoke<string>('settings:export'),
  chooseJson: () => invoke<string | null>('settings:chooseJson'),
  importData: (filePath: string) => invoke<{ imported: boolean; backup: string }>('settings:import', filePath),
  clearAllData: (deleteImages: boolean) => invoke<boolean>('settings:clear', deleteImages),
  chooseRoot: () => invoke<string | null>('settings:chooseRoot'),
  setRoot: (root: string, migrate: boolean) => invoke<AppPaths>('settings:setRoot', root, migrate),
  createDatabaseBackup: () => invoke<ManagedGlobalJob>('backups:create'),
  ensureDailyAutoBackup: () => invoke<DatabaseBackupResult | null>('backups:ensureDaily'),
  listDatabaseBackups: () => invoke<readonly ManagedBackup[]>('backups:list'),
  listLegacyDatabaseBackups: () => invoke<DatabaseBackupInfo[]>('backups:listLegacy'),
  restoreDatabaseBackup: (fileName: string) => invoke<RestoreDatabaseBackupResult>('backups:restore', fileName),
  deleteDatabaseBackup: (fileName: string) => invoke<boolean>('backups:delete', fileName),
  openBackupsFolder: () => invoke<boolean>('backups:openFolder'),
  exportQuestionsToPdf: (options: Pick<PdfExportOptions, 'scope' | 'mode' | 'questionIds'>) => invoke<ManagedGlobalJob>('pdfExport:create', options),
  getManagedExport: (assetId: string) => invoke<ManagedExport>('pdfExport:get', assetId),
  openExportedPdf: (filePath: string) => invoke<boolean>('pdfExport:open', filePath),
  openExportsFolder: () => invoke<boolean>('pdfExport:openFolder'),
  createImportTemplate: () => invoke<string>('structuredImport:template'),
  prepareExcelImport: () => invoke<StructuredImportPreview | null>('structuredImport:prepareExcel'),
  prepareJsonStructuredImport: () => invoke<StructuredImportPreview | null>('structuredImport:prepareJson'),
  prepareZipImport: () => invoke<StructuredImportPreview | null>('structuredImport:prepareZip'),
  confirmStructuredImport: (sessionId: string) => invoke<StructuredImportResult>('structuredImport:confirm', sessionId),
  cancelStructuredImport: (sessionId: string) => invoke<boolean>('structuredImport:cancel', sessionId),
  imports: {
    selectImages: () => invoke('imports:selectImages'),
    createDraft: (payload) => invoke('imports:createDraft', payload),
    addDraftImage: (payload) => invoke('imports:addDraftImage', payload),
    validateDraft: (draftId) => invoke('imports:validateDraft', draftId),
    previewDraft: (draftId) => invoke('imports:previewDraft', draftId),
    applyDraft: (draftId, previewHash) => invoke('imports:applyDraft', draftId, previewHash),
    get: (draftId) => invoke('imports:get', draftId),
    cancel: (draftId) => invoke('imports:cancel', draftId),
    stageSelectedImages: (selectionToken) => invoke('imports:stageSelectedImages', selectionToken)
  },
  importKnowledgeMapZip: () => invoke<KnowledgeMapImportResult | null>('knowledgeMap:importZip'),
  importQuestionBankZip: () => invoke<QuestionBankImportResult | null>('questionBank:importZip'),
  listExternalQuestions: (filters: ExternalQuestionFilters) => invoke<ExternalQuestion[]>('questionBank:list', filters),
  getExternalQuestion: (id: number) => invoke<ExternalQuestion | null>('questionBank:get', id),
  getExternalQuestionStats: () => invoke<ExternalQuestionStats>('questionBank:stats'),
  getExternalQuestionAssetUrl: (id: number, resourcePath: string) => invoke<ImageUrlResult>('questionBank:getAssetUrl', id, resourcePath),
  recordExternalQuestionAttempt: (input: ExternalQuestionAttemptInput) => invoke<ExternalQuestionAttempt>('questionBank:recordAttempt', input),
  addExternalQuestionToMistakes: (id: number) => invoke<AddExternalQuestionToMistakesResult>('questionBank:addToMistakes', id),
  deleteExternalQuestionBatch: (batchId: string) => invoke<DeleteExternalQuestionBatchResult>('questionBank:deleteBatch', batchId),
  listImportBatches: () => invoke<ImportBatch[]>('importBatches:list'),
  getImportBatchDetail: (batchId: string) => invoke<ImportBatchDetail | null>('importBatches:getDetail', batchId),
  deleteImportBatch: (batchId: string, options?: DeleteImportBatchOptions) => invoke<DeleteImportBatchResult>('importBatches:delete', batchId, options),
  listLegacyExternalQuestionGroups: () => invoke<LegacyExternalQuestionGroup[]>('importBatches:listLegacyExternalGroups'),
  deleteLegacyExternalQuestionGroup: (groupKey: string) => invoke<DeleteLegacyExternalQuestionGroupResult>('importBatches:deleteLegacyExternalGroup', groupKey),
  openTrashFolder: () => invoke<boolean>('importBatches:openTrashFolder'),
  openExternalQuestionPaper: (id: number) => invoke<boolean>('questionBank:openPaper', id),
  openExternalQuestionSolutionPdf: (id: number) => invoke<boolean>('questionBank:openSolutionPdf', id),
  listKnowledgeTree: () => invoke<KnowledgePointTreeNode[]>('knowledgeMap:listTree'),
  getKnowledgeDetail: (nodeId: string) => invoke<KnowledgePointDetail | null>('knowledgeMap:getDetail', nodeId),
  openTextbookPage: (nodeId: string) => invoke<OpenTextbookResult>('knowledgeMap:openTextbookPage', nodeId),
  bindTextbookPdf: (nodeId: string) => invoke<BindTextbookPdfResult | null>('knowledgeMap:bindTextbookPdf', nodeId),
  rematchKnowledgePoints: () => invoke<KnowledgeRematchResult>('knowledgeMap:rematch'),
  listKnowledgeForQuestion: (questionId: number) => invoke<KnowledgePoint[]>('knowledgeMap:listForQuestion', questionId),
  listKnowledgeReviewStats: () => invoke<KnowledgePointReviewStats[]>('knowledgeMap:listReviewStats'),
  getKnowledgePointReviewStats: (nodeId: string, includeChildren = true) => invoke<KnowledgePointReviewStats | null>('knowledgeMap:getReviewStats', nodeId, includeChildren),
  getKnowledgeReviewQuestions: (nodeId: string, mode: KnowledgeReviewMode, includeChildren: boolean) => invoke<KnowledgePointReviewQuestionsResult>('knowledgeMap:getReviewQuestions', nodeId, mode, includeChildren),
  getStudySettings: () => invoke<StudySettings>('study:settings:get'),
  updateStudySettings: (input: Partial<StudySettings>) => invoke<StudySettings>('study:settings:update', input),
  listStudySubjects: () => invoke<StudySubject[]>('study:subjects:list'),
  listStudyMaterials: (filters?: StudyMaterialFilters) => invoke<StudyMaterial[]>('study:materials:list', filters),
  createStudyMaterial: (input: StudyMaterialInput) => invoke<StudyMaterial>('study:materials:create', input),
  updateStudyMaterial: (id: string, input: StudyMaterialInput) => invoke<StudyMaterial | null>('study:materials:update', id, input),
  deleteStudyMaterial: (id: string) => invoke<boolean>('study:materials:delete', id),
  updateStudyMaterialProgress: (id: string, currentAmount: number) => invoke<StudyMaterial | null>('study:materials:updateProgress', id, currentAmount),
  listStudyTasks: (filters?: StudyTaskFilters) => invoke<StudyTask[]>('study:tasks:list', filters),
  listTodayStudyTasks: () => invoke<StudyTask[]>('study:tasks:today'),
  createStudyTask: (input: StudyTaskInput) => invoke<StudyTask>('study:tasks:create', input),
  updateStudyTask: (id: string, input: StudyTaskInput) => invoke<StudyTask | null>('study:tasks:update', id, input),
  deleteStudyTask: (id: string) => invoke<boolean>('study:tasks:delete', id),
  completeStudyTask: (id: string, input?: { actual_minutes?: number; completion_quality?: StudyQuality; note?: string }) => invoke<StudyTask | null>('study:tasks:complete', id, input),
  skipStudyTask: (id: string, reason: string) => invoke<StudyTask | null>('study:tasks:skip', id, reason),
  rolloverStudyTasks: () => invoke<{ rolled: number; skipped: boolean }>('study:tasks:rollover'),
  listStudySessions: (filters?: StudySessionFilters) => invoke<StudySession[]>('study:sessions:list', filters),
  createStudySession: (input: StudySessionInput) => invoke<StudySession>('study:sessions:create', input),
  deleteStudySession: (id: string) => invoke<boolean>('study:sessions:delete', id),
  getDailyReview: (date: string) => invoke<DailyReview | null>('study:reviews:get', date),
  saveDailyReview: (input: DailyReviewInput) => invoke<DailyReview | null>('study:reviews:save', input),
  getStudySupervisorDashboard: (date?: string) => invoke<StudySupervisorDashboard>('study:dashboard', date),
  getStudyToday: (date?: string) => invoke<import('../shared/agent/v1/contracts').StudyTodaySummary>('study:getToday', date),
  getStudyWeekSummary: (date?: string) => invoke<import('../shared/agent/v1/contracts').StudyWeekSummary>('study:getWeekSummary', date),
  createStudyPlanDraft: (date: string, tasks: import('../shared/agent/v1/contracts').StudyCreatePlanDraftCommand['payload']['tasks']) => invoke<import('../shared/agent/v1/contracts').StudyCommandValues['study.create_plan_draft']>('study:createPlanDraft', date, tasks),
  applyStudyPlanAdjustment: (payload: import('../shared/agent/v1/contracts').StudyApplyPlanAdjustmentCommand['payload']) => invoke<import('../shared/agent/v1/contracts').StudyCommandValues['study.apply_plan_adjustment']>('study:applyPlanAdjustment', payload),
  recordStudyManualProgress: (payload: import('../shared/agent/v1/contracts').StudyRecordManualProgressCommand['payload']) => invoke<import('../shared/agent/v1/contracts').StudyCommandValues['study.record_manual_progress']>('study:recordManualProgress', payload),

  // TickTick Lists
  listTickTickLists: () => invoke<TickTickList[]>('ticktick:lists:list'),
  getTickTickList: (id: string) => invoke<TickTickList | null>('ticktick:lists:get', id),
  createTickTickList: (input: TickTickListInput) => invoke<TickTickList>('ticktick:lists:create', input),
  updateTickTickList: (id: string, input: TickTickListInput) => invoke<TickTickList | null>('ticktick:lists:update', id, input),
  deleteTickTickList: (id: string) => invoke<boolean>('ticktick:lists:delete', id),
  reorderTickTickLists: (ids: string[]) => invoke<void>('ticktick:lists:reorder', ids),

  // TickTick Tasks
  listTickTickTasks: (filters?: TickTickTaskFilters) => invoke<TickTickTask[]>('ticktick:tasks:list', filters),
  getTickTickTask: (id: string) => invoke<TickTickTask | null>('ticktick:tasks:get', id),
  createTickTickTask: (input: TickTickTaskInput) => invoke<TickTickTask>('ticktick:tasks:create', input),
  updateTickTickTask: (id: string, input: Partial<TickTickTaskInput> & { is_completed?: number; actual_minutes?: number; pomodoro_sessions?: number; sort_order?: number }) => invoke<TickTickTask | null>('ticktick:tasks:update', id, input),
  deleteTickTickTask: (id: string) => invoke<boolean>('ticktick:tasks:delete', id),
  completeTickTickTask: (id: string) => invoke<TickTickTask | null>('ticktick:tasks:complete', id),
  uncompleteTickTickTask: (id: string) => invoke<TickTickTask | null>('ticktick:tasks:uncomplete', id),
  getTodayTickTickTasks: () => invoke<{ overdue: TickTickTask[]; today: TickTickTask[]; upcoming: TickTickTask[] }>('ticktick:tasks:today'),

  // TickTick Tags
  listTickTickTags: () => invoke<TickTickTag[]>('ticktick:tags:list'),

  // TickTick Focus Sessions
  listTickTickFocusSessions: (filters?: { date?: string; taskId?: string }) => invoke<TickTickFocusSession[]>('ticktick:focus:list', filters),
  createTickTickFocusSession: (input: TickTickFocusSessionInput) => invoke<TickTickFocusSession>('ticktick:focus:create', input),

  // TickTick Bridge
  getTickTickTaskBridges: (taskId: string) => invoke<TickTickBridge[]>('ticktick:bridge:task', taskId),
  createTickTickBridge: (input: TickTickBridgeInput) => invoke<TickTickBridge>('ticktick:bridge:create', input),
  deleteTickTickBridge: (id: number) => invoke<boolean>('ticktick:bridge:delete', id),
  getBridgesForLinked: (linkedType: TickTickBridgeLinkedType, linkedId: string) => invoke<TickTickBridge[]>('ticktick:bridge:linked', linkedType, linkedId),

  // TickTick Calendar
  getTickTickCalendarMonth: (year: number, month: number) => invoke<TickTickCalendarDay[]>('ticktick:calendar:month', year, month),

  // TickTick AI
  aiDecomposeTask: (input: TickTickAiDecompositionInput) => invoke<TickTickAiDecompositionResult>('ticktick:ai:decompose', input),
  aiGenerateDailyPlan: () => invoke<TickTickAiDailyPlanResult>('ticktick:ai:dailyPlan'),
  aiGenerateReview: (type: 'daily' | 'weekly') => invoke<TickTickAiReviewResult>('ticktick:ai:review', type),

  // TickTick Settings
  getTickTickSettings: () => invoke<TickTickSettings>('ticktick:settings:get'),
  saveTickTickSettings: (settings: TickTickSettings) => invoke<TickTickSettings>('ticktick:settings:save', settings),

  // White Noise
  getTickTickWhiteNoiseState: () => invoke<{ enabled: boolean; noise: TickTickWhiteNoise }>('ticktick:whiteNoise:get'),
  setTickTickWhiteNoiseState: (state: { enabled: boolean; noise: TickTickWhiteNoise }) => invoke<void>('ticktick:whiteNoise:set', state),

  // Shared timer state (single source of truth: main engine)
  getSharedTimerState: () => invoke('timer:getState'),
  startSharedTimer: () => invoke('timer:start'),
  pauseSharedTimer: () => invoke('timer:pause'),
  resetSharedTimer: () => invoke('timer:reset'),
  skipBreakSharedTimer: () => invoke('timer:skipBreak'),
  bindTimerTask: (taskId: string | null) => invoke('timer:bindTask', taskId),
  setTimerConfig: (config: { focusMinutes?: number; shortBreakMinutes?: number; longBreakMinutes?: number; sessionsBeforeLongBreak?: number }) => invoke('timer:setConfig', config),

  // Widget
  openWidget: () => { ipcRenderer.send('widget:open'); },
  closeWidget: () => { ipcRenderer.send('widget:close'); },
  toggleWidgetPin: (pinned: boolean) => { ipcRenderer.send('widget:togglePin', pinned); },
  setWidgetOpacity: (opacity: number) => { ipcRenderer.send('widget:setOpacity', opacity); },
  setWidgetSize: (width: number, height: number) => { ipcRenderer.send('widget:setSize', width, height); },
  setWidgetBounds: (bounds: { x: number; y: number; width: number; height: number }) => { ipcRenderer.send('widget:setBounds', bounds); },
  openMainWindow: () => { ipcRenderer.send('widget:openMain'); },
  isWidgetOpen: () => invoke<boolean>('widget:isOpen'),

  // TickTick Habits
  listTickTickHabits: () => invoke<TickTickHabit[]>('ticktick:habits:list'),
  createTickTickHabit: (input: TickTickHabitInput) => invoke<TickTickHabit>('ticktick:habits:create', input),
  updateTickTickHabit: (id: string, input: TickTickHabitInput) => invoke<TickTickHabit | null>('ticktick:habits:update', id, input),
  deleteTickTickHabit: (id: string) => invoke<boolean>('ticktick:habits:delete', id),
  toggleTickTickHabit: (habitId: string, date: string) => invoke<TickTickHabitLog | null>('ticktick:habits:toggle', habitId, date),
  getTickTickHabitLogs: (habitId: string, fromDate?: string, toDate?: string) => invoke<TickTickHabitLog[]>('ticktick:habits:logs', habitId, fromDate, toDate),

  // Sync
  triggerReviewTaskGeneration: () => invoke<{ created: number }>('ticktick:sync:generateReviewTasks'),
  syncTickTickTaskCompletedToReview: (taskId: string, taskTitle: string, actualMinutes: number) => invoke<void>('ticktick:sync:reviewTask', taskId, taskTitle, actualMinutes),
  undoReviewTaskSync: (taskId: string, taskTitle: string) => invoke<void>('ticktick:sync:undoReviewTask', taskId, taskTitle),
  syncReviewToTickTick: (linkedType: TickTickBridgeLinkedType, linkedId: string) => invoke<void>('ticktick:sync:reviewUpdated', linkedType, linkedId),
  syncMasteryToTickTick: (knowledgeNodeId: string, newMasteryScore: number) => invoke<void>('ticktick:sync:masteryChanged', knowledgeNodeId, newMasteryScore),

  saveWindowState: (state: WindowState) => ipcRenderer.send('window:saveState', state),
  loadWindowState: () => invoke<WindowState | null>('window:loadState'),

  // DeepSeek settings
  getDeepSeekSettings: () => invoke<DeepSeekSettings>('deepseek:settings:get'),
  saveDeepSeekSettings: (input: DeepSeekSettings) => invoke<DeepSeekSettings>('deepseek:settings:save', input),

  // OCR
  runOcr: (imagePaths: string[]) => invoke<OcrResult[]>('ocr:run', imagePaths),
  checkPythonEnv: () => invoke<void>('python:checkEnv'),
  testDeepSeekConnection: () => invoke<void>('deepseek:testConnection'),

  // AI structuring
  structureQuestion: (ocrTexts: string[]) => invoke<AiStructuredQuestion>('deepseek:structure', ocrTexts),

  // AI error diagnosis
  diagnoseError: (questionId: number) => invoke<AiDiagnosisResult>('deepseek:diagnose', questionId),

  toFileUrl: (filePath: string) => `mistake-image:///${encodeURIComponent(filePath)}`
};

contextBridge.exposeInMainWorld('api', api);

if (process.env.KAOYAN_E2E_HARNESS === '1') {
  contextBridge.exposeInMainWorld('agentControlE2e', Object.freeze({
    async report(result: { readonly ok: boolean; readonly assertions: readonly string[]; readonly error?: string }) {
      const response = await ipcRenderer.invoke('agentControl:e2e:writeResult', result) as IpcResponse<void>;
      if (!response || response.ok !== true || !('data' in response)) throw new Error('Invalid E2E result acknowledgement');
    }
  }));
}
