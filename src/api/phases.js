import express from 'express';
import { pool } from '../db/connection.js';
import * as queries from '../db/queries.js';
import * as github from '../services/github.js';
import * as taskManager from '../core/taskManager.js';
import * as poller from '../core/poller.js';
import { portalAuth } from './auth.js';

const router = express.Router();

/**
 * POST /api/phases
 * Creates a new phase with a description and its associated tasks, mapping dependencies.
 */
router.post('/', portalAuth, async (req, res) => {
  const { title, description, mainBranch, tasks } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Insert Phase
    const [phaseRes] = await connection.query(
      'INSERT INTO phases (title, description, main_branch, status) VALUES (?, ?, ?, ?)',
      [title, description || '', mainBranch || 'main', 'draft']
    );
    const phaseId = phaseRes.insertId;

    // 2. Insert Tasks and map dependencies
    if (Array.isArray(tasks)) {
      const insertedTasks = [];
      const clientToDbMap = {};

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
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
        
        // Map index and client-side temp ID
        clientToDbMap[i] = dbId;
        if (t.id !== undefined) {
          clientToDbMap[t.id] = dbId;
        }
      }

      // Update depends_on using real DB IDs
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
    }

    await connection.commit();
    res.status(201).json({ phaseId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating phase:', error);
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

/**
 * POST /api/phases/:id/start
 * Launches the phase: creates git branch, sets active flag, triggers initial tasks, starts poller.
 */
router.post('/:id/start', portalAuth, async (req, res) => {
  const phaseId = parseInt(req.params.id, 10);
  
  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    if (phase.status !== 'draft') {
      return res.status(400).json({ error: 'Phase is already started or completed' });
    }

    const branchName = `feature/phase-${phaseId}`;
    console.log(`Creating branch ${branchName} from ${phase.main_branch}...`);
    
    // Create github branch
    await github.createBranch(branchName, phase.main_branch);

    // Update phase status to active
    await queries.updatePhaseStatus(phaseId, 'active', {
      phase_branch: branchName,
      started_at: new Date()
    });

    // Start ready tasks immediately
    console.log('Launching initial ready tasks...');
    await taskManager.startReadyTasks(phaseId, branchName);

    // Start background poller loop
    poller.startPoller(phaseId);

    res.json({ started: true, branch: branchName });
  } catch (error) {
    console.error('Error starting phase:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/phases/:id
 * Retrieves the phase, its details, and its tasks ordered by sort_order.
 */
router.get('/:id', async (req, res) => {
  const phaseId = parseInt(req.params.id, 10);
  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    const [tasks] = await pool.query(
      'SELECT * FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC',
      [phaseId]
    );

    res.json({
      ...phase,
      tasks
    });
  } catch (error) {
    console.error('Error getting phase details:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/phases/:id/qalog
 * Returns all QA transaction logs associated with tasks inside this phase.
 */
router.get('/:id/qalog', async (req, res) => {
  const phaseId = parseInt(req.params.id, 10);
  try {
    const [logs] = await pool.query(
      `SELECT q.*, t.title as task_title 
       FROM qa_log q 
       JOIN tasks t ON q.task_id = t.id 
       WHERE t.phase_id = ? 
       ORDER BY q.created_at DESC`,
      [phaseId]
    );
    res.json(logs);
  } catch (error) {
    console.error('Error fetching Phase QA Log:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
