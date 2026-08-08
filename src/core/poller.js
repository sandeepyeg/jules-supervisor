import * as queries from '../db/queries.js';
import * as sessionHandler from './sessionHandler.js';
import * as taskManager from './taskManager.js';
import * as telegram from '../services/telegram.js';
import * as github from '../services/github.js';
import * as config from './config.js';

// Keep track of active interval references by phase ID so we can stop them if needed
const activePollers = new Map();
const activePollRuns = new Set();
const manuallyPausedPollers = new Set();

/**
 * Watchdog: runs every 2 minutes and auto-revives any dead pollers for active phases.
 * Handles server restarts, crashes, or any reason the poller interval died.
 */
setInterval(async () => {
  try {
    const [activePhases] = await (await import('../db/connection.js')).pool.query("SELECT id FROM phases WHERE status = 'active'");
    for (const phase of activePhases) {
      if (manuallyPausedPollers.has(phase.id)) {
        continue;
      }
      if (!activePollers.has(phase.id)) {
        console.log(`[Watchdog] Poller for phase #${phase.id} is dead. Auto-reviving...`);
        startPoller(phase.id);
      }
    }
  } catch (watchdogErr) {
    console.warn('[Watchdog] Error checking poller health:', watchdogErr.message);
  }
}, 2 * 60 * 1000); // Every 2 minutes

export function getPollerHealth() {
  return {
    activePhaseIds: [...activePollers.keys()],
    inFlightPhaseIds: [...activePollRuns.values()],
    manuallyPausedPhaseIds: [...manuallyPausedPollers.values()]
  };
}

export async function runPollCycle(phaseId) {
  if (manuallyPausedPollers.has(phaseId)) {
    console.log(`Phase ${phaseId} poller is manually paused. Skipping poll cycle.`);
    return { skipped: true, reason: 'manually_paused' };
  }

  if (activePollRuns.has(phaseId)) {
    console.log(`Poll cycle already running for phase ${phaseId}. Skipping overlapping run.`);
    return { skipped: true, reason: 'already_running' };
  }

  activePollRuns.add(phaseId);

  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase || phase.status !== 'active') {
      console.log(`Phase ${phaseId} is no longer active (status: ${phase?.status}).`);
      stopPoller(phaseId);
      return { skipped: true, reason: 'phase_inactive' };
    }

    // 1. Process active running/open PR sessions
    const activeTasks = await queries.getActiveTasks(phaseId);
    for (const task of activeTasks) {
      if (task.status === 'waiting_answer') {
        continue;
      }

      try {
        await sessionHandler.handleSession(task);
      } catch (error) {
        console.error(`Error handling session for task #${task.id}:`, error);
      }
    }

    // 2. Start any newly unblocked tasks
    try {
      await taskManager.startReadyTasks(phaseId, phase.phase_branch);
    } catch (error) {
      console.error(`Error starting ready tasks for phase ${phaseId}:`, error);
    }

    // 3. Send reminders
    try {
      await sendReminders();
    } catch (error) {
      console.error('Error sending Telegram reminders:', error);
    }

    // 4. Check for failed tasks
    const tasks = await queries.getTasksForPhase(phaseId);
    const failedTask = tasks.find(t => t.status === 'failed');
    if (failedTask) {
      console.log(`Task "${failedTask.title}" failed. Marking phase ${phaseId} as failed.`);
      await queries.updatePhaseStatus(phaseId, 'failed', { completed_at: new Date() });
      await telegram.sendNotification(`Phase failed: "${phase.title}" was stopped because task "${failedTask.title}" failed.`);
      stopPoller(phaseId);
      return { failed: true };
    }

    // 5. Check for phase completion
    const isComplete = tasks.length > 0 && tasks.every(t => t.status === 'merged' || t.status === 'skipped' || t.status === 'unreviewed');
    if (isComplete) {
      console.log(`All tasks in phase ${phaseId} merged/skipped/unreviewed! Marking phase complete.`);
      await queries.updatePhaseStatus(phaseId, 'complete', { completed_at: new Date() });
      try {
        await telegram.sendPhaseCompleteNotification(phase.phase_branch, phase.title);
      } catch (tgErr) {
        console.warn('Failed to send Telegram phase complete notification:', tgErr.message);
      }

      if (config.CREATE_FINAL_DRAFT_PR) {
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

      stopPoller(phaseId);
      return { completed: true };
    }

    return { completed: false };
  } finally {
    activePollRuns.delete(phaseId);
  }
}

/**
 * Starts the periodic poller for a given phase ID.
 */
export function startPoller(phaseId) {
  manuallyPausedPollers.delete(phaseId);

  // If there's already a poller for this phase, return it
  if (activePollers.has(phaseId)) {
    return activePollers.get(phaseId);
  }

  console.log(`Starting supervisor poller for phase ID: ${phaseId} (polling every ${config.POLL_INTERVAL_MS}ms)`);
  const interval = setInterval(() => {
    runPollCycle(phaseId).catch(err => {
      console.error(`Unhandled error in poller cycle for phase ${phaseId}:`, err);
    });
  }, config.POLL_INTERVAL_MS);

  activePollers.set(phaseId, interval);
  void runPollCycle(phaseId).catch(err => {
    console.error(`Immediate poll cycle failed for phase ${phaseId}:`, err);
  });
  return interval;
}

/**
 * Sends reminders to the developer for pending Telegram questions that are overdue.
 */
async function sendReminders() {
  const pending = await queries.getUnresolvedPendingOlderThan(config.TELEGRAM_REMINDER_MS);
  
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
export function stopPoller(phaseId, options = {}) {
  if (options.manual) {
    manuallyPausedPollers.add(phaseId);
  }

  if (activePollers.has(phaseId)) {
    console.log(`Stopping poller for phase ${phaseId}${options.manual ? ' manually' : ''}.`);
    clearInterval(activePollers.get(phaseId));
    activePollers.delete(phaseId);
  }
}

export function resumePoller(phaseId) {
  manuallyPausedPollers.delete(phaseId);
  return startPoller(phaseId);
}

/**
 * Startup GitHub scan: immediately after server boot, finds any running tasks
 * that already have open PRs on GitHub (but pr_number not yet in DB).
 * Fixes the "server restarted while Jules PR was open" failure class.
 */
export async function startupGitHubScan() {
  try {
    const [activePhases] = await (await import('../db/connection.js')).pool.query("SELECT id FROM phases WHERE status = 'active'");
    for (const phase of activePhases) {
      console.log(`[StartupScan] Running immediate reconciliation for phase #${phase.id}...`);
      await runPollCycle(phase.id);
    }
  } catch (err) {
    console.warn('[StartupScan] Error during startup GitHub PR scan:', err.message);
  }
}
