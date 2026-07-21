import type {
  AppPaths,
  DashboardData,
  DatabaseBackupInfo,
  DatabaseBackupKind,
  DatabaseBackupResult,
  AddExternalQuestionToMistakesResult,
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
  BindTextbookPdfResult,
  KnowledgeMapImportResult,
  KnowledgePoint,
  KnowledgePointDetail,
  KnowledgePointReviewQuestionsResult,
  KnowledgePointReviewStats,
  KnowledgePointTreeNode,
  KnowledgeRematchResult,
  KnowledgeReviewMode,
  MasteryLevel,
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
  DeepSeekSettings,
  OcrResult,
  AiStructuredQuestion,
  AiDiagnosisResult,
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
  TickTickAiPlan,
  TickTickCalendarDay,
  TickTickAiDecompositionInput,
  TickTickAiDecompositionResult,
  TickTickAiDailyPlanResult,
  TickTickAiReviewResult,
  TickTickPomodoroSettings,
  TickTickSettings,
  TickTickWhiteNoise,
  TickTickHabit,
  TickTickHabitInput,
  TickTickHabitLog
} from './types';
import type {
  AgentScope,
  ApprovalStatus,
  AuditKind,
  ChangeSetStatus,
  R4GrantStatus,
  TrustProfile,
  OperationName
} from './agent/v1/gatewayContracts';
import type { PairingRequest, PairingStatus, PairingTargetRequest } from './mcp/v1/pairingContracts';

export interface ManagedGlobalJob { readonly assetId: string; readonly jobId: string; readonly status: 'intent'; }
export interface ManagedBackup { readonly assetId: string; readonly kind: 'backup'; readonly status: 'intent' | 'staged' | 'published' | 'quarantined' | 'failed' | 'needs_recovery'; readonly metadata: Readonly<{ readonly backupKind?: 'manual' }>; readonly createdAt: string; readonly updatedAt: string; }
export interface ManagedExport { readonly assetId: string; readonly kind: 'export'; readonly status: 'intent' | 'staged' | 'published' | 'quarantined' | 'failed' | 'needs_recovery'; readonly metadata: Readonly<Record<string, unknown>>; readonly createdAt: string; readonly updatedAt: string; }

export interface AgentControlPageRequest {
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface AgentControlPage<T> {
  readonly items: readonly T[];
  readonly page: { readonly pageSize: number; readonly hasMore: boolean; readonly nextCursor?: string };
}

export interface AgentControlMutationAcknowledgement { readonly clientId?: string; readonly sessionId?: string; readonly grantId?: string; readonly approvalId?: string; readonly changeSetId?: string; readonly enabled?: boolean; readonly revoked?: boolean; readonly terminated?: boolean; }
export interface AgentControlClientSummary { readonly clientId: string; readonly subjectId: string; readonly displayName: string; readonly scopes: readonly AgentScope[]; readonly trust: TrustProfile; readonly revokedAt?: string; readonly lastActiveAt?: string; }
export interface AgentControlSessionSummary { readonly sessionId: string; readonly clientId: string; readonly appInstanceId: string; readonly createdAt: string; readonly expiresAt: string; readonly lastActiveAt: string; readonly terminatedAt?: string; }
export interface AgentControlCreateR4GrantRequest { readonly clientId: string; readonly operation: OperationName; readonly payloadHash: string; readonly targetHash: string; readonly maxAffectedEntities: number; readonly expiresAt: string; }
export interface AgentControlR4GrantSummary { readonly grantId: string; readonly clientId: string; readonly operation: OperationName; readonly recovery: string; readonly maxAffectedEntities: number; readonly status: R4GrantStatus; readonly issuedAt: string; readonly expiresAt: string; readonly consumedAt?: string; readonly revokedAt?: string; }
export interface AgentControlApprovalSummary { readonly approvalId: string; readonly clientId: string; readonly operation: OperationName; readonly status: ApprovalStatus; readonly risk: string; readonly createdAt: string; readonly expiresAt: string; }
export interface AgentControlChangeSetSummary { readonly changeSetId: string; readonly clientId: string; readonly status: ChangeSetStatus; readonly summary: string; readonly risk: string; readonly createdAt: string; readonly expiresAt: string; }
export interface AgentControlAuditSummary { readonly sequence: number; readonly clientId: string; readonly operation?: string; readonly kind: AuditKind; readonly occurredAt: string; readonly risk?: string; }
export interface AgentControlStatus { readonly settings: { readonly externalControlEnabled: boolean; readonly policyVersion: string; readonly privacyRevision: number }; readonly runtimeState: string; readonly directHttps?: { readonly port: number; readonly authority: string; readonly resource: string; readonly issuer: string; readonly appInstanceId: string; readonly enabled: boolean; readonly state?: 'disabled' | 'ready' | 'stopped'; readonly reason?: string; readonly certificateThumbprint?: string; readonly rootCaThumbprint?: string }; }
export interface AgentControlPrivacyDisclosure { readonly revision: number; readonly externalModelDataDisclosureRequired: boolean; }
export interface AgentControlVerification { readonly valid: boolean; readonly segments: number; readonly events: number; readonly headHash?: string; }

export interface AgentControlApi {
  getStatus: () => Promise<AgentControlStatus>;
  setExternalControlEnabled: (enabled: boolean) => Promise<{ readonly enabled: boolean }>;
  listClients: (request?: AgentControlPageRequest) => Promise<AgentControlPage<AgentControlClientSummary>>;
  updateClientAccess: (clientId: string, scopes: readonly AgentScope[], trust: TrustProfile) => Promise<AgentControlMutationAcknowledgement>;
  revokeClient: (clientId: string) => Promise<AgentControlMutationAcknowledgement>;
  listSessions: (request?: AgentControlPageRequest & { readonly clientId?: string }) => Promise<AgentControlPage<AgentControlSessionSummary>>;
  terminateSession: (sessionId: string) => Promise<AgentControlMutationAcknowledgement>;
  listR4Grants: (request?: AgentControlPageRequest & { readonly clientId?: string; readonly status?: R4GrantStatus }) => Promise<AgentControlPage<AgentControlR4GrantSummary>>;
  createR4Grant: (grant: AgentControlCreateR4GrantRequest) => Promise<AgentControlR4GrantSummary>;
  revokeR4Grant: (grantId: string) => Promise<AgentControlMutationAcknowledgement>;
  listApprovals: (request?: AgentControlPageRequest & { readonly status?: ApprovalStatus }) => Promise<AgentControlPage<AgentControlApprovalSummary>>;
  approve: (approvalId: string) => Promise<AgentControlMutationAcknowledgement>;
  rejectApproval: (approvalId: string, reasonCode: string) => Promise<AgentControlMutationAcknowledgement>;
  listChangeSets: (request?: AgentControlPageRequest & { readonly status?: ChangeSetStatus }) => Promise<AgentControlPage<AgentControlChangeSetSummary>>;
  getChangeSet: (changeSetId: string) => Promise<AgentControlChangeSetSummary | null>;
  applyChangeSet: (changeSetId: string) => Promise<AgentControlMutationAcknowledgement>;
  rejectChangeSet: (changeSetId: string, reasonCode: string) => Promise<AgentControlMutationAcknowledgement>;
  searchAudit: (request?: AgentControlPageRequest & { readonly clientId?: string; readonly kinds?: readonly AuditKind[] }) => Promise<AgentControlPage<AgentControlAuditSummary>>;
  exportAudit: (request?: AgentControlPageRequest) => Promise<AgentControlVerification>;
  verifyAudit: (segmentId?: string) => Promise<AgentControlVerification>;
  getPolicy: () => Promise<{ readonly policyVersion: string; readonly externalControlEnabled: boolean }>;
  getCatalog: () => Promise<{ readonly version: string; readonly hash: string }>;
  getPrivacyDisclosure: () => Promise<AgentControlPrivacyDisclosure>;
  connectClient: (request: PairingRequest) => Promise<PairingStatus>;
  getClientConnection: (request: PairingTargetRequest) => Promise<PairingStatus>;
  repairClientConnection: (request: PairingTargetRequest) => Promise<PairingStatus>;
  rotateClientKey: (request: PairingTargetRequest) => Promise<PairingStatus>;
  disconnectClientConnection: (request: PairingTargetRequest) => Promise<PairingStatus>;
}

export interface AppApi {
  agentControl: AgentControlApi;
  knowledge: {
    listNodes: (parentNodeId?: string, subject?: string) => Promise<import('./types').KnowledgePoint[]>;
    getNode: (nodeId: string) => Promise<import('./types').SafeKnowledgeNode | null>;
    listLinks: (input: { nodeId?: string; questionId?: number }) => Promise<import('./agent/v1/contracts').KnowledgeLinkView[]>;
    listTextbooks: (subject?: string) => Promise<import('./types').SafeTextbook[]>;
    getTextbook: (textbookId: number) => Promise<import('./types').SafeTextbook | null>;
    getWeakAreas: (subject?: string) => Promise<import('./types').KnowledgePointReviewStats[]>;
    linkQuestion: (questionId: number, nodeId: string, matchType: 'gpt' | 'auto' | 'manual') => Promise<{ linked: boolean; questionId: number; nodeId: string }>;
    unlinkQuestion: (questionId: number, nodeId: string) => Promise<{ unlinked: boolean; questionId: number; nodeId: string }>;
    bindTextbook: (nodeId: string, textbookId: number) => Promise<{ bound: boolean; nodeId: string; textbookId: number }>;
  };
  dashboard: () => Promise<DashboardData>;
  listQuestions: (filters: QuestionFilters) => Promise<Question[]>;
  getQuestion: (id: number) => Promise<Question | null>;
  createQuestion: (input: QuestionInput) => Promise<Question>;
  updateQuestion: (id: number, input: QuestionInput) => Promise<Question>;
  deleteQuestion: (id: number, deleteImages: boolean) => Promise<boolean>;
  markMastery: (id: number, mastery: MasteryLevel) => Promise<Question>;
  chooseImages: () => Promise<string[]>;
  getImageUrl: (imagePath: string) => Promise<ImageUrlResult>;
  checkImageExists: (imagePath: string) => Promise<boolean>;
  openImage: (imagePath: string) => Promise<string>;
  revealImageInFolder: (imagePath: string) => Promise<boolean>;
  removeImage: (id: number, deleteFile: boolean) => Promise<boolean>;
  listReviewLogs: (questionId: number) => Promise<ReviewLog[]>;
  addReviewLog: (input: ReviewInput) => Promise<Question>;
  submitReviewResult: (input: ReviewSubmitInput) => Promise<ReviewSubmitResult>;
  getReviewBuckets: () => Promise<ReviewBuckets>;
  getStats: () => Promise<StatsData>;
  getPaths: () => Promise<AppPaths>;
  exportData: () => Promise<string>;
  chooseJson: () => Promise<string | null>;
  importData: (filePath: string) => Promise<{ imported: boolean; backup: string }>;
  clearAllData: (deleteImages: boolean) => Promise<boolean>;
  chooseRoot: () => Promise<string | null>;
  setRoot: (root: string, migrate: boolean) => Promise<AppPaths>;
  createDatabaseBackup: () => Promise<ManagedGlobalJob>;
  ensureDailyAutoBackup: () => Promise<DatabaseBackupResult | null>;
  listDatabaseBackups: () => Promise<readonly ManagedBackup[]>;
  listLegacyDatabaseBackups: () => Promise<DatabaseBackupInfo[]>;
  restoreDatabaseBackup: (fileName: string) => Promise<RestoreDatabaseBackupResult>;
  deleteDatabaseBackup: (fileName: string) => Promise<boolean>;
  openBackupsFolder: () => Promise<boolean>;
  exportQuestionsToPdf: (options: Pick<PdfExportOptions, 'scope' | 'mode' | 'questionIds'>) => Promise<ManagedGlobalJob>;
  getManagedExport: (assetId: string) => Promise<ManagedExport>;
  openExportedPdf: (filePath: string) => Promise<boolean>;
  openExportsFolder: () => Promise<boolean>;
  createImportTemplate: () => Promise<string>;
  prepareExcelImport: () => Promise<StructuredImportPreview | null>;
  prepareJsonStructuredImport: () => Promise<StructuredImportPreview | null>;
  prepareZipImport: () => Promise<StructuredImportPreview | null>;
  confirmStructuredImport: (sessionId: string) => Promise<StructuredImportResult>;
  cancelStructuredImport: (sessionId: string) => Promise<boolean>;
  imports: {
    selectImages: () => Promise<{ readonly selectionToken: string; readonly filePaths: readonly string[] }>;
    createDraft: (payload: import('./imports/v1').ImportsCreateDraftCommand['payload']) => Promise<import('./imports/v1').ImportDraft>;
    addDraftImage: (payload: import('./imports/v1').ImportsAddDraftImageCommand['payload']) => Promise<import('./imports/v1').ImportDraft>;
    validateDraft: (draftId: string) => Promise<import('./imports/v1').ImportDraftValidation>;
    previewDraft: (draftId: string) => Promise<import('./imports/v1').ImportDraftValidation>;
    applyDraft: (draftId: string, previewHash: string) => Promise<import('./imports/v1').ImportsCommandValues['imports.apply_draft']>;
    get: (draftId: string) => Promise<import('./imports/v1').ImportDraft>;
    cancel: (draftId: string) => Promise<import('./imports/v1').ImportsCommandValues['imports.cancel']>;
    stageSelectedImages: (selectionToken: string) => Promise<readonly { assetId: string; fileName: string; sha256: string; size: number }[]>;
  };
  importKnowledgeMapZip: () => Promise<KnowledgeMapImportResult | null>;
  importQuestionBankZip: () => Promise<QuestionBankImportResult | null>;
  listExternalQuestions: (filters: ExternalQuestionFilters) => Promise<ExternalQuestion[]>;
  getExternalQuestion: (id: number) => Promise<ExternalQuestion | null>;
  getExternalQuestionStats: () => Promise<ExternalQuestionStats>;
  getExternalQuestionAssetUrl: (id: number, resourcePath: string) => Promise<ImageUrlResult>;
  recordExternalQuestionAttempt: (input: ExternalQuestionAttemptInput) => Promise<ExternalQuestionAttempt>;
  addExternalQuestionToMistakes: (id: number) => Promise<AddExternalQuestionToMistakesResult>;
  deleteExternalQuestionBatch: (batchId: string) => Promise<DeleteExternalQuestionBatchResult>;
  listImportBatches: () => Promise<ImportBatch[]>;
  getImportBatchDetail: (batchId: string) => Promise<ImportBatchDetail | null>;
  deleteImportBatch: (batchId: string, options?: DeleteImportBatchOptions) => Promise<DeleteImportBatchResult>;
  listLegacyExternalQuestionGroups: () => Promise<LegacyExternalQuestionGroup[]>;
  deleteLegacyExternalQuestionGroup: (groupKey: string) => Promise<DeleteLegacyExternalQuestionGroupResult>;
  openTrashFolder: () => Promise<boolean>;
  openExternalQuestionPaper: (id: number) => Promise<boolean>;
  openExternalQuestionSolutionPdf: (id: number) => Promise<boolean>;
  listKnowledgeTree: () => Promise<KnowledgePointTreeNode[]>;
  getKnowledgeDetail: (nodeId: string) => Promise<KnowledgePointDetail | null>;
  openTextbookPage: (nodeId: string) => Promise<OpenTextbookResult>;
  bindTextbookPdf: (nodeId: string) => Promise<BindTextbookPdfResult | null>;
  rematchKnowledgePoints: () => Promise<KnowledgeRematchResult>;
  listKnowledgeForQuestion: (questionId: number) => Promise<KnowledgePoint[]>;
  listKnowledgeReviewStats: () => Promise<KnowledgePointReviewStats[]>;
  getKnowledgePointReviewStats: (nodeId: string, includeChildren?: boolean) => Promise<KnowledgePointReviewStats | null>;
  getKnowledgeReviewQuestions: (nodeId: string, mode: KnowledgeReviewMode, includeChildren: boolean) => Promise<KnowledgePointReviewQuestionsResult>;
  getStudySettings: () => Promise<StudySettings>;
  updateStudySettings: (input: Partial<StudySettings>) => Promise<StudySettings>;
  listStudySubjects: () => Promise<StudySubject[]>;
  listStudyMaterials: (filters?: StudyMaterialFilters) => Promise<StudyMaterial[]>;
  createStudyMaterial: (input: StudyMaterialInput) => Promise<StudyMaterial>;
  updateStudyMaterial: (id: string, input: StudyMaterialInput) => Promise<StudyMaterial | null>;
  deleteStudyMaterial: (id: string) => Promise<boolean>;
  updateStudyMaterialProgress: (id: string, currentAmount: number) => Promise<StudyMaterial | null>;
  listStudyTasks: (filters?: StudyTaskFilters) => Promise<StudyTask[]>;
  listTodayStudyTasks: () => Promise<StudyTask[]>;
  createStudyTask: (input: StudyTaskInput) => Promise<StudyTask>;
  updateStudyTask: (id: string, input: StudyTaskInput) => Promise<StudyTask | null>;
  deleteStudyTask: (id: string) => Promise<boolean>;
  completeStudyTask: (id: string, input?: { actual_minutes?: number; completion_quality?: StudyQuality; note?: string }) => Promise<StudyTask | null>;
  skipStudyTask: (id: string, reason: string) => Promise<StudyTask | null>;
  rolloverStudyTasks: () => Promise<{ rolled: number; skipped: boolean }>;
  listStudySessions: (filters?: StudySessionFilters) => Promise<StudySession[]>;
  createStudySession: (input: StudySessionInput) => Promise<StudySession>;
  deleteStudySession: (id: string) => Promise<boolean>;
  getDailyReview: (date: string) => Promise<DailyReview | null>;
  saveDailyReview: (input: DailyReviewInput) => Promise<DailyReview | null>;
  getStudySupervisorDashboard: (date?: string) => Promise<StudySupervisorDashboard>;
  getStudyToday: (date?: string) => Promise<import('./agent/v1/contracts').StudyTodaySummary>;
  getStudyWeekSummary: (date?: string) => Promise<import('./agent/v1/contracts').StudyWeekSummary>;
  createStudyPlanDraft: (date: string, tasks: import('./agent/v1/contracts').StudyCreatePlanDraftCommand['payload']['tasks']) => Promise<import('./agent/v1/contracts').StudyCommandValues['study.create_plan_draft']>;
  applyStudyPlanAdjustment: (payload: import('./agent/v1/contracts').StudyApplyPlanAdjustmentCommand['payload']) => Promise<import('./agent/v1/contracts').StudyCommandValues['study.apply_plan_adjustment']>;
  recordStudyManualProgress: (payload: import('./agent/v1/contracts').StudyRecordManualProgressCommand['payload']) => Promise<import('./agent/v1/contracts').StudyCommandValues['study.record_manual_progress']>;
  saveWindowState: (state: WindowState) => void;
  loadWindowState: () => Promise<WindowState | null>;

  // DeepSeek settings
  getDeepSeekSettings: () => Promise<DeepSeekSettings>;
  saveDeepSeekSettings: (input: DeepSeekSettings) => Promise<DeepSeekSettings>;

  // OCR
  runOcr: (imagePaths: string[]) => Promise<OcrResult[]>;
  checkPythonEnv: () => Promise<void>;
  testDeepSeekConnection: () => Promise<void>;

  // AI structuring
  structureQuestion: (ocrTexts: string[]) => Promise<AiStructuredQuestion>;

  // AI error diagnosis
  diagnoseError: (questionId: number) => Promise<AiDiagnosisResult>;

  // TickTick Lists
  listTickTickLists: () => Promise<TickTickList[]>;
  getTickTickList: (id: string) => Promise<TickTickList | null>;
  createTickTickList: (input: TickTickListInput) => Promise<TickTickList>;
  updateTickTickList: (id: string, input: TickTickListInput) => Promise<TickTickList | null>;
  deleteTickTickList: (id: string) => Promise<boolean>;
  reorderTickTickLists: (ids: string[]) => Promise<void>;

  // TickTick Tasks
  listTickTickTasks: (filters?: TickTickTaskFilters) => Promise<TickTickTask[]>;
  getTickTickTask: (id: string) => Promise<TickTickTask | null>;
  createTickTickTask: (input: TickTickTaskInput) => Promise<TickTickTask>;
  updateTickTickTask: (id: string, input: Partial<TickTickTaskInput> & { is_completed?: number; actual_minutes?: number; pomodoro_sessions?: number; sort_order?: number }) => Promise<TickTickTask | null>;
  deleteTickTickTask: (id: string) => Promise<boolean>;
  completeTickTickTask: (id: string) => Promise<TickTickTask | null>;
  uncompleteTickTickTask: (id: string) => Promise<TickTickTask | null>;
  getTodayTickTickTasks: () => Promise<{ overdue: TickTickTask[]; today: TickTickTask[]; upcoming: TickTickTask[] }>;

  // TickTick Tags
  listTickTickTags: () => Promise<TickTickTag[]>;

  // TickTick Focus Sessions
  listTickTickFocusSessions: (filters?: { date?: string; taskId?: string }) => Promise<TickTickFocusSession[]>;
  createTickTickFocusSession: (input: TickTickFocusSessionInput) => Promise<TickTickFocusSession>;

  // TickTick Bridge
  getTickTickTaskBridges: (taskId: string) => Promise<TickTickBridge[]>;
  createTickTickBridge: (input: TickTickBridgeInput) => Promise<TickTickBridge>;
  deleteTickTickBridge: (id: number) => Promise<boolean>;
  getBridgesForLinked: (linkedType: TickTickBridgeLinkedType, linkedId: string) => Promise<TickTickBridge[]>;

  // TickTick Calendar
  getTickTickCalendarMonth: (year: number, month: number) => Promise<TickTickCalendarDay[]>;

  // TickTick AI
  aiDecomposeTask: (input: TickTickAiDecompositionInput) => Promise<TickTickAiDecompositionResult>;
  aiGenerateDailyPlan: () => Promise<TickTickAiDailyPlanResult>;
  aiGenerateReview: (type: 'daily' | 'weekly') => Promise<TickTickAiReviewResult>;

  // TickTick Settings
  getTickTickSettings: () => Promise<TickTickSettings>;
  saveTickTickSettings: (settings: TickTickSettings) => Promise<TickTickSettings>;

  // White Noise
  getTickTickWhiteNoiseState: () => Promise<{ enabled: boolean; noise: TickTickWhiteNoise }>;
  setTickTickWhiteNoiseState: (state: { enabled: boolean; noise: TickTickWhiteNoise }) => Promise<void>;

  // Shared timer state (single source of truth: main engine)
  getSharedTimerState: () => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;
  startSharedTimer: () => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;
  pauseSharedTimer: () => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;
  resetSharedTimer: () => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;
  skipBreakSharedTimer: () => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;
  bindTimerTask: (taskId: string | null) => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;
  setTimerConfig: (config: { focusMinutes?: number; shortBreakMinutes?: number; longBreakMinutes?: number; sessionsBeforeLongBreak?: number }) => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;

  // Widget
  openWidget: () => void;
  closeWidget: () => void;
  toggleWidgetPin: (pinned: boolean) => void;
  setWidgetOpacity: (opacity: number) => void;
  setWidgetSize: (width: number, height: number) => void;
  setWidgetBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  openMainWindow: () => void;
  isWidgetOpen: () => Promise<boolean>;

  // Auto review task creation
  triggerReviewTaskGeneration: () => Promise<{ created: number }>;
  syncTickTickTaskCompletedToReview: (taskId: string, taskTitle: string, actualMinutes: number) => Promise<void>;
  undoReviewTaskSync: (taskId: string, taskTitle: string) => Promise<void>;
  syncReviewToTickTick: (linkedType: TickTickBridgeLinkedType, linkedId: string) => Promise<void>;
  syncMasteryToTickTick: (knowledgeNodeId: string, newMasteryScore: number) => Promise<void>;

  // TickTick Habits
  listTickTickHabits: () => Promise<TickTickHabit[]>;
  createTickTickHabit: (input: TickTickHabitInput) => Promise<TickTickHabit>;
  updateTickTickHabit: (id: string, input: TickTickHabitInput) => Promise<TickTickHabit | null>;
  deleteTickTickHabit: (id: string) => Promise<boolean>;
  toggleTickTickHabit: (habitId: string, date: string) => Promise<TickTickHabitLog | null>;
  getTickTickHabitLogs: (habitId: string, fromDate?: string, toDate?: string) => Promise<TickTickHabitLog[]>;

  toFileUrl: (filePath: string) => string;
}
