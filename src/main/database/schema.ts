export const schemaSql = `
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  wrong_thinking TEXT DEFAULT '',
  wrong_solution TEXT DEFAULT '',
  correct_solution TEXT DEFAULT '',
  answer TEXT DEFAULT '',
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
  subject TEXT DEFAULT '',
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

CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at);
CREATE INDEX IF NOT EXISTS idx_questions_next_review_at ON questions(next_review_at);
CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_mastery ON questions(mastery_level);
CREATE INDEX IF NOT EXISTS idx_review_logs_question ON review_logs(question_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_node ON knowledge_points(node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_parent ON knowledge_points(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_question_knowledge_question ON question_knowledge_points(question_id);
CREATE INDEX IF NOT EXISTS idx_question_knowledge_node ON question_knowledge_points(knowledge_node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_knowledge_unique ON question_knowledge_points(question_id, knowledge_node_id);
`;
