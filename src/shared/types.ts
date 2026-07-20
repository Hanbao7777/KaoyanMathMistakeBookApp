export type ImageType = 'original' | 'question' | 'solution';

export type MasteryLevel = '未掌握' | '较弱' | '一般' | '较好' | '已掌握';
export type Difficulty = '简单' | '中等' | '困难' | '压轴';
export type ReviewResult = '做对了' | '做错了' | '看懂了但不会独立做' | '仍然没思路';
export type ReviewResultV2 = 'correct' | 'wrong' | 'no_idea';
export type MathSubject = '高等数学' | '线性代数' | '概率论' | '其他';
export type QuestionFormat = '选择题' | '填空题' | '解答题';
export type ExternalQuestionResult = 'correct' | 'wrong' | 'no_idea';
export type StudySubjectId = 'math' | 'major' | 'politics' | 'english' | string;
export type StudyPriority = '高' | '中' | '低';
export type StudyRiskLevel = 'normal' | 'warning' | 'danger' | 'critical';
export type StudyMaterialStatus = '未开始' | '进行中' | '已完成' | '暂停';
export type StudyTaskStatus = '未开始' | '进行中' | '部分完成' | '已完成' | '已跳过';
export type StudyQuality = '很差' | '一般' | '良好' | '很好';

export interface StudySettings {
  id: number;
  exam_date: string | null;
  daily_target_minutes: number;
  supervision_mode: 'strict' | string;
  auto_rollover_enabled: number;
  last_rollover_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudySubject {
  id: StudySubjectId;
  name: string;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface StudyMaterial {
  id: string;
  subject_id: StudySubjectId;
  subject_name?: string;
  name: string;
  material_type: string;
  progress_unit: string;
  custom_unit_name: string | null;
  total_amount: number;
  current_amount: number;
  start_date: string | null;
  target_date: string | null;
  priority: StudyPriority;
  status: StudyMaterialStatus;
  note: string;
  is_deleted: number;
  created_at: string;
  updated_at: string;
  completionRate?: number;
  remainingAmount?: number;
  expectedAmount?: number | null;
  lagAmount?: number;
  suggestedDailyAmount?: number | null;
  suggestedPaceText?: string | null;
  catchUpText?: string | null;
  riskLevel?: StudyRiskLevel;
}

export interface StudyMaterialInput {
  subject_id: StudySubjectId;
  name: string;
  material_type: string;
  progress_unit: string;
  custom_unit_name?: string | null;
  total_amount: number;
  current_amount: number;
  start_date?: string | null;
  target_date?: string | null;
  priority: StudyPriority;
  status: StudyMaterialStatus;
  note?: string;
}

export interface StudyMaterialFilters {
  subjectId?: string;
  status?: string;
  risk?: string;
  search?: string;
}

export interface StudyTask {
  id: string;
  task_date: string;
  subject_id: StudySubjectId;
  subject_name?: string;
  material_id: string | null;
  material_name?: string | null;
  title: string;
  task_type: string;
  estimated_minutes: number;
  actual_minutes: number;
  priority: StudyPriority;
  status: StudyTaskStatus;
  completion_quality: StudyQuality | null;
  defer_count: number;
  original_date: string | null;
  skipped_reason: string | null;
  note: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  delayLevel?: StudyRiskLevel;
}

export interface StudyTaskInput {
  task_date: string;
  subject_id: StudySubjectId;
  material_id?: string | null;
  title: string;
  task_type: string;
  estimated_minutes: number;
  actual_minutes?: number;
  priority: StudyPriority;
  status: StudyTaskStatus;
  completion_quality?: StudyQuality | null;
  skipped_reason?: string | null;
  note?: string;
}

export interface StudyTaskFilters {
  date?: string;
  subjectId?: string;
  status?: string;
  includeBeforeDate?: boolean;
}

export interface StudySession {
  id: string;
  session_date: string;
  subject_id: StudySubjectId;
  subject_name?: string;
  task_id: string | null;
  task_title?: string | null;
  material_id: string | null;
  material_name?: string | null;
  start_time: string;
  end_time: string | null;
  duration_minutes: number;
  quality: StudyQuality | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface StudySessionInput {
  session_date: string;
  subject_id: StudySubjectId;
  task_id?: string | null;
  material_id?: string | null;
  start_time: string;
  end_time?: string | null;
  duration_minutes: number;
  quality?: StudyQuality | null;
  note?: string;
}

export interface StudySessionFilters {
  date?: string;
  subjectId?: string;
  from?: string;
  to?: string;
}

export interface DailyReview {
  id: string;
  review_date: string;
  completion_rate: number;
  total_study_minutes: number;
  completed_task_count: number;
  total_task_count: number;
  mood: StudyQuality | null;
  today_summary: string;
  main_problem: string;
  tomorrow_priority: string;
  created_at: string;
  updated_at: string;
}

export interface DailyReviewInput {
  review_date: string;
  mood?: StudyQuality | null;
  today_summary?: string;
  main_problem?: string;
  tomorrow_priority?: string;
}

export interface StudySubjectStat {
  subjectId: StudySubjectId;
  subjectName: string;
  weekStudyMinutes: number;
  todayTaskTotal: number;
  todayTaskCompleted: number;
  unfinishedTaskCount: number;
  consecutiveNoStudyDays: number;
  materialCount: number;
  delayedMaterialCount: number;
  status: StudyRiskLevel;
}

export interface StudySupervisorDashboard {
  today: string;
  examDate: string | null;
  daysUntilExam: number | null;
  dailyTargetMinutes: number;
  todayStudyMinutes: number;
  todayTaskTotal: number;
  todayTaskCompleted: number;
  todayCompletionRate: number;
  todayUnfinishedTaskCount: number;
  supervisionStatus: StudyRiskLevel;
  dueReviewCount: number;
  subjectStats: StudySubjectStat[];
  delayedTasks: StudyTask[];
  criticalDelayedTasks: StudyTask[];
  riskyMaterials: StudyMaterial[];
  noStudySubjects: StudySubjectStat[];
  suggestions: string[];
}

export interface QuestionImage {
  id: number;
  question_id: number;
  image_type: ImageType;
  file_path: string;
  created_at: string;
}

export interface ReviewLog {
  id: number;
  question_id: number;
  review_date?: string;
  review_round?: number;
  result: ReviewResult | ReviewResultV2;
  duration_minutes?: number;
  mastery_before?: string | null;
  mastery_after?: string | null;
  reviewed_at?: string | null;
  next_review_at?: string | null;
  note: string;
  created_at?: string;
}

export interface Question {
  id: number;
  title: string;
  content: string;
  wrong_thinking: string;
  wrong_solution: string;
  correct_solution: string;
  answer: string;
  subject: MathSubject | string;
  category: string;
  question_type: string;
  error_reason: string;
  source: string;
  difficulty: Difficulty;
  mastery_level: MasteryLevel;
  note: string;
  review_count: number;
  correct_count: number;
  wrong_count: number;
  no_idea_count: number;
  consecutive_correct: number;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  import_batch_id?: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
  question_images: QuestionImage[];
  solution_images: QuestionImage[];
  knowledge_points?: KnowledgePoint[];
}

export interface QuestionInput {
  title: string;
  content: string;
  wrong_thinking: string;
  wrong_solution: string;
  correct_solution: string;
  answer: string;
  subject?: MathSubject | string;
  category: string;
  question_type: string;
  error_reason: string;
  source: string;
  difficulty: Difficulty;
  mastery_level: MasteryLevel;
  note: string;
  tags: string[];
  questionImageSources: string[];
  solutionImageSources: string[];
  import_batch_id?: string;
}

export interface QuestionFilters {
  search?: string;
  subject?: string;
  category?: string;
  questionType?: string;
  errorReason?: string;
  masteryLevel?: string;
  difficulty?: string;
  source?: string;
  tag?: string;
  sortBy?: 'created_at' | 'last_reviewed_at' | 'review_count';
  sortOrder?: 'asc' | 'desc';
  weakOnly?: boolean;
}


export interface ReviewInput {
  questionId: number;
  review_date: string;
  result: ReviewResult;
  duration_minutes: number;
  note: string;
}

export interface ReviewSubmitInput {
  questionId: number;
  result: ReviewResultV2;
  note?: string;
}

export interface ReviewSubmitResult {
  question: Question;
  log: ReviewLog;
  message: string;
}

export interface AppPaths {
  root: string;
  data: string;
  images: string;
  exports: string;
  backups: string;
  temp: string;
  textbooks: string;
  database: string;
  isFallback: boolean;
  warning: string | null;
}

export interface StatsData {
  total: number;
  mastered: number;
  unmastered: number;
  repeatedWrong: number;
  byCategory: Array<{ name: string; count: number }>;
  byType: Array<{ name: string; count: number }>;
  byReason: Array<{ name: string; count: number }>;
  recentNew: Array<{ date: string; count: number }>;
  recentReviews: Array<{ date: string; count: number }>;
  weakestCategories: Array<{ name: string; count: number }>;
  topReasons: Array<{ name: string; count: number }>;
}

export interface DashboardWeeklyReviewSummary {
  total: number;
  correct: number;
  wrong: number;
  noIdea: number;
  correctRate: number | null;
}

export interface DashboardData {
  total: number;
  due: number;
  unmastered: number;
  weakQuestions: number;
  reviewedThisWeek: number;
  correctRateThisWeek: number | null;
  weeklyReviewSummary: DashboardWeeklyReviewSummary;
  topErrorReasons: Array<{ name: string; count: number }>;
  recent: Question[];
  topCategories: Array<{ name: string; count: number }>;
  subjectCounts?: Array<{ name: string; count: number }>;
}

export interface ReviewBuckets {
  due: Question[];
  unmastered: Question[];
  repeatedWrong: Question[];
  weak: Question[];
  weekReviewedCount: number;
  counts: {
    due: number;
    unmastered: number;
    weak: number;
    weekReviewed: number;
  };
}

export interface ImageUrlResult {
  originalPath: string;
  resolvedPath: string;
  url: string;
  exists: boolean;
}

export type DatabaseBackupKind = 'manual' | 'auto' | 'before_restore' | 'before_delete_import';

export interface DatabaseBackupInfo {
  fileName: string;
  filePath: string;
  type: DatabaseBackupKind;
  createdAt: string;
  sizeBytes: number;
  sizeText: string;
}

export interface DatabaseBackupResult {
  fileName: string;
  filePath: string;
  createdAt: string;
}

export interface RestoreDatabaseBackupResult {
  restored: boolean;
  restoredFrom: string;
  beforeRestoreBackup: string;
  message: string;
}

export type PdfExportMode = 'full' | 'practice';
export type PdfExportScope = 'all' | 'questionIds' | 'knowledgePoint';

export interface PdfExportOptions {
  scope: PdfExportScope;
  mode: PdfExportMode;
  questionIds?: number[];
  knowledgeNodeId?: string;
  includeChildren?: boolean;
  title?: string;
}

export interface PdfExportResult {
  fileName: string;
  filePath: string;
  count: number;
  mode: PdfExportMode;
  scope: PdfExportScope;
}

export type StructuredImportKind = 'excel' | 'json' | 'zip';

export interface StructuredImportRow {
  rowNumber: number;
  title: string;
  content: string;
  wrong_thinking: string;
  correct_solution: string;
  answer: string;
  subject: MathSubject | string;
  category: string;
  question_type: string;
  error_reason: string;
  difficulty: Difficulty;
  mastery_level: MasteryLevel;
  source: string;
  tags: string[];
  knowledge_points: string[];
  image_path: string;
  resolved_image_path: string | null;
  hasImage: boolean;
  isValid: boolean;
  errors: string[];
}

export interface StructuredImportPreview {
  sessionId: string;
  kind: StructuredImportKind;
  sourceFile: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: StructuredImportRow[];
}

export interface StructuredImportResult {
  successCount: number;
  failCount: number;
  imageCopiedCount: number;
  failures: Array<{ rowNumber: number; title: string; reason: string }>;
  warnings?: Array<{ rowNumber: number; title: string; message: string }>;
}

export interface Textbook {
  id: number;
  title: string;
  subject: string;
  edition: string;
  file_name: string;
  file_path: string;
  note: string;
  created_at: string;
  updated_at: string;
}

/** Public textbook metadata intentionally excludes every filesystem path field. */
export interface SafeTextbook {
  id: number;
  title: string;
  subject: string;
  edition: string;
  file_name: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface SafeKnowledgeNode {
  id: number;
  textbook_id: number | null;
  node_id: string;
  parent_node_id: string | null;
  title: string;
  subject: MathSubject | string;
  category: string;
  level: number;
  sort_order: number;
  book_page: number | null;
  pdf_page: number | null;
  summary: string;
  coreFormulas: string[];
  commonQuestionTypes: string[];
  commonErrorReasons: string[];
  tagList: string[];
  textbook: SafeTextbook | null;
  questionCount: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgePoint {
  id: number;
  textbook_id: number | null;
  node_id: string;
  parent_node_id: string | null;
  title: string;
  subject: MathSubject | string;
  category: string;
  level: number;
  sort_order: number;
  book_page: number | null;
  pdf_page: number | null;
  summary: string;
  core_formulas: string;
  common_question_types: string;
  common_error_reasons: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgePointTreeNode extends KnowledgePoint {
  children: KnowledgePointTreeNode[];
  questionCount: number;
}

export interface KnowledgePointDetail extends KnowledgePoint {
  textbook: Textbook | null;
  pdfStatus: TextbookPdfStatus | null;
  coreFormulas: string[];
  commonQuestionTypes: string[];
  commonErrorReasons: string[];
  tagList: string[];
  relatedQuestions: Question[];
  questionCount: number;
  reviewStats?: KnowledgePointReviewStats;
}

export type KnowledgeReviewMode = 'due' | 'all';

export interface KnowledgePointReviewStats {
  node_id: string;
  title: string;
  subject: MathSubject | string;
  category: string;
  level: number;
  sort_order: number;
  book_page: number | null;
  pdf_page: number | null;
  tags: string[];
  commonQuestionTypes: string[];
  total_questions: number;
  due_questions: number;
  weak_questions: number;
  average_mastery_score: number | null;
}

export interface KnowledgePointReviewQuestionsResult {
  point: KnowledgePoint;
  stats: KnowledgePointReviewStats;
  questions: Question[];
  mode: KnowledgeReviewMode;
  includeChildren: boolean;
}

export interface QuestionKnowledgePoint {
  id: number;
  question_id: number;
  knowledge_node_id: string;
  match_type: 'gpt' | 'auto' | 'manual';
  created_at: string;
}

export interface KnowledgeMapImportResult {
  textbookTitle: string;
  subject?: MathSubject | string;
  importedCount: number;
  updatedCount: number;
  failedCount: number;
  failures: Array<{ node_id: string; title: string; reason: string }>;
  copiedPdfPath: string | null;
}

export interface TextbookPdfStatus {
  textbookTitle: string;
  fileName: string;
  filePath: string;
  textbooksDir: string;
  lookupPath: string;
  resolvedPath: string;
  exists: boolean;
  bookPage: number | null;
  pdfPage: number | null;
}

export interface OpenTextbookResult {
  opened: boolean;
  filePath: string;
  pdfPage: number | null;
  bookPage: number | null;
  usedFallback: boolean;
  message: string;
}

export interface BindTextbookPdfResult {
  bound: boolean;
  filePath: string;
  fileName: string;
  status: TextbookPdfStatus | null;
}

export interface KnowledgeRematchResult {
  scannedQuestions: number;
  insertedCount: number;
  skippedExistingCount: number;
  unmatchedQuestions: number;
}

export interface ExternalQuestion {
  id: number;
  title: string;
  content: string;
  options: string;
  answer: string;
  solution: string;
  subject: MathSubject | string;
  category: string;
  question_format: QuestionFormat | string;
  question_type: string;
  difficulty: Difficulty | string;
  knowledge_points: string;
  source: string;
  year: number | null;
  exam_type: string;
  question_number: number | null;
  section: string;
  tags: string;
  raw_file_path: string;
  paper_pdf_path: string;
  solution_pdf_path: string;
  import_batch_id: string;
  asset_base_path: string;
  added_to_mistakes: number;
  created_question_id: number | null;
  created_at: string;
  updated_at: string;
  latest_result?: ExternalQuestionResult | null;
  latest_attempted_at?: string | null;
  latest_added_to_mistakes?: number;
  latest_created_question_id?: number | null;
}

export type ImportBatchType = 'wrong_questions' | 'question_bank' | 'knowledge_map' | 'textbook' | 'unknown';
export type ImportBatchStatus = 'active' | 'deleted' | 'failed';

export interface ImportBatch {
  id: string;
  type: ImportBatchType;
  name: string;
  source_file_name: string;
  source: string;
  imported_at: string;
  item_count: number;
  asset_count: number;
  status: ImportBatchStatus;
  metadata_json: string;
  deleted_at: string | null;
}

export interface ImportBatchItem {
  id: number;
  batch_id: string;
  target_table: string;
  target_id: string;
  action: string;
  created_at: string;
}

export interface ImportAsset {
  id: number;
  batch_id: string;
  asset_type: string;
  file_path: string;
  created_at: string;
  deleted_at: string | null;
}

export interface ImportBatchDetail {
  batch: ImportBatch;
  items: ImportBatchItem[];
  assets: ImportAsset[];
  tableCounts: Array<{ target_table: string; count: number }>;
}

export interface DeleteImportBatchOptions {
  deleteLinkedQuestions?: boolean;
  deleteAssets?: boolean;
}

export interface DeleteImportBatchResult {
  backupPath: string;
  deletedQuestions: number;
  deletedExternalQuestions: number;
  deletedAttempts: number;
  softDeletedKnowledgePoints: number;
  movedAssets: number;
  failedAssets: string[];
}

export interface LegacyExternalQuestionGroup {
  groupKey: string;
  source: string;
  exam_type: string;
  year: number | null;
  questionCount: number;
  attemptedCount: number;
  addedToMistakesCount: number;
}

export interface DeleteLegacyExternalQuestionGroupResult {
  backupPath: string;
  deletedQuestions: number;
  deletedAttempts: number;
  movedAssets: number;
  failedAssets: string[];
}

export interface ExternalQuestionFilters {
  year?: string;
  subject?: string;
  questionFormat?: string;
  questionType?: string;
  status?: 'all' | 'unattempted' | 'attempted' | 'added';
}

export interface ExternalQuestionStats {
  total: number;
  attempted: number;
  wrong: number;
  noIdea: number;
  added: number;
  years: number[];
  questionTypes: string[];
}

export interface ExternalQuestionAttempt {
  id: number;
  external_question_id: number;
  result: ExternalQuestionResult;
  attempted_at: string;
  note: string;
  added_to_mistakes: number;
  created_question_id: number | null;
}

export interface ExternalQuestionAttemptInput {
  externalQuestionId: number;
  result: ExternalQuestionResult;
  note?: string;
}

export interface QuestionBankImportResult {
  bankName: string;
  source: string;
  version: string;
  importBatchId?: string;
  copiedImageCount?: number;
  copiedPaperCount?: number;
  imageReferenceCount?: number;
  missingImageReferences?: string[];
  paperPdfReferenceCount?: number;
  solutionPdfReferenceCount?: number;
  missingPdfReferences?: string[];
  addedCount: number;
  skippedCount: number;
  failedCount: number;
  failures: Array<{ rowNumber: number; title: string; reason: string }>;
}

export interface AddExternalQuestionToMistakesResult {
  question: Question;
  attempt: ExternalQuestionAttempt | null;
}

export interface DeleteExternalQuestionBatchResult {
  deletedQuestions: number;
  deletedAttempts: number;
  movedAssetPath: string;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface DeepSeekSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface OcrResult {
  text: string;
  confidence: number;
  processingTimeMs: number;
}

export interface AiStructuredQuestion {
  title: string;
  content: string;
  wrong_thinking: string;
  correct_solution: string;
  answer: string;
  subject: string;
  category: string;
  question_type: string;
  error_reason: string;
  difficulty: string;
  tags: string[];
  knowledge_points: string[];
  raw_ocr_text: string;
}

export interface AiDiagnosisResult {
  knowledgeBlindSpot: string;
  suggestedKnowledgePoints: string[];
  suggestedReviewDirection: string;
  rawResponse: string;
}

// ── TickTick Types ──

export type TickTickPriority = 'none' | '低' | '中' | '高';
export type TickTickSessionType = 'focus' | 'short_break' | 'long_break';
export type TickTickBridgeLinkedType = 'question' | 'knowledge_point' | 'subject' | 'study_task';
export type TickTickTaskSource = 'manual' | 'auto_review' | 'ai_plan';
export type TickTickWhiteNoise = 'rain' | 'stream' | 'cafe' | 'white' | 'forest' | 'none';

export interface TickTickList {
  id: string;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
  is_folder: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  task_count?: number;
}

export interface TickTickListInput {
  name: string;
  color?: string;
  icon?: string;
  is_folder?: number;
  parent_id?: string | null;
}

export type TickTickListPatch = Partial<TickTickListInput>;

export interface TickTickTask {
  id: string;
  list_id: string;
  list_name?: string;
  list_color?: string;
  title: string;
  note: string;
  due_date: string | null;
  due_time: string | null;
  priority: TickTickPriority;
  is_completed: number;
  completed_at: string | null;
  parent_id: string | null;
  sort_order: number;
  tags: string;
  tags_list?: string[];
  recurrence_rule: string | null;
  estimated_minutes: number;
  actual_minutes: number;
  pomodoro_sessions: number;
  source: TickTickTaskSource;
  created_at: string;
  updated_at: string;
  subtask_count?: number;
  subtask_completed?: number;
  bridge_links?: TickTickBridge[];
}

export interface TickTickTaskInput {
  list_id: string;
  title: string;
  note?: string;
  due_date?: string | null;
  due_time?: string | null;
  priority?: TickTickPriority;
  parent_id?: string | null;
  tags?: string[];
  recurrence_rule?: string | null;
  estimated_minutes?: number;
  source?: TickTickTaskSource;
}

export interface TickTickTaskFilters {
  listId?: string;
  dueDate?: string;
  dueDateBefore?: string;
  includeCompleted?: boolean;
  includeNoDate?: boolean;
  search?: string;
  tag?: string;
  priority?: TickTickPriority;
}

export interface TickTickTag {
  id: string;
  name: string;
  color: string;
  task_count?: number;
}

export interface TickTickFocusSession {
  id: string;
  task_id: string | null;
  task_title?: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number;
  session_type: TickTickSessionType;
  completed: number;
  white_noise: TickTickWhiteNoise | null;
  created_at: string;
}

export interface TickTickFocusSessionInput {
  task_id?: string | null;
  start_time: string;
  end_time?: string | null;
  duration_minutes: number;
  session_type?: TickTickSessionType;
  completed?: number;
  white_noise?: TickTickWhiteNoise | null;
}

export interface TickTickBridge {
  id: number;
  ticktick_task_id: string;
  linked_type: TickTickBridgeLinkedType;
  linked_id: string;
  sync_review: number;
  sync_mastery: number;
  created_at: string;
}

export interface TickTickBridgeInput {
  ticktick_task_id: string;
  linked_type: TickTickBridgeLinkedType;
  linked_id: string;
  sync_review?: number;
  sync_mastery?: number;
}

export interface TickTickAiPlan {
  id: string;
  plan_date: string;
  raw_response: string;
  tasks_json: string;
  accepted_count: number;
  reviewed: number;
  created_at: string;
}

export interface TickTickCalendarDay {
  date: string;
  task_count: number;
  completed_count: number;
  review_due_count: number;
  pomodoro_count: number;
  has_ai_plan: boolean;
  tasks: TickTickTask[];
}

export interface TickTickAiDecompositionInput {
  goal: string;
  context?: {
    availableDays?: number;
    weakKnowledgePoints?: string[];
    subjectId?: string;
  };
}

export interface TickTickAiDecompositionResult {
  subtasks: Array<{
    title: string;
    estimated_days: number;
    estimated_minutes: number;
    priority: '高' | '中' | '低' | 'none';
    deadline_days: number;
    tags: string[];
    knowledge_points: string[];
  }>;
  total_days: number;
  total_minutes: number;
}

export interface TickTickAiDailyPlanResult {
  suggested_tasks: Array<{
    title: string;
    time_block: string;
    priority: TickTickPriority;
    estimated_minutes: number;
    linked_type: TickTickBridgeLinkedType | null;
    linked_id: string | null;
    reason: string;
  }>;
  summary: string;
}

export interface TickTickAiReviewResult {
  completion_rate: number;
  total_focus_minutes: number;
  correct_rate: number | null;
  weak_points: string[];
  suggestion: string;
}

export interface TickTickPomodoroSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
}

export interface TickTickSettings {
  pomodoro: TickTickPomodoroSettings;
  autoCreateReviewTasks: boolean;
  whiteNoise: TickTickWhiteNoise;
  defaultListId: string | null;
}

export interface TickTickHabit {
  id: string;
  name: string;
  icon: string;
  color: string;
  goal_description: string;
  frequency: 'daily' | 'weekly';
  target_count: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  streak?: number;
  today_completed?: number;
}

export interface TickTickHabitInput {
  name: string;
  icon?: string;
  color?: string;
  goal_description?: string;
  frequency?: 'daily' | 'weekly';
  target_count?: number;
}

export type TickTickHabitPatch = Partial<TickTickHabitInput>;

export interface TickTickHabitLog {
  id: string;
  habit_id: string;
  log_date: string;
  completed: number;
  note: string;
  created_at: string;
}
