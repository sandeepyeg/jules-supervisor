import * as queries from '../db/queries.js';
import * as github from '../services/github.js';
import * as taskManager from './taskManager.js';
import * as poller from './poller.js';

function lifecycleError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function queueEpicPipeline(epicId, activePhaseId) {
  const phases = await queries.getEpicPhases(epicId);
  const queued = [];
  for (const phase of phases) {
    if (phase.id === activePhaseId || phase.status !== 'draft' || !phase.depends_on_phase_id) {
      continue;
    }
    await queries.updatePhaseStatus(phase.id, 'queued');
    queued.push(phase.id);
  }
  return queued;
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

  if (phase.epic_id) {
    const epic = await queries.getEpic(phase.epic_id);
    if (!epic) {
      throw lifecycleError(`Epic ${phase.epic_id} not found for phase ${phaseId}`, 400);
    }
    if (phase.main_branch !== epic.master_feature_branch) {
      throw lifecycleError(
        `Phase base branch "${phase.main_branch}" does not match epic master branch "${epic.master_feature_branch}"`,
        400
      );
    }
    await github.ensureBranchFromBase(epic.master_feature_branch, epic.target_base_branch || 'develop');
  }

  await github.createBranch(branchName, phase.main_branch);

  await queries.updatePhaseStatus(phaseId, 'active', {
    phase_branch: branchName,
    started_at: new Date()
  });

  const queuedPhaseIds = phase.epic_id
    ? await queueEpicPipeline(phase.epic_id, phaseId)
    : [];

  await taskManager.startReadyTasks(phaseId, branchName);
  poller.startPoller(phaseId);

  return { started: true, branch: branchName, queuedPhaseIds };
}

/**
 * Starts an epic by activating the first pending phase in dependency order. Later
 * phases remain queued and are advanced automatically when their parent completes.
 */
export async function startEpic(epicId) {
  const epic = await queries.getEpic(epicId);
  if (!epic) {
    throw lifecycleError('Epic not found', 404);
  }

  const phases = await queries.getEpicPhases(epicId);
  if (phases.length === 0) {
    throw lifecycleError('Epic has no phases to start', 400);
  }

  const activePhase = phases.find(phase => phase.status === 'active');
  if (activePhase) {
    const queuedPhaseIds = await queueEpicPipeline(epicId, activePhase.id);
    poller.startPoller(activePhase.id);
    return {
      started: false,
      alreadyActive: true,
      activePhaseId: activePhase.id,
      branch: activePhase.phase_branch,
      queuedPhaseIds
    };
  }

  const nextPhase = phases.find(phase => ['draft', 'queued'].includes(phase.status));
  if (!nextPhase) {
    throw lifecycleError('Epic has no draft or queued phases to start', 400);
  }

  if (nextPhase.status === 'queued') {
    await queries.updatePhaseStatus(nextPhase.id, 'draft');
  }

  const result = await startPhase(nextPhase.id);
  return {
    ...result,
    epicId,
    activePhaseId: nextPhase.id
  };
}

export async function pausePhase(phaseId) {
  const phase = await queries.getPhase(phaseId);
  if (!phase) {
    throw lifecycleError('Phase not found', 404);
  }
  if (phase.status === 'paused') {
    poller.stopPoller(phaseId, { manual: true });
    return { paused: true, alreadyPaused: true, phaseId };
  }
  if (phase.status !== 'active') {
    throw lifecycleError(`Only active phases can be paused. Current status: ${phase.status}`, 400);
  }

  poller.stopPoller(phaseId, { manual: true });
  await queries.updatePhaseStatus(phaseId, 'paused');
  return { paused: true, phaseId };
}

export async function resumePhase(phaseId) {
  const phase = await queries.getPhase(phaseId);
  if (!phase) {
    throw lifecycleError('Phase not found', 404);
  }

  // Clear any active quota backoff timer when developer explicitly clicks Resume
  taskManager.resetLaunchThrottlesForTests();

  if (phase.status === 'active') {
    poller.resumePoller(phaseId);
    return { resumed: true, alreadyActive: true, phaseId, branch: phase.phase_branch };
  }
  if (phase.status !== 'paused' && phase.status !== 'failed') {
    throw lifecycleError(`Only paused or failed phases can be resumed. Current status: ${phase.status}`, 400);
  }

  await queries.updatePhaseStatus(phaseId, 'active', { completed_at: null });
  poller.resumePoller(phaseId);
  return { resumed: true, phaseId, branch: phase.phase_branch };
}

export async function pauseEpic(epicId) {
  const epic = await queries.getEpic(epicId);
  if (!epic) {
    throw lifecycleError('Epic not found', 404);
  }
  const phases = await queries.getEpicPhases(epicId);
  const phase = phases.find(p => p.status === 'active') || phases.find(p => p.status === 'paused');
  if (!phase) {
    throw lifecycleError('Epic has no active or paused phase', 400);
  }
  const result = await pausePhase(phase.id);
  return { ...result, epicId, activePhaseId: phase.id };
}

export async function resumeEpic(epicId) {
  const epic = await queries.getEpic(epicId);
  if (!epic) {
    throw lifecycleError('Epic not found', 404);
  }
  const phases = await queries.getEpicPhases(epicId);
  const phase = phases.find(p => p.status === 'paused') || phases.find(p => p.status === 'active');
  if (!phase) {
    return startEpic(epicId);
  }
  const result = await resumePhase(phase.id);
  const queuedPhaseIds = await queueEpicPipeline(epicId, phase.id);
  return { ...result, epicId, activePhaseId: phase.id, queuedPhaseIds };
}
