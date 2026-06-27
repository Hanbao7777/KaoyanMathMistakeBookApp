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

export interface AppApi {
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
  createDatabaseBackup: (type?: DatabaseBackupKind) => Promise<DatabaseBackupResult>;
  ensureDailyAutoBackup: () => Promise<DatabaseBackupResult | null>;
  listDatabaseBackups: () => Promise<DatabaseBackupInfo[]>;
  restoreDatabaseBackup: (fileName: string) => Promise<RestoreDatabaseBackupResult>;
  deleteDatabaseBackup: (fileName: string) => Promise<boolean>;
  openBackupsFolder: () => Promise<boolean>;
  exportQuestionsToPdf: (options: PdfExportOptions) => Promise<PdfExportResult>;
  openExportedPdf: (filePath: string) => Promise<boolean>;
  openExportsFolder: () => Promise<boolean>;
  createImportTemplate: () => Promise<string>;
  prepareExcelImport: () => Promise<StructuredImportPreview | null>;
  prepareJsonStructuredImport: () => Promise<StructuredImportPreview | null>;
  prepareZipImport: () => Promise<StructuredImportPreview | null>;
  confirmStructuredImport: (sessionId: string) => Promise<StructuredImportResult>;
  cancelStructuredImport: (sessionId: string) => Promise<boolean>;
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
  recordAiImport: (questionId: number) => Promise<{ batchId: string }>;

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

  // Shared timer state
  getSharedTimerState: () => Promise<{ status: string; secondsLeft: number; totalSeconds: number; completedSessions: number; currentSession: number; sessionStartTime: number | null; boundTaskId: string | null }>;
  setSharedTimerState: (state: any) => Promise<void>;

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
