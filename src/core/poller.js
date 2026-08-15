import * as queries from '../db/queries.js';
import * as sessionHandler from './sessionHandler.js';
import * as taskManager from './taskManager.js';
import * as telegram from '../services/telegram.js';
import * as github from '../services/github.js';
import * as config from './config.js';
import { checkStaleRunningTasks } from './staleWatcher.js';

// Keep track of active interval references by phase ID so we can stop them if needed
const activePollers = new Map();
const activePollRuns = new Map(); // stores phaseId -> startTime
const manuallyPausedPollers = new Set();
const POLL_RUN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per poll cycle

let isGlobalEmergencyStopped = false;
let emergencyStoppedAt = null;

export function isEmergencyStopped() {
  return isGlobalEmergencyStopped;
}

export function getEmergencyStopInfo() {
  return {
    isEmergencyStopped: isGlobalEmergencyStopped,
    stoppedAt: emergencyStoppedAt
  };
}

export async function globalEmergencyStop() {
  console.warn('[EMERGENCY STOP] Master shutdown triggered! Halting all pollers, task execution, and reviews.');
  isGlobalEmergencyStopped = true;
  emergencyStoppedAt = new Date().toISOString();

  // Clear all poller intervals immediately
  for (const [phaseId, interval] of activePollers.entries()) {
    clearInterval(interval);
    console.log(`[EMERGENCY STOP] Stopped poller for phase #${phaseId}`);
  }
  activePollers.clear();
  activePollRuns.clear();

  try {
    await telegram.sendNotification('🛑 *EMERGENCY STOP ACTIVATED*\nJules Supervisor has been completely shut down via Master Kill Switch. All pollers, task launches, and PR reviews are paused.');
  } catch (_) {}

  return { ok: true, isEmergencyStopped: true, stoppedAt: emergencyStoppedAt };
}

export async function globalResume() {
  console.log('[EMERGENCY RESUME] Master restart triggered! Resuming supervisor pollers...');
  isGlobalEmergencyStopped = false;
  emergencyStoppedAt = null;

  try {
    await telegram.sendNotification('🟢 *SUPERVISOR RESUMED*\nMaster shutdown cleared. Jules Supervisor background orchestration is now active.');
  } catch (_) {}

  return await forceResumeAll();
}

/**
 * Watchdog: runs every 2 minutes and auto-revives any dead pollers for active phases.
 * Handles server restarts, crashes, or any reason the poller interval died.
 * Also checks for stale running tasks (>30m) and alerts via Telegram.
 */
setInterval(async () => {
  if (isGlobalEmergencyStopped) {
    return; // Do not revive pollers during emergency stop
  }

  try {
    const [activePhases] = await (await import('../db/connection.js')).pool.query("SELECT id FROM phases WHERE status = 'active'");
    for (const phase of activePhases) {
      if (manuallyPausedPollers.has(phase.id)) {
        continue;
      }

      // Break stale lock if running for > 2 minutes
      if (activePollRuns.has(phase.id)) {
        const startedAt = activePollRuns.get(phase.id);
        if (Date.now() - startedAt > POLL_RUN_TIMEOUT_MS) {
          console.warn(`[Watchdog] Stale poll cycle lock for phase #${phase.id} (${Math.round((Date.now() - startedAt)/1000)}s). Forcing lock release...`);
          activePollRuns.delete(phase.id);
        }
      }

      if (!activePollers.has(phase.id)) {
        console.log(`[Watchdog] Poller for phase #${phase.id} is dead. Auto-reviving...`);
        startPoller(phase.id);
      }
    }

    // Check for stale running tasks
    await checkStaleRunningTasks(30);
  } catch (watchdogErr) {
    console.warn('[Watchdog] Error checking poller health:', watchdogErr.message);
  }
}, 2 * 60 * 1000); // Every 2 minutes

export function getPollerHealth() {
  return {
    isEmergencyStopped: isGlobalEmergencyStopped,
    stoppedAt: emergencyStoppedAt,
    activePhaseIds: [...activePollers.keys()],
    inFlightPhaseIds: [...activePollRuns.keys()],
    manuallyPausedPhaseIds: [...manuallyPausedPollers.values()]
  };
}

export async function runPollCycle(phaseId) {
  if (isGlobalEmergencyStopped) {
    console.log(`[EMERGENCY STOP] Poller for phase ${phaseId} aborted (System is globally stopped).`);
    return { skipped: true, reason: 'emergency_stopped' };
  }

  if (manuallyPausedPollers.has(phaseId)) {
    console.log(`Phase ${phaseId} poller is manually paused. Skipping poll cycle.`);
    return { skipped: true, reason: 'manually_paused' };
  }

  if (activePollRuns.has(phaseId)) {
    const startedAt = activePollRuns.get(phaseId);
    if (Date.now() - startedAt > POLL_RUN_TIMEOUT_MS) {
      console.warn(`[Watchdog] Stale poll cycle lock detected for phase #${phaseId} (${Math.round((Date.now() - startedAt)/1000)}s). Forcing lock release...`);
      activePollRuns.delete(phaseId);
    } else {
      console.log(`Poll cycle already running for phase ${phaseId}. Skipping overlapping run.`);
      return { skipped: true, reason: 'already_running' };
    }
  }

  activePollRuns.set(phaseId, Date.now());

  try {
    const phase = await queries.getPhase(phaseId);
    if (!phase || phase.status !== 'active') {
      console.log(`Phase ${phaseId} is no longer active (status: ${phase?.status}).`);
      stopPoller(phaseId);
      return { skipped: true, reason: 'phase_inactive' };
    }

    // 1. Process active running/open PR sessions with per-task timeout guard
    const activeTasks = await queries.getActiveTasks(phaseId);
    for (const task of activeTasks) {
      if (task.status === 'waiting_answer') {
        continue;
      }

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Task #${task.id} session handling timed out (180s)`)), 180000)
        );
        await Promise.race([sessionHandler.handleSession(task), timeoutPromise]);
      } catch (error) {
        console.error(`Error handling session for task #${task.id}:`, error.message || error);
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

    // 4. Check for failed tasks and notify without freezing the entire phase
    const tasks = await queries.getTasksForPhase(phaseId);
    const hasUnfinishedTasks = tasks.some(t => t.status === 'queued' || t.status === 'running' || t.status === 'waiting_answer' || t.status === 'pr_open');

    // 5. Check for phase completion (all tasks finished processing)
    const isComplete = tasks.length > 0 && tasks.every(t => t.status === 'merged' || t.status === 'skipped' || t.status === 'unreviewed' || t.status === 'failed');
    if (isComplete) {
      const hasFailures = tasks.some(t => t.status === 'failed');
      const finalStatus = hasFailures ? 'failed' : 'complete';

      console.log(`All tasks in phase ${phaseId} completed processing (Status: ${finalStatus}).`);
      await queries.updatePhaseStatus(phaseId, finalStatus, { completed_at: new Date() });
      
      try {
        if (finalStatus === 'complete') {
          await telegram.sendPhaseCompleteNotification(phase.phase_branch, phase.title);
        } else {
          await telegram.sendNotification(`⚠️ Phase #${phaseId} ("${phase.title}") finished with some failed tasks. Please review in dashboard.`);
        }
      } catch (tgErr) {
        console.warn('Failed to send Telegram phase completion notification:', tgErr.message);
      }

      if (config.CREATE_FINAL_DRAFT_PR) {
        try {
          // If this phase was branched off a parent feature/epic branch, merge it into its parent branch
          if (phase.phase_branch && phase.main_branch && phase.phase_branch !== phase.main_branch) {
            console.log(`Auto-merging completed phase branch ${phase.phase_branch} into parent base branch ${phase.main_branch}...`);
            await github.mergeBranch(
              phase.phase_branch,
              phase.main_branch,
              `Supervisor: Auto-merge completed phase "${phase.title}" into ${phase.main_branch}`
            );
          }
        } catch (prErr) {
          console.error(`Auto-merge for phase branch ${phase.phase_branch} into ${phase.main_branch} encountered notice/error:`, prErr.message);
        }
      }

      // Check for queued dependent phases ready to start
      try {
        const readyPhases = await queries.getQueuedPhasesReadyToStart();
        for (const readyPhase of readyPhases) {
          console.log(`Unlocking ready dependent phase #${readyPhase.id} ("${readyPhase.title}")...`);
          
          let childBranch = readyPhase.phase_branch;
          const parentBaseBranch = phase.main_branch || 'develop';
          if (!childBranch) {
            childBranch = `feature/phase-${readyPhase.id}-${Date.now()}`;
          }

          try {
            await github.createBranch(childBranch, parentBaseBranch);
          } catch (bErr) {
            console.warn(`Branch creation for phase #${readyPhase.id} notice:`, bErr.message);
          }

          await queries.updatePhaseStatus(readyPhase.id, 'active', {
            phase_branch: childBranch,
            main_branch: parentBaseBranch,
            started_at: new Date()
          });

          await taskManager.startReadyTasks(readyPhase.id, childBranch);
          startPoller(readyPhase.id);

          try {
            await telegram.sendNotification(
              `🚀 *Dependent Phase Unlocked*\nPhase: "${readyPhase.title}" (Phase #${readyPhase.id})\nBase Branch: ${parentBaseBranch}\nPhase Branch: ${childBranch}`
            );
          } catch (tgErr) {
            console.warn('Failed to send Telegram phase unlocked notification:', tgErr.message);
          }
        }
      } catch (chainErr) {
        console.error('Error resolving dependent phases:', chainErr.message);
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
  if (isGlobalEmergencyStopped) {
    console.warn(`[startPoller] Blocked starting poller for phase #${phaseId}: System is in EMERGENCY STOP.`);
    return null;
  }

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
 * Force Resumes and Unsticks all pollers:
 * 1. Clears all in-flight locks and manual pauses.
 * 2. Un-fails any halted active/failed phases in MySQL.
 * 3. Starts pollers for all active phases immediately.
 * 4. Runs a GitHub PR scan to catch any PRs created while server/poller was hung.
 */
export async function forceResumeAll() {
  console.log('[ForceResume] Executing force resume & unstick routine...');
  
  activePollRuns.clear();
  manuallyPausedPollers.clear();

  const pool = (await import('../db/connection.js')).pool;
  const [phases] = await pool.query("SELECT id, title, status FROM phases WHERE status IN ('active', 'failed') ORDER BY id DESC LIMIT 5");

  const revivedPhaseIds = [];
  for (const phase of phases) {
    if (phase.status === 'failed') {
      await queries.updatePhaseStatus(phase.id, 'active', { completed_at: null });
      console.log(`[ForceResume] Reset phase #${phase.id} ("${phase.title}") status back to 'active'.`);
    }
    stopPoller(phase.id);
    startPoller(phase.id);
    revivedPhaseIds.push(phase.id);
  }

  try {
    await startupGitHubScan();
  } catch (scanErr) {
    console.warn('[ForceResume] GitHub scan notice:', scanErr.message);
  }

  return { ok: true, revivedPhaseIds };
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
