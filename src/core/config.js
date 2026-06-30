import './env.js';

export const PRIMARY_SUPERVISOR_PROVIDER = process.env.PRIMARY_SUPERVISOR_PROVIDER || 'google';
export const PRIMARY_SUPERVISOR_MODEL = process.env.PRIMARY_SUPERVISOR_MODEL || 'gemini-3.1-flash-lite';
export const BACKUP_SUPERVISOR_PROVIDER = process.env.BACKUP_SUPERVISOR_PROVIDER || 'openrouter';
export const BACKUP_SUPERVISOR_MODEL = process.env.BACKUP_SUPERVISOR_MODEL || 'deepseek/deepseek-chat';
export const STRONG_REVIEW_PROVIDER = process.env.STRONG_REVIEW_PROVIDER || 'google';
export const STRONG_REVIEW_MODEL = process.env.STRONG_REVIEW_MODEL || 'gemini-3.5-flash';

export const AI_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || '8');
export const TASK_AUTO_MERGE_TO_PHASE_BRANCH = process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH === 'true'; // default false
export const NEVER_MERGE_TO_MAIN = process.env.NEVER_MERGE_TO_MAIN !== 'false'; // default true
export const HUMAN_APPROVAL_REQUIRED_FOR_MAIN = process.env.HUMAN_APPROVAL_REQUIRED_FOR_MAIN !== 'false'; // default true
export const CREATE_FINAL_DRAFT_PR = process.env.CREATE_FINAL_DRAFT_PR === 'true'; // default false

export const MAX_PR_DIFF_CHARS = parseInt(process.env.MAX_PR_DIFF_CHARS || '120000', 10);
export const PR_REVIEW_CHUNK_CHARS = parseInt(process.env.PR_REVIEW_CHUNK_CHARS || '20000', 10);
export const GEMINI_DAILY_FREE_CALL_BUDGET = parseInt(process.env.GEMINI_DAILY_FREE_CALL_BUDGET || '450', 10);

export const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
export const TELEGRAM_REMINDER_MS = parseInt(process.env.TELEGRAM_REMINDER_MS || '300000', 10);
