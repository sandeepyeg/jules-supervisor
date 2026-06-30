import * as queries from '../db/queries.js';
import * as sessionHandler from './sessionHandler.js';
import * as taskManager from './taskManager.js';
import * as telegram from '../services/telegram.js';
import * as github from '../services/github.js';
import {
  POLL_INTERVAL_MS,
  TELEGRAM_REMINDER_MS,
  CREATE_FINAL_DRAFT_PR
} from './config.js';

// Keep track of active interval references by phase ID so we can stop them if needed
const activePollers = new Map();

/**
 * Starts the periodic poller for a given phase ID.
 */
export function startPoller(phaseId) {
  // If there's already a poller for this phase, return it
  if (activePollers.has(phaseId)) {
    return activePollers.get(phaseId);
  }

  console.log(`Starting supervisor poller for phase ID: ${phaseId} (polling every ${POLL_INTERVAL_MS}ms)`);

  const interval = setInterval(async () => {
    try {
      const phase = await queries.getPhase(phaseId);
      if (!phase || phase.status !== 'active') {
        console.log(`Phase ${phaseId} is no longer active (status: ${phase?.status}). Stopping poller.`);
        clearInterval(interval);
        activePollers.delete(phaseId);
        return;
      }
      
      // 1. Process active running/open PR sessions
      const activeTasks = await queries.getActiveTasks(phaseId);
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
        await taskManager.startReadyTasks(phaseId, phase.phase_branch);
      } catch (error) {
        console.error(`Error starting ready tasks for phase ${phaseId}:`, error);
      }
      
      // 3. Send Telegram reminders for unresolved pending questions
      try {
        await sendReminders();
      } catch (error) {
        console.error('Error sending Telegram reminders:', error);
      }
      
      // 4. Check if any task has failed
      const [tasks] = await queries.pool.query('SELECT status, title FROM tasks WHERE phase_id = ?', [phaseId]);
      const failedTask = tasks.find(t => t.status === 'failed');
      if (failedTask) {
        console.log(`Task "${failedTask.title}" failed. Marking phase ${phaseId} as failed.`);
        await queries.updatePhaseStatus(phaseId, 'failed', { completed_at: new Date() });
        await telegram.sendNotification(`Phase failed: "${phase.title}" was stopped because task "${failedTask.title}" failed.`);
        
        clearInterval(interval);
        activePollers.delete(phaseId);
        return;
      }
      
      // 5. Check if phase is complete
      const isComplete = tasks.length > 0 && tasks.every(t => t.status === 'merged' || t.status === 'skipped');
      if (isComplete) {
        console.log(`All tasks in phase ${phaseId} merged/skipped! Marking phase complete.`);
        await queries.updatePhaseStatus(phaseId, 'complete', { completed_at: new Date() });
        
        // Notify Telegram with the safe phase-branch text
        await telegram.sendPhaseCompleteNotification(phase.phase_branch, phase.title);
        
        // If configured, create a draft PR from phase_branch to main (does not merge)
        if (CREATE_FINAL_DRAFT_PR) {
          try {
            console.log(`Creating final draft PR for branch ${phase.phase_branch} into ${phase.main_branch}...`);
            await github.createDraftPR(
              phase.phase_branch,
              phase.main_branch,
              `Draft: Merge phase branch ${phase.phase_branch} into ${phase.main_branch}`
            );
          } catch (prErr) {
            console.error('Failed to create final draft PR:', prErr);
          }
        }
        
        clearInterval(interval);
        activePollers.delete(phaseId);
      }
    } catch (err) {
      console.error('Supervisor poller execution error:', err);
    }
  }, POLL_INTERVAL_MS);

  activePollers.set(phaseId, interval);
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
 * Stops the poller for a given phase ID.
 */
export function stopPoller(phaseId) {
  if (activePollers.has(phaseId)) {
    console.log(`Stopping poller for phase ${phaseId} manually.`);
    clearInterval(activePollers.get(phaseId));
    activePollers.delete(phaseId);
  }
}
