import type {
  AppPaths,
  DashboardData,
  DatabaseBackupInfo,
  DatabaseBackupKind,
  DatabaseBackupResult,
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
  QuestionFilters,
  QuestionInput,
  ReviewBuckets,
  ReviewInput,
  ReviewLog,
  ReviewSubmitInput,
  ReviewSubmitResult,
  RestoreDatabaseBackupResult,
  StatsData,
  StructuredImportPreview,
  StructuredImportResult
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
  listKnowledgeTree: () => Promise<KnowledgePointTreeNode[]>;
  getKnowledgeDetail: (nodeId: string) => Promise<KnowledgePointDetail | null>;
  openTextbookPage: (nodeId: string) => Promise<OpenTextbookResult>;
  bindTextbookPdf: (nodeId: string) => Promise<BindTextbookPdfResult | null>;
  rematchKnowledgePoints: () => Promise<KnowledgeRematchResult>;
  listKnowledgeForQuestion: (questionId: number) => Promise<KnowledgePoint[]>;
  listKnowledgeReviewStats: () => Promise<KnowledgePointReviewStats[]>;
  getKnowledgePointReviewStats: (nodeId: string, includeChildren?: boolean) => Promise<KnowledgePointReviewStats | null>;
  getKnowledgeReviewQuestions: (nodeId: string, mode: KnowledgeReviewMode, includeChildren: boolean) => Promise<KnowledgePointReviewQuestionsResult>;
  toFileUrl: (filePath: string) => string;
}
