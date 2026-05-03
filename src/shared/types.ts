export type ImageType = 'original' | 'question' | 'solution';

export type MasteryLevel = '未掌握' | '较弱' | '一般' | '较好' | '已掌握';
export type Difficulty = '简单' | '中等' | '困难' | '压轴';
export type ReviewResult = '做对了' | '做错了' | '看懂了但不会独立做' | '仍然没思路';
export type ReviewResultV2 = 'correct' | 'wrong' | 'no_idea';

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
}

export interface QuestionFilters {
  search?: string;
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

export type DatabaseBackupKind = 'manual' | 'auto' | 'before_restore';

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

export interface KnowledgePoint {
  id: number;
  textbook_id: number | null;
  node_id: string;
  parent_node_id: string | null;
  title: string;
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

