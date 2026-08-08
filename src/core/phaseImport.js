import { pool } from '../db/connection.js';

/**
 * Creates a phase and its tasks from a single JSON payload in one transaction,
 * mapping task dependencies by array index or client-supplied id. Shared by the
 * dashboard's "Create Running Phase" form and the Telegram bulk-import command —
 * both submit the exact same shape, so this is the one place that validates it.
 *
 * Expected payload shape:
 * {
 *   "title": "Phase title",              // required
 *   "description": "Phase goals...",     // optional
 *   "mainBranch": "main",                 // optional, defaults to "main"
 *   "tasks": [
 *     { "title": "Task 1", "description": "...", "mode": "ai_assisted" },
 *     { "title": "Task 2", "depends_on": [0] }   // 0-based index into this array
 *   ]
 * }
 *
 * Always creates a draft phase — never auto-starts it. Starting (creating the
 * GitHub branch and launching sessions) stays a deliberate, separate action.
 */
function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

export async function createPhaseFromPayload(payload) {
  const { title, description, mainBranch, tasks } = payload || {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    throw validationError('Phase "title" is required.');
  }

  if (tasks !== undefined && !Array.isArray(tasks)) {
    throw validationError('"tasks" must be an array.');
  }

  const taskList = Array.isArray(tasks) ? tasks : [];
  taskList.forEach((t, i) => {
    if (!t || typeof t.title !== 'string' || !t.title.trim()) {
      throw validationError(`Task at index ${i} is missing a "title".`);
    }
  });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [phaseRes] = await connection.query(
      'INSERT INTO phases (title, description, main_branch, status) VALUES (?, ?, ?, ?)',
      [title.trim(), description || '', mainBranch || 'main', 'draft']
    );
    const phaseId = phaseRes.insertId;

    const insertedTasks = [];
    const clientToDbMap = {};

    for (let i = 0; i < taskList.length; i++) {
      const t = taskList[i];
      const [taskRes] = await connection.query(
        `INSERT INTO tasks (phase_id, title, description, jules_notes, mode, status, sort_order)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
        [
          phaseId,
          t.title,
          t.description || '',
          t.jules_notes || null,
          t.mode || 'ai_assisted',
          i
        ]
      );

      const dbId = taskRes.insertId;
      insertedTasks.push({ dbId, clientTask: t });

      clientToDbMap[i] = dbId;
      if (t.id !== undefined) {
        clientToDbMap[t.id] = dbId;
      }
    }

    for (const item of insertedTasks) {
      const clientDeps = item.clientTask.depends_on || [];
      const dbDeps = clientDeps.map(dep => {
        if (clientToDbMap[dep] !== undefined) {
          return clientToDbMap[dep];
        }
        const num = parseInt(dep, 10);
        return isNaN(num) ? dep : num;
      });

      await connection.query(
        'UPDATE tasks SET depends_on = ? WHERE id = ?',
        [JSON.stringify(dbDeps), item.dbId]
      );
    }

    await connection.commit();
    return { phaseId, taskCount: taskList.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Creates an Epic and chained phases with their tasks from a multi-phase JSON payload.
 */
export async function createEpicFromPayload(payload) {
  const { epic_title, title, master_feature_branch, target_base_branch = 'develop', phases } = payload || {};
  const epicTitle = epic_title || title || 'New Multi-Phase Epic';
  const masterBranch = master_feature_branch || `feature/epic-${Date.now()}`;

  if (!Array.isArray(phases) || phases.length === 0) {
    throw validationError('Multi-phase import payload must contain a non-empty "phases" array.');
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [epicRes] = await connection.query(
      'INSERT INTO epics (title, master_feature_branch, target_base_branch, status) VALUES (?, ?, ?, ?)',
      [epicTitle, masterBranch, target_base_branch, 'active']
    );
    const epicId = epicRes.insertId;

    const createdPhaseIds = [];

    for (let pIdx = 0; pIdx < phases.length; pIdx++) {
      const p = phases[pIdx];
      const dependsOnIdx = p.depends_on_index !== undefined ? p.depends_on_index : (pIdx > 0 ? pIdx - 1 : null);
      const dependsOnPhaseId = dependsOnIdx !== null && createdPhaseIds[dependsOnIdx] ? createdPhaseIds[dependsOnIdx] : null;

      const phaseStatus = pIdx === 0 ? 'draft' : 'queued';
      const phaseBranch = pIdx === 0 ? masterBranch : null;

      const [phaseRes] = await connection.query(
        'INSERT INTO phases (epic_id, depends_on_phase_id, title, description, main_branch, phase_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [epicId, dependsOnPhaseId, p.title || `Phase ${pIdx + 1}`, p.description || '', masterBranch, phaseBranch, phaseStatus]
      );
      const phaseId = phaseRes.insertId;
      createdPhaseIds.push(phaseId);

      const taskList = Array.isArray(p.tasks) ? p.tasks : [];
      const clientToDbMap = {};
      const insertedTasks = [];

      for (let tIdx = 0; tIdx < taskList.length; tIdx++) {
        const t = taskList[tIdx];
        const [taskRes] = await connection.query(
          `INSERT INTO tasks (phase_id, title, description, jules_notes, mode, status, sort_order)
           VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
          [phaseId, t.title || `Task ${tIdx + 1}`, t.description || '', t.jules_notes || null, t.mode || 'ai_assisted', tIdx]
        );
        const dbId = taskRes.insertId;
        insertedTasks.push({ dbId, clientTask: t });
        clientToDbMap[tIdx] = dbId;
        if (t.id !== undefined) clientToDbMap[t.id] = dbId;
      }

      for (const item of insertedTasks) {
        const clientDeps = item.clientTask.depends_on || [];
        const dbDeps = clientDeps.map(dep => {
          if (clientToDbMap[dep] !== undefined) return clientToDbMap[dep];
          const num = parseInt(dep, 10);
          return isNaN(num) ? dep : num;
        });
        await connection.query('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify(dbDeps), item.dbId]);
      }
    }

    await connection.commit();
    return { epicId, masterBranch, phaseIds: createdPhaseIds };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Appends a single phase JSON payload into an existing Epic container.
 */
export async function createPhaseInEpicFromPayload(epicId, payload) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [epicRows] = await connection.query('SELECT * FROM epics WHERE id = ?', [epicId]);
    const epic = epicRows[0];
    const masterBranch = epic ? epic.master_feature_branch : 'develop';

    const [existingPhases] = await connection.query(
      'SELECT id FROM phases WHERE epic_id = ? ORDER BY id DESC LIMIT 1',
      [epicId]
    );
    const parentPhaseId = existingPhases.length > 0 ? existingPhases[0].id : null;

    const { title, description, tasks } = payload || {};
    const [phaseRes] = await connection.query(
      'INSERT INTO phases (epic_id, depends_on_phase_id, title, description, main_branch, status) VALUES (?, ?, ?, ?, ?, ?)',
      [epicId, parentPhaseId, title || 'Imported Phase', description || '', masterBranch, 'queued']
    );
    const phaseId = phaseRes.insertId;

    const taskList = Array.isArray(tasks) ? tasks : [];
    const clientToDbMap = {};
    const insertedTasks = [];

    for (let tIdx = 0; tIdx < taskList.length; tIdx++) {
      const t = taskList[tIdx];
      const [taskRes] = await connection.query(
        `INSERT INTO tasks (phase_id, title, description, jules_notes, mode, status, sort_order)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
        [phaseId, t.title || `Task ${tIdx + 1}`, t.description || '', t.jules_notes || null, t.mode || 'ai_assisted', tIdx]
      );
      const dbId = taskRes.insertId;
      insertedTasks.push({ dbId, clientTask: t });
      clientToDbMap[tIdx] = dbId;
      if (t.id !== undefined) clientToDbMap[t.id] = dbId;
    }

    for (const item of insertedTasks) {
      const clientDeps = item.clientTask.depends_on || [];
      const dbDeps = clientDeps.map(dep => {
        if (clientToDbMap[dep] !== undefined) return clientToDbMap[dep];
        const num = parseInt(dep, 10);
        return isNaN(num) ? dep : num;
      });
      await connection.query('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify(dbDeps), item.dbId]);
    }

    await connection.commit();
    return { epicId, phaseId, dependsOnPhaseId: parentPhaseId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
