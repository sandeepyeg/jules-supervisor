import { getQueuedReadyTasks, updateTaskStatus, getPhase, getGlobalRunningTaskCount, getDailyLaunchedTaskCount } from '../db/queries.js';
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

export function getRateLimitStatus() {
  const isBackoff = Date.now() < rateLimitBackoffUntil;
  return {
    isRateLimited: isBackoff,
    retryInSeconds: isBackoff ? Math.ceil((rateLimitBackoffUntil - Date.now()) / 1000) : 0,
    maxConcurrent: MAX_CONCURRENT_TASKS,
    maxDaily: MAX_DAILY_TASKS
  };
}

export async function startReadyTasks(phaseId, explicitBranch = null) {
  if (Date.now() < rateLimitBackoffUntil) {
    console.log(`[TaskManager] Skipping task launch for Phase #${phaseId} — Jules API rate-limited until ${new Date(rateLimitBackoffUntil).toLocaleTimeString()}`);
    return 0;
  }

  // 1. Enforce Max Concurrency (default 15)
  const currentlyRunning = await getGlobalRunningTaskCount();
  if (currentlyRunning >= MAX_CONCURRENT_TASKS) {
    console.log(`[TaskManager] Concurrency limit reached (${currentlyRunning}/${MAX_CONCURRENT_TASKS} active tasks). Waiting for active sessions to complete.`);
    return 0;
  }

  // 2. Enforce Daily Safety Limit (default 100)
  const dailyLaunched = await getDailyLaunchedTaskCount();
  if (dailyLaunched >= MAX_DAILY_TASKS) {
    console.warn(`⚠️ [TaskManager] Daily safety quota limit reached (${dailyLaunched}/${MAX_DAILY_TASKS} tasks in 24h). Pausing launch.`);
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
    } catch (error) {
      const isRateLimit = error.message && (
        error.message.includes('429') || 
        error.message.toLowerCase().includes('resource_exhausted') || 
        error.message.toLowerCase().includes('quota') ||
        error.message.toLowerCase().includes('too many requests')
      );

      if (isRateLimit) {
        rateLimitBackoffUntil = Date.now() + 5 * 60 * 1000; // 5-minute backoff
        console.warn(`⚠️ [RateLimit] Jules API quota limit hit on task #${task.id}. Pausing task launches for 5 minutes.`);
        
        try {
          await telegram.sendNotification(`⚠️ *Jules API Quota Limit Reached*\nTask "#${task.id}: ${task.title}" hit API rate limits.\n\n🛡️ *Supervisor Action*: Auto-pausing task launches for 5 minutes. The phase remains active and will retry automatically!`);
        } catch (tErr) {}
        break; // Stop attempting remaining tasks in this cycle
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
