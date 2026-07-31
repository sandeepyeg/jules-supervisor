import { getQueuedReadyTasks, updateTaskStatus } from '../db/queries.js';
import { pool } from '../db/connection.js';
import { createSession } from '../services/jules.js';
import * as telegram from '../services/telegram.js';

/**
 * Gets tasks that are queued and ready to start (i.e. all dependencies are merged/skipped).
 */
export async function getReadyTasks(phaseId) {
  return getQueuedReadyTasks(phaseId);
}

/**
 * Launches Jules sessions for all ready tasks and updates their database status to 'running'.
 */
export async function startReadyTasks(phaseId, phaseBranch) {
  const readyTasks = await getReadyTasks(phaseId);
  let startedCount = 0;

  for (const task of readyTasks) {
    try {
      // Build the prompt containing the task description and target branch instruction
      const prompt = `${task.description}

Target branch: ${phaseBranch}
Open your pull request against ${phaseBranch}.
Do not open your PR against main.
Do not merge into main.
Keep the change limited to this task.
Add or update tests when behavior changes.`;
      
      // Start the Jules session
      const { sessionId } = await createSession(prompt, phaseBranch, task.jules_notes);
      
      // Update task status and session ID in database
      await updateTaskStatus(task.id, 'running', {
        jules_session_id: sessionId
      });
      
      // Send Telegram notification
      try {
        await telegram.sendTaskStartedNotification(task.title, task.id, phaseBranch);
      } catch (tgErr) {
        console.error('Failed to send Telegram task start notification:', tgErr);
      }
      
      startedCount++;
    } catch (error) {
      console.error(`Failed to start ready task #${task.id} ("${task.title}"):`, error);
    }
  }

  return startedCount;
}

/**
 * Checks if all tasks in a phase have successfully finished (merged or skipped).
 */
export async function checkAllMerged(phaseId) {
  const [tasks] = await pool.query('SELECT status FROM tasks WHERE phase_id = ?', [phaseId]);
  if (tasks.length === 0) return false;
  
  return tasks.every(t => t.status === 'merged' || t.status === 'skipped');
}
