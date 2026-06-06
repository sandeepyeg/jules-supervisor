import { getQueuedReadyTasks, updateTaskStatus } from '../db/queries.js';
import { pool } from '../db/connection.js';
import { createSession } from '../services/jules.js';

/**
 * Gets tasks that are queued and ready to start (i.e. all dependencies are merged/skipped).
 */
export async function getReadyTasks(sprintId) {
  return getQueuedReadyTasks(sprintId);
}

/**
 * Launches Jules sessions for all ready tasks and updates their database status to 'running'.
 */
export async function startReadyTasks(sprintId, sprintBranch) {
  const readyTasks = await getReadyTasks(sprintId);
  let startedCount = 0;

  for (const task of readyTasks) {
    try {
      // Build the prompt containing the task description and target branch instruction
      const prompt = `${task.description}\n\nTarget branch: ${sprintBranch}`;
      
      // Start the Jules session
      const { sessionId } = await createSession(prompt, sprintBranch, task.jules_notes);
      
      // Update task status and session ID in database
      await updateTaskStatus(task.id, 'running', {
        jules_session_id: sessionId
      });
      
      startedCount++;
    } catch (error) {
      console.error(`Failed to start ready task #${task.id} ("${task.title}"):`, error);
    }
  }

  return startedCount;
}

/**
 * Checks if all tasks in a sprint have successfully finished (merged or skipped).
 */
export async function checkAllMerged(sprintId) {
  const [tasks] = await pool.query('SELECT status FROM tasks WHERE sprint_id = ?', [sprintId]);
  if (tasks.length === 0) return false;
  
  return tasks.every(t => t.status === 'merged' || t.status === 'skipped');
}
