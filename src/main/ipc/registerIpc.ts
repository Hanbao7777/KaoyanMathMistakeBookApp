import { ipcMain } from 'electron';
import {
  addReviewLog,
  clearAllData,
  createQuestion,
  deleteQuestion,
  exportData,
  getCurrentPaths,
  getDashboard,
  getQuestion,
  getReviewBuckets,
  getStats,
  importData,
  initializeDatabase,
  listQuestions,
  listReviewLogs,
  markMastery,
  removeImage,
  resetDatabaseConnection,
  submitReviewResult,
  updateQuestion
} from '../services/databaseService';
import { chooseDataRoot, chooseImages, chooseJsonFile } from '../services/fileService';
import { copyExistingData, getPaths, setDataRoot } from '../services/pathService';
import { checkImageExists, getImageUrl, openImage, revealImageInFolder } from '../services/imageService';
import { createDatabaseBackup, deleteDatabaseBackup, ensureDailyAutoBackup, listDatabaseBackups, openBackupsFolder, restoreDatabaseBackup } from '../services/backupService';
import { exportQuestionsToPdf, openExportedPdf, openExportsFolder } from '../services/pdfExportService';
import {
  cleanupStructuredImport,
  confirmStructuredImport,
  createImportTemplate,
  prepareExcelImport,
  prepareJsonImport,
  prepareZipImport
} from '../services/structuredImportService';
import {
  getKnowledgeDetail,
  bindTextbookPdf,
  getKnowledgePointReviewStats,
  getKnowledgeReviewQuestions,
  importKnowledgeMapZip,
  listKnowledgeForQuestion,
  listKnowledgeReviewStats,
  listKnowledgeTree,
  openTextbookPage,
  rematchKnowledgePoints
} from '../services/knowledgeMapService';
import {
  addExternalQuestionToMistakes,
  deleteExternalQuestionBatch,
  getExternalQuestion,
  getExternalQuestionAssetUrl,
  getExternalQuestionStats,
  importQuestionBankZip,
  listExternalQuestions,
  openExternalQuestionPaper,
  openExternalQuestionSolutionPdf,
  recordExternalQuestionAttempt
} from '../services/questionBankService';
import {
  deleteImportBatch,
  deleteLegacyExternalQuestionGroup,
  getImportBatchDetail,
  listImportBatches,
  listLegacyExternalQuestionGroups,
  openTrashFolder
} from '../services/importBatchService';
import {
  completeStudyTask,
  createStudyMaterial,
  createStudySession,
  createStudyTask,
  deleteStudyMaterial,
  deleteStudySession,
  deleteStudyTask,
  getDailyReview,
  getStudySettings,
  getStudySupervisorDashboard,
  listStudyMaterials,
  listStudySessions,
  listStudySubjects,
  listStudyTasks,
  listTodayStudyTasks,
  rolloverStudyTasks,
  saveDailyReview,
  skipStudyTask,
  updateStudyMaterial,
  updateStudyMaterialProgress,
  updateStudySettings,
  updateStudyTask
} from '../services/studySupervisorService';
import type {
  DatabaseBackupKind,
  DeleteImportBatchOptions,
  ExternalQuestionAttemptInput,
  ExternalQuestionFilters,
  KnowledgeReviewMode,
  MasteryLevel,
  PdfExportOptions,
  QuestionFilters,
  QuestionInput,
  ReviewInput,
  ReviewSubmitInput,
  DailyReviewInput,
  StudyMaterialFilters,
  StudyMaterialInput,
  StudyQuality,
  StudySessionFilters,
  StudySessionInput,
  StudySettings,
  StudyTaskFilters,
  StudyTaskInput
} from '../../shared/types';

function handle<TArgs extends unknown[], TResult>(channel: string, listener: (...args: TArgs) => Promise<TResult> | TResult) {
  ipcMain.handle(channel, async (_event, ...args: TArgs) => {
    try {
      return { ok: true, data: await listener(...args) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function registerIpc() {
  handle('dashboard:get', () => getDashboard());
  handle('questions:list', (filters: QuestionFilters) => listQuestions(filters));
  handle('questions:get', (id: number) => getQuestion(id));
  handle('questions:create', (input: QuestionInput) => createQuestion(input));
  handle('questions:update', (id: number, input: QuestionInput) => updateQuestion(id, input));
  handle('questions:delete', (id: number, deleteImages: boolean) => deleteQuestion(id, deleteImages));
  handle('questions:markMastery', (id: number, mastery: MasteryLevel) => markMastery(id, mastery));
  handle('images:remove', (id: number, deleteFile: boolean) => removeImage(id, deleteFile));
  handle('images:choose', () => chooseImages());
  handle('images:getUrl', (imagePath: string) => getImageUrl(imagePath));
  handle('images:exists', (imagePath: string) => checkImageExists(imagePath));
  handle('images:open', (imagePath: string) => openImage(imagePath));
  handle('images:reveal', (imagePath: string) => revealImageInFolder(imagePath));
  handle('reviews:list', (questionId: number) => listReviewLogs(questionId));
  handle('reviews:add', (input: ReviewInput) => addReviewLog(input));
  handle('reviews:submitResult', (input: ReviewSubmitInput) => submitReviewResult(input));
  handle('review:buckets', () => getReviewBuckets());
  handle('stats:get', () => getStats());
  handle('paths:get', () => getCurrentPaths());
  handle('settings:export', () => exportData());
  handle('settings:chooseJson', () => chooseJsonFile());
  handle('settings:import', (filePath: string) => importData(filePath));
  handle('settings:clear', (deleteImages: boolean) => clearAllData(deleteImages));
  handle('settings:chooseRoot', () => chooseDataRoot());
  handle('settings:setRoot', async (root: string, migrate: boolean) => {
    const oldPaths = getPaths();
    const newPaths = setDataRoot(root);
    if (migrate) copyExistingData(oldPaths, newPaths);
    resetDatabaseConnection();
    await initializeDatabase();
    return getPaths();
  });
  handle('backups:create', (type?: DatabaseBackupKind) => createDatabaseBackup(type || 'manual'));
  handle('backups:ensureDaily', () => ensureDailyAutoBackup());
  handle('backups:list', () => listDatabaseBackups());
  handle('backups:restore', (fileName: string) => restoreDatabaseBackup(fileName));
  handle('backups:delete', (fileName: string) => deleteDatabaseBackup(fileName));
  handle('backups:openFolder', () => openBackupsFolder());
  handle('pdfExport:create', (options: PdfExportOptions) => exportQuestionsToPdf(options));
  handle('pdfExport:open', (filePath: string) => openExportedPdf(filePath));
  handle('pdfExport:openFolder', () => openExportsFolder());
  handle('structuredImport:template', () => createImportTemplate());
  handle('structuredImport:prepareExcel', () => prepareExcelImport());
  handle('structuredImport:prepareJson', () => prepareJsonImport());
  handle('structuredImport:prepareZip', () => prepareZipImport());
  handle('structuredImport:confirm', (sessionId: string) => confirmStructuredImport(sessionId));
  handle('structuredImport:cancel', (sessionId: string) => cleanupStructuredImport(sessionId));
  handle('knowledgeMap:importZip', () => importKnowledgeMapZip());
  handle('knowledgeMap:listTree', () => listKnowledgeTree());
  handle('knowledgeMap:getDetail', (nodeId: string) => getKnowledgeDetail(nodeId));
  handle('knowledgeMap:openTextbookPage', (nodeId: string) => openTextbookPage(nodeId));
  handle('knowledgeMap:bindTextbookPdf', (nodeId: string) => bindTextbookPdf(nodeId));
  handle('knowledgeMap:rematch', () => rematchKnowledgePoints());
  handle('knowledgeMap:listForQuestion', (questionId: number) => listKnowledgeForQuestion(questionId));
  handle('knowledgeMap:listReviewStats', () => listKnowledgeReviewStats());
  handle('knowledgeMap:getReviewStats', (nodeId: string, includeChildren?: boolean) => getKnowledgePointReviewStats(nodeId, includeChildren ?? true));
  handle('knowledgeMap:getReviewQuestions', (nodeId: string, mode: KnowledgeReviewMode, includeChildren: boolean) => getKnowledgeReviewQuestions(nodeId, mode, includeChildren));
  handle('questionBank:importZip', () => importQuestionBankZip());
  handle('questionBank:list', (filters: ExternalQuestionFilters) => listExternalQuestions(filters));
  handle('questionBank:get', (id: number) => getExternalQuestion(id));
  handle('questionBank:stats', () => getExternalQuestionStats());
  handle('questionBank:getAssetUrl', (id: number, resourcePath: string) => getExternalQuestionAssetUrl(id, resourcePath));
  handle('questionBank:recordAttempt', (input: ExternalQuestionAttemptInput) => recordExternalQuestionAttempt(input));
  handle('questionBank:addToMistakes', (id: number) => addExternalQuestionToMistakes(id));
  handle('questionBank:deleteBatch', (batchId: string) => deleteExternalQuestionBatch(batchId));
  handle('questionBank:openPaper', (id: number) => openExternalQuestionPaper(id));
  handle('questionBank:openSolutionPdf', (id: number) => openExternalQuestionSolutionPdf(id));
  handle('importBatches:list', () => listImportBatches());
  handle('importBatches:getDetail', (batchId: string) => getImportBatchDetail(batchId));
  handle('importBatches:delete', (batchId: string, options?: DeleteImportBatchOptions) => deleteImportBatch(batchId, options));
  handle('importBatches:listLegacyExternalGroups', () => listLegacyExternalQuestionGroups());
  handle('importBatches:deleteLegacyExternalGroup', (groupKey: string) => deleteLegacyExternalQuestionGroup(groupKey));
  handle('importBatches:openTrashFolder', () => openTrashFolder());
  handle('study:settings:get', () => getStudySettings());
  handle('study:settings:update', (input: Partial<StudySettings>) => updateStudySettings(input));
  handle('study:subjects:list', () => listStudySubjects());
  handle('study:materials:list', (filters?: StudyMaterialFilters) => listStudyMaterials(filters || {}));
  handle('study:materials:create', (input: StudyMaterialInput) => createStudyMaterial(input));
  handle('study:materials:update', (id: string, input: StudyMaterialInput) => updateStudyMaterial(id, input));
  handle('study:materials:delete', (id: string) => deleteStudyMaterial(id));
  handle('study:materials:updateProgress', (id: string, currentAmount: number) => updateStudyMaterialProgress(id, currentAmount));
  handle('study:tasks:list', (filters?: StudyTaskFilters) => listStudyTasks(filters || {}));
  handle('study:tasks:today', () => listTodayStudyTasks());
  handle('study:tasks:create', (input: StudyTaskInput) => createStudyTask(input));
  handle('study:tasks:update', (id: string, input: StudyTaskInput) => updateStudyTask(id, input));
  handle('study:tasks:delete', (id: string) => deleteStudyTask(id));
  handle('study:tasks:complete', (id: string, input?: { actual_minutes?: number; completion_quality?: StudyQuality; note?: string }) => completeStudyTask(id, input));
  handle('study:tasks:skip', (id: string, reason: string) => skipStudyTask(id, reason));
  handle('study:tasks:rollover', () => rolloverStudyTasks());
  handle('study:sessions:list', (filters?: StudySessionFilters) => listStudySessions(filters || {}));
  handle('study:sessions:create', (input: StudySessionInput) => createStudySession(input));
  handle('study:sessions:delete', (id: string) => deleteStudySession(id));
  handle('study:reviews:get', (date: string) => getDailyReview(date));
  handle('study:reviews:save', (input: DailyReviewInput) => saveDailyReview(input));
  handle('study:dashboard', (date?: string) => getStudySupervisorDashboard(date));
}
