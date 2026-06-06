import express from 'express';
import * as queries from '../db/queries.js';
import { portalAuth } from './auth.js';

const router = express.Router();

/**
 * GET /api/tasks/:id
 * Retrieves detail for a specific task.
 */
router.get('/:id', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  try {
    const task = await queries.getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
  } catch (error) {
    console.error(`Error fetching task #${taskId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/tasks/:id
 * Updates status or other attributes (like retry_count) of a task.
 */
router.patch('/:id', portalAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const { status, ...extra } = req.body;

  try {
    const task = await queries.getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await queries.updateTaskStatus(taskId, status || task.status, extra);
    const updated = await queries.getTask(taskId);
    res.json(updated);
  } catch (error) {
    console.error(`Error updating task #${taskId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
