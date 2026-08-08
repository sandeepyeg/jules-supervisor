import { getStaleRunningTasks } from '../db/queries.js';
import * as telegram from '../services/telegram.js';
import { getPhase } from '../db/queries.js';

const alertSentSet = new Set();

/**
 * Checks for tasks running for > 30 minutes without PR creation or feedback activity.
 * Sends a Telegram alert to notify the developer.
 */
export async function checkStaleRunningTasks(thresholdMinutes = 30) {
  try {
    const staleTasks = await getStaleRunningTasks(thresholdMinutes);
    let alertedCount = 0;

    for (const task of staleTasks) {
      if (alertSentSet.has(task.id)) continue;

      const phase = await getPhase(task.phase_id);
      const phaseBranch = phase ? phase.phase_branch : 'unknown';

      const runningMinutes = Math.round((Date.now() - new Date(task.updated_at).getTime()) / 60000) || thresholdMinutes;

      const message = `⏰ *Stale Session Alert*\nTask "#${task.id}: ${task.title}" has been in 'running' state for *${runningMinutes} minutes* without progress.\n\nBranch: \`${phaseBranch}\`\nSession ID: \`${task.jules_session_id || 'N/A'}\`\n\n💡 *Action*: Please check Jules UI or restart the task if stuck.`;

      try {
        await telegram.sendNotification(message);
        alertSentSet.add(task.id);
        alertedCount++;
      } catch (err) {
        console.error(`[StaleWatcher] Failed to send Telegram alert for task #${task.id}:`, err);
      }
    }

    return alertedCount;
  } catch (error) {
    console.error('[StaleWatcher] Error checking stale tasks:', error);
    return 0;
  }
}

export function clearAlertHistory() {
  alertSentSet.clear();
}
