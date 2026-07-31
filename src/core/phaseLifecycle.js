import * as queries from '../db/queries.js';
import * as github from '../services/github.js';
import * as taskManager from './taskManager.js';
import * as poller from './poller.js';

function lifecycleError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Starts a draft phase: creates its GitHub branch, marks it active, launches the
 * first ready tasks, and starts the background poller. This is the same action as
 * the dashboard's "Start Phase & Launch Sessions" button — shared so other entry
 * points (e.g. Telegram /import) can trigger the identical, validated path instead
 * of duplicating it.
 */
export async function startPhase(phaseId) {
  const phase = await queries.getPhase(phaseId);
  if (!phase) {
    throw lifecycleError('Phase not found', 404);
  }
  if (phase.status !== 'draft') {
    throw lifecycleError('Phase is already started or completed', 400);
  }

  const titleSlug = (phase.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → dash
    .replace(/^-+|-+$/g, '')        // trim leading/trailing dashes
    .substring(0, 40)               // max 40 chars
    || `phase-${phaseId}`;
  const shortTs = Date.now().toString(36).slice(-5); // e.g. "a3f2k"
  const branchName = `feature/${titleSlug}-${shortTs}`;

  await github.createBranch(branchName, phase.main_branch);

  await queries.updatePhaseStatus(phaseId, 'active', {
    phase_branch: branchName,
    started_at: new Date()
  });

  await taskManager.startReadyTasks(phaseId, branchName);
  poller.startPoller(phaseId);

  return { started: true, branch: branchName };
}
