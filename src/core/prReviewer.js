import * as github from '../services/github.js';
import * as ai from '../services/ai.js';
import * as jules from '../services/jules.js';
import * as telegram from '../services/telegram.js';
import { updateTaskStatus, logQA, getPhase, getQueuedReadyTasks } from '../db/queries.js';
import {
  TASK_AUTO_MERGE_TO_PHASE_BRANCH,
  NEVER_MERGE_TO_MAIN,
  MAX_PR_DIFF_CHARS,
  PR_REVIEW_CHUNK_CHARS,
  STRONG_REVIEW_PROVIDER,
  STRONG_REVIEW_MODEL,
  PRIMARY_SUPERVISOR_PROVIDER,
  PRIMARY_SUPERVISOR_MODEL,
  BACKUP_SUPERVISOR_PROVIDER,
  BACKUP_SUPERVISOR_MODEL
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

    // 2b. Check for Git merge conflicts
    if (pr.mergeable === false) {
      console.log(`PR #${task.pr_number} has merge conflicts with target branch "${phase.phase_branch}". Requesting rebase from Jules.`);
      
      const rebaseInstruction = `Your PR has merge conflicts with target branch ${phase.phase_branch}. Please fetch the latest commits from ${phase.phase_branch}, resolve any merge conflicts, and push an updated commit.`;
      try {
        await jules.sendMessage(task.jules_session_id, rebaseInstruction);
      } catch (sendErr) {
        console.warn('Failed to send rebase instruction to Jules:', sendErr.message);
      }
      
      await logQA(
        task.id,
        `[PR Review Command] PR #${task.pr_number}`,
        `Blocked. Reason: PR has merge conflicts with "${phase.phase_branch}". Rebase instruction sent to Jules.`,
        'system',
        null
      );

      await telegram.sendPRBlockedNotification({
        taskTitle: task.title,
        prUrl: pr.html_url || task.pr_url,
        riskLevel: 'high',
        blockingReason: `PR has Git merge conflicts with ${phase.phase_branch}`,
        julesFix: `Rebase instruction sent to Jules to fetch ${phase.phase_branch} and resolve conflicts`
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
      await telegram.sendPRBlockedNotification({
        taskTitle: task.title,
        prUrl: task.pr_url || `https://github.com/sandeepyeg/project-jupitor/pull/${task.pr_number}`,
        riskLevel: 'high',
        blockingReason: `PR diff size (${rawDiff.length} chars) exceeds the maximum allowed limit of ${MAX_PR_DIFF_CHARS} chars.`,
        julesFix: 'Manual human review and merge required'
      });
      return { merged: false, approved: false, reason: 'PR diff size exceeds maximum allowed limit' };
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
      let primarySucceeded = false;
      let primaryError = null;
      try {
        const responseText = await ai.askModel(provider, model, prompt, { returnJson: true, temperature: 0.1 });
        const clean = responseText.replace(/```json|```/g, '').trim();
        chunkResult = JSON.parse(clean);
        primarySucceeded = true;
      } catch (err) {
        primaryError = err;
        console.warn(`Primary AI review call or JSON parsing failed for chunk ${idx + 1}. Routing to backup supervisor model... Error: ${err.message}`);
      }

      if (!primarySucceeded) {
        try {
          const responseText = await ai.askModel(BACKUP_SUPERVISOR_PROVIDER, BACKUP_SUPERVISOR_MODEL, prompt, { returnJson: true, temperature: 0.1 });
          const clean = responseText.replace(/```json|```/g, '').trim();
          chunkResult = JSON.parse(clean);
        } catch (fallbackError) {
          console.error(`Fallback AI review call or JSON parsing also failed for chunk ${idx + 1}:`, fallbackError);
          approved = false;
          blockingIssues.push(`AI review chunk ${idx + 1} failed: Primary error: ${primaryError.message}. Fallback error: ${fallbackError.message}`);
          continue;
        }
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
        blockingIssues.push('Missing verifiable test evidence. You must either include test file modifications, or ensure Gemini test evidence is provided AND GitHub checks are passing.');
      }
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

    if (approved || TASK_AUTO_MERGE_TO_PHASE_BRANCH) {
      // Determine if we can auto-merge:
      // If targeting a phase branch (not main) and TASK_AUTO_MERGE_TO_PHASE_BRANCH is true
      const isTargetingPhaseBranch = baseBranch === phase.phase_branch && baseBranch !== 'main';
      const canAutoMerge = TASK_AUTO_MERGE_TO_PHASE_BRANCH && isTargetingPhaseBranch && checksStatus !== 'failing';

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
