import * as github from '../services/github.js';
import * as ai from '../services/ai.js';
import * as jules from '../services/jules.js';
import * as telegram from '../services/telegram.js';
import * as taskManager from './taskManager.js';
import { updateTaskStatus, logQA, hasQALogEntry, getPhase, getQueuedReadyTasks, resetTaskForConflictRework } from '../db/queries.js';
import {
  TASK_AUTO_MERGE_TO_PHASE_BRANCH,
  NEVER_MERGE_TO_MAIN,
  BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH,
  AUTO_MERGE_WITH_NOTES,
  MAX_PR_DIFF_CHARS,
  PR_REVIEW_CHUNK_CHARS,
  MAX_AUTO_REVISION_ATTEMPTS,
  MAX_CONFLICT_RETRIES,
  STRONG_REVIEW_PROVIDER,
  STRONG_REVIEW_MODEL,
  PRIMARY_SUPERVISOR_PROVIDER,
  PRIMARY_SUPERVISOR_MODEL
} from './config.js';

const PROJECT_CONVENTIONS = `PR Reviewer Guidelines & Smart Constraints:
1. Pragmatic Review: Focus strictly on code correctness, syntax errors, broken imports, missing core logic, or security flaws.
2. Unit Test Files vs Test Execution:
   - Creating or updating test files (.test.js, .spec.ts) for backend logic is fine, BUT Jules is NOT required to run tests or provide runtime execution logs/proof.
   - As long as code and test files are clean and have valid syntax, APPROVE the PR without demanding runtime execution logs.
3. DO NOT Ask For Impossible or Out-of-Scope Tasks:
   - NEVER block a PR asking for manual visual smoke tests, E2E browser verification, or human checks. (Put visual/manual suggestions into "advisoryNotes", NEVER "blockingIssues").
   - NEVER block a PR asking to create complex test harnesses or rewrite unchanged files.
4. DO NOT Miss Critical Blockers:
   - ALWAYS block on syntax errors, broken/missing ESM imports, undefined variables, or completely unfulfilled task requirements.
   - ALWAYS block on security vulnerabilities (hardcoded secrets, broken auth, SQL injection).
5. Advisory vs Blocking Distinction:
   - "blockingIssues": Concrete code bugs or unfulfilled task requirements ONLY.
   - "advisoryNotes": Optional style hints, manual UI check recommendations, or non-blocking suggestions.`;

/**
 * Detects high-risk files or patterns in changed files and diff content.
 */
export function detectRisk(filenames, diff) {
  const highRiskPatterns = [
    /auth/i, /security/i, /login/i, /(^|[/_.-])migrations?([/_.-]|$)|\bmigration\b/i, /schema/i, /\.sql$/i,
    /\.env/i, /config/i, /secrets?/i, /github/i, /jules/i, /telegram/i,
    /wrapper/i, /merge/i, /jupiter/i, /form/i, /generation/i,
    /supported/i, /auto-submit/i, /government/i, /portal/i, /automation/i
  ];

  for (const file of filenames) {
    if (highRiskPatterns.some(pattern => pattern.test(file))) {
      return 'high';
    }
  }

  const diffPatterns = [
    /gov(ernment)?\s*portal/i,
    /auto-submit/i,
    /form.*supported/i,
    /db_pass|github_token|telegram_bot_token|api_key/i
  ];
  if (diffPatterns.some(pattern => pattern.test(diff))) {
    return 'high';
  }

  return 'low';
}

async function sendReviewNotificationOnce(task, pr, outcome, sendNotification) {
  const sha = pr.head?.sha || 'unknown-sha';
  const marker = `[PR Review Notification] PR #${pr.number} ${sha} ${outcome}`;

  try {
    const alreadySent = await hasQALogEntry(task.id, marker);
    if (alreadySent) {
      console.log(`Skipping duplicate PR notification marker: ${marker}`);
      return false;
    }

    await sendNotification();
    await logQA(task.id, marker, 'Notification sent.', 'system', null);
    return true;
  } catch (error) {
    console.warn(`PR notification marker failed for ${marker}:`, error.message);
    return false;
  }
}

/**
 * Runs the chunked AI diff review and returns the aggregate verdict.
 * This is the expensive (token-costing) part of a review — callers should only
 * invoke this when the PR's head SHA has actually changed since the last review.
 */
async function runAiDiffReview(task, phase, filenames, rawDiff) {
  let finalRiskLevel = detectRisk(filenames, rawDiff);
  const provider = finalRiskLevel === 'high' ? STRONG_REVIEW_PROVIDER : PRIMARY_SUPERVISOR_PROVIDER;
  const model = finalRiskLevel === 'high' ? STRONG_REVIEW_MODEL : PRIMARY_SUPERVISOR_MODEL;

  const chunks = [];
  if (rawDiff.length === 0) {
    chunks.push('');
  } else {
    for (let i = 0; i < rawDiff.length; i += PR_REVIEW_CHUNK_CHARS) {
      chunks.push(rawDiff.substring(i, i + PR_REVIEW_CHUNK_CHARS));
    }
  }

  let approved = true;
  let reviewerSource = `${provider === 'google' ? 'Google' : 'OpenRouter'} (${model})`;
  const summaries = [];
  const missingRequirements = [];
  const filesReviewedSet = new Set();
  const testEvidences = [];
  const blockingIssues = [];
  const followUpInstructions = [];
  const advisoryNotes = [];

  const revisionCount = task.pr_revision_count || 0;
  const isFinalAttemptRound = revisionCount >= MAX_AUTO_REVISION_ATTEMPTS - 1;

  let revisionHistoryBlock = '';
  if (revisionCount > 0 && task.last_review_feedback) {
    revisionHistoryBlock = `
## REVISION HISTORY (Round ${revisionCount + 1} of ${MAX_AUTO_REVISION_ATTEMPTS})
In the previous review round, the coding agent (Jules) was asked to fix:
"${task.last_review_feedback}"

CRITICAL REVIEW RULES FOR REVISIONS:
1. Verify if Jules addressed the specific issues listed above in this updated diff.
2. DO NOT repeat issues that have already been resolved or addressed by Jules.
3. DO NOT invent new minor style or nitpick complaints if the previous feedback was addressed and the code works.
${isFinalAttemptRound ? '4. THIS IS THE FINAL AUTOMATED REVISION ROUND. If code functionality is complete and no severe security flaws or fatal syntax bugs exist, APPROVE the PR.' : '4. Evaluate incremental progress pragmatically.'}
`;
  } else {
    revisionHistoryBlock = `
## REVIEW PHILOSOPHY
Focus on task intent and functional correctness. Distinguish between critical blockers vs minor style.
- Mark as "blockingIssues" / "missingRequirements" ONLY if there are true bugs, security vulnerabilities, broken logic, or missing core task requirements.
- Mark style suggestions, refactor preferences, or minor hints as "advisoryNotes" (non-blocking).
`;
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];

    // Full phase/task context + project conventions only on the first chunk — repeating
    // it on every chunk would multiply its token cost for no benefit. Later chunks get a
    // short recap of findings so far instead, so the model doesn't re-flag duplicates.
    const contextBlock = idx === 0
      ? `## Phase Goals\nTitle: ${phase.title || 'Current Phase'}\nDescription: ${phase.description || 'None provided.'}\n\n## Task Intent & Requirements\nTitle: ${task.title}\nDescription: ${task.description}\n\n${PROJECT_CONVENTIONS}\n${revisionHistoryBlock}`
      : `## Task Intent & Requirements\nTitle: ${task.title}\n(Full phase goals, task description, and revision history were provided in chunk 1.)\n\nFindings recorded so far from earlier chunks of this diff:\nMissing requirements so far: ${missingRequirements.join('; ') || 'none yet'}\nBlocking issues so far: ${blockingIssues.join('; ') || 'none yet'}`;

    const prompt = `You are reviewing a code change.
${contextBlock}

PR Changed Files: ${JSON.stringify(filenames)}
PR Diff Chunk (${idx + 1} of ${chunks.length}):
${chunk}

Check this diff chunk against the task requirements and the project conventions above. Classify every issue you find by severity:
- "blockingIssues" / "missingRequirements": real bugs, security problems, incorrect logic, or unmet task requirements. These block merge and get sent back to the coding agent to fix.
- "advisoryNotes": minor, non-blocking suggestions only (e.g. "could use more test coverage", "recommend a manual/visual check of this UI change", style nits). These never block merge and are shown only to the human reviewer, never sent to the coding agent.

The response must be strict JSON matching this exact format:
{
  "approved": true,
  "riskLevel": "low",
  "summary": "Short explanation",
  "missingRequirements": [],
  "filesReviewed": [],
  "testEvidence": "Tests found or not found",
  "blockingIssues": [],
  "advisoryNotes": [],
  "followUpInstructions": ""
}`;

    let chunkResult;
    try {
      const reviewResult = await ai.askJsonGoogleFirst(
        provider,
        model,
        prompt,
        { returnJson: true, temperature: 0.1 },
        parsed => (
          Object.prototype.hasOwnProperty.call(parsed, 'approved') &&
          typeof parsed.riskLevel === 'string' &&
          typeof parsed.summary === 'string' &&
          Array.isArray(parsed.missingRequirements) &&
          Array.isArray(parsed.filesReviewed) &&
          Array.isArray(parsed.blockingIssues)
        )
      );
      chunkResult = reviewResult.parsed;
      if (reviewResult.paidFallbackUsed) {
        reviewerSource = `OpenRouter (${reviewResult.model}) [Paid Failover]`;
        console.warn(`Paid fallback model used for PR #${task.pr_number} chunk ${idx + 1}: ${reviewResult.provider}/${reviewResult.model}`);
        try {
          await telegram.sendNotification(`⚠️ AI Model Failover for PR #${task.pr_number} ("${task.title}"):\nPrimary Google model (${reviewResult.primaryModelAttempted}) failed. Switched to OpenRouter (${reviewResult.model}).`);
        } catch (_) {}
      } else if (reviewResult.googleFallbackUsed) {
        reviewerSource = `Google (${reviewResult.model}) [Failover from ${reviewResult.primaryModelAttempted}]`;
        console.warn(`Google fallback model used for PR #${task.pr_number} chunk ${idx + 1}: ${reviewResult.model}`);
        try {
          await telegram.sendNotification(`ℹ️ AI Model Failover for PR #${task.pr_number} ("${task.title}"):\nPrimary model ${reviewResult.primaryModelAttempted} hit quota limit. Switched to ${reviewResult.model}.`);
        } catch (_) {}
      } else {
        reviewerSource = `Google (${reviewResult.model})`;
      }
    } catch (reviewError) {
      console.error(`AI review infrastructure failure for chunk ${idx + 1}:`, reviewError.message || reviewError);
      // Infrastructure errors (429 quota, 403 forbidden, timeouts, rate limits) are NOT code defects in the PR.
      // Do NOT add to blockingIssues and do NOT comment on GitHub or message Jules.
      // Mark as unreviewed infrastructure failure so the supervisor retries quietly when AI quota/network recovers.
      return {
        approved: false,
        finalRiskLevel: 'unknown',
        reviewerSource: 'None (AI Infrastructure Unavailable)',
        summaries: [`AI review deferred due to provider failure: ${reviewError.message}`],
        missingRequirements: [],
        testEvidences: [],
        blockingIssues: [],
        advisoryNotes: [],
        followUpInstructions: [],
        infraFailure: true,
        infraError: reviewError.message
      };
    }

    if (chunkResult.approved === false || chunkResult.approved === 'false') {
      approved = false;
    }
    if (chunkResult.riskLevel === 'high') {
      finalRiskLevel = 'high';
    }
    if (chunkResult.summary) {
      summaries.push(chunkResult.summary);
    }
    if (Array.isArray(chunkResult.missingRequirements)) {
      missingRequirements.push(...chunkResult.missingRequirements);
    }
    if (Array.isArray(chunkResult.filesReviewed)) {
      chunkResult.filesReviewed.forEach(f => filesReviewedSet.add(f));
    }
    if (chunkResult.testEvidence) {
      testEvidences.push(chunkResult.testEvidence);
    }
    if (Array.isArray(chunkResult.blockingIssues)) {
      blockingIssues.push(...chunkResult.blockingIssues);
    }
    // advisoryNotes is read optionally (like testEvidence) and never validated as
    // required, so mock/older AI responses that omit it don't fail the review.
    if (Array.isArray(chunkResult.advisoryNotes)) {
      advisoryNotes.push(...chunkResult.advisoryNotes);
    }
    if (chunkResult.followUpInstructions) {
      followUpInstructions.push(chunkResult.followUpInstructions);
    }
  }

  if (missingRequirements.length > 0) {
    approved = false;
  }
  if (blockingIssues.length > 0) {
    approved = false;
  }

  return {
    approved,
    finalRiskLevel,
    reviewerSource,
    summaries,
    missingRequirements,
    filesReviewed: Array.from(filesReviewedSet),
    testEvidences,
    blockingIssues,
    followUpInstructions,
    advisoryNotes
  };
}

/**
 * Reviews a task's Pull Request and merges it if approved, otherwise requests revisions.
 * Automatically queued sequentially per phase branch via mergeQueue to prevent merge race conditions.
 */
export async function reviewAndMerge(task) {
  let phaseBranch = 'default';
  try {
    const phase = await getPhase(task.phase_id);
    if (phase?.phase_branch) {
      phaseBranch = phase.phase_branch;
    }
  } catch (_) {}

  const { enqueueMerge } = await import('./mergeQueue.js');
  return enqueueMerge(phaseBranch, () => executeReviewAndMerge(task));
}

async function executeReviewAndMerge(task) {
  console.log(`Reviewing PR #${task.pr_number} for task #${task.id} ("${task.title}")`);

  try {
    // 1. Fetch PR metadata
    const pr = await github.getPR(task.pr_number);
    const phase = await getPhase(task.phase_id);

    if (!phase) {
      throw new Error(`Phase not found for phase ID: ${task.phase_id}`);
    }

    // 2. Validate target/base branch
    const baseBranch = pr.base?.ref;
    if (baseBranch === 'main' || baseBranch !== phase.phase_branch || (NEVER_MERGE_TO_MAIN && baseBranch === 'main')) {
      console.log(`PR #${task.pr_number} targets wrong base branch: "${baseBranch}" (expected "${phase.phase_branch}"). Blocking.`);

      const correction = `Your PR targets ${baseBranch}. Retarget the PR to ${phase.phase_branch}. The supervisor is not allowed to merge into main.`;

      // Update QA log
      await logQA(
        task.id,
        `[PR Review Command] PR #${task.pr_number}`,
        `Blocked. Reason: PR targets base branch "${baseBranch}" instead of "${phase.phase_branch}". Correction sent to Jules.`,
        'system',
        null
      );

      await sendReviewNotificationOnce(task, pr, 'wrong-branch', async () => {
        await jules.sendMessage(task.jules_session_id, correction);
        await telegram.sendPRBlockedNotification({
          taskTitle: task.title,
          prUrl: pr.html_url || task.pr_url,
          riskLevel: 'low',
          blockingReason: `PR targets base branch "${baseBranch}" instead of "${phase.phase_branch}"`,
          julesFix: `Retarget the PR to ${phase.phase_branch}`,
          isHardStop: true
        });
      });

      // Keep task status as pr_open
      await updateTaskStatus(task.id, 'pr_open');
      return { merged: false, blocked: true, reason: 'PR targets wrong branch' };
    }

    // 2b. Check for Git merge conflicts and attempt proactive branch update
    if (pr.mergeable === false) {
      console.log(`PR #${task.pr_number} has merge conflicts with target branch "${phase.phase_branch}". Attempting auto update-branch...`);
      try {
        const updated = await github.updatePRBranch(task.pr_number);
        if (updated) {
          pr = await github.getPR(task.pr_number);
        }
      } catch (syncErr) {
        console.warn(`Proactive update-branch attempt warning for PR #${task.pr_number}:`, syncErr.message);
      }
    }

    if (pr.mergeable === false) {
      const currentRetries = task.retry_count || 0;
      console.log(`PR #${task.pr_number} has unresolved merge conflicts with target branch "${phase.phase_branch}". Retry count: ${currentRetries}/${MAX_CONFLICT_RETRIES}`);

      // 2. Smart merge conflict resolution — AI synthesize clean merge and keep PR open
      console.log(`PR #${task.pr_number} has merge conflicts with base branch "${phase.phase_branch}". Attempting automated branch update...`);
      let updateSuccess = await github.updatePRBranch(task.pr_number);

      if (!updateSuccess) {
        console.log(`[SmartConflictResolver] Branch update hit conflict. Running AI Line-by-Line Conflict Resolver for PR #${task.pr_number}...`);
        const { smartResolvePRMergeConflicts } = await import('./conflictResolver.js');
        updateSuccess = await smartResolvePRMergeConflicts(task.pr_number, task, phase.phase_branch);
      }

      if (updateSuccess) {
        console.log(`Auto-update branch succeeded for PR #${task.pr_number}. Re-evaluating PR status...`);
        pr = await github.getPR(task.pr_number);
      }

      if (!pr.mergeable && pr.mergeable_state === 'dirty') {
        console.log(`PR #${task.pr_number} still has conflicts. Notifying Jules session once while keeping PR open.`);
        
        const conflictPrompt = `Merge conflict alert: Your PR #${task.pr_number} has merge conflicts with base branch ${phase.phase_branch}. Please fetch the latest ${phase.phase_branch}, merge/rebase it into your local working branch, resolve all conflict markers, and push the updated commit to PR #${task.pr_number}.`;

        try {
          await jules.sendMessage(task.jules_session_id, conflictPrompt);
          await github.addPRComment(task.pr_number, `⚠️ **Supervisor Notice**: Merge conflicts detected with \`${phase.phase_branch}\`. Jules has been instructed to rebase and resolve conflicts.`);
        } catch (msgErr) {
          console.warn(`Failed to notify Jules for PR #${task.pr_number} conflict:`, msgErr.message);
        }

        // Keep in pr_open status with feedback recorded so we don't bounce back and forth
        await updateTaskStatus(task.id, 'pr_open', {
          last_review_feedback: `Merge conflict with ${phase.phase_branch} — waiting for rebase`
        });

        return { merged: false, conflict: true, reason: `PR #${task.pr_number} has merge conflicts; waiting for clean branch` };
      }
    }

    // 3. Fetch changed files and diff
    const files = await github.getPRFiles(task.pr_number);
    const filenames = files.map(f => f.filename);

    // 3b. Empty PR & Zero-Diff Fast Rejector (50ms check without calling AI reviewer)
    // Only trigger if file metadata is present and explicitly has 0 additions/deletions across files
    if (files && files.length > 0) {
      const hasStats = files.some(f => f.additions !== undefined || f.deletions !== undefined || f.changes !== undefined);
      const totalDiffChanges = files.reduce((acc, f) => acc + (f.additions || 0) + (f.deletions || 0), 0);
      if (hasStats && totalDiffChanges === 0) {
        console.warn(`[FastRejector] PR #${task.pr_number} for task #${task.id} contains 0 code changes. Fast-rejecting without calling AI Reviewer.`);
        const emptyPrompt = `Automated verification failed: PR #${task.pr_number} contains 0 lines of implementation code. Please implement the requested feature, commit, and push your changes to PR #${task.pr_number}.`;
        
        try {
          await jules.sendMessage(task.jules_session_id, emptyPrompt);
          await github.addPRComment(task.pr_number, `⚠️ **Supervisor Verification Notice**: PR #${task.pr_number} contains 0 code changes. Requested Jules to commit implementation code.`);
        } catch (rejectErr) {
          console.warn(`[FastRejector] Error messaging Jules/GitHub for task #${task.id}:`, rejectErr.message);
        }

        await updateTaskStatus(task.id, 'running', {
          last_review_feedback: 'Fast-rejected: PR contains 0 code changes'
        });
        return { merged: false, approved: false, emptyPr: true, reason: 'PR contains zero code changes' };
      }
    }

    let rawDiff = await github.getPRDiff(task.pr_number);
    if (rawDiff.length > MAX_PR_DIFF_CHARS) {
      console.warn(`PR diff length (${rawDiff.length}) exceeds MAX_PR_DIFF_CHARS (${MAX_PR_DIFF_CHARS}). Marking task as unreviewed so phase flow is not stopped.`);
      await updateTaskStatus(task.id, 'unreviewed', {
        last_review_feedback: `⚠️ Unreviewed (PR diff size ${rawDiff.length} chars exceeds maximum limit of ${MAX_PR_DIFF_CHARS} chars)`
      });
      await sendReviewNotificationOnce(task, pr, 'diff-too-large', async () => {
        await telegram.sendPRBlockedNotification({
          taskTitle: task.title,
          prUrl: task.pr_url || github.getPRWebUrl(task.pr_number),
          riskLevel: 'high',
          blockingReason: `PR diff size (${rawDiff.length} chars) exceeds the maximum allowed limit of ${MAX_PR_DIFF_CHARS} chars.`,
          julesFix: 'Manual human review and merge required',
          isHardStop: false
        });
      });
      return { merged: false, approved: false, unreviewed: true, reason: 'PR diff size exceeds maximum allowed limit' };
    }

    // 4. Reuse the cached AI verdict if this exact commit was already reviewed, otherwise
    // run the (expensive) chunked AI diff review fresh. Steps 5+ below always run live
    // regardless of the cache, so CI/mergeability changes are still caught every poll.
    const headSha = pr.head?.sha;
    let cachedAggregate = null;
    if (task.last_reviewed_sha && task.last_reviewed_sha === headSha && task.last_review_verdict) {
      try {
        cachedAggregate = JSON.parse(task.last_review_verdict);
      } catch (parseErr) {
        console.warn(`Failed to parse cached review verdict for task #${task.id}, re-reviewing:`, parseErr.message);
      }
    }

    let aggregate;
    if (cachedAggregate) {
      console.log(`PR #${task.pr_number} head sha ${headSha} unchanged since last review. Reusing cached AI verdict — skipping AI diff review.`);
      aggregate = cachedAggregate;
    } else {
      aggregate = await runAiDiffReview(task, phase, filenames, rawDiff);
      if (aggregate.infraFailure) {
        console.warn(`[PRReviewer] AI review for PR #${task.pr_number} deferred due to provider infrastructure unavailability (${aggregate.infraError}). Will retry next cycle without commenting.`);
        return { merged: false, approved: false, infraFailure: true, reason: aggregate.infraError };
      }
      try {
        await updateTaskStatus(task.id, task.status, {
          last_reviewed_sha: headSha,
          last_review_verdict: JSON.stringify(aggregate)
        });
      } catch (cacheErr) {
        console.warn(`Failed to persist review verdict cache for task #${task.id}:`, cacheErr.message);
      }
    }

    let { approved, finalRiskLevel, reviewerSource, summaries, missingRequirements, testEvidences, blockingIssues, followUpInstructions, advisoryNotes } = aggregate;

    // 5. Check for status checks and check runs (always fresh — CI can change independently of the diff)
    const checksStatus = await github.getPRChecks(task.pr_number);
    if (checksStatus === 'failing') {
      approved = false;
      blockingIssues = blockingIssues.concat('PR status checks or check runs are failing.');
    }

    // 6. Validate test evidence for backend logic changes
    // Pure UI/CSS/HTML/Docs/Config changes or code cleanup/deletion tasks do NOT require unit test files.
    const isUiOrAssets = filenames.length > 0 && filenames.every(f => {
      const lower = f.toLowerCase();
      return lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.html') || 
             lower.endsWith('.svg') || lower.endsWith('.png') || lower.endsWith('.jpg') || 
             lower.endsWith('.json') || lower.endsWith('.md') || lower.endsWith('.yaml') || lower.endsWith('.yml');
    });

    const taskTitleLower = (task.title || '').toLowerCase();
    const isCleanupOrRefactor = taskTitleLower.includes('cleanup') || 
                               taskTitleLower.includes('remove') || 
                               taskTitleLower.includes('delete') || 
                               taskTitleLower.includes('refactor') || 
                               taskTitleLower.includes('style') || 
                               taskTitleLower.includes('css') || 
                               taskTitleLower.includes('html') || 
                               taskTitleLower.includes('ui');

    const prDescriptionLower = ((pr.body || '') + ' ' + testEvidences.join(' ')).toLowerCase();
    const julesVerified = prDescriptionLower.includes('verified') || 
                          prDescriptionLower.includes('tests were run') || 
                          prDescriptionLower.includes('no console errors') ||
                          prDescriptionLower.includes('no failing tests');

    const requiresTestEvidence = !isUiOrAssets && !isCleanupOrRefactor && !julesVerified;

    if (requiresTestEvidence) {
      const hasSourceChanges = filenames.some(f => f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.py') || f.endsWith('.go') || f.endsWith('.rs'));
      const hasTestFileChanges = filenames.some(f => {
        const lower = f.toLowerCase();
        return lower.includes('test') || lower.includes('spec') || lower.includes('__tests__');
      });

      const testEvidenceText = testEvidences.join('; ').toLowerCase();
      const hasTestEvidenceText = testEvidenceText.includes('test') &&
                                  !testEvidenceText.includes('no test') &&
                                  !testEvidenceText.includes('missing') &&
                                  !testEvidenceText.includes('unknown');

      if (hasSourceChanges) {
        const verifiedByTestFile = hasTestFileChanges;
        const verifiedByChecks = hasTestEvidenceText && checksStatus === 'passing';

        if (!verifiedByTestFile && !verifiedByChecks) {
          advisoryNotes.push('Note: No unit test file was added for source code changes.');
        }
      }
    }

    // 7. Actions based on approval and safety policies
    const normalizeStringList = (list) => {
      if (!Array.isArray(list)) return [];
      return list.map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.description || item.message || JSON.stringify(item);
        return String(item);
      });
    };

    blockingIssues = normalizeStringList(blockingIssues);
    missingRequirements = normalizeStringList(missingRequirements);
    advisoryNotes = normalizeStringList(advisoryNotes);

    const summaryText = summaries.join(' ');
    const blockingText = blockingIssues.concat(missingRequirements).join(', ');

    // Log the review action in qa_log
    await logQA(
      task.id,
      `[PR Review Command] PR #${task.pr_number}`,
      `Approved: ${approved}. Reviewer: ${reviewerSource || 'unknown'}. Risk Level: ${finalRiskLevel}. Summary: ${summaryText}. Blockers: ${blockingText}. Advisory: ${advisoryNotes.join('; ') || 'none'}`,
      'system',
      null
    );

    // Advisory notes are informational only — surfaced to the human, never sent to
    // Jules, never posted to GitHub, never affect the merge decision.
    if (advisoryNotes.length > 0) {
      await sendReviewNotificationOnce(task, pr, `advisory-${headSha}`, async () => {
        await telegram.sendNotification(
          `💡 Advisory notes for "${task.title}" (PR #${task.pr_number}, non-blocking):\n${advisoryNotes.map(n => `- ${n}`).join('\n')}`
        );
      });
    }

    if (approved) {
      // Determine if we can auto-merge:
      // If targeting a phase branch (not main) and TASK_AUTO_MERGE_TO_PHASE_BRANCH is true
      const isTargetingPhaseBranch = baseBranch === phase.phase_branch && baseBranch !== 'main';
      const canAutoMerge = (
        TASK_AUTO_MERGE_TO_PHASE_BRANCH &&
        isTargetingPhaseBranch &&
        checksStatus !== 'failing' &&
        (!BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH || finalRiskLevel !== 'high')
      );

      if (canAutoMerge) {
        console.log(`Approving PR #${task.pr_number}...`);
        try { await github.approvePR(task.pr_number); } catch (appErr) { console.warn('Approve PR warning:', appErr.message); }

        console.log(`Merging PR #${task.pr_number} into ${phase.phase_branch}...`);
        await github.mergePR(task.pr_number, task.title, phase.phase_branch);

        // Clean up any other open duplicate/abandoned PRs for this task
        try {
          await github.closeDuplicateTaskPRs(phase.phase_branch, task.pr_number, task.id, task.title, task.jules_session_id);
        } catch (cleanupErr) {
          console.warn(`Duplicate PR cleanup warning for task #${task.id}:`, cleanupErr.message);
        }

        // Auto-sync other open PRs on the phase branch to prevent merge conflicts
        try {
          await autoSyncOtherOpenPRs(phase.phase_branch, task.pr_number);
        } catch (syncErr) {
          console.warn(`Auto-sync notice for phase branch ${phase.phase_branch}:`, syncErr.message);
        }

        // Update task to merged status
        await updateTaskStatus(task.id, 'merged', { escalated: false });

        // Send Telegram notification
        try {
          const readyTasks = await getQueuedReadyTasks(task.phase_id);
          const nextTitle = readyTasks[0]?.title;
          await telegram.sendTaskMergedNotification(task.title, task.id, pr.html_url || task.pr_url, phase.phase_branch, nextTitle);
        } catch (tgErr) {
          console.error('Failed to send Telegram task merged notification:', tgErr);
        }

        // Instant downstream task launch (sub-second draining)
        try {
          await taskManager.startReadyTasks(task.phase_id, phase.phase_branch);
        } catch (launchErr) {
          console.warn(`[InstantLaunch] Downstream launch notice for phase #${task.phase_id}:`, launchErr.message);
        }

        return { merged: true };
      } else {
        console.log(`PR #${task.pr_number} is approved but blocked from auto-merge. AutoMergeEnabled=${TASK_AUTO_MERGE_TO_PHASE_BRANCH}, BlockHighRisk=${BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH}, Risk=${finalRiskLevel}, Checks=${checksStatus}`);

        await sendReviewNotificationOnce(task, pr, `ready-${finalRiskLevel}-${checksStatus}`, async () => {
          await telegram.sendPRReadyNotification({
            taskTitle: task.title,
            prUrl: pr.html_url || task.pr_url,
            reviewerSource: reviewerSource
          });
        });

        // Keep task status as pr_open
        await updateTaskStatus(task.id, 'pr_open', { escalated: false });
        return { merged: false, reason: 'Auto-merge policies prevented merge' };
      }
    } else {
      const revisionCount = task.pr_revision_count || 0;

      if (revisionCount < MAX_AUTO_REVISION_ATTEMPTS) {
        const nextRevisionCount = revisionCount + 1;
        console.log(`PR #${task.pr_number} rejected. Requesting revision from Jules (round ${nextRevisionCount}/${MAX_AUTO_REVISION_ATTEMPTS})...`);

        const revisionPrompt = `Please revise. The following issues were found:\n${blockingIssues.concat(missingRequirements).join('\n')}\n${followUpInstructions.join('\n')}`;
        const githubFeedback = `**Automated review — changes requested (round ${nextRevisionCount}/${MAX_AUTO_REVISION_ATTEMPTS})**

Reviewer: ${reviewerSource || 'AI Reviewer'}
Risk level: ${finalRiskLevel}

Blocking issues:
${blockingIssues.concat(missingRequirements).map(issue => `- ${issue}`).join('\n') || '- See summary below.'}

Summary: ${summaryText}${followUpInstructions.length ? `\n\nSuggested fix:\n${followUpInstructions.join('\n')}` : ''}`;

        await sendReviewNotificationOnce(task, pr, `rejected-${finalRiskLevel}`, async () => {
          await jules.sendMessage(task.jules_session_id, revisionPrompt);

          try {
            await github.requestChangesOnPR(task.pr_number, githubFeedback);
          } catch (reviewCommentErr) {
            console.warn(`requestChangesOnPR failed for PR #${task.pr_number}, falling back to a plain comment:`, reviewCommentErr.message);
            try {
              await github.addPRComment(task.pr_number, githubFeedback);
            } catch (commentErr) {
              console.warn(`addPRComment fallback also failed for PR #${task.pr_number}:`, commentErr.message);
            }
          }

          await telegram.sendPRBlockedNotification({
            taskTitle: task.title,
            prUrl: pr.html_url || task.pr_url,
            riskLevel: finalRiskLevel,
            blockingReason: blockingText || 'Failing verification requirements',
            julesFix: `Review blocking issues and update the PR (auto-revision round ${nextRevisionCount}/${MAX_AUTO_REVISION_ATTEMPTS})`,
            reviewerSource: reviewerSource,
            isHardStop: false
          });

          const feedbackItems = blockingIssues.concat(missingRequirements);
          const feedbackSummary = feedbackItems.join('; ') || 'Requested revisions for task criteria';
          await updateTaskStatus(task.id, 'running', {
            pr_revision_count: nextRevisionCount,
            last_review_feedback: feedbackSummary
          });
        });

        return { merged: false, reason: blockingText };
      } else {
        const isTargetingPhaseBranch = baseBranch === phase.phase_branch && baseBranch !== 'main';
        
        if (AUTO_MERGE_WITH_NOTES && isTargetingPhaseBranch) {
          console.log(`PR #${task.pr_number} reached auto-revision limit. Merging into phase branch "${phase.phase_branch}" with notes to unblock dependent tasks.`);

          const autoMergeComment = `**Supervisor Notice: Auto-merged with notes**
Automated review limit (${MAX_AUTO_REVISION_ATTEMPTS}/${MAX_AUTO_REVISION_ATTEMPTS} rounds) reached. Merging into phase branch \`${phase.phase_branch}\` with reviewer notes to keep phase workflow moving.

Reviewer: ${reviewerSource || 'AI Reviewer'}
Review Notes / Follow-up Items:
${blockingIssues.concat(missingRequirements).map(issue => `- ${issue}`).join('\n') || '- See summary below.'}

Summary: ${summaryText}`;

          try { await github.addPRComment(task.pr_number, autoMergeComment); } catch (_) {}
          try { await github.approvePR(task.pr_number); } catch (_) {}

          console.log(`Merging PR #${task.pr_number} into ${phase.phase_branch}...`);
          await github.mergePR(task.pr_number, task.title, phase.phase_branch);

          try {
            await github.closeDuplicateTaskPRs(phase.phase_branch, task.pr_number, task.id, task.title, task.jules_session_id);
          } catch (_) {}

          await updateTaskStatus(task.id, 'merged', { escalated: false, last_review_feedback: `Merged with notes: ${blockingText}` });

          try {
            const readyTasks = await getQueuedReadyTasks(task.phase_id);
            const nextTitle = readyTasks[0]?.title;
            await telegram.sendNotification(`ℹ️ Task #${task.id} ("${task.title}") auto-merged into phase branch \`${phase.phase_branch}\` with notes.\n\nNotes: ${blockingText}\n\nDependent tasks unblocked! Next task: ${nextTitle || 'None'}`);
          } catch (tgErr) {
            console.warn('Failed to send Telegram notification:', tgErr.message);
          }

          return { merged: true, mergedWithNotes: true };
        } else {
          console.log(`PR #${task.pr_number} has exhausted ${MAX_AUTO_REVISION_ATTEMPTS} auto-revision attempts. Escalating to human, not messaging Jules again.`);

          const escalationComment = `**Automated review limit reached (${MAX_AUTO_REVISION_ATTEMPTS}/${MAX_AUTO_REVISION_ATTEMPTS} revision rounds)** — issues remain and Jules will not be messaged again automatically for this PR. A human needs to take over.

Reviewer: ${reviewerSource || 'AI Reviewer'}

Outstanding blocking issues:
${blockingText || 'See review summary in the supervisor QA log.'}`;

          await sendReviewNotificationOnce(task, pr, 'revision-limit-reached', async () => {
            try {
              await github.addPRComment(task.pr_number, escalationComment);
            } catch (commentErr) {
              console.warn(`Failed to post escalation comment on PR #${task.pr_number}:`, commentErr.message);
            }

            await telegram.sendPRBlockedNotification({
              taskTitle: task.title,
              prUrl: pr.html_url || task.pr_url,
              riskLevel: finalRiskLevel,
              blockingReason: `Auto-review limit reached (${MAX_AUTO_REVISION_ATTEMPTS}/${MAX_AUTO_REVISION_ATTEMPTS}) — ${blockingText || 'issues remain'}`,
              julesFix: 'Please review and fix this manually — Jules will not be auto-messaged again for this PR.',
              reviewerSource: reviewerSource,
              isHardStop: true
            });
          });

          await updateTaskStatus(task.id, 'pr_open', { escalated: true });
          return { merged: false, reason: blockingText, escalated: true };
        }
      }
    }
  } catch (error) {
    console.error(`Error reviewing/merging PR #${task.pr_number} for task #${task.id}:`, error);
    throw error;
  }
}

/**
 * Automatically syncs (rebases/updates) all other open PRs on the phase branch
 * whenever a sibling PR is successfully merged into the phase branch.
 */
export async function autoSyncOtherOpenPRs(phaseBranch, mergedPrNumber) {
  if (!phaseBranch || phaseBranch === 'main') return;
  try {
    const openPRs = await github.getPRsForBranch(phaseBranch);
    for (const pr of openPRs) {
      if (pr.number === mergedPrNumber) continue;

      console.log(`[AutoResolver] Attempting branch sync for open PR #${pr.number} on base branch ${phaseBranch}...`);
      const success = await github.updatePRBranch(pr.number);
      if (success) {
        console.log(`[AutoResolver] Successfully updated base branch for PR #${pr.number}.`);
      } else {
        const pool = (await import('../db/connection.js')).pool;
        const [taskRows] = await pool.query('SELECT * FROM tasks WHERE pr_number = ?', [pr.number]);
        const task = taskRows[0];
        if (task && task.jules_session_id && task.status === 'pr_open') {
          console.warn(`[AutoResolver] Merge conflict detected on PR #${pr.number} for task #${task.id}. Notifying Jules session...`);
          try {
            await jules.sendMessage(
              task.jules_session_id,
              `The base branch ${phaseBranch} was updated with newly merged code, resulting in a merge conflict on PR #${pr.number}. Please fetch the latest ${phaseBranch}, merge or rebase it into your working branch, resolve conflicts, and push the updated branch to PR #${pr.number}.`
            );
            await github.addPRComment(
              pr.number,
              `⚠️ **Supervisor Merge Conflict Notice**: The base branch \`${phaseBranch}\` was updated, resulting in merge conflicts on this PR. Jules has been messaged to rebase/resolve conflicts.`
            );
          } catch (msgErr) {
            console.warn(`[AutoResolver] Could not notify Jules for PR #${pr.number} conflict:`, msgErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[AutoResolver] Error auto-syncing open PRs for branch ${phaseBranch}:`, err.message);
  }
}
