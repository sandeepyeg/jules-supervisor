import express from 'express';
import { pool } from '../db/connection.js';
import * as queries from '../db/queries.js';
import * as github from '../services/github.js';
import * as taskManager from '../core/taskManager.js';
import * as poller from '../core/poller.js';
import { portalAuth } from './auth.js';

const router = express.Router();

/**
 * POST /api/sprints
 * Creates a new sprint, including plan sections and tasks with mapped dependencies.
 */
router.post('/', portalAuth, async (req, res) => {
  const { title, mainBranch, planSections, tasks } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Insert Sprint
    const [sprintRes] = await connection.query(
      'INSERT INTO sprints (title, main_branch, status) VALUES (?, ?, ?)',
      [title, mainBranch || 'main', 'draft']
    );
    const sprintId = sprintRes.insertId;

    // 2. Insert Plan Sections
    if (Array.isArray(planSections)) {
      for (const section of planSections) {
        if (section.key && section.content) {
          await connection.query(
            'INSERT INTO plan_sections (sprint_id, section_key, content) VALUES (?, ?, ?)',
            [sprintId, section.key, section.content]
          );
        }
      }
    }

    // 3. Insert Tasks and map dependencies
    if (Array.isArray(tasks)) {
      const insertedTasks = [];
      const clientToDbMap = {};

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const [taskRes] = await connection.query(
          `INSERT INTO tasks (sprint_id, title, description, jules_notes, mode, status, context_sections, sort_order) 
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
          [
            sprintId,
            t.title,
            t.description || '',
            t.jules_notes || null,
            t.mode || 'ai_assisted',
            JSON.stringify(t.context_sections || []),
            i
          ]
        );
        
        const dbId = taskRes.insertId;
        insertedTasks.push({ dbId, clientTask: t });
        
        // Map index and temp client-side ID
        clientToDbMap[i] = dbId;
        if (t.id !== undefined) {
          clientToDbMap[t.id] = dbId;
        }
      }

      // Update depends_on for tasks using real DB IDs
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
    res.status(201).json({ sprintId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating sprint:', error);
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

/**
 * POST /api/sprints/:id/start
 * Configures the git branch, updates state, starts ready tasks, and runs the poller.
 */
router.post('/:id/start', portalAuth, async (req, res) => {
  const sprintId = parseInt(req.params.id, 10);
  
  try {
    const sprint = await queries.getSprint(sprintId);
    if (!sprint) {
      return res.status(404).json({ error: 'Sprint not found' });
    }

    if (sprint.status !== 'draft') {
      return res.status(400).json({ error: 'Sprint is already started or completed' });
    }

    const branchName = `feature/sprint-${sprintId}`;
    console.log(`Creating branch ${branchName} from ${sprint.main_branch}...`);
    
    // Create github branch
    await github.createBranch(branchName, sprint.main_branch);

    // Update sprint in DB
    await queries.updateSprintStatus(sprintId, 'active', {
      sprint_branch: branchName,
      started_at: new Date()
    });

    // Start ready tasks immediately (don't wait for first poll)
    console.log('Launching initial tasks...');
    await taskManager.startReadyTasks(sprintId, branchName);

    // Start poller loop
    poller.startPoller(sprintId);

    res.json({ started: true, branch: branchName });
  } catch (error) {
    console.error('Error starting sprint:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/sprints/:id
 * Returns a sprint with all its associated plan sections and tasks.
 */
router.get('/:id', async (req, res) => {
  const sprintId = parseInt(req.params.id, 10);
  try {
    const sprint = await queries.getSprint(sprintId);
    if (!sprint) {
      return res.status(404).json({ error: 'Sprint not found' });
    }

    const planSections = await queries.getPlanSections(sprintId);
    
    const [tasks] = await pool.query(
      'SELECT * FROM tasks WHERE sprint_id = ? ORDER BY sort_order ASC',
      [sprintId]
    );

    res.json({
      ...sprint,
      planSections,
      tasks
    });
  } catch (error) {
    console.error('Error getting sprint:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/sprints/:id/qalog
 * Returns all QA Log records for tasks in a sprint.
 */
router.get('/:id/qalog', async (req, res) => {
  const sprintId = parseInt(req.params.id, 10);
  try {
    const [logs] = await pool.query(
      `SELECT q.*, t.title as task_title 
       FROM qa_log q 
       JOIN tasks t ON q.task_id = t.id 
       WHERE t.sprint_id = ? 
       ORDER BY q.created_at DESC`,
      [sprintId]
    );
    res.json(logs);
  } catch (error) {
    console.error('Error fetching QA Log:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
