-- Jules Supervisor Production Database DDL Schema (MySQL / MariaDB / PostgreSQL Compatible)

CREATE TABLE IF NOT EXISTS epics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  goal TEXT,
  master_feature_branch VARCHAR(255) NOT NULL,
  target_base_branch VARCHAR(255) DEFAULT 'develop',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  epic_id INT,
  phase_number INT DEFAULT 1,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  phase_branch VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phase_id INT NOT NULL,
  task_number INT DEFAULT 1,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  jules_notes TEXT,
  status VARCHAR(50) DEFAULT 'queued',
  jules_session_id VARCHAR(255),
  pr_number INT,
  pr_url VARCHAR(512),
  pr_revision_count INT DEFAULT 0,
  last_review_feedback TEXT,
  depends_on JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qa_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT,
  action VARCHAR(255) NOT NULL,
  details TEXT,
  source VARCHAR(50) DEFAULT 'system',
  activity_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_pending (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  telegram_message_id INT NOT NULL,
  activity_id VARCHAR(255),
  question_text TEXT,
  reminder_count INT DEFAULT 0,
  last_reminder_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_phases_epic_id ON phases(epic_id);
CREATE INDEX idx_tasks_phase_id ON tasks(phase_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_session ON tasks(jules_session_id);
