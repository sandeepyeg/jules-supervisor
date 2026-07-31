import express from 'express';
import { pool } from '../db/connection.js';
import * as queries from '../db/queries.js';
import * as github from '../services/github.js';
import * as taskManager from '../core/taskManager.js';
import * as poller from '../core/poller.js';
import { portalAuth } from './auth.js';
import { MAX_AUTO_REVISION_ATTEMPTS } from '../core/config.js';
import { createPhaseFromPayload } from '../core/phaseImport.js';
import { startPhase } from '../core/phaseLifecycle.js';

const router = express.Router();

/**
 * GET /api/phases
 * Returns a list of all phases (recent first) to check existing phases.
 */
router.get('/', portalAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM phases ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching phases:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/phases/config
 * Exposes non-secret metadata for the frontend (GitHub owner/repo, review tunables).
 */
router.get('/config', portalAuth, (req, res) => {
  res.json({
    githubOwner: process.env.GITHUB_OWNER || '',
    githubRepo:  process.env.GITHUB_REPO  || '',
    maxAutoRevisionAttempts: MAX_AUTO_REVISION_ATTEMPTS,
  });
});

/**
 * GET /api/phases/github/branches
 * Returns a list of branch names in the repository.
 */
router.get('/github/branches', portalAuth, async (req, res) => {
  try {
    const branches = await github.listBranches();
    const names = branches.map(b => b.name);
    res.json(names);
  } catch (error) {
    console.error('Error listing branches:', error);
    // If GitHub token is mock/placeholder, fallback to standard list
    res.json(['main', 'master', 'dev', 'feature/phase-1']);
  }
});

/**
 * POST /api/phases
 * Creates a new phase with a description and its associated tasks, mapping dependencies.
 */
router.post('/', portalAuth, async (req, res) => {
  try {
    const { phaseId } = await createPhaseFromPayload(req.body);
    res.status(201).json({ phaseId });
  } catch (error) {
    console.error('Error creating phase:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

/**
 * POST /api/phases/:id/start
 * Launches the phase: creates git branch, sets active flag, triggers initial tasks, starts poller.
 */
router.post('/:id/start', portalAuth, async (req, res) => {
  const phaseId = parseInt(req.params.id, 10);

  try {
    const result = await startPhase(phaseId);
    res.json(result);
  } catch (error) {
    console.error('Error starting phase:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

/**
 * GET /api/phases/:id
 * Retrieves the phase, its details, and its tasks ordered by sort_order.
 */
router.get('/:id', portalAuth, async (req, res) => {
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
router.get('/:id/qalog', portalAuth, async (req, res) => {
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

/**
 * POST /api/phases/:id/tasks
 * Appends a new task to an active or draft phase.
 */
router.post('/:id/tasks', portalAuth, async (req, res) => {
  const phaseId = parseInt(req.params.id, 10);
  const { title, description, jules_notes, mode, depends_on } = req.body;
  
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }
  
  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }
    
    // Get max sort_order to append to the end
    const [maxRes] = await pool.query('SELECT MAX(sort_order) as maxSort FROM tasks WHERE phase_id = ?', [phaseId]);
    const nextSort = (maxRes[0]?.maxSort !== null ? maxRes[0].maxSort : -1) + 1;
    
    const [taskRes] = await pool.query(
      `INSERT INTO tasks (phase_id, title, description, jules_notes, mode, status, sort_order, depends_on) 
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        phaseId,
        title,
        description || '',
        jules_notes || null,
        mode || 'ai_assisted',
        nextSort,
        JSON.stringify(depends_on || [])
      ]
    );
    
    // If phase is active, start any tasks that might be ready
    if (phase.status === 'active') {
      await taskManager.startReadyTasks(phaseId, phase.phase_branch);
    }
    
    res.status(201).json({ taskId: taskRes.insertId });
  } catch (error) {
    console.error('Error appending task:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/phases/:id/sync
 * Triggers an immediate supervisor poll cycle for the phase.
 */
router.post('/:id/sync', portalAuth, async (req, res) => {
  const phaseId = parseInt(req.params.id, 10);
  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    const result = await poller.runPollCycle(phaseId);

    res.json({ synced: true, result });
  } catch (error) {
    console.error('Error syncing phase:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/phases/:id/tasks/:taskId
 * Updates a task status, session ID, or PR info and triggers ready tasks.
 */
router.patch('/:id/tasks/:taskId', portalAuth, async (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);
  const { status, pr_url, pr_number, jules_session_id } = req.body;
  
  try {
    const fields = {};
    if (pr_url !== undefined) fields.pr_url = pr_url;
    if (pr_number !== undefined) fields.pr_number = pr_number;
    if (jules_session_id !== undefined) fields.jules_session_id = jules_session_id;

    await queries.updateTaskStatus(taskId, status, fields);
    
    // Trigger startReadyTasks for active phase
    const phaseId = parseInt(req.params.id, 10);
    const phase = await queries.getPhase(phaseId);
    if (phase && phase.status === 'active') {
      await taskManager.startReadyTasks(phaseId, phase.phase_branch);
    }
    
    res.json({ updated: true });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
