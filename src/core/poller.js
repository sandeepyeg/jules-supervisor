import * as queries from '../db/queries.js';
import * as sessionHandler from './sessionHandler.js';
import * as taskManager from './taskManager.js';
import * as telegram from '../services/telegram.js';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const TELEGRAM_REMINDER_MS = parseInt(process.env.TELEGRAM_REMINDER_MS || '300000', 10);

// Keep track of active interval references by sprint ID so we can stop them if needed
const activePollers = new Map();

/**
 * Starts the periodic poller for a given sprint ID.
 */
export function startPoller(sprintId) {
  // If there's already a poller for this sprint, return it
  if (activePollers.has(sprintId)) {
    return activePollers.get(sprintId);
  }

  console.log(`Starting supervisor poller for sprint ID: ${sprintId} (polling every ${POLL_INTERVAL_MS}ms)`);

  const interval = setInterval(async () => {
    try {
      const sprint = await queries.getSprint(sprintId);
      if (!sprint || sprint.status !== 'active') {
        console.log(`Sprint ${sprintId} is no longer active (status: ${sprint?.status}). Stopping poller.`);
        clearInterval(interval);
        activePollers.delete(sprintId);
        return;
      }
      
      // 1. Process active running/open PR sessions
      const activeTasks = await queries.getActiveTasks(sprintId);
      for (const task of activeTasks) {
        // Skip tasks that are explicitly waiting for a Telegram reply
        if (task.status === 'waiting_answer') {
          continue;
        }
        try {
          await sessionHandler.handleSession(task);
        } catch (error) {
          console.error(`Error handling session for task #${task.id}:`, error);
        }
      }
      
      // 2. Start any newly unblocked tasks (dependencies resolved)
      try {
        await taskManager.startReadyTasks(sprintId, sprint.sprint_branch);
      } catch (error) {
        console.error(`Error starting ready tasks for sprint ${sprintId}:`, error);
      }
      
      // 3. Send Telegram reminders for unresolved pending questions
      try {
        await sendReminders();
      } catch (error) {
        console.error('Error sending Telegram reminders:', error);
      }
      
      // 4. Check if sprint is complete
      const isComplete = await taskManager.checkAllMerged(sprintId);
      if (isComplete) {
        console.log(`All tasks in sprint ${sprintId} merged/skipped! Marking sprint complete.`);
        await queries.updateSprintStatus(sprintId, 'complete', { completed_at: new Date() });
        await telegram.sendNotification(`Sprint complete: "${sprint.title}". Ready for your testing.`);
        
        clearInterval(interval);
        activePollers.delete(sprintId);
      }
    } catch (err) {
      console.error('Supervisor poller execution error:', err);
    }
  }, POLL_INTERVAL_MS);

  activePollers.set(sprintId, interval);
  return interval;
}

/**
 * Sends reminders to the developer for pending Telegram questions that are overdue.
 */
async function sendReminders() {
  const pending = await queries.getUnresolvedPendingOlderThan(TELEGRAM_REMINDER_MS);
  
  for (const p of pending) {
    try {
      const task = await queries.getTask(p.task_id);
      if (task) {
        console.log(`Sending Telegram reminder for task #${task.id} question.`);
        await telegram.sendReminder(task.title, p.jules_question, p.telegram_message_id);
        await queries.updateReminderSent(p.id);
      }
    } catch (error) {
      console.error(`Failed to send reminder for pending ID ${p.id}:`, error);
    }
  }
}

/**
 * Stops the poller for a given sprint ID.
 */
export function stopPoller(sprintId) {
  if (activePollers.has(sprintId)) {
    console.log(`Stopping poller for sprint ${sprintId} manually.`);
    clearInterval(activePollers.get(sprintId));
    activePollers.delete(sprintId);
  }
}
