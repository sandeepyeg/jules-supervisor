import express from 'express';
import { pool } from '../db/connection.js';
import * as queries from '../db/queries.js';

const router = express.Router();

/**
 * GET /api/status/:sprintId
 * Returns the status summary of the sprint, its tasks, and unresolved Telegram pending questions.
 * Polled by the portal frontend.
 */
router.get('/:sprintId', async (req, res) => {
  const sprintId = parseInt(req.params.sprintId, 10);
  
  try {
    const sprint = await queries.getSprint(sprintId);
    if (!sprint) {
      return res.status(404).json({ error: 'Sprint not found' });
    }

    // Retrieve clean task metadata for visualization
    const [tasks] = await pool.query(
      'SELECT id, title, status, jules_session_id, pr_url, retry_count FROM tasks WHERE sprint_id = ? ORDER BY sort_order ASC',
      [sprintId]
    );

    // Retrieve the number of active, unanswered Telegram escalations
    const [[{ pendingCount }]] = await pool.query(
      `SELECT COUNT(*) as pendingCount 
       FROM telegram_pending tp 
       JOIN tasks t ON tp.task_id = t.id 
       WHERE t.sprint_id = ? AND tp.resolved = FALSE`,
      [sprintId]
    );

    res.json({
      sprint,
      tasks,
      unresolvedPendingCount: pendingCount
    });
  } catch (error) {
    console.error('Error getting sprint status:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
