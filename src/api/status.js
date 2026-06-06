import express from 'express';
import { pool } from '../db/connection.js';
import * as queries from '../db/queries.js';
import { portalAuth } from './auth.js';

const router = express.Router();

/**
 * GET /api/status/:phaseId
 * Returns the status summary of the phase, its tasks, and unresolved Telegram pending questions.
 * Polled by the portal frontend.
 */
router.get('/:phaseId', portalAuth, async (req, res) => {
  const phaseId = parseInt(req.params.phaseId, 10);
  
  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    // Retrieve clean task metadata for visualization
    const [tasks] = await pool.query(
      'SELECT id, title, status, jules_session_id, pr_url, retry_count FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC',
      [phaseId]
    );

    // Retrieve the number of active, unanswered Telegram escalations
    const [[{ pendingCount }]] = await pool.query(
      `SELECT COUNT(*) as pendingCount 
       FROM telegram_pending tp 
       JOIN tasks t ON tp.task_id = t.id 
       WHERE t.phase_id = ? AND tp.resolved = FALSE`,
      [phaseId]
    );

    res.json({
      phase,
      tasks,
      unresolvedPendingCount: pendingCount
    });
  } catch (error) {
    console.error('Error getting phase status:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
