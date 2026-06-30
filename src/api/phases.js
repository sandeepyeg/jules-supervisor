import express from 'express';
import { pool } from '../db/connection.js';
import * as queries from '../db/queries.js';
import * as github from '../services/github.js';
import * as taskManager from '../core/taskManager.js';
import * as poller from '../core/poller.js';
import { portalAuth } from './auth.js';

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
 * Exposes non-secret GitHub metadata for the frontend (owner/repo).
 */
router.get('/config', portalAuth, (req, res) => {
  res.json({
    githubOwner: process.env.GITHUB_OWNER || '',
    githubRepo:  process.env.GITHUB_REPO  || '',
  });
});

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

    // Generate a unique, meaningful branch name from the phase title + short timestamp
    const titleSlug = (phase.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → dash
      .replace(/^-+|-+$/g, '')        // trim leading/trailing dashes
      .substring(0, 40)               // max 40 chars
      || `phase-${phaseId}`;
    const shortTs = Date.now().toString(36).slice(-5); // e.g. "a3f2k"
    const branchName = `feature/${titleSlug}-${shortTs}`;
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

export default router;
