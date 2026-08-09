import './env.js';

export let PRIMARY_SUPERVISOR_PROVIDER = process.env.PRIMARY_SUPERVISOR_PROVIDER || 'google';
export let PRIMARY_SUPERVISOR_MODEL = process.env.PRIMARY_SUPERVISOR_MODEL || 'gemini-3.1-flash-lite';
export let BACKUP_SUPERVISOR_PROVIDER = process.env.BACKUP_SUPERVISOR_PROVIDER || 'openrouter';
export let BACKUP_SUPERVISOR_MODEL = process.env.BACKUP_SUPERVISOR_MODEL || 'qwen/qwen3.7-flash';
export let STRONG_REVIEW_PROVIDER = process.env.STRONG_REVIEW_PROVIDER || 'google';
export let STRONG_REVIEW_MODEL = process.env.STRONG_REVIEW_MODEL || 'gemini-3.5-flash';
export let GOOGLE_FALLBACK_MODELS = process.env.GOOGLE_FALLBACK_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.1-flash';

export let AI_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || '8');
export let TASK_AUTO_MERGE_TO_PHASE_BRANCH = process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH === 'true'; // default false
export let NEVER_MERGE_TO_MAIN = process.env.NEVER_MERGE_TO_MAIN !== 'false'; // default true
export let HUMAN_APPROVAL_REQUIRED_FOR_MAIN = process.env.HUMAN_APPROVAL_REQUIRED_FOR_MAIN !== 'false'; // default true
export let BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH === 'true'; // default false
export let AUTO_MERGE_WITH_NOTES = process.env.AUTO_MERGE_WITH_NOTES !== 'false'; // default true: merge PRs into phase branch with notes rather than holding dependent tasks
export let CREATE_FINAL_DRAFT_PR = process.env.CREATE_FINAL_DRAFT_PR !== 'false'; // default true

export let MAX_PR_DIFF_CHARS = parseInt(process.env.MAX_PR_DIFF_CHARS || '120000', 10);
export let PR_REVIEW_CHUNK_CHARS = parseInt(process.env.PR_REVIEW_CHUNK_CHARS || '20000', 10);
export let GEMINI_DAILY_FREE_CALL_BUDGET = parseInt(process.env.GEMINI_DAILY_FREE_CALL_BUDGET || '450', 10);
export let MAX_AUTO_REVISION_ATTEMPTS = parseInt(process.env.MAX_AUTO_REVISION_ATTEMPTS || '3', 10);
export let MAX_CONFLICT_RETRIES = parseInt(process.env.MAX_CONFLICT_RETRIES || '2', 10);

export let POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
export let TELEGRAM_REMINDER_MS = parseInt(process.env.TELEGRAM_REMINDER_MS || '300000', 10);
export let DAYTIME_QUESTION_TIMEOUT_MS = parseInt(process.env.DAYTIME_QUESTION_TIMEOUT_MS || '1800000', 10); // 30 mins
export let MST_OVERNIGHT_START_HOUR = parseInt(process.env.MST_OVERNIGHT_START_HOUR || '22', 10); // 10 PM MST
export let MST_OVERNIGHT_END_HOUR = parseInt(process.env.MST_OVERNIGHT_END_HOUR || '7', 10); // 7 AM MST

export function isMSTOvernight(date = new Date()) {
  if (process.env.JULES_SUPERVISOR_TEST === '1' && process.env.FORCE_OVERNIGHT !== 'true') {
    return false;
  }
  try {
    const mstTimeStr = date.toLocaleString("en-US", { timeZone: "America/Denver", hour12: false });
    const hourStr = mstTimeStr.split(',')[1]?.trim().split(':')[0];
    const hour = parseInt(hourStr || '0', 10);
    if (MST_OVERNIGHT_START_HOUR > MST_OVERNIGHT_END_HOUR) {
      return hour >= MST_OVERNIGHT_START_HOUR || hour < MST_OVERNIGHT_END_HOUR;
    }
    return hour >= MST_OVERNIGHT_START_HOUR && hour < MST_OVERNIGHT_END_HOUR;
  } catch (_) {
    const utcHour = date.getUTCHours();
    const mstHour = (utcHour - 7 + 24) % 24;
    return mstHour >= MST_OVERNIGHT_START_HOUR || mstHour < MST_OVERNIGHT_END_HOUR;
  }
}

export function reloadConfig() {
  PRIMARY_SUPERVISOR_PROVIDER = process.env.PRIMARY_SUPERVISOR_PROVIDER || 'google';
  PRIMARY_SUPERVISOR_MODEL = process.env.PRIMARY_SUPERVISOR_MODEL || 'gemini-3.1-flash-lite';
  BACKUP_SUPERVISOR_PROVIDER = process.env.BACKUP_SUPERVISOR_PROVIDER || 'openrouter';
  BACKUP_SUPERVISOR_MODEL = process.env.BACKUP_SUPERVISOR_MODEL || 'qwen/qwen3.7-flash';
  STRONG_REVIEW_PROVIDER = process.env.STRONG_REVIEW_PROVIDER || 'google';
  STRONG_REVIEW_MODEL = process.env.STRONG_REVIEW_MODEL || 'gemini-3.5-flash';
  GOOGLE_FALLBACK_MODELS = process.env.GOOGLE_FALLBACK_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.1-flash';

  AI_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || '8');
  TASK_AUTO_MERGE_TO_PHASE_BRANCH = process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH === 'true';
  NEVER_MERGE_TO_MAIN = process.env.NEVER_MERGE_TO_MAIN !== 'false';
  HUMAN_APPROVAL_REQUIRED_FOR_MAIN = process.env.HUMAN_APPROVAL_REQUIRED_FOR_MAIN !== 'false';
  BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH === 'true';
  AUTO_MERGE_WITH_NOTES = process.env.AUTO_MERGE_WITH_NOTES !== 'false';
  CREATE_FINAL_DRAFT_PR = process.env.CREATE_FINAL_DRAFT_PR !== 'false';

  MAX_PR_DIFF_CHARS = parseInt(process.env.MAX_PR_DIFF_CHARS || '120000', 10);
  PR_REVIEW_CHUNK_CHARS = parseInt(process.env.PR_REVIEW_CHUNK_CHARS || '20000', 10);
  GEMINI_DAILY_FREE_CALL_BUDGET = parseInt(process.env.GEMINI_DAILY_FREE_CALL_BUDGET || '450', 10);
  MAX_AUTO_REVISION_ATTEMPTS = parseInt(process.env.MAX_AUTO_REVISION_ATTEMPTS || '3', 10);
  MAX_CONFLICT_RETRIES = parseInt(process.env.MAX_CONFLICT_RETRIES || '2', 10);

  POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
  TELEGRAM_REMINDER_MS = parseInt(process.env.TELEGRAM_REMINDER_MS || '300000', 10);
  DAYTIME_QUESTION_TIMEOUT_MS = parseInt(process.env.DAYTIME_QUESTION_TIMEOUT_MS || '1800000', 10);
  MST_OVERNIGHT_START_HOUR = parseInt(process.env.MST_OVERNIGHT_START_HOUR || '22', 10);
  MST_OVERNIGHT_END_HOUR = parseInt(process.env.MST_OVERNIGHT_END_HOUR || '7', 10);
}
