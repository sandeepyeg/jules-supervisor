DROP TABLE IF EXISTS telegram_pending;
DROP TABLE IF EXISTS qa_log;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS plan_sections;
DROP TABLE IF EXISTS sprints;
DROP TABLE IF EXISTS phases;

CREATE TABLE phases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status ENUM('draft','active','complete','failed') DEFAULT 'draft',
  phase_branch VARCHAR(255),
  main_branch VARCHAR(255) DEFAULT 'main',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL
);

CREATE TABLE tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phase_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  jules_notes TEXT,
  mode ENUM('ai_assisted','manual') DEFAULT 'ai_assisted',
  status ENUM('queued','running','waiting_answer','pr_open','merged','failed','skipped') DEFAULT 'queued',
  depends_on JSON COMMENT 'Array of task IDs this task waits for',
  sort_order INT DEFAULT 0,
  jules_session_id VARCHAR(255),
  pr_url VARCHAR(500),
  pr_number INT,
  last_activity_id VARCHAR(255) COMMENT 'Last Jules activity we responded to',
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE
);

CREATE TABLE qa_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  jules_question TEXT NOT NULL,
  answer TEXT NOT NULL,
  answered_by ENUM('gemini','deepseek','telegram','system') NOT NULL,
  confidence_score FLOAT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE telegram_pending (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  jules_question TEXT NOT NULL,
  telegram_message_id BIGINT NOT NULL,
  reminder_count INT DEFAULT 0,
  last_reminder_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
