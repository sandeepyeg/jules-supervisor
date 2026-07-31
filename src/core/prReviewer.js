import * as github from '../services/github.js';
import * as ai from '../services/ai.js';
import * as jules from '../services/jules.js';
import * as telegram from '../services/telegram.js';
import { updateTaskStatus, logQA, hasQALogEntry, getPhase, getQueuedReadyTasks } from '../db/queries.js';
import {
  TASK_AUTO_MERGE_TO_PHASE_BRANCH,
  NEVER_MERGE_TO_MAIN,
  BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH,
  MAX_PR_DIFF_CHARS,
  PR_REVIEW_CHUNK_CHARS,
  MAX_AUTO_REVISION_ATTEMPTS,
  STRONG_REVIEW_PROVIDER,
  STRONG_REVIEW_MODEL,
  PRIMARY_SUPERVISOR_PROVIDER,
  PRIMARY_SUPERVISOR_MODEL
} from './config.js';

const PROJECT_CONVENTIONS = `Project conventions to check against, in addition to the task requirements:
- ESM only: relative imports must include the .js extension.
- Database query blocks must release connections via try/finally or try/catch.
- Never log secrets, tokens, or API keys.
- Changes to auth, security, schema/migrations, config/secrets, or automation-sensitive code are high risk and need extra scrutiny.`;

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
  const summaries = [];
  const missingRequirements = [];
  const filesReviewedSet = new Set();
  const testEvidences = [];
  const blockingIssues = [];
  const followUpInstructions = [];
  const advisoryNotes = [];

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];

    // Full phase/task context + project conventions only on the first chunk — repeating
    // it on every chunk would multiply its token cost for no benefit. Later chunks get a
    // short recap of findings so far instead, so the model doesn't re-flag duplicates.
    const contextBlock = idx === 0
      ? `## Phase Goals\n${phase.description || 'None provided.'}\n\n## Current Task\nTitle: ${task.title}\nDescription: ${task.description}\n\n${PROJECT_CONVENTIONS}`
      : `## Current Task\nTitle: ${task.title}\n(Full phase goals and task description were given with chunk 1.)\n\nFindings already recorded from earlier chunks of this same diff — do not repeat them, but do cross-reference (e.g. a fix in this chunk may resolve a requirement flagged missing earlier):\nMissing requirements so far: ${missingRequirements.join('; ') || 'none yet'}\nBlocking issues so far: ${blockingIssues.join('; ') || 'none yet'}`;

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
        console.warn(`Paid fallback model used for PR #${task.pr_number} chunk ${idx + 1}: ${reviewResult.provider}/${reviewResult.model}`);
      }
    } catch (reviewError) {
      console.error(`AI review failed for chunk ${idx + 1}:`, reviewError);
      approved = false;
      blockingIssues.push(`AI review chunk ${idx + 1} failed: ${reviewError.message}`);
      continue;
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
 */
export async function reviewAndMerge(task) {
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
          julesFix: `Retarget the PR to ${phase.phase_branch}`
        });
      });

      // Keep task status as pr_open
      await updateTaskStatus(task.id, 'pr_open');
      return { merged: false, blocked: true, reason: 'PR targets wrong branch' };
    }

    // 2b. Check for Git merge conflicts
    if (pr.mergeable === false) {
      console.log(`PR #${task.pr_number} has merge conflicts with target branch "${phase.phase_branch}". Requesting rebase from Jules.`);

      const rebaseInstruction = `Your PR has merge conflicts with target branch ${phase.phase_branch}. Please fetch the latest commits from ${phase.phase_branch}, resolve any merge conflicts, and push an updated commit.`;
      await logQA(
        task.id,
        `[PR Review Command] PR #${task.pr_number}`,
        `Blocked. Reason: PR has merge conflicts with "${phase.phase_branch}". Rebase instruction sent to Jules.`,
        'system',
        null
      );

      await sendReviewNotificationOnce(task, pr, 'merge-conflicts', async () => {
        try {
          await jules.sendMessage(task.jules_session_id, rebaseInstruction);
        } catch (sendErr) {
          console.warn('Failed to send rebase instruction to Jules:', sendErr.message);
        }
        await telegram.sendPRBlockedNotification({
          taskTitle: task.title,
          prUrl: pr.html_url || task.pr_url,
          riskLevel: 'high',
          blockingReason: `PR has Git merge conflicts with ${phase.phase_branch}`,
          julesFix: `Rebase instruction sent to Jules to fetch ${phase.phase_branch} and resolve conflicts`
        });
      });

      await updateTaskStatus(task.id, 'pr_open');
      return { merged: false, blocked: true, reason: 'PR has merge conflicts' };
    }

    // 3. Fetch changed files and diff
    const files = await github.getPRFiles(task.pr_number);
    const filenames = files.map(f => f.filename);

    let rawDiff = await github.getPRDiff(task.pr_number);
    if (rawDiff.length > MAX_PR_DIFF_CHARS) {
      console.warn(`PR diff length (${rawDiff.length}) exceeds MAX_PR_DIFF_CHARS (${MAX_PR_DIFF_CHARS}). Blocking and requesting human review.`);
      await updateTaskStatus(task.id, 'pr_open');
      await sendReviewNotificationOnce(task, pr, 'diff-too-large', async () => {
        await telegram.sendPRBlockedNotification({
          taskTitle: task.title,
          prUrl: task.pr_url || github.getPRWebUrl(task.pr_number),
          riskLevel: 'high',
          blockingReason: `PR diff size (${rawDiff.length} chars) exceeds the maximum allowed limit of ${MAX_PR_DIFF_CHARS} chars.`,
          julesFix: 'Manual human review and merge required'
        });
      });
      return { merged: false, approved: false, reason: 'PR diff size exceeds maximum allowed limit' };
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
      try {
        await updateTaskStatus(task.id, task.status, {
          last_reviewed_sha: headSha,
          last_review_verdict: JSON.stringify(aggregate)
        });
      } catch (cacheErr) {
        console.warn(`Failed to persist review verdict cache for task #${task.id}:`, cacheErr.message);
      }
    }

    let { approved, finalRiskLevel, summaries, missingRequirements, testEvidences, blockingIssues, followUpInstructions, advisoryNotes } = aggregate;

    // 5. Check for status checks and check runs (always fresh — CI can change independently of the diff)
    const checksStatus = await github.getPRChecks(task.pr_number);
    if (checksStatus === 'failing') {
      approved = false;
      blockingIssues = blockingIssues.concat('PR status checks or check runs are failing.');
    }

    // 6. Validate test evidence for code behavior changes
    const hasSourceChanges = filenames.some(f => f.endsWith('.js') || f.endsWith('.py') || f.includes('/src/'));
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
        approved = false;
        blockingIssues = blockingIssues.concat('Missing verifiable test evidence. You must either include test file modifications, or ensure Gemini test evidence is provided AND GitHub checks are passing.');
      }
    }

    // 7. Actions based on approval and safety policies
    const summaryText = summaries.join(' ');
    const blockingText = blockingIssues.concat(missingRequirements).join(', ');

    // Log the review action in qa_log
    await logQA(
      task.id,
      `[PR Review Command] PR #${task.pr_number}`,
      `Approved: ${approved}. Risk Level: ${finalRiskLevel}. Summary: ${summaryText}. Blockers: ${blockingText}. Advisory: ${advisoryNotes.join('; ') || 'none'}`,
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

        // Update task to merged status
        await updateTaskStatus(task.id, 'merged');

        // Send Telegram notification
        try {
          const readyTasks = await getQueuedReadyTasks(task.phase_id);
          const nextTitle = readyTasks[0]?.title;
          await telegram.sendTaskMergedNotification(task.title, task.id, pr.html_url || task.pr_url, phase.phase_branch, nextTitle);
        } catch (tgErr) {
          console.error('Failed to send Telegram task merged notification:', tgErr);
        }

        return { merged: true };
      } else {
        console.log(`PR #${task.pr_number} is approved but blocked from auto-merge. AutoMergeEnabled=${TASK_AUTO_MERGE_TO_PHASE_BRANCH}, BlockHighRisk=${BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH}, Risk=${finalRiskLevel}, Checks=${checksStatus}`);

        await sendReviewNotificationOnce(task, pr, `ready-${finalRiskLevel}-${checksStatus}`, async () => {
          await telegram.sendPRReadyNotification({
            taskTitle: task.title,
            prUrl: pr.html_url || task.pr_url
          });
        });

        // Keep task status as pr_open
        await updateTaskStatus(task.id, 'pr_open');
        return { merged: false, reason: 'Auto-merge policies prevented merge' };
      }
    } else {
      const revisionCount = task.pr_revision_count || 0;

      if (revisionCount < MAX_AUTO_REVISION_ATTEMPTS) {
        const nextRevisionCount = revisionCount + 1;
        console.log(`PR #${task.pr_number} rejected. Requesting revision from Jules (round ${nextRevisionCount}/${MAX_AUTO_REVISION_ATTEMPTS})...`);

        const revisionPrompt = `Please revise. The following issues were found:\n${blockingIssues.concat(missingRequirements).join('\n')}\n${followUpInstructions.join('\n')}`;
        const githubFeedback = `**Automated review — changes requested (round ${nextRevisionCount}/${MAX_AUTO_REVISION_ATTEMPTS})**

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
            julesFix: `Review blocking issues and update the PR (auto-revision round ${nextRevisionCount}/${MAX_AUTO_REVISION_ATTEMPTS})`
          });

          await updateTaskStatus(task.id, 'running', { pr_revision_count: nextRevisionCount });
        });

        return { merged: false, reason: blockingText };
      } else {
        console.log(`PR #${task.pr_number} has exhausted ${MAX_AUTO_REVISION_ATTEMPTS} auto-revision attempts. Escalating to human, not messaging Jules again.`);

        const escalationComment = `**Automated review limit reached (${MAX_AUTO_REVISION_ATTEMPTS}/${MAX_AUTO_REVISION_ATTEMPTS} revision rounds)** — issues remain and Jules will not be messaged again automatically for this PR. A human needs to take over.

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
            blockingReason: `🛑 Auto-review limit reached (${MAX_AUTO_REVISION_ATTEMPTS}/${MAX_AUTO_REVISION_ATTEMPTS}) — ${blockingText || 'issues remain'}`,
            julesFix: 'Please review and fix this manually — Jules will not be auto-messaged again for this PR.'
          });
        });

        await updateTaskStatus(task.id, 'pr_open');
        return { merged: false, reason: blockingText, escalated: true };
      }
    }
  } catch (error) {
    console.error(`Error reviewing/merging PR #${task.pr_number} for task #${task.id}:`, error);
    throw error;
  }
}
