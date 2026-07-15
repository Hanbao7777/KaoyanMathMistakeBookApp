import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { Database } from 'sql.js';
import type { DatabaseMutationResult } from '../persistence';
import {
  clearAllData,
  exportData,
  getDatabaseCoordinator,
  getCurrentPaths,
  getDashboard,
  getQuestionsApplication,
  getReadOnlyDatabase,
  getReviewBuckets,
  getStats,
  importData,
  initializeDatabase,
  resetDatabaseConnection,
} from '../services/databaseService';
import {
  addReviewFromRenderer,
  createQuestionFromRenderer,
  deleteQuestionFromRenderer,
  getQuestionFromRenderer,
  getReviewBucketsFromRenderer,
  listQuestionsFromRenderer,
  listReviewLogsFromRenderer,
  markMasteryFromRenderer,
  removeImageFromRenderer,
  submitReviewResultFromRenderer,
  updateQuestionFromRenderer
} from './adapters/questionsIpc';
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
  getTodayTickTickTasks,
  listTickTickTags,
  listTickTickFocusSessions, createTickTickFocusSession,
  getTickTickTaskBridges, createTickTickBridge, deleteTickTickBridge, getBridgesForLinked,
  getTickTickCalendarMonth,
  getTickTickSettings, saveTickTickSettings,
  listTickTickHabits, createTickTickHabit, updateTickTickHabit, deleteTickTickHabit, toggleTickTickHabit, getTickTickHabitLogs
} from '../services/ticktickService';
import { syncTaskCompletedToReview, syncReviewToTickTickTask, syncMasteryToTaskPriority, generateAutoReviewTasks, undoSyncTaskCompleted, completeTaskWithReviewSync, uncompleteTaskWithReviewSync } from '../services/bridgeService';
import { FocusTimerEngine } from '../services/focusTimerEngine';
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

async function executeLegacyMutation<T>(
  operation: string,
  execute: (database: Database) => DatabaseMutationResult<T> | Promise<DatabaseMutationResult<T>>
): Promise<T> {
  const coordinator = await getDatabaseCoordinator();
  const application = await getQuestionsApplication();
  const requestId = randomUUID();
  const preparedEvents = application.eventBus.prepareEvents(
    [{ type: 'legacy.operation_completed', payload: { operation } }],
    { requestId, traceId: randomUUID(), source: 'internal' }
  );
  const result = await coordinator.executeWrite({ requestId, concurrency: 'none', execute });
  if (result.changed) {
    await application.eventBus.publish(application.eventBus.finalizeEvents(preparedEvents, {
      versionBefore: result.versionBefore,
      versionAfter: result.versionAfter
    }));
  }
  return result.value;
}

async function recordAiImport(questionId: number): Promise<{ batchId: string }> {
  const timestamp = new Date();
  const batchId = `wrong_questions-${timestamp.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
  return executeLegacyMutation('ipc-ai-record-import', (database) => {
    const batchStatement = database.prepare(`INSERT INTO import_batches (
      id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
    ) VALUES (?, 'wrong_questions', ?, ?, 'AI 智能导入', ?, 0, 0, 'active', '', NULL)`);
    try {
      batchStatement.run([
        batchId,
        `AI 导入 - ${timestamp.toLocaleString('zh-CN')}`,
        `ai-import-${timestamp.getTime()}`,
        timestamp.toISOString()
      ]);
    } finally {
      batchStatement.free();
    }

    const itemStatement = database.prepare(
      "INSERT INTO import_batch_items (batch_id, target_table, target_id, action, created_at) VALUES (?, 'questions', ?, 'created', ?)"
    );
    try {
      itemStatement.run([batchId, String(questionId), timestamp.toISOString()]);
    } finally {
      itemStatement.free();
    }
    return { changed: true, value: { batchId } };
  });
}

async function getWhiteNoiseState(): Promise<{ enabled: boolean; noise: TickTickWhiteNoise }> {
  const database = await getReadOnlyDatabase();
  try {
    const row = database.select<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'ticktick_white_noise'"
    )[0];
    if (row) return JSON.parse(row.value) as { enabled: boolean; noise: TickTickWhiteNoise };
  } catch { /* not yet configured */ }
  return { enabled: false, noise: 'none' };
}

async function setWhiteNoiseState(state: { enabled: boolean; noise: TickTickWhiteNoise }): Promise<void> {
  const value = JSON.stringify(state);
  await executeLegacyMutation('ipc-white-noise-set', (database) => {
    const tableExists = database.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
    ).length > 0;
    if (!tableExists) {
      database.run('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    } else {
      const current = database.exec("SELECT value FROM app_settings WHERE key = 'ticktick_white_noise'");
      if (current[0]?.values[0]?.[0] === value) return { changed: false, value: undefined };
    }

    const statement = database.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ticktick_white_noise', ?)");
    try {
      statement.run([value]);
    } finally {
      statement.free();
    }
    return { changed: true, value: undefined };
  });
}

// ── Shared Timer State (single source of truth: FocusTimerEngine) ──
const focusTimerEngine = new FocusTimerEngine();
let focusTimerInterval: ReturnType<typeof setInterval> | null = null;

focusTimerEngine.setSessionEndCallback((info) => {
  void createTickTickFocusSession({
    task_id: info.boundTaskId,
    start_time: new Date(info.sessionStartTime).toISOString(),
    end_time: new Date().toISOString(),
    duration_minutes: info.durationMinutes,
    session_type: 'focus',
    completed: 1,
  }).then(
    () => undefined,
    (error) => { console.error('focusTimerEngine: saveSession failed', error); }
  );
});

function startEngineTick() {
  if (focusTimerInterval) return;
  focusTimerInterval = setInterval(() => {
    focusTimerEngine.tick();
  }, 500);
}
startEngineTick();

// ── Widget Window ──

let widgetWindow: BrowserWindow | null = null;
const isDev = !app.isPackaged && process.env.KAOYAN_USE_RENDERER_BUILD !== '1';
const widgetStatePath = () => path.join(app.getPath('userData'), 'widget-state.json');

function loadWidgetState(): { x?: number; y?: number; width: number; height: number; pinned: boolean } {
  try {
    const raw = fs.readFileSync(widgetStatePath(), 'utf8');
    return { width: 320, height: 500, pinned: true, ...JSON.parse(raw) };
  } catch {
    return { width: 320, height: 500, pinned: true };
  }
}

function saveWidgetState() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const bounds = widgetWindow.getBounds();
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    pinned: widgetWindow.isAlwaysOnTop(),
  };
  try {
    fs.writeFileSync(widgetStatePath(), JSON.stringify(state), 'utf8');
  } catch { /* ignore */ }
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.focus();
    return;
  }

  const saved = loadWidgetState();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const width = Math.min(420, Math.max(280, saved.width || 320));
  const height = Math.min(680, Math.max(360, saved.height || 500));

  widgetWindow = new BrowserWindow({
    width,
    height,
    x: typeof saved.x === 'number' ? saved.x : screenWidth - width - 16,
    y: typeof saved.y === 'number' ? saved.y : Math.max(16, Math.floor(screenHeight * 0.12)),
    minWidth: 280,
    minHeight: 360,
    maxWidth: 420,
    maxHeight: 680,
    title: 'Kaoyan Desktop Widget',
    frame: false,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: saved.pinned,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWidgetState, 300);
  };
  widgetWindow.on('move', scheduleSave);
  widgetWindow.on('resize', scheduleSave);

  if (isDev) {
    widgetWindow.loadURL('http://127.0.0.1:5173/#/widget');
  } else {
    widgetWindow.loadFile(path.join(__dirname, '../../../renderer/index.html'), { hash: '/widget' });
  }

  widgetWindow.on('close', saveWidgetState);
  widgetWindow.on('closed', () => { widgetWindow = null; });
}

function focusMainWindow() {
  const mainWindow = BrowserWindow.getAllWindows().find((win) => win !== widgetWindow && !win.isDestroyed() && win.getTitle() !== 'Kaoyan Desktop Widget');
  if (!mainWindow) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

export function registerIpc() {
  handle('dashboard:get', () => getDashboard());
  handle('questions:list', (filters: QuestionFilters) => listQuestionsFromRenderer(filters));
  handle('questions:get', (id: number) => getQuestionFromRenderer(id));
  handle('questions:create', (input: QuestionInput) => createQuestionFromRenderer(input));
  handle('questions:update', (id: number, input: QuestionInput) => updateQuestionFromRenderer(id, input));
  handle('questions:delete', (id: number, deleteImages: boolean) => deleteQuestionFromRenderer(id, deleteImages));
  handle('questions:markMastery', (id: number, mastery: MasteryLevel) => markMasteryFromRenderer(id, mastery));
  handle('images:remove', (id: number, deleteFile: boolean) => removeImageFromRenderer(id, deleteFile));
  handle('images:choose', () => chooseImages());
  handle('images:getUrl', (imagePath: string) => getImageUrl(imagePath));
  handle('images:exists', (imagePath: string) => checkImageExists(imagePath));
  handle('images:open', (imagePath: string) => openImage(imagePath));
  handle('images:reveal', (imagePath: string) => revealImageInFolder(imagePath));
  handle('reviews:list', (questionId: number) => listReviewLogsFromRenderer(questionId));
  handle('reviews:add', (input: ReviewInput) => addReviewFromRenderer(input));
  handle('reviews:submitResult', (input: ReviewSubmitInput) => submitReviewResultFromRenderer(input));
  handle('review:buckets', () => getReviewBucketsFromRenderer());
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
  handle('ai:recordImport', (questionId: number) => recordAiImport(questionId));

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
  handle('ticktick:tasks:complete', (id: string) => completeTaskWithReviewSync(id));
  handle('ticktick:tasks:uncomplete', (id: string) => uncompleteTaskWithReviewSync(id));
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
  handle('ticktick:whiteNoise:get', () => getWhiteNoiseState());
  handle('ticktick:whiteNoise:set', (state: { enabled: boolean; noise: TickTickWhiteNoise }) => setWhiteNoiseState(state));

  // Shared timer state IPC (single source of truth: engine)
  handle('timer:getState', () => focusTimerEngine.getState());
  handle('timer:start', () => { focusTimerEngine.start(); return focusTimerEngine.getState(); });
  handle('timer:pause', () => { focusTimerEngine.pause(); return focusTimerEngine.getState(); });
  handle('timer:reset', () => { focusTimerEngine.reset(); return focusTimerEngine.getState(); });
  handle('timer:skipBreak', () => { focusTimerEngine.skipBreak(); return focusTimerEngine.getState(); });
  handle('timer:bindTask', (taskId: string | null) => { focusTimerEngine.setBoundTaskId(taskId); return focusTimerEngine.getState(); });
  handle('timer:setConfig', (config: { focusMinutes?: number; shortBreakMinutes?: number; longBreakMinutes?: number; sessionsBeforeLongBreak?: number }) => {
    focusTimerEngine.setConfig(config);
    return focusTimerEngine.getState();
  });

  // Widget
  ipcMain.on('widget:open', () => createWidgetWindow());
  ipcMain.on('widget:close', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close();
  });
  ipcMain.on('widget:togglePin', (_event, pinned: boolean) => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.setAlwaysOnTop(!!pinned);
      saveWidgetState();
    }
  });
  ipcMain.on('widget:setOpacity', (_event, opacity: number) => {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.setOpacity(opacity);
  });
  ipcMain.on('widget:setSize', (_event, width: number, height: number) => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const nextWidth = Math.min(420, Math.max(280, Math.round(width)));
      const nextHeight = Math.min(680, Math.max(360, Math.round(height)));
      widgetWindow.setSize(nextWidth, nextHeight);
      saveWidgetState();
    }
  });
  ipcMain.on('widget:setBounds', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const current = widgetWindow.getBounds();
      const nextWidth = Math.min(420, Math.max(280, Math.round(bounds.width)));
      const nextHeight = Math.min(680, Math.max(360, Math.round(bounds.height)));
      widgetWindow.setBounds({
        x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : current.x,
        y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : current.y,
        width: nextWidth,
        height: nextHeight,
      });
      saveWidgetState();
    }
  });
  ipcMain.on('widget:openMain', () => focusMainWindow());
  handle('widget:isOpen', () => widgetWindow !== null && !widgetWindow.isDestroyed());
}
