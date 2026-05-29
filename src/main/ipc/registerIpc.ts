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
import { getDeepSeekSettings, saveDeepSeekSettings, structureQuestion as structureQuestionAi, diagnoseError as diagnoseErrorAi } from '../services/deepseekService';
import { runOcr as runOcrService, getPythonPath } from '../services/ocrService';
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
import {
  listTickTickLists, getTickTickList, createTickTickList, updateTickTickList, deleteTickTickList, reorderTickTickLists,
  listTickTickTasks, getTickTickTask, createTickTickTask, updateTickTickTask, deleteTickTickTask,
  completeTickTickTask, uncompleteTickTickTask, getTodayTickTickTasks,
  listTickTickTags,
  listTickTickFocusSessions, createTickTickFocusSession,
  getTickTickTaskBridges, createTickTickBridge, deleteTickTickBridge, getBridgesForLinked,
  getTickTickCalendarMonth,
  getTickTickSettings, saveTickTickSettings,
  listTickTickHabits, createTickTickHabit, updateTickTickHabit, deleteTickTickHabit, toggleTickTickHabit, getTickTickHabitLogs
} from '../services/ticktickService';
import { syncTaskCompletedToReview, syncReviewToTickTickTask, syncMasteryToTaskPriority, generateAutoReviewTasks, undoSyncTaskCompleted } from '../services/bridgeService';
import { aiDecomposeTask, aiGenerateDailyPlan, aiGenerateReview } from '../services/ticktickAiService';
import type {
  DatabaseBackupKind,
  DeepSeekSettings,
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
  StudyTaskInput,
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
  TickTickHabitInput,
  TickTickHabitLog
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

  // DeepSeek Settings
  handle('deepseek:settings:get', () => getDeepSeekSettings());
  handle('deepseek:settings:save', (input: DeepSeekSettings) => saveDeepSeekSettings(input));

  // OCR
  handle('ocr:run', (imagePaths: string[]) => runOcrService(imagePaths));

  // AI Structuring
  handle('deepseek:structure', (ocrTexts: string[]) => structureQuestionAi(ocrTexts));

  // AI Diagnosis
  handle('deepseek:diagnose', async (questionId: number) => {
    const { getQuestion } = await import('../services/databaseService');
    const question = await getQuestion(questionId);
    if (!question) throw new Error('错题未找到');
    return diagnoseErrorAi(
      question.content,
      question.answer,
      question.wrong_thinking || question.wrong_solution,
      question.correct_solution
    );
  });

  // Python env check
  handle('python:checkEnv', async () => {
    const { execSync } = await import('node:child_process');
    const python = getPythonPath();
    try {
      execSync(`"${python}" -c "from paddleocr import PaddleOCR; print('OK')"`, { timeout: 30000, encoding: 'utf8' });
    } catch {
      throw new Error('无法加载 PaddleOCR。请确认已执行: pip install paddlepaddle paddleocr');
    }
  });

  // DeepSeek connection test
  handle('deepseek:testConnection', async () => {
    const settings = await getDeepSeekSettings();
    if (!settings.apiKey) throw new Error('请先填写 API Key');

    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`连接失败 (${response.status}): ${errorText.slice(0, 300)}`);
    }
  });

  // AI import batch record
  handle('ai:recordImport', async (questionId: number) => {
    const { createImportBatch, recordImportBatchItem } = await import('../services/importBatchService');
    const { getDatabase } = await import('../services/databaseService');
    const db = await getDatabase();
    const batchId = await createImportBatch({
      type: 'wrong_questions',
      name: `AI 导入 - ${new Date().toLocaleString('zh-CN')}`,
      source: 'AI 智能导入',
      sourceFileName: `ai-import-${Date.now()}`
    });
    recordImportBatchItem(db, batchId, 'questions', questionId, 'created');
    return { batchId };
  });

  // TickTick Lists
  handle('ticktick:lists:list', () => listTickTickLists());
  handle('ticktick:lists:get', (id: string) => getTickTickList(id));
  handle('ticktick:lists:create', (input: TickTickListInput) => createTickTickList(input));
  handle('ticktick:lists:update', (id: string, input: TickTickListInput) => updateTickTickList(id, input));
  handle('ticktick:lists:delete', (id: string) => deleteTickTickList(id));
  handle('ticktick:lists:reorder', (ids: string[]) => reorderTickTickLists(ids));

  // TickTick Tasks
  handle('ticktick:tasks:list', (filters?: TickTickTaskFilters) => listTickTickTasks(filters));
  handle('ticktick:tasks:get', (id: string) => getTickTickTask(id));
  handle('ticktick:tasks:create', (input: TickTickTaskInput) => createTickTickTask(input));
  handle('ticktick:tasks:update', (id: string, input: Partial<TickTickTaskInput> & { is_completed?: number; actual_minutes?: number; pomodoro_sessions?: number; sort_order?: number }) => updateTickTickTask(id, input));
  handle('ticktick:tasks:delete', (id: string) => deleteTickTickTask(id));
  handle('ticktick:tasks:complete', (id: string) => completeTickTickTask(id));
  handle('ticktick:tasks:uncomplete', (id: string) => uncompleteTickTickTask(id));
  handle('ticktick:tasks:today', () => getTodayTickTickTasks());

  // TickTick Tags
  handle('ticktick:tags:list', () => listTickTickTags());

  // TickTick Focus
  handle('ticktick:focus:list', (filters?: { date?: string; taskId?: string }) => listTickTickFocusSessions(filters));
  handle('ticktick:focus:create', (input: TickTickFocusSessionInput) => createTickTickFocusSession(input));

  // TickTick Bridge
  handle('ticktick:bridge:task', (taskId: string) => getTickTickTaskBridges(taskId));
  handle('ticktick:bridge:create', (input: TickTickBridgeInput) => createTickTickBridge(input));
  handle('ticktick:bridge:delete', (id: number) => deleteTickTickBridge(id));
  handle('ticktick:bridge:linked', (linkedType: TickTickBridgeLinkedType, linkedId: string) => getBridgesForLinked(linkedType, linkedId));

  // TickTick Calendar
  handle('ticktick:calendar:month', (year: number, month: number) => getTickTickCalendarMonth(year, month));

  // TickTick AI
  handle('ticktick:ai:decompose', (input: TickTickAiDecompositionInput) => aiDecomposeTask(input));
  handle('ticktick:ai:dailyPlan', () => aiGenerateDailyPlan());
  handle('ticktick:ai:review', (type: 'daily' | 'weekly') => aiGenerateReview(type));

  // TickTick Settings
  handle('ticktick:settings:get', () => getTickTickSettings());
  handle('ticktick:settings:save', (settings: TickTickSettings) => saveTickTickSettings(settings));

  // TickTick Habits
  handle('ticktick:habits:list', () => listTickTickHabits());
  handle('ticktick:habits:create', (input: TickTickHabitInput) => createTickTickHabit(input));
  handle('ticktick:habits:update', (id: string, input: TickTickHabitInput) => updateTickTickHabit(id, input));
  handle('ticktick:habits:delete', (id: string) => deleteTickTickHabit(id));
  handle('ticktick:habits:toggle', (habitId: string, date: string) => toggleTickTickHabit(habitId, date));
  handle('ticktick:habits:logs', (habitId: string, fromDate?: string, toDate?: string) => getTickTickHabitLogs(habitId, fromDate, toDate));

  // TickTick Sync
  handle('ticktick:sync:reviewTask', (taskId: string, taskTitle: string, actualMinutes: number) => syncTaskCompletedToReview(taskId, taskTitle, actualMinutes));
  handle('ticktick:sync:undoReviewTask', (taskId: string, taskTitle: string) => undoSyncTaskCompleted(taskId, taskTitle));
  handle('ticktick:sync:generateReviewTasks', () => generateAutoReviewTasks());
  handle('ticktick:sync:reviewUpdated', (linkedType: TickTickBridgeLinkedType, linkedId: string) => syncReviewToTickTickTask(linkedType, linkedId));
  handle('ticktick:sync:masteryChanged', (knowledgeNodeId: string, newMasteryScore: number) => syncMasteryToTaskPriority(knowledgeNodeId, newMasteryScore));

  // White noise state
  handle('ticktick:whiteNoise:get', async () => {
    const db = await (await import('../services/databaseService')).getDatabase();
    try {
      const result = db.exec("SELECT value FROM app_settings WHERE key = 'ticktick_white_noise'");
      if (result.length && result[0].values.length) return JSON.parse(result[0].values[0][0] as string);
    } catch { /* ignore */ }
    return { enabled: false, noise: 'none' };
  });
  handle('ticktick:whiteNoise:set', async (state: { enabled: boolean; noise: TickTickWhiteNoise }) => {
    const db = await (await import('../services/databaseService')).getDatabase();
    db.run("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ticktick_white_noise', ?)", [JSON.stringify(state)]);
    (await import('../services/databaseService')).persistDatabase();
  });
}
