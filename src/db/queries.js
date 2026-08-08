import { pool } from './connection.js';

/**
 * Creates a new Epic container.
 */
export async function createEpic({ title, master_feature_branch, target_base_branch = 'develop' }) {
  const [result] = await pool.query(
    'INSERT INTO epics (title, master_feature_branch, target_base_branch, status) VALUES (?, ?, ?, ?)',
    [title, master_feature_branch, target_base_branch, 'active']
  );
  return result.insertId;
}

/**
 * Retrieves an epic by ID.
 */
export async function getEpic(epicId) {
  const [rows] = await pool.query('SELECT * FROM phases WHERE id = ?', [epicId]);
  // Also check epics table
  const [epicRows] = await pool.query('SELECT * FROM epics WHERE id = ?', [epicId]);
  return epicRows[0] || rows[0] || null;
}

/**
 * Retrieves all epics.
 */
export async function getEpics() {
  const [rows] = await pool.query('SELECT * FROM epics ORDER BY id DESC');
  return rows;
}

/**
 * Retrieves all phases for a given epic.
 */
export async function getEpicPhases(epicId) {
  const [rows] = await pool.query('SELECT * FROM phases WHERE epic_id = ? ORDER BY id ASC', [epicId]);
  return rows;
}

/**
 * Retrieves all phases.
 */
export async function getPhases() {
  const [rows] = await pool.query('SELECT * FROM phases ORDER BY id ASC');
  return rows;
}

/**
 * Creates a new phase record with epic and dependency support.
 */
export async function createPhase({ title, description = '', status = 'active', phase_branch = null, main_branch = 'develop', epic_id = null, depends_on_phase_id = null }) {
  const [result] = await pool.query(
    'INSERT INTO phases (title, description, status, phase_branch, main_branch, epic_id, depends_on_phase_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, description, status, phase_branch, main_branch, epic_id, depends_on_phase_id]
  );
  return result.insertId;
}

/**
 * Retrieves queued phases ready to start (parent phase is complete or depends_on_phase_id is null).
 */
export async function getQueuedPhasesReadyToStart() {
  const [queuedPhases] = await pool.query("SELECT * FROM phases WHERE status = 'queued'");
  const [completedPhases] = await pool.query("SELECT id FROM phases WHERE status = 'complete'");
  const completedIds = new Set(completedPhases.map(p => p.id));

  return queuedPhases.filter(p => !p.depends_on_phase_id || completedIds.has(p.depends_on_phase_id));
}

/**
 * Retrieves a phase record by ID.
 */
export async function getPhase(phaseId) {
  const [rows] = await pool.query('SELECT * FROM phases WHERE id = ?', [phaseId]);
  return rows[0] || null;
}

/**
 * Updates the status and metadata of a phase.
 */
export async function updatePhaseStatus(phaseId, status, extra = {}) {
  const fields = ['status = ?'];
  const values = [status];
  
  if (extra.phase_branch !== undefined) {
    fields.push('phase_branch = ?');
    values.push(extra.phase_branch);
  }
  if (extra.main_branch !== undefined) {
    fields.push('main_branch = ?');
    values.push(extra.main_branch);
  }
  if (extra.started_at !== undefined) {
    fields.push('started_at = ?');
    values.push(extra.started_at);
  }
  if (extra.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(extra.completed_at);
  }
  
  values.push(phaseId);
  const sql = `UPDATE phases SET ${fields.join(', ')} WHERE id = ?`;
  await pool.query(sql, values);
}

/**
 * Retrieves a task record by ID.
 */
export async function getTask(taskId) {
  const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
  return rows[0] || null;
}

/**
 * Updates the status and runtime metadata of a task.
 */
export async function updateTaskStatus(taskId, status, extra = {}) {
  const fields = ['status = ?'];
  const values = [status];
  
  if (extra.jules_session_id !== undefined) {
    fields.push('jules_session_id = ?');
    values.push(extra.jules_session_id);
  }
  if (extra.pr_url !== undefined) {
    fields.push('pr_url = ?');
    values.push(extra.pr_url);
  }
  if (extra.pr_number !== undefined) {
    fields.push('pr_number = ?');
    values.push(extra.pr_number);
  }
  if (extra.last_activity_id !== undefined) {
    fields.push('last_activity_id = ?');
    values.push(extra.last_activity_id);
  }
  if (extra.retry_count !== undefined) {
    fields.push('retry_count = ?');
    values.push(extra.retry_count);
  }
  if (extra.last_reviewed_sha !== undefined) {
    fields.push('last_reviewed_sha = ?');
    values.push(extra.last_reviewed_sha);
  }
  if (extra.last_review_verdict !== undefined) {
    fields.push('last_review_verdict = ?');
    values.push(extra.last_review_verdict);
  }
  if (extra.last_review_feedback !== undefined) {
    fields.push('last_review_feedback = ?');
    values.push(extra.last_review_feedback);
  }
  if (extra.pr_revision_count !== undefined) {
    fields.push('pr_revision_count = ?');
    values.push(extra.pr_revision_count);
  }
  if (extra.nudge_sent !== undefined) {
    fields.push('nudge_sent = ?');
    values.push(extra.nudge_sent);
  }
  if (extra.escalated !== undefined) {
    fields.push('escalated = ?');
    values.push(extra.escalated);
  }

  values.push(taskId);
  const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
  await pool.query(sql, values);
}

/**
 * Gets tasks that are currently active in a phase.
 */
export async function getActiveTasks(phaseId) {
  const [rows] = await pool.query(
    "SELECT * FROM tasks WHERE phase_id = ? AND status IN ('running', 'waiting_answer', 'pr_open')",
    [phaseId]
  );
  return rows;
}

/**
 * Gets count of all tasks currently running in Jules across all phases.
 */
export async function getGlobalRunningTaskCount() {
  const [rows] = await pool.query("SELECT COUNT(*) as count FROM tasks WHERE status IN ('running', 'waiting_answer')");
  return rows[0] ? parseInt(rows[0].count, 10) : 0;
}

/**
 * Gets count of all tasks launched in the past 24 hours.
 */
export async function getDailyLaunchedTaskCount() {
  const [rows] = await pool.query("SELECT COUNT(*) as count FROM tasks WHERE jules_session_id IS NOT NULL");
  return rows[0] ? parseInt(rows[0].count, 10) : 0;
}

/**
 * Returns ALL tasks for a phase regardless of status.
 */
export async function getTasksForPhase(phaseId) {
  const [rows] = await pool.query(
    'SELECT * FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC',
    [phaseId]
  );
  return rows;
}

/**
 * Resolves queued tasks whose dependencies have already merged or skipped.
 */
export async function getQueuedReadyTasks(phaseId) {
  const [tasks] = await pool.query('SELECT * FROM tasks WHERE phase_id = ?', [phaseId]);
  
  const statusMap = new Map();
  for (const task of tasks) {
    statusMap.set(task.id, task.status);
  }
  
  const readyTasks = [];
  for (const task of tasks) {
    if (task.status !== 'queued') continue;
    
    let dependsOn = [];
    if (task.depends_on) {
      try {
        dependsOn = typeof task.depends_on === 'string' ? JSON.parse(task.depends_on) : task.depends_on;
      } catch (e) {
        console.error(`Error parsing depends_on for task #${task.id}:`, e);
      }
    }
    
    const allDependenciesMerged = dependsOn.every(depId => {
      const status = statusMap.get(depId);
      return status === 'merged' || status === 'skipped' || status === 'unreviewed';
    });
    
    if (allDependenciesMerged) {
      readyTasks.push(task);
    }
  }
  
  return readyTasks;
}

/**
 * Logs QA transactions to the database.
 */
export async function logQA(taskId, question, answer, answeredBy, confidenceScore) {
  const [result] = await pool.query(
    'INSERT INTO qa_log (task_id, jules_question, answer, answered_by, confidence_score) VALUES (?, ?, ?, ?, ?)',
    [taskId, question, answer, answeredBy, confidenceScore]
  );
  return result.insertId;
}

/**
 * Checks whether a QA/system marker already exists for a task.
 */
export async function hasQALogEntry(taskId, question) {
  const [rows] = await pool.query(
    'SELECT id FROM qa_log WHERE task_id = ? AND jules_question = ? LIMIT 1',
    [taskId, question]
  );
  return rows.length > 0;
}

/**
 * Logs an unresolved Telegram escalation for a task.
 */
export async function createTelegramPending(taskId, question, telegramMessageId) {
  const [result] = await pool.query(
    'INSERT INTO telegram_pending (task_id, jules_question, telegram_message_id) VALUES (?, ?, ?)',
    [taskId, question, telegramMessageId]
  );
  return result.insertId;
}

/**
 * Checks for pending developer replies using the Telegram Message ID.
 */
export async function getTelegramPendingByMessageId(replyToMessageId) {
  const [rows] = await pool.query(
    'SELECT * FROM telegram_pending WHERE telegram_message_id = ? AND resolved = FALSE LIMIT 1',
    [replyToMessageId]
  );
  return rows[0] || null;
}

/**
 * Resolves a pending Telegram ticket.
 */
export async function resolveTelegramPending(pendingId) {
  await pool.query('UPDATE telegram_pending SET resolved = TRUE WHERE id = ?', [pendingId]);
}

/**
 * Returns tickets that are overdue and require subsequent reminders.
 */
export async function getUnresolvedPendingOlderThan(ms) {
  const seconds = Math.round(ms / 1000);
  const [rows] = await pool.query(
    'SELECT * FROM telegram_pending WHERE resolved = FALSE AND last_reminder_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
    [seconds]
  );
  return rows;
}

/**
 * Increments the reminder counter and updates timing.
 */
export async function updateReminderSent(pendingId) {
  await pool.query(
    'UPDATE telegram_pending SET reminder_count = reminder_count + 1, last_reminder_at = CURRENT_TIMESTAMP WHERE id = ?',
    [pendingId]
  );
}

/**
 * Resets a task to 'queued' state for rework on the latest target branch after merge conflict.
 */
export async function resetTaskForConflictRework(taskId, nextRetryCount) {
  await updateTaskStatus(taskId, 'queued', {
    jules_session_id: null,
    pr_url: null,
    pr_number: null,
    pr_revision_count: 0,
    last_reviewed_sha: null,
    last_review_verdict: null,
    last_review_feedback: null,
    escalated: false,
    retry_count: nextRetryCount
  });
}

