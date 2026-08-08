import {
  getQueuedReadyTasks,
  updateTaskStatus,
  getPhase,
  getGlobalRunningTaskCount,
  getDailyLaunchedTaskCount,
  getOldestDailyLaunchCreatedAt
} from '../db/queries.js';
import { pool } from '../db/connection.js';
import { createSession } from '../services/jules.js';
import * as telegram from '../services/telegram.js';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '15', 10);
const MAX_DAILY_TASKS = parseInt(process.env.MAX_DAILY_TASKS || '100', 10);

/**
 * Gets tasks that are queued and ready to start (i.e. all dependencies are merged/skipped).
 */
export async function getReadyTasks(phaseId) {
  return getQueuedReadyTasks(phaseId);
}

/**
 * Launches Jules sessions for all ready tasks and updates their database status to 'running'.
 */
let rateLimitBackoffUntil = 0;
let rateLimitBackoffMs = 5 * 60 * 1000;
let dailyLimitBackoffUntil = 0;

function isRateLimitError(error) {
  const message = error?.message?.toLowerCase?.() || '';
  return (
    message.includes('429')
    || message.includes('resource_exhausted')
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('too many requests')
  );
}

function isTransientLaunchError(error) {
  const message = error?.message?.toLowerCase?.() || '';
  return (
    isRateLimitError(error)
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('503')
    || message.includes('502')
    || message.includes('504')
  );
}

async function setDailyLimitBackoff() {
  const oldestLaunch = await getOldestDailyLaunchCreatedAt();
  const oldestTs = oldestLaunch ? new Date(oldestLaunch).getTime() : 0;
  const nextSlotAt = oldestTs
    ? oldestTs + 24 * 60 * 60 * 1000 + 60 * 1000
    : Date.now() + 15 * 60 * 1000;

  dailyLimitBackoffUntil = Math.max(Date.now() + 60 * 1000, nextSlotAt);
  return dailyLimitBackoffUntil;
}

export function getRateLimitStatus() {
  const now = Date.now();
  const isRateLimited = now < rateLimitBackoffUntil;
  const isDailyLimited = now < dailyLimitBackoffUntil;
  const nextRetryAt = Math.max(rateLimitBackoffUntil, dailyLimitBackoffUntil);
  return {
    isRateLimited,
    isDailyLimited,
    retryInSeconds: nextRetryAt > now ? Math.ceil((nextRetryAt - now) / 1000) : 0,
    rateLimitRetryInSeconds: isRateLimited ? Math.ceil((rateLimitBackoffUntil - now) / 1000) : 0,
    dailyLimitRetryInSeconds: isDailyLimited ? Math.ceil((dailyLimitBackoffUntil - now) / 1000) : 0,
    maxConcurrent: MAX_CONCURRENT_TASKS,
    maxDaily: MAX_DAILY_TASKS
  };
}

export function resetLaunchThrottlesForTests() {
  rateLimitBackoffUntil = 0;
  rateLimitBackoffMs = 5 * 60 * 1000;
  dailyLimitBackoffUntil = 0;
}

export async function startReadyTasks(phaseId, explicitBranch = null) {
  const now = Date.now();
  if (now < rateLimitBackoffUntil) {
    console.log(`[TaskManager] Skipping task launch for Phase #${phaseId}; Jules launch backoff active until ${new Date(rateLimitBackoffUntil).toLocaleTimeString()}. Queued tasks will retry automatically.`);
    return 0;
  }
  if (now < dailyLimitBackoffUntil) {
    console.log(`[TaskManager] Skipping task launch for Phase #${phaseId}; rolling 24h launch capacity will reopen around ${new Date(dailyLimitBackoffUntil).toLocaleTimeString()}.`);
    return 0;
  }

  // 1. Enforce Max Concurrency (default 15)
  const currentlyRunning = await getGlobalRunningTaskCount();
  if (currentlyRunning >= MAX_CONCURRENT_TASKS) {
    console.log(`[TaskManager] Concurrency limit reached (${currentlyRunning}/${MAX_CONCURRENT_TASKS} active tasks). Waiting for active sessions to complete.`);
    return 0;
  }

  // 2. Enforce rolling 24h launch capacity (default 100)
  const dailyLaunched = await getDailyLaunchedTaskCount();
  if (dailyLaunched >= MAX_DAILY_TASKS) {
    const retryAt = await setDailyLimitBackoff();
    console.warn(`[TaskManager] Rolling 24h launch limit reached (${dailyLaunched}/${MAX_DAILY_TASKS} sessions). Holding queued tasks until about ${new Date(retryAt).toLocaleTimeString()}.`);
    return 0;
  }
  const dailyLaunchSlots = Math.max(0, MAX_DAILY_TASKS - dailyLaunched);

  let phaseBranch = explicitBranch;
  if (!phaseBranch) {
    const phase = await getPhase(phaseId);
    if (!phase) return 0;
    phaseBranch = phase.phase_branch;
  }
  if (!phaseBranch) return 0;

  const readyTasks = await getQueuedReadyTasks(phaseId);
  if (readyTasks.length === 0) return 0;

  let startedCount = 0;

  for (const task of readyTasks) {
    if (currentlyRunning + startedCount >= MAX_CONCURRENT_TASKS) {
      console.log(`[TaskManager] Reached concurrency limit of ${MAX_CONCURRENT_TASKS} active tasks.`);
      break;
    }
    if (startedCount >= dailyLaunchSlots) {
      const retryAt = await setDailyLimitBackoff();
      console.log(`[TaskManager] Used remaining rolling 24h launch capacity (${dailyLaunched + startedCount}/${MAX_DAILY_TASKS}). Holding the rest until about ${new Date(retryAt).toLocaleTimeString()}.`);
      break;
    }
    try {
      const prompt = `${task.title}

${task.description || ''}

Target branch: ${phaseBranch}
Open your pull request against ${phaseBranch}.

REQUIREMENTS:
- Do NOT open PRs against main or develop. Open PR against ${phaseBranch}.
- Focus on clean, modular, and robust implementation of this specific task.

⚡ DIRECT EXECUTION INSTRUCTION:
Proceed directly to implementation and code execution. Do NOT ask clarifying questions, do NOT request plan approval, and do NOT wait for chat feedback. Implement the changes, commit, push, and open the Pull Request against ${phaseBranch} immediately.`;
      
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
      rateLimitBackoffMs = 5 * 60 * 1000;
    } catch (error) {
      if (isRateLimitError(error)) {
        rateLimitBackoffUntil = Date.now() + rateLimitBackoffMs;
        const retryMinutes = Math.ceil(rateLimitBackoffMs / 60000);
        rateLimitBackoffMs = Math.min(rateLimitBackoffMs * 2, 60 * 60 * 1000);
        console.warn(`[TaskManager] Jules launch quota/rate limit hit on task #${task.id}. Holding queued tasks for about ${retryMinutes} minute(s), then retrying automatically.`);
        
        try {
          await telegram.sendNotification(`⚠️ *Jules Launch Limit Reached*\nTask "#${task.id}: ${task.title}" hit a Jules rate/quota limit.\n\nSupervisor action: holding queued tasks for about ${retryMinutes} minute(s). The phase remains active and will retry automatically.`);
        } catch (tErr) {}
        break;
      }

      if (isTransientLaunchError(error)) {
        rateLimitBackoffUntil = Date.now() + 2 * 60 * 1000;
        console.warn(`[TaskManager] Transient launch error on task #${task.id}. Holding queued tasks for 2 minutes, then retrying automatically: ${error.message}`);
        break;
      }

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
