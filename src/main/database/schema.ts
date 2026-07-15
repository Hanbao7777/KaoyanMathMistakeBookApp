// This versions the control_metadata row shape only. Existing migrations remain
// authoritative for application schema upgrades until a unified migrator lands.
export const controlMetadataSchemaVersion = 1;

export const controlMetadataSchemaSql = `
CREATE TABLE IF NOT EXISTS control_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_epoch TEXT NOT NULL CHECK (length(trim(data_epoch)) > 0),
  data_revision INTEGER NOT NULL CHECK (
    typeof(data_revision) = 'integer'
    AND data_revision >= 0
    AND data_revision <= 9007199254740991
  ),
  control_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(control_revision) = 'integer'
    AND control_revision >= 0
    AND control_revision <= 9007199254740991
  ),
  schema_version INTEGER NOT NULL CHECK (
    typeof(schema_version) = 'integer'
    AND schema_version >= 1
    AND schema_version <= 9007199254740991
  ),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);
`;

export const schemaSql = `
${controlMetadataSchemaSql}

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  wrong_thinking TEXT DEFAULT '',
  wrong_solution TEXT DEFAULT '',
  correct_solution TEXT DEFAULT '',
  answer TEXT DEFAULT '',
  subject TEXT DEFAULT '高等数学',
  category TEXT NOT NULL,
  question_type TEXT NOT NULL,
  error_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  mastery_level TEXT NOT NULL,
  note TEXT DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  no_idea_count INTEGER NOT NULL DEFAULT 0,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  next_review_at TEXT,
  import_batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  image_type TEXT NOT NULL CHECK (image_type IN ('original', 'question', 'solution')),
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  result TEXT NOT NULL,
  mastery_before TEXT,
  mastery_after TEXT,
  reviewed_at TEXT,
  next_review_at TEXT,
  note TEXT DEFAULT '',
  review_date TEXT,
  review_round INTEGER,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_tags (
  question_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (question_id, tag_id),
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS textbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject TEXT DEFAULT '高等数学',
  edition TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  textbook_id INTEGER,
  node_id TEXT UNIQUE NOT NULL,
  parent_node_id TEXT,
  title TEXT NOT NULL,
  subject TEXT DEFAULT '高等数学',
  category TEXT DEFAULT '',
  level INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  book_page INTEGER,
  pdf_page INTEGER,
  summary TEXT DEFAULT '',
  core_formulas TEXT DEFAULT '[]',
  common_question_types TEXT DEFAULT '[]',
  common_error_reasons TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  import_batch_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (textbook_id) REFERENCES textbooks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS question_knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  knowledge_node_id TEXT NOT NULL,
  match_type TEXT DEFAULT 'gpt',
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_node_id) REFERENCES knowledge_points(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('wrong_questions', 'question_bank', 'knowledge_map', 'textbook', 'unknown')),
  name TEXT DEFAULT '',
  source_file_name TEXT DEFAULT '',
  source TEXT DEFAULT '',
  imported_at TEXT NOT NULL,
  item_count INTEGER DEFAULT 0,
  asset_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'failed')),
  metadata_json TEXT DEFAULT '',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS import_batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT DEFAULT 'created',
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  options TEXT DEFAULT '',
  answer TEXT DEFAULT '',
  solution TEXT DEFAULT '',
  subject TEXT DEFAULT '高等数学',
  category TEXT DEFAULT '其他',
  question_format TEXT DEFAULT '解答题',
  question_type TEXT DEFAULT '其他',
  difficulty TEXT DEFAULT '中等',
  knowledge_points TEXT DEFAULT '',
  source TEXT DEFAULT '',
  year INTEGER,
  exam_type TEXT DEFAULT '',
  question_number INTEGER,
  section TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  raw_file_path TEXT DEFAULT '',
  paper_pdf_path TEXT DEFAULT '',
  solution_pdf_path TEXT DEFAULT '',
  import_batch_id TEXT DEFAULT '',
  asset_base_path TEXT DEFAULT '',
  added_to_mistakes INTEGER NOT NULL DEFAULT 0,
  created_question_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_question_id) REFERENCES questions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS external_question_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_question_id INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('correct', 'wrong', 'no_idea')),
  attempted_at TEXT NOT NULL,
  note TEXT DEFAULT '',
  added_to_mistakes INTEGER NOT NULL DEFAULT 0,
  created_question_id INTEGER,
  FOREIGN KEY (external_question_id) REFERENCES external_questions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_question_id) REFERENCES questions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS study_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  exam_date TEXT,
  daily_target_minutes INTEGER DEFAULT 240,
  supervision_mode TEXT DEFAULT 'strict',
  auto_rollover_enabled INTEGER DEFAULT 1,
  last_rollover_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_materials (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,
  material_type TEXT DEFAULT '其他',
  progress_unit TEXT NOT NULL,
  custom_unit_name TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  current_amount REAL NOT NULL DEFAULT 0,
  start_date TEXT,
  target_date TEXT,
  priority TEXT DEFAULT '中',
  status TEXT DEFAULT '进行中',
  note TEXT DEFAULT '',
  is_deleted INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES study_subjects(id)
);

CREATE TABLE IF NOT EXISTS study_tasks (
  id TEXT PRIMARY KEY,
  task_date TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  material_id TEXT,
  title TEXT NOT NULL,
  task_type TEXT DEFAULT '其他',
  estimated_minutes INTEGER DEFAULT 0,
  actual_minutes INTEGER DEFAULT 0,
  priority TEXT DEFAULT '中',
  status TEXT DEFAULT '未开始',
  completion_quality TEXT,
  defer_count INTEGER DEFAULT 0,
  original_date TEXT,
  skipped_reason TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (subject_id) REFERENCES study_subjects(id),
  FOREIGN KEY (material_id) REFERENCES study_materials(id)
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  task_id TEXT,
  material_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_minutes INTEGER DEFAULT 0,
  quality TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES study_subjects(id),
  FOREIGN KEY (task_id) REFERENCES study_tasks(id),
  FOREIGN KEY (material_id) REFERENCES study_materials(id)
);

CREATE TABLE IF NOT EXISTS daily_reviews (
  id TEXT PRIMARY KEY,
  review_date TEXT NOT NULL UNIQUE,
  completion_rate REAL DEFAULT 0,
  total_study_minutes INTEGER DEFAULT 0,
  completed_task_count INTEGER DEFAULT 0,
  total_task_count INTEGER DEFAULT 0,
  mood TEXT,
  today_summary TEXT DEFAULT '',
  main_problem TEXT DEFAULT '',
  tomorrow_priority TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at);
CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_mastery ON questions(mastery_level);
CREATE INDEX IF NOT EXISTS idx_review_logs_question ON review_logs(question_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_node ON knowledge_points(node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_parent ON knowledge_points(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_question_knowledge_question ON question_knowledge_points(question_id);
CREATE INDEX IF NOT EXISTS idx_question_knowledge_node ON question_knowledge_points(knowledge_node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_knowledge_unique ON question_knowledge_points(question_id, knowledge_node_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_type ON import_batches(type);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batch_items_batch ON import_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_import_assets_batch ON import_assets(batch_id);
CREATE INDEX IF NOT EXISTS idx_external_questions_subject ON external_questions(subject);
CREATE INDEX IF NOT EXISTS idx_external_questions_year ON external_questions(year);
CREATE INDEX IF NOT EXISTS idx_external_questions_format ON external_questions(question_format);
CREATE INDEX IF NOT EXISTS idx_external_questions_type ON external_questions(question_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_questions_unique_source ON external_questions(source, exam_type, year, question_number);
CREATE INDEX IF NOT EXISTS idx_external_attempts_question ON external_question_attempts(external_question_id);
CREATE INDEX IF NOT EXISTS idx_external_attempts_created_question ON external_question_attempts(created_question_id);
CREATE INDEX IF NOT EXISTS idx_study_materials_subject ON study_materials(subject_id);
CREATE INDEX IF NOT EXISTS idx_study_materials_status ON study_materials(status);
CREATE INDEX IF NOT EXISTS idx_study_tasks_date ON study_tasks(task_date);
CREATE INDEX IF NOT EXISTS idx_study_tasks_subject ON study_tasks(subject_id);
CREATE INDEX IF NOT EXISTS idx_study_tasks_material ON study_tasks(material_id);
CREATE INDEX IF NOT EXISTS idx_study_tasks_status ON study_tasks(status);
CREATE INDEX IF NOT EXISTS idx_study_sessions_date ON study_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_study_sessions_subject ON study_sessions(subject_id);
CREATE INDEX IF NOT EXISTS idx_daily_reviews_date ON daily_reviews(review_date);

CREATE TABLE IF NOT EXISTS ticktick_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4a90d9',
  icon TEXT DEFAULT 'list',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_folder INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticktick_tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT DEFAULT '',
  due_date TEXT,
  due_time TEXT CHECK(due_time IS NULL OR due_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  priority TEXT CHECK(priority IN ('none','低','中','高')) DEFAULT 'none',
  is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  tags TEXT DEFAULT '[]',
  recurrence_rule TEXT,
  estimated_minutes INTEGER NOT NULL DEFAULT 0,
  actual_minutes INTEGER NOT NULL DEFAULT 0,
  pomodoro_sessions INTEGER NOT NULL DEFAULT 0,
  source TEXT CHECK(source IN ('manual','auto_review','ai_plan')) DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (list_id) REFERENCES ticktick_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES ticktick_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticktick_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#999999'
);

CREATE TABLE IF NOT EXISTS ticktick_focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  session_type TEXT CHECK(session_type IN ('focus','short_break','long_break')) DEFAULT 'focus',
  completed INTEGER NOT NULL DEFAULT 1,
  white_noise TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ticktick_tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ticktick_bridge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticktick_task_id TEXT NOT NULL,
  linked_type TEXT NOT NULL CHECK(linked_type IN ('question','knowledge_point','subject','study_task')),
  linked_id TEXT NOT NULL,
  sync_review INTEGER NOT NULL DEFAULT 1,
  sync_mastery INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ticktick_task_id) REFERENCES ticktick_tasks(id) ON DELETE CASCADE,
  UNIQUE(ticktick_task_id, linked_type, linked_id)
);

CREATE TABLE IF NOT EXISTS ticktick_ai_plans (
  id TEXT PRIMARY KEY,
  plan_date TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_list ON ticktick_tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_date ON ticktick_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_parent ON ticktick_tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_bridge_task ON ticktick_bridge(ticktick_task_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_bridge_linked ON ticktick_bridge(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_focus_task ON ticktick_focus_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_ai_plans_date ON ticktick_ai_plans(plan_date);

CREATE TABLE IF NOT EXISTS ticktick_habits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT DEFAULT 'check',
  color TEXT NOT NULL DEFAULT '#4a90d9',
  goal_description TEXT DEFAULT '',
  frequency TEXT DEFAULT 'daily' CHECK(frequency IN ('daily','weekly')),
  target_count INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticktick_habit_logs (
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL,
  log_date TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (habit_id) REFERENCES ticktick_habits(id) ON DELETE CASCADE,
  UNIQUE(habit_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON ticktick_habit_logs(habit_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON ticktick_habit_logs(log_date);
`;
