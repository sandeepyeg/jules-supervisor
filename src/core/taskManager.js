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
import { buildContext } from './contextBuilder.js';

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
let lastQuotaTelegramAlertAt = 0;
let consecutiveQuotaHits = 0;

function isRateLimitError(error) {
  const message = error?.message?.toLowerCase?.() || '';
  return (
    message.includes('429')
    || message.includes('resource_exhausted')
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('failed_precondition')
    || message.includes('precondition check failed')
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
  consecutiveQuotaHits++;
  // Progressive backoff (15m -> 30m -> 60m max) to prevent hammering Google's API while quota is full
  let backoffMinutes = 15;
  if (consecutiveQuotaHits === 2) backoffMinutes = 30;
  if (consecutiveQuotaHits >= 3) backoffMinutes = 60;

  dailyLimitBackoffUntil = Date.now() + backoffMinutes * 60 * 1000;
  return dailyLimitBackoffUntil;
}

function resetQuotaTracking() {
  consecutiveQuotaHits = 0;
  lastQuotaTelegramAlertAt = 0;
  dailyLimitBackoffUntil = 0;
  rateLimitBackoffUntil = 0;
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
  lastQuotaTelegramAlertAt = 0;
  consecutiveQuotaHits = 0;
}

export async function startReadyTasks(phaseId, explicitBranch = null) {
  const now = Date.now();
  if (now < rateLimitBackoffUntil) {
    console.log(`[TaskManager] Skipping task launch for Phase #${phaseId}; Jules launch backoff active until ${new Date(rateLimitBackoffUntil).toLocaleTimeString()}. Queued tasks will retry automatically.`);
    return 0;
  }
  if (now < dailyLimitBackoffUntil) {
    console.log(`[TaskManager] Jules quota backoff active until ${new Date(dailyLimitBackoffUntil).toLocaleTimeString()} (Hit #${consecutiveQuotaHits}). Will re-check Jules API then.`);
    return 0;
  }

  // 1. Enforce Max Concurrency (default 15)
  const currentlyRunning = await getGlobalRunningTaskCount();
  if (currentlyRunning >= MAX_CONCURRENT_TASKS) {
    console.log(`[TaskManager] Concurrency limit reached (${currentlyRunning}/${MAX_CONCURRENT_TASKS} active tasks). Waiting for active sessions to complete.`);
    return 0;
  }

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
    try {
      const prompt = await buildContext(task, phaseId);
      
      // Start the Jules session
      const { sessionId } = await createSession(prompt, phaseBranch, task.jules_notes);
      
      // Update task status and session ID in database
      await updateTaskStatus(task.id, 'running', {
        jules_session_id: sessionId,
        jules_launched_at: new Date()
      });
      
      // Send Telegram notification
      try {
        await telegram.sendTaskStartedNotification(task.title, task.id, phaseBranch);
      } catch (tgErr) {
        console.error('Failed to send Telegram task start notification:', tgErr);
      }
      
      startedCount++;
      resetQuotaTracking();
    } catch (error) {
      if (isRateLimitError(error)) {
        const retryAt = await setDailyLimitBackoff();
        const retryMinutes = Math.ceil((retryAt - Date.now()) / 60000);
        console.warn(`[TaskManager] Jules launch quota hit on task #${task.id} (Hit #${consecutiveQuotaHits}). Backing off for ${retryMinutes} minute(s).`);
        
        // Deduplicate Telegram notification: send ONCE when quota limit is first hit (or every 6h max)
        const timestampNow = Date.now();
        if (!lastQuotaTelegramAlertAt || (timestampNow - lastQuotaTelegramAlertAt > 6 * 60 * 60 * 1000)) {
          lastQuotaTelegramAlertAt = timestampNow;
          try {
            await telegram.sendNotification(`⚠️ *Jules Launch Quota Reached*\nTask "#${task.id}: ${task.title}" hit Jules daily quota limit.\n\nSupervisor action: Pausing launches with progressive backoff (${retryMinutes}m) so Google quota can reset naturally without API hammering. The supervisor will retry automatically.`);
          } catch (tErr) {}
        }
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
