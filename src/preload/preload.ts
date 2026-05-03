import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi } from '../shared/api';
import type {
  AppPaths,
  BindTextbookPdfResult,
  DashboardData,
  DatabaseBackupInfo,
  DatabaseBackupKind,
  DatabaseBackupResult,
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
} from '../shared/types';

type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: string };

async function invoke<T>(channel: string, ...args: unknown[]) {
  const response = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>;
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

const api: AppApi = {
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
  createDatabaseBackup: (type?: DatabaseBackupKind) => invoke<DatabaseBackupResult>('backups:create', type),
  ensureDailyAutoBackup: () => invoke<DatabaseBackupResult | null>('backups:ensureDaily'),
  listDatabaseBackups: () => invoke<DatabaseBackupInfo[]>('backups:list'),
  restoreDatabaseBackup: (fileName: string) => invoke<RestoreDatabaseBackupResult>('backups:restore', fileName),
  deleteDatabaseBackup: (fileName: string) => invoke<boolean>('backups:delete', fileName),
  openBackupsFolder: () => invoke<boolean>('backups:openFolder'),
  exportQuestionsToPdf: (options: PdfExportOptions) => invoke<PdfExportResult>('pdfExport:create', options),
  openExportedPdf: (filePath: string) => invoke<boolean>('pdfExport:open', filePath),
  openExportsFolder: () => invoke<boolean>('pdfExport:openFolder'),
  createImportTemplate: () => invoke<string>('structuredImport:template'),
  prepareExcelImport: () => invoke<StructuredImportPreview | null>('structuredImport:prepareExcel'),
  prepareJsonStructuredImport: () => invoke<StructuredImportPreview | null>('structuredImport:prepareJson'),
  prepareZipImport: () => invoke<StructuredImportPreview | null>('structuredImport:prepareZip'),
  confirmStructuredImport: (sessionId: string) => invoke<StructuredImportResult>('structuredImport:confirm', sessionId),
  cancelStructuredImport: (sessionId: string) => invoke<boolean>('structuredImport:cancel', sessionId),
  importKnowledgeMapZip: () => invoke<KnowledgeMapImportResult | null>('knowledgeMap:importZip'),
  listKnowledgeTree: () => invoke<KnowledgePointTreeNode[]>('knowledgeMap:listTree'),
  getKnowledgeDetail: (nodeId: string) => invoke<KnowledgePointDetail | null>('knowledgeMap:getDetail', nodeId),
  openTextbookPage: (nodeId: string) => invoke<OpenTextbookResult>('knowledgeMap:openTextbookPage', nodeId),
  bindTextbookPdf: (nodeId: string) => invoke<BindTextbookPdfResult | null>('knowledgeMap:bindTextbookPdf', nodeId),
  rematchKnowledgePoints: () => invoke<KnowledgeRematchResult>('knowledgeMap:rematch'),
  listKnowledgeForQuestion: (questionId: number) => invoke<KnowledgePoint[]>('knowledgeMap:listForQuestion', questionId),
  listKnowledgeReviewStats: () => invoke<KnowledgePointReviewStats[]>('knowledgeMap:listReviewStats'),
  getKnowledgePointReviewStats: (nodeId: string, includeChildren = true) => invoke<KnowledgePointReviewStats | null>('knowledgeMap:getReviewStats', nodeId, includeChildren),
  getKnowledgeReviewQuestions: (nodeId: string, mode: KnowledgeReviewMode, includeChildren: boolean) => invoke<KnowledgePointReviewQuestionsResult>('knowledgeMap:getReviewQuestions', nodeId, mode, includeChildren),
  toFileUrl: (filePath: string) => `mistake-image:///${encodeURIComponent(filePath)}`
};

contextBridge.exposeInMainWorld('api', api);
