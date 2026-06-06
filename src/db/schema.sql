CREATE DATABASE IF NOT EXISTS jules_supervisor;
USE jules_supervisor;

CREATE TABLE IF NOT EXISTS sprints (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  status ENUM('draft','active','complete','failed') DEFAULT 'draft',
  sprint_branch VARCHAR(255),
  main_branch VARCHAR(255) DEFAULT 'main',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS plan_sections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sprint_id INT NOT NULL,
  section_key VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sprint_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  jules_notes TEXT,
  mode ENUM('ai_assisted','manual') DEFAULT 'ai_assisted',
  status ENUM('queued','running','waiting_answer','pr_open','merged','failed','skipped') DEFAULT 'queued',
  depends_on JSON COMMENT 'Array of task IDs this task waits for',
  context_sections JSON COMMENT 'Array of section_key strings to pull for Q&A',
  sort_order INT DEFAULT 0,
  jules_session_id VARCHAR(255),
  pr_url VARCHAR(500),
  pr_number INT,
  last_activity_id VARCHAR(255) COMMENT 'Last Jules activity we responded to',
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qa_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  jules_question TEXT NOT NULL,
  answer TEXT NOT NULL,
  answered_by ENUM('gemini','deepseek','telegram','system') NOT NULL,
  confidence_score FLOAT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS telegram_pending (
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
