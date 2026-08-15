import express from 'express';
import { pool } from '../db/connection.js';
import * as queries from '../db/queries.js';
import { portalAuth } from './auth.js';
import { getMetrics } from '../core/metrics.js';
import { getPollerHealth, globalEmergencyStop, globalResume, isEmergencyStopped, getEmergencyStopInfo } from '../core/poller.js';
import { getRateLimitStatus } from '../core/taskManager.js';
import { MAX_AUTO_REVISION_ATTEMPTS } from '../core/config.js';

const router = express.Router();

/**
 * POST /api/status/emergency-stop
 * Master Kill Switch: Halts all supervisor pollers, background orchestration, and task operations immediately.
 */
router.post('/emergency-stop', portalAuth, async (req, res) => {
  try {
    const result = await globalEmergencyStop();
    res.json({
      success: true,
      message: 'Emergency stop activated. All supervisor operations halted.',
      ...result
    });
  } catch (error) {
    console.error('Error activating emergency stop:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/status/resume
 * Master Resume Switch: Resumes background orchestration and restores active phase pollers.
 */
router.post('/resume', portalAuth, async (req, res) => {
  try {
    const result = await globalResume();
    res.json({
      success: true,
      message: 'Supervisor operations resumed.',
      ...result
    });
  } catch (error) {
    console.error('Error resuming supervisor:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/status/emergency-state
 * Quick check on whether emergency stop is currently active.
 */
router.get('/emergency-state', portalAuth, (req, res) => {
  res.json(getEmergencyStopInfo());
});

/**
 * GET /api/status/metrics
 * Lightweight operational visibility: AI call/retry counts since the process started,
 * poller health, and how many tasks currently need manual attention (auto-review gave up).
 * Registered before /:phaseId so "metrics" isn't matched as a phase ID.
 */
router.get('/metrics', portalAuth, async (req, res) => {
  try {
    const [[{ escalatedCount }]] = await pool.query(
      'SELECT COUNT(*) as escalatedCount FROM tasks WHERE escalated = TRUE'
    );

    res.json({
      ...getMetrics(),
      isEmergencyStopped: isEmergencyStopped(),
      emergencyStopInfo: getEmergencyStopInfo(),
      escalatedTasksCount: escalatedCount,
      maxAutoRevisionAttempts: MAX_AUTO_REVISION_ATTEMPTS,
      pollers: getPollerHealth(),
      launchThrottle: getRateLimitStatus()
    });
  } catch (error) {
    console.error('Error getting metrics:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/status/:phaseId
 * Returns the status summary of the phase, its tasks (with qa_log), and unresolved Telegram pending questions.
 * Polled by the portal frontend.
 */
router.get('/:phaseId', portalAuth, async (req, res) => {
  const phaseId = parseInt(req.params.phaseId, 10);
  
  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    // Retrieve all task metadata for visualization
    const [tasks] = await pool.query(
      'SELECT * FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC',
      [phaseId]
    );

    // Attach Q&A log to each task
    for (const task of tasks) {
      const [qaRows] = await pool.query(
        'SELECT * FROM qa_log WHERE task_id = ? ORDER BY created_at ASC',
        [task.id]
      );
      task.qa_log = qaRows;
    }

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
