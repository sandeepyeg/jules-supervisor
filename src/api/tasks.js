import express from 'express';
import * as queries from '../db/queries.js';
import { portalAuth } from './auth.js';
import * as github from '../services/github.js';
import * as prReviewer from '../core/prReviewer.js';

const router = express.Router();

/**
 * GET /api/tasks/:id
 * Retrieves detail for a specific task.
 */
router.get('/:id', portalAuth, async (req, res) => {
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

  if (status === 'merged') {
    return res.status(400).json({ error: 'Use POST /api/tasks/:id/mark-merged so GitHub PR verification is enforced.' });
  }

  try {
    const task = await queries.getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await queries.updateTaskStatus(taskId, status || task.status, extra);
    const updated = await queries.getTask(taskId);

    // Reactivate phase and restart poller if user retried/skipped a task in a failed or complete phase
    if (status === 'queued' || status === 'skipped') {
      const phase = await queries.getPhase(task.phase_id);
      if (phase && (phase.status === 'failed' || phase.status === 'complete')) {
        console.log(`Reactivating phase #${phase.id} (status was ${phase.status}) due to task #${taskId} update to ${status}.`);
        await queries.updatePhaseStatus(phase.id, 'active', { completed_at: null });
        
        // Dynamically import and start the poller to avoid circular dependencies
        const { startPoller } = await import('../core/poller.js');
        startPoller(phase.id);
      }
    }

    res.json(updated);
  } catch (error) {
    console.error(`Error updating task #${taskId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:id/mark-merged
 * Manually confirms and marks a task as merged after verifying the PR status on GitHub.
 */
router.post('/:id/mark-merged', portalAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  try {
    const task = await queries.getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const phase = await queries.getPhase(task.phase_id);
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    if (!task.pr_number) {
      return res.status(400).json({ error: 'Task has no associated PR number' });
    }

    // Fetch PR details from GitHub
    const pr = await github.getPR(task.pr_number);
    if (!pr) {
      return res.status(404).json({ error: `Could not retrieve PR #${task.pr_number} metadata from GitHub` });
    }

    const baseBranch = pr.base?.ref;
    if (!baseBranch) {
      return res.status(400).json({ error: 'Could not resolve PR base branch' });
    }

    // Validation checks
    if (baseBranch === 'main') {
      return res.status(400).json({ error: 'PR targets the forbidden base branch: main' });
    }

    if (baseBranch !== phase.phase_branch) {
      return res.status(400).json({ error: `PR targets base branch "${baseBranch}", but the active phase branch is "${phase.phase_branch}"` });
    }

    // State/Merged validation check
    if (pr.merged !== true) {
      if (pr.state === 'closed') {
        return res.status(400).json({ error: 'PR is closed but was not merged.' });
      }
      return res.status(400).json({ error: 'PR is not merged yet on GitHub.' });
    }

    // Mark task as merged
    await queries.updateTaskStatus(taskId, 'merged');
    const updated = await queries.getTask(taskId);

    // Immediately trigger downstream queued tasks
    if (phase.status === 'active') {
      const { startReadyTasks } = await import('../core/taskManager.js');
      await startReadyTasks(phase.id, phase.phase_branch);
    }

    res.json(updated);
  } catch (error) {
    console.error(`Error marking task #${taskId} as merged:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:id/force-review
 * Clears the cached AI diff-review verdict for the task's current PR and immediately
 * re-runs reviewAndMerge, instead of waiting for the next poll cycle to (not) do it —
 * the cache normally treats an unchanged PR head sha as "already reviewed."
 * Does not reset pr_revision_count/escalated: this is "look again," not "start over."
 */
router.post('/:id/force-review', portalAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  try {
    const task = await queries.getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (!task.pr_number) {
      return res.status(400).json({ error: 'Task has no associated PR to review' });
    }

    await queries.updateTaskStatus(taskId, task.status, {
      last_reviewed_sha: null,
      last_review_verdict: null
    });

    const freshTask = await queries.getTask(taskId);
    const result = await prReviewer.reviewAndMerge(freshTask);
    const updated = await queries.getTask(taskId);

    res.json({ result, task: updated });
  } catch (error) {
    console.error(`Error forcing re-review for task #${taskId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
