import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export let useMockDb = process.env.NODE_ENV === 'test';

export const inMemoryDb = {
  phases: [],
  tasks: [],
  qa_log: [],
  telegram_pending: []
};

let db_id_counter = 1;

export function resetInMemoryDb() {
  inMemoryDb.phases = [];
  inMemoryDb.tasks = [];
  inMemoryDb.qa_log = [];
  inMemoryDb.telegram_pending = [];
  db_id_counter = 1;
}

export function mockQuery(sql, params = []) {
  const sqlNormalized = sql.replace(/\s+/g, ' ').trim();

  // Dynamic INSERT handler
  if (sqlNormalized.startsWith('INSERT INTO')) {
    const table = sqlNormalized.split('INSERT INTO')[1].split('(')[0].trim();
    const colsPart = sqlNormalized.split('(')[1].split(')')[0];
    const cols = colsPart.split(',').map(c => c.trim());
    
    const id = db_id_counter++;
    const newRecord = { id };
    
    cols.forEach((col, idx) => {
      newRecord[col] = params[idx];
    });

    if (table === 'phases') {
      if (newRecord.status === undefined) newRecord.status = 'draft';
      if (newRecord.main_branch === undefined) newRecord.main_branch = 'main';
      newRecord.phase_branch = newRecord.phase_branch || null;
      newRecord.created_at = new Date();
      newRecord.started_at = null;
      newRecord.completed_at = null;
      inMemoryDb.phases.push(newRecord);
    } else if (table === 'tasks') {
      newRecord.jules_notes = newRecord.jules_notes || null;
      newRecord.mode = newRecord.mode || 'ai_assisted';
      newRecord.status = newRecord.status || 'queued';
      newRecord.depends_on = newRecord.depends_on || null;
      newRecord.sort_order = newRecord.sort_order || 0;
      newRecord.jules_session_id = null;
      newRecord.pr_url = null;
      newRecord.pr_number = null;
      newRecord.last_activity_id = null;
      newRecord.retry_count = 0;
      newRecord.created_at = new Date();
      newRecord.updated_at = new Date();
      inMemoryDb.tasks.push(newRecord);
    } else if (table === 'qa_log') {
      newRecord.created_at = new Date();
      inMemoryDb.qa_log.push(newRecord);
    } else if (table === 'telegram_pending') {
      newRecord.reminder_count = 0;
      newRecord.last_reminder_at = new Date();
      newRecord.resolved = 0;
      newRecord.created_at = new Date();
      inMemoryDb.telegram_pending.push(newRecord);
    }
    
    return [{ insertId: id }];
  }

  // SELECT * FROM phases WHERE id = ?
  if (sqlNormalized.startsWith('SELECT * FROM phases WHERE id = ?')) {
    const res = inMemoryDb.phases.find(p => p.id === params[0]);
    return [res ? [res] : []];
  }

  // SELECT * FROM phases ORDER BY created_at DESC
  if (sqlNormalized.startsWith('SELECT * FROM phases ORDER BY')) {
    return [[...inMemoryDb.phases].sort((a, b) => b.created_at - a.created_at)];
  }

  // SELECT id FROM phases WHERE status = 'active'
  if (sqlNormalized.startsWith("SELECT id FROM phases WHERE status = 'active'")) {
    return [inMemoryDb.phases.filter(p => p.status === 'active').map(p => ({ id: p.id }))];
  }

  // SELECT * FROM tasks WHERE id = ?
  if (sqlNormalized.startsWith('SELECT * FROM tasks WHERE id = ?')) {
    const res = inMemoryDb.tasks.find(t => t.id === params[0]);
    return [res ? [res] : []];
  }

  // SELECT status, title FROM tasks WHERE phase_id = ?
  if (sqlNormalized.includes('SELECT status, title FROM tasks WHERE phase_id = ?')) {
    return [inMemoryDb.tasks.filter(t => t.phase_id === params[0]).map(t => ({ status: t.status, title: t.title }))];
  }

  // SELECT * FROM tasks WHERE phase_id = ? AND status IN ('running', 'waiting_answer', 'pr_open')
  if (sqlNormalized.includes("status IN ('running', 'waiting_answer', 'pr_open')") || sqlNormalized.includes("status IN ('running','waiting_answer','pr_open')")) {
    return [inMemoryDb.tasks.filter(t => t.phase_id === params[0] && ['running', 'waiting_answer', 'pr_open'].includes(t.status))];
  }

  // SELECT MAX(sort_order) as maxSort FROM tasks WHERE phase_id = ?
  if (sqlNormalized.startsWith('SELECT MAX(sort_order) as maxSort FROM tasks WHERE phase_id = ?')) {
    const phaseTasks = inMemoryDb.tasks.filter(t => t.phase_id === params[0]);
    const maxSort = phaseTasks.length
      ? Math.max(...phaseTasks.map(t => Number(t.sort_order || 0)))
      : null;
    return [[{ maxSort }]];
  }

  // SELECT * FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC
  if (sqlNormalized.includes('SELECT * FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC')) {
    return [inMemoryDb.tasks.filter(t => t.phase_id === params[0]).sort((a, b) => a.sort_order - b.sort_order)];
  }

  // SELECT * FROM tasks WHERE phase_id = ?
  if (sqlNormalized.startsWith('SELECT * FROM tasks WHERE phase_id = ?')) {
    return [inMemoryDb.tasks.filter(t => t.phase_id === params[0])];
  }

  // SELECT * FROM telegram_pending WHERE telegram_message_id = ? AND resolved = FALSE LIMIT 1
  if (sqlNormalized.startsWith('SELECT * FROM telegram_pending WHERE telegram_message_id = ? AND resolved = FALSE')) {
    const res = inMemoryDb.telegram_pending.find(p => p.telegram_message_id === params[0] && p.resolved === 0);
    return [res ? [res] : []];
  }

  // SELECT * FROM telegram_pending WHERE task_id = ?
  if (sqlNormalized.startsWith('SELECT * FROM telegram_pending WHERE task_id = ?')) {
    return [inMemoryDb.telegram_pending.filter(p => p.task_id === params[0])];
  }

  // SELECT * FROM telegram_pending WHERE resolved = FALSE AND last_reminder_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
  if (sqlNormalized.startsWith('SELECT * FROM telegram_pending WHERE resolved = FALSE')) {
    return [[]];
  }

  // SELECT * FROM qa_log WHERE task_id = ? ORDER BY id DESC
  if (sqlNormalized.startsWith('SELECT * FROM qa_log WHERE task_id = ? ORDER BY id DESC')) {
    return [inMemoryDb.qa_log.filter(q => q.task_id === params[0]).sort((a, b) => b.id - a.id)];
  }

  // SELECT q.*, t.title as task_title FROM qa_log q JOIN tasks t ON q.task_id = t.id WHERE t.phase_id = ? ORDER BY q.created_at DESC
  if (sqlNormalized.includes('FROM qa_log q JOIN tasks t ON q.task_id = t.id WHERE t.phase_id = ?')) {
    const logs = [];
    for (const q of inMemoryDb.qa_log) {
      const task = inMemoryDb.tasks.find(t => t.id === q.task_id);
      if (task && task.phase_id === params[0]) {
        logs.push({ ...q, task_title: task.title });
      }
    }
    return [logs.sort((a, b) => b.created_at - a.created_at)];
  }

  // UPDATE phases SET
  if (sqlNormalized.startsWith('UPDATE phases SET')) {
    const phaseId = params[params.length - 1];
    const phase = inMemoryDb.phases.find(p => p.id === phaseId);
    if (phase) {
      const matches = [...sqlNormalized.matchAll(/([a-zA-Z0-9_]+)\s*=\s*\?/g)];
      matches.forEach((match, idx) => {
        const col = match[1];
        phase[col] = params[idx];
      });
    }
    return [{}];
  }

  // UPDATE tasks SET
  if (sqlNormalized.startsWith('UPDATE tasks SET')) {
    const taskId = params[params.length - 1];
    const task = inMemoryDb.tasks.find(t => t.id === taskId);
    if (task) {
      const matches = [...sqlNormalized.matchAll(/([a-zA-Z0-9_]+)\s*=\s*\?/g)];
      matches.forEach((match, idx) => {
        const col = match[1];
        task[col] = params[idx];
      });
    }
    return [{}];
  }

  // UPDATE telegram_pending SET
  if (sqlNormalized.startsWith('UPDATE telegram_pending SET')) {
    const id = params[params.length - 1];
    const pending = inMemoryDb.telegram_pending.find(p => p.id === id);
    if (pending) {
      if (sqlNormalized.includes('resolved = TRUE') || sqlNormalized.includes('resolved = true')) {
        pending.resolved = 1;
      }
      if (sqlNormalized.includes('reminder_count = reminder_count + 1')) {
        pending.reminder_count++;
        pending.last_reminder_at = new Date();
      }
      const matches = [...sqlNormalized.matchAll(/([a-zA-Z0-9_]+)\s*=\s*\?/g)];
      matches.forEach((match, idx) => {
        const col = match[1];
        pending[col] = params[idx];
      });
    }
    return [{}];
  }

  // DELETE FROM phases WHERE id = ?
  if (sqlNormalized.startsWith('DELETE FROM phases WHERE id = ?')) {
    const phaseId = params[0];
    inMemoryDb.phases = inMemoryDb.phases.filter(p => p.id !== phaseId);
    inMemoryDb.tasks = inMemoryDb.tasks.filter(t => t.phase_id !== phaseId);
    return [{}];
  }

  if (sqlNormalized === 'SELECT 1') {
    return [[{ '1': 1 }]];
  }

  console.warn(`Unmatched mock query: ${sqlNormalized}`);
  return [[]];
}

const realPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'jules_supervisor',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export const pool = {
  query: async (sql, params) => {
    if (useMockDb) {
      return mockQuery(sql, params);
    }
    try {
      return await realPool.query(sql, params);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
        console.warn('MySQL connection refused. Falling back to in-memory database mock.');
        useMockDb = true;
        return mockQuery(sql, params);
      }
      throw err;
    }
  },
  getConnection: async () => {
    if (useMockDb) {
      return {
        query: async (sql, params) => mockQuery(sql, params),
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {}
      };
    }
    try {
      const conn = await realPool.getConnection();
      return conn;
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
        console.warn('MySQL connection refused in getConnection. Falling back to in-memory database mock.');
        useMockDb = true;
        return {
          query: async (sql, params) => mockQuery(sql, params),
          beginTransaction: async () => {},
          commit: async () => {},
          rollback: async () => {},
          release: () => {}
        };
      }
      throw err;
    }
  },
  end: async () => {
    if (useMockDb) return;
    return realPool.end();
  }
};

export async function runSchema() {
  if (useMockDb) {
    console.log('Database schema initialization bypassed in Mock DB mode.');
    return;
  }
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  
  const statements = schemaSql
    .split(';')
    .map(st => st.trim())
    .filter(st => {
      if (!st) return false;
      if (st.startsWith('--') || st.startsWith('/*')) return false;
      const upper = st.toUpperCase();
      if (upper.startsWith('CREATE DATABASE') || upper.startsWith('USE ')) return false;
      return true;
    });

  let connection;
  try {
    connection = await pool.getConnection();
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED')) {
      console.warn('MySQL connection refused in runSchema. Falling back to in-memory database mock.');
      useMockDb = true;
      return;
    }
    throw error;
  }

  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
    console.log('Database schema checked/initialized successfully.');
  } catch (error) {
    console.error('Error initializing database schema:', error);
    throw error;
  } finally {
    connection.release();
  }
}
