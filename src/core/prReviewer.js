import * as github from '../services/github.js';
import * as ai from '../services/ai.js';
import * as jules from '../services/jules.js';
import * as telegram from '../services/telegram.js';
import { updateTaskStatus, logQA, getPhase } from '../db/queries.js';
import {
  TASK_AUTO_MERGE_TO_PHASE_BRANCH,
  NEVER_MERGE_TO_MAIN,
  MAX_PR_DIFF_CHARS,
  PR_REVIEW_CHUNK_CHARS,
  STRONG_REVIEW_PROVIDER,
  STRONG_REVIEW_MODEL,
  PRIMARY_SUPERVISOR_PROVIDER,
  PRIMARY_SUPERVISOR_MODEL
} from './config.js';

/**
 * Detects high-risk files or patterns in changed files and diff content.
 */
export function detectRisk(filenames, diff) {
  const highRiskPatterns = [
    /auth/i, /security/i, /login/i, /migration/i, /schema/i, /\.sql$/i,
    /\.env/i, /config/i, /secrets?/i, /github/i, /jules/i, /telegram/i,
    /api/i, /wrapper/i, /merge/i, /jupiter/i, /form/i, /generation/i,
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
      
      // Send Jules correction
      await jules.sendMessage(task.jules_session_id, correction);
      
      // Update QA log
      await logQA(
        task.id,
        `[PR Review Command] PR #${task.pr_number}`,
        `Blocked. Reason: PR targets base branch "${baseBranch}" instead of "${phase.phase_branch}". Correction sent to Jules.`,
        'system',
        null
      );
      
      // Send Telegram notification
      await telegram.sendPRBlockedNotification({
        taskTitle: task.title,
        prUrl: pr.html_url || task.pr_url,
        riskLevel: 'low',
        blockingReason: `PR targets base branch "${baseBranch}" instead of "${phase.phase_branch}"`,
        julesFix: `Retarget the PR to ${phase.phase_branch}`
      });

      // Keep task status as pr_open
      await updateTaskStatus(task.id, 'pr_open');
      return { merged: false, blocked: true, reason: 'PR targets wrong branch' };
    }

    // 3. Fetch changed files and diff
    const files = await github.getPRFiles(task.pr_number);
    const filenames = files.map(f => f.filename);

    let rawDiff = await github.getPRDiff(task.pr_number);
    if (rawDiff.length > MAX_PR_DIFF_CHARS) {
      console.warn(`PR diff length (${rawDiff.length}) exceeds MAX_PR_DIFF_CHARS (${MAX_PR_DIFF_CHARS}). Truncating.`);
      rawDiff = rawDiff.substring(0, MAX_PR_DIFF_CHARS);
    }

    // 4. Detect Risk
    let finalRiskLevel = detectRisk(filenames, rawDiff);
    console.log(`Risk classification for PR #${task.pr_number}: ${finalRiskLevel}`);

    // 5. Select Model based on Risk
    const provider = finalRiskLevel === 'high' ? STRONG_REVIEW_PROVIDER : PRIMARY_SUPERVISOR_PROVIDER;
    const model = finalRiskLevel === 'high' ? STRONG_REVIEW_MODEL : PRIMARY_SUPERVISOR_MODEL;

    // 6. Split diff into chunks for review
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
    const filesReviewed = new Set();
    const testEvidences = [];
    const blockingIssues = [];
    const followUpInstructions = [];

    // Review each chunk
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      const prompt = `You are reviewing a code change. The task was:
Task Title: ${task.title}
Task Description: ${task.description}

PR Changed Files: ${JSON.stringify(filenames)}
PR Diff Chunk (${idx + 1} of ${chunks.length}):
${chunk}

Check this diff chunk against the task requirements. The response must be strict JSON matching this exact format:
{
  "approved": true,
  "riskLevel": "low",
  "summary": "Short explanation",
  "missingRequirements": [],
  "filesReviewed": [],
  "testEvidence": "Tests found or not found",
  "blockingIssues": [],
  "followUpInstructions": ""
}`;

      let chunkResult;
      try {
        const responseText = await ai.askModel(provider, model, prompt, { returnJson: true, temperature: 0.1 });
        const clean = responseText.replace(/```json|```/g, '').trim();
        chunkResult = JSON.parse(clean);
      } catch (parseError) {
        console.error(`Failed to parse AI review response chunk ${idx + 1}:`, parseError);
        approved = false;
        blockingIssues.push(`Failed to parse AI review JSON response for chunk ${idx + 1}: ${parseError.message}`);
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
        chunkResult.filesReviewed.forEach(f => filesReviewed.add(f));
      }
      if (chunkResult.testEvidence) {
        testEvidences.push(chunkResult.testEvidence);
      }
      if (Array.isArray(chunkResult.blockingIssues)) {
        blockingIssues.push(...chunkResult.blockingIssues);
      }
      if (chunkResult.followUpInstructions) {
        followUpInstructions.push(chunkResult.followUpInstructions);
      }
    }

    // 7. Check for status checks and check runs
    const checksStatus = await github.getPRChecks(task.pr_number);
    if (checksStatus === 'failing') {
      approved = false;
      blockingIssues.push('PR status checks or check runs are failing.');
    }

    // 8. Validate test evidence for code behavior changes
    const hasSourceChanges = filenames.some(f => f.endsWith('.js') || f.endsWith('.py') || f.includes('/src/'));
    const testEvidenceText = testEvidences.join('; ').toLowerCase();
    const hasTestEvidence = testEvidenceText.includes('test') && 
                            !testEvidenceText.includes('no test') && 
                            !testEvidenceText.includes('missing') && 
                            !testEvidenceText.includes('unknown');

    if (hasSourceChanges && !hasTestEvidence) {
      approved = false;
      blockingIssues.push('Missing or unknown test evidence for code behavior changes.');
    }

    // Accumulate all blockers
    if (missingRequirements.length > 0) {
      approved = false;
    }
    if (blockingIssues.length > 0) {
      approved = false;
    }

    // 9. Actions based on approval and safety policies
    const summaryText = summaries.join(' ');
    const blockingText = blockingIssues.concat(missingRequirements).join(', ');

    // Log the review action in qa_log
    await logQA(
      task.id,
      `[PR Review Command] PR #${task.pr_number}`,
      `Approved: ${approved}. Risk Level: ${finalRiskLevel}. Summary: ${summaryText}. Blockers: ${blockingText}`,
      'system',
      null
    );

    if (approved) {
      // Determine if we can auto-merge:
      // - TASK_AUTO_MERGE_TO_PHASE_BRANCH must be true
      // - finalRiskLevel must not be 'high'
      // - checksStatus must not be 'unknown' (unless explicitly configured to allow, but we default block)
      const canAutoMerge = TASK_AUTO_MERGE_TO_PHASE_BRANCH && 
                           finalRiskLevel !== 'high' && 
                           checksStatus === 'passing';

      if (canAutoMerge) {
        console.log(`Approving PR #${task.pr_number}...`);
        await github.approvePR(task.pr_number);
        
        console.log(`Merging PR #${task.pr_number}...`);
        await github.mergePR(task.pr_number, task.title);
        
        // Update task to merged status
        await updateTaskStatus(task.id, 'merged');
        return { merged: true };
      } else {
        console.log(`PR #${task.pr_number} is approved but blocked from auto-merge. AutoMergeEnabled=${TASK_AUTO_MERGE_TO_PHASE_BRANCH}, Risk=${finalRiskLevel}, Checks=${checksStatus}`);
        
        // Notify Telegram that the PR is ready for human review
        await telegram.sendPRReadyNotification({
          taskTitle: task.title,
          prUrl: pr.html_url || task.pr_url
        });

        // Keep task status as pr_open
        await updateTaskStatus(task.id, 'pr_open');
        return { merged: false, reason: 'Auto-merge policies prevented merge' };
      }
    } else {
      console.log(`PR #${task.pr_number} rejected. Requesting revision from Jules...`);
      const revisionPrompt = `Please revise. The following issues were found:\n${blockingIssues.concat(missingRequirements).join('\n')}\n${followUpInstructions.join('\n')}`;
      
      await jules.sendMessage(task.jules_session_id, revisionPrompt);
      
      // Send Telegram notification
      await telegram.sendPRBlockedNotification({
        taskTitle: task.title,
        prUrl: pr.html_url || task.pr_url,
        riskLevel: finalRiskLevel,
        blockingReason: blockingText || 'Failing verification requirements',
        julesFix: 'Review blocking issues and update the PR'
      });

      // Update task status back to running
      await updateTaskStatus(task.id, 'running');
      return { merged: false, reason: blockingText };
    }
  } catch (error) {
    console.error(`Error reviewing/merging PR #${task.pr_number} for task #${task.id}:`, error);
    throw error;
  }
}
