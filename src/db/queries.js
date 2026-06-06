import { pool } from './connection.js';

export async function getSprint(sprintId) {
  const [rows] = await pool.query('SELECT * FROM sprints WHERE id = ?', [sprintId]);
  return rows[0] || null;
}

export async function updateSprintStatus(sprintId, status, extra = {}) {
  const fields = ['status = ?'];
  const values = [status];
  
  if (extra.sprint_branch !== undefined) {
    fields.push('sprint_branch = ?');
    values.push(extra.sprint_branch);
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
  
  values.push(sprintId);
  const sql = `UPDATE sprints SET ${fields.join(', ')} WHERE id = ?`;
  await pool.query(sql, values);
}

export async function getPlanSections(sprintId) {
  const [rows] = await pool.query('SELECT section_key, content FROM plan_sections WHERE sprint_id = ?', [sprintId]);
  return rows;
}

export async function getTask(taskId) {
  const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
  return rows[0] || null;
}

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
  
  values.push(taskId);
  const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
  await pool.query(sql, values);
}

export async function getActiveTasks(sprintId) {
  const [rows] = await pool.query(
    "SELECT * FROM tasks WHERE sprint_id = ? AND status IN ('running', 'waiting_answer', 'pr_open')",
    [sprintId]
  );
  return rows;
}

export async function getQueuedReadyTasks(sprintId) {
  // Select all tasks for this sprint to determine dependencies
  const [tasks] = await pool.query('SELECT * FROM tasks WHERE sprint_id = ?', [sprintId]);
  
  // Create a map of taskId -> status
  const statusMap = new Map();
  for (const task of tasks) {
    statusMap.set(task.id, task.status);
  }
  
  // Filter for ready tasks
  const readyTasks = [];
  for (const task of tasks) {
    if (task.status !== 'queued') continue;
    
    let dependsOn = [];
    if (task.depends_on) {
      try {
        dependsOn = typeof task.depends_on === 'string' ? JSON.parse(task.depends_on) : task.depends_on;
      } catch (e) {
        console.error('Error parsing depends_on for task', task.id, e);
      }
    }
    
    // Check if all dependencies are merged or skipped
    const allDependenciesMerged = dependsOn.every(depId => {
      const status = statusMap.get(depId);
      return status === 'merged' || status === 'skipped';
    });
    
    if (allDependenciesMerged) {
      readyTasks.push(task);
    }
  }
  
  return readyTasks;
}

export async function logQA(taskId, question, answer, answeredBy, confidenceScore) {
  const [result] = await pool.query(
    'INSERT INTO qa_log (task_id, jules_question, answer, answered_by, confidence_score) VALUES (?, ?, ?, ?, ?)',
    [taskId, question, answer, answeredBy, confidenceScore]
  );
  return result.insertId;
}

export async function createTelegramPending(taskId, question, telegramMessageId) {
  const [result] = await pool.query(
    'INSERT INTO telegram_pending (task_id, jules_question, telegram_message_id) VALUES (?, ?, ?)',
    [taskId, question, telegramMessageId]
  );
  return result.insertId;
}

export async function getTelegramPendingByMessageId(replyToMessageId) {
  const [rows] = await pool.query(
    'SELECT * FROM telegram_pending WHERE telegram_message_id = ? AND resolved = FALSE LIMIT 1',
    [replyToMessageId]
  );
  return rows[0] || null;
}

export async function resolveTelegramPending(pendingId) {
  await pool.query('UPDATE telegram_pending SET resolved = TRUE WHERE id = ?', [pendingId]);
}

export async function getUnresolvedPendingOlderThan(ms) {
  const seconds = Math.round(ms / 1000);
  const [rows] = await pool.query(
    'SELECT * FROM telegram_pending WHERE resolved = FALSE AND last_reminder_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
    [seconds]
  );
  return rows;
}

export async function updateReminderSent(pendingId) {
  await pool.query(
    'UPDATE telegram_pending SET reminder_count = reminder_count + 1, last_reminder_at = CURRENT_TIMESTAMP WHERE id = ?',
    [pendingId]
  );
}
