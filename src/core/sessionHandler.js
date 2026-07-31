import * as jules from '../services/jules.js';
import * as github from '../services/github.js';
import * as queries from '../db/queries.js';
import * as telegram from '../services/telegram.js';
import * as questionHandler from './questionHandler.js';
import * as prReviewer from './prReviewer.js';

const HANDLED_FEEDBACK_RETRY_MS = parseInt(process.env.HANDLED_FEEDBACK_RETRY_MS || '1800000', 10);
const FEEDBACK_RETRY_MARKER = '::feedback_retry::';

/**
 * Manages the state machine transitions of an active Jules session.
 */
export async function handleSession(task) {
  console.log(`Checking session ${task.jules_session_id} for task #${task.id} (Status: ${task.status})`);
  
  // 0. Self-Healing PR Reconciliation:
  // Step 0a: If we have a pr_number, check if it's already merged on GitHub
  if ((task.status === 'running' || task.status === 'pr_open') && task.pr_number) {
    try {
      const pr = await github.getPR(task.pr_number);
      if (pr?.merged === true) {
        console.log(`Self-Healing: PR #${task.pr_number} for task #${task.id} is MERGED on GitHub. Syncing DB status.`);
        await queries.updateTaskStatus(task.id, 'merged', {
          pr_url: pr.html_url || task.pr_url,
          pr_number: task.pr_number
        });
        const phase = await queries.getPhase(task.phase_id);
        const ready = await queries.getQueuedReadyTasks(task.phase_id);
        const nextTitle = ready[0]?.title;
        await telegram.sendTaskMergedNotification(task.title, task.id, pr.html_url || task.pr_url, phase ? phase.phase_branch : 'phase branch', nextTitle);
        return;
      }
      if (pr?.state === 'closed') {
        console.log(`Self-Healing: PR #${task.pr_number} for task #${task.id} is closed without merge. Marking task failed.`);
        await queries.updateTaskStatus(task.id, 'failed', {
          pr_url: pr.html_url || task.pr_url,
          pr_number: task.pr_number
        });
        await telegram.sendNotification(`Task failed: "${task.title}" PR #${task.pr_number} was closed without being merged.\n${pr.html_url || task.pr_url || ''}`);
        return;
      }
    } catch (reconcileErr) {
      console.warn(`PR self-healing (merge check) warning for task #${task.id}:`, reconcileErr.message);
    }
  }

  // Step 0b: GitHub-First PR Detection — even if Jules session is IN_PROGRESS,
  // check if Jules already opened a PR on GitHub that we haven't recorded yet.
  // This is the fix for the "PR exists but supervisor didn't notice" failure class.
  if (task.status === 'running' && !task.pr_number) {
    try {
      const phase0 = await queries.getPhase(task.phase_id);
      if (phase0) {
        const ghPR = await github.findOpenPRForTask(task.jules_session_id, phase0.phase_branch);
        if (ghPR) {
          console.log(`GitHub-First Detection: Found open PR #${ghPR.number} for task #${task.id} (session ${task.jules_session_id}). Routing to review/merge immediately.`);
          const prNumber0 = ghPR.number;
          const prUrl0 = ghPR.html_url;

          // Guard: block if targeting main
          if (ghPR.base?.ref === 'main' || ghPR.base?.ref === 'master') {
            console.error(`SAFETY BLOCK: PR #${prNumber0} targets main! Skipping auto-merge. Telegram alert sent.`);
            await telegram.sendNotification(`🚨 SAFETY BLOCK: PR #${prNumber0} for Task #${task.id} targets main! Human review required. DO NOT auto-merge.\n${prUrl0}`);
            return;
          }

          await queries.updateTaskStatus(task.id, 'pr_open', {
            pr_url: prUrl0,
            pr_number: prNumber0,
            // Fresh PR for this task — start its own revision/review-cache lifecycle.
            pr_revision_count: 0,
            last_reviewed_sha: null,
            last_review_verdict: null,
            escalated: false
          });
          try {
            await telegram.sendPRCreatedNotification(task.title, task.id, prUrl0);
          } catch (_) {}
          const updatedTask0 = await queries.getTask(task.id);
          await prReviewer.reviewAndMerge(updatedTask0);
          return;
        }
      }
    } catch (ghDetectErr) {
      console.warn(`GitHub-First PR detection warning for task #${task.id}:`, ghDetectErr.message);
    }
  }

  // 1. Get current session details from Jules API
  const session = await jules.getSession(task.jules_session_id);
  const state = session.state;
  console.log(`Jules Session state for task #${task.id}: ${state}`);

  // 2. Transition state machine based on session state
  switch (state) {
    case 'AWAITING_PLAN_APPROVAL': {
      console.log(`Approving plan for session ${task.jules_session_id}...`);
      await jules.approvePlan(task.jules_session_id);
      break;
    }
    
    case 'AWAITING_USER_FEEDBACK': {
      // If we've already escalated and are waiting for the Telegram reply, skip
      if (task.status === 'waiting_answer') {
        console.log(`Task #${task.id} is already waiting for user answer. Skipping session handler.`);
        return;
      }
      
      const agentMsg = await jules.getLatestAgentMessage(task.jules_session_id);
      if (!agentMsg) {
        console.log(`Session awaiting user feedback but no agent message retrieved yet.`);
        return;
      }
      
      const lastActivityId = String(task.last_activity_id || '');
      const retryPrefix = `${agentMsg.activityId}${FEEDBACK_RETRY_MARKER}`;
      const alreadyHandled = lastActivityId === agentMsg.activityId || lastActivityId.startsWith(retryPrefix);

      // If Jules is still waiting on an already-handled activity, retry after a grace period.
      if (alreadyHandled) {
        const elapsedMs = Date.now() - new Date(task.updated_at || task.created_at).getTime();
        if (task.status === 'running' && elapsedMs >= HANDLED_FEEDBACK_RETRY_MS) {
          console.log(`Agent question activity ${agentMsg.activityId} is still awaiting feedback after ${Math.floor(elapsedMs / 60000)} minutes. Re-sending proceed instruction.`);
          await jules.sendMessage(
            task.jules_session_id,
            'Proceed with the implementation based on the previous supervisor answer. Keep the PR targeted to the phase branch and continue without waiting for additional confirmation.'
          );
          await queries.updateTaskStatus(task.id, 'running', {
            last_activity_id: `${retryPrefix}${Date.now()}`
          });
          return;
        }

        console.log(`Agent question activity ${agentMsg.activityId} has already been handled.`);
        return;
      }
      
      console.log(`New question from Jules: "${agentMsg.text}"`);
      await questionHandler.handleQuestion(task, agentMsg.text, agentMsg.activityId);
      break;
    }
    
    case 'COMPLETED': {
      console.log(`Jules session ${task.jules_session_id} completed successfully.`);
      
      // Extract PR URL from all possible Jules API payload structures
      let prUrl = session.output?.prUrl;
      if (!prUrl) {
        try {
          const activities = await jules.listActivities(task.jules_session_id);
          for (const act of activities) {
            if (act.publishPullRequest?.pullRequest?.url) {
              prUrl = act.publishPullRequest.pullRequest.url;
              break;
            }
            if (act.pullRequestCreated?.prUrl) {
              prUrl = act.pullRequestCreated.prUrl;
              break;
            }
            if (act.createPullRequest?.prUrl) {
              prUrl = act.createPullRequest.prUrl;
              break;
            }
            if (act.pullRequest?.url) {
              prUrl = act.pullRequest.url;
              break;
            }
            const actStr = JSON.stringify(act);
            const match = actStr.match(/https:\/\/github\.com\/[^\s"']+\/pull\/\d+/);
            if (match) {
              prUrl = match[0];
              break;
            }
          }
        } catch (actErr) {
          console.warn(`Failed to fetch activities for session ${task.jules_session_id}:`, actErr.message);
        }
      }
      
      // Fallback: check GitHub API directly for open or merged PRs
      const phase = await queries.getPhase(task.phase_id);
      if (!prUrl && phase) {
        try {
          const repoPrs = await github.listBranches(); // ping
          const openPrs = await github.getPRsForBranch ? await github.getPRsForBranch(phase.phase_branch) : [];
          if (openPrs && openPrs.length > 0) {
            prUrl = openPrs[0].html_url;
          }
        } catch (ghErr) {
          console.warn('GitHub PR fallback check error:', ghErr.message);
        }
      }

      if (!prUrl) {
        console.warn(`Jules session ${task.jules_session_id} completed but no PR URL found yet.`);
        return;
      }
      
      const prNumber = github.getPRNumber(prUrl);
      if (!prNumber) {
        throw new Error(`Failed to parse PR number from URL: ${prUrl}`);
      }

      console.log(`Pull Request URL: ${prUrl} (PR #${prNumber})`);

      // Check if PR is ALREADY merged on GitHub (e.g., manual merge by user)
      try {
        const prState = await github.getPR(prNumber);
        if (prState?.merged === true) {
          console.log(`PR #${prNumber} for task #${task.id} is already MERGED on GitHub. Marking task merged.`);
          await queries.updateTaskStatus(task.id, 'merged', {
            pr_url: prUrl,
            pr_number: prNumber
          });
          
          try {
            const ready = await queries.getQueuedReadyTasks(task.phase_id);
            const nextTitle = ready[0]?.title;
            await telegram.sendTaskMergedNotification(task.title, task.id, prUrl, phase ? phase.phase_branch : 'phase branch', nextTitle);
          } catch (tgErr) {
            console.error('Telegram notification error:', tgErr);
          }
          return;
        }
        if (prState?.state === 'closed') {
          console.log(`PR #${prNumber} for task #${task.id} is closed without merge. Marking task failed.`);
          await queries.updateTaskStatus(task.id, 'failed', {
            pr_url: prUrl,
            pr_number: prNumber
          });
          await telegram.sendNotification(`Task failed: "${task.title}" PR #${prNumber} was closed without being merged.\n${prUrl}`);
          return;
        }
      } catch (prCheckErr) {
        console.warn(`Could not check PR #${prNumber} state from GitHub:`, prCheckErr.message);
      }
      
      // Only treat this as "a PR was just discovered" once — Jules' session state stays
      // COMPLETED indefinitely while the PR sits open, so without this guard this block
      // (and the Telegram notification) would otherwise re-fire on every single poll cycle.
      const isNewlyDiscoveredPr = task.pr_number !== prNumber || task.status !== 'pr_open';
      if (isNewlyDiscoveredPr) {
        const isDifferentPrNumber = task.pr_number !== prNumber;
        await queries.updateTaskStatus(task.id, 'pr_open', {
          pr_url: prUrl,
          pr_number: prNumber,
          // A genuinely different PR number starts its own revision/review-cache lifecycle
          // — otherwise a counter exhausted on an earlier, abandoned PR would carry over.
          ...(isDifferentPrNumber ? { pr_revision_count: 0, last_reviewed_sha: null, last_review_verdict: null, escalated: false } : {})
        });

        // Send Telegram PR created alert
        try {
          await telegram.sendPRCreatedNotification(task.title, task.id, prUrl);
        } catch (tgErr) {
          console.error('Failed to send Telegram PR notification:', tgErr);
        }
      }

      // Fetch updated task from DB to pass to reviewer
      const updatedTask = await queries.getTask(task.id);

      // Trigger review and merge (cheap on repeat polls thanks to prReviewer's sha cache)
      await prReviewer.reviewAndMerge(updatedTask);
      // Auto-update base branch for all open PRs in phase to prevent merge conflicts
      try {
        if (phase) {
          const openPrs = await github.getPRsForBranch ? await github.getPRsForBranch(phase.phase_branch) : [];
          for (const openPr of (openPrs || [])) {
            if (openPr.number !== prNumber && openPr.state === 'open') {
              console.log(`Auto-updating base branch for open PR #${openPr.number}...`);
              await github.updatePRBranch(openPr.number);
            }
          }
        }
      } catch (autoSyncErr) {
        console.warn('Auto branch sync warning:', autoSyncErr.message);
      }

      break;
    }
    
    case 'FAILED': {
      console.log(`Jules session ${task.jules_session_id} failed.`);
      
      const maxRetries = 2;
      if (task.retry_count < maxRetries) {
        const nextAttempt = task.retry_count + 1;
        console.log(`Retrying task #${task.id} (Attempt ${nextAttempt}/${maxRetries}). Initializing a new Jules session.`);
        
        const phase = await queries.getPhase(task.phase_id);
        const phaseBranch = phase ? phase.phase_branch : 'main';
        
        const prompt = `${task.description}

Target branch: ${phaseBranch}
Open your pull request against ${phaseBranch}.
Do not open your PR against main.
Do not merge into main.
Keep the change limited to this task.
Add or update tests when behavior changes.

Note: The previous attempt failed. Please try a different approach.`;

        // Launch a new session
        const { sessionId } = await jules.createSession(prompt, phaseBranch, task.jules_notes);
        
        // Update task database record
        await queries.updateTaskStatus(task.id, 'running', {
          retry_count: nextAttempt,
          jules_session_id: sessionId
        });
        
        try {
          await telegram.sendNotification(`⚠️ Task #${task.id} ("${task.title}") session failed. Auto-retrying (Attempt ${nextAttempt}/${maxRetries})...`);
        } catch (tgErr) {
          console.error('Failed to send Telegram retry alert:', tgErr);
        }

        console.log(`Task #${task.id} retried. New Session ID: ${sessionId}`);
      } else {
        console.log(`Task #${task.id} failed after ${maxRetries} retries.`);
        await queries.updateTaskStatus(task.id, 'failed');
        await telegram.sendNotification(`❌ Task failed after ${maxRetries} retries: "${task.title}"`);
      }
      break;
    }
    
    case 'IN_PROGRESS':
    default: {
      console.log(`Session ${task.jules_session_id} is in progress (State: ${state}).`);

      // GitHub-First PR scan also runs for IN_PROGRESS Jules state (redundancy guard)
      // Already handled in step 0b above before Jules API call — no duplicate needed here.

      const elapsedMs = Date.now() - new Date(task.updated_at || task.created_at).getTime();
      const elapsedMins = Math.floor(elapsedMs / 60000);
      
      // 1. Nudge Jules if in progress for > 20 mins
      if (elapsedMins >= 20 && elapsedMins < 45 && !task.nudge_sent) {
        console.log(`Task #${task.id} has been in progress for ${elapsedMins} mins. Sending finish nudge to Jules...`);
        try {
          await jules.sendMessage(task.jules_session_id, "Please complete your implementation, run your checks, commit your changes, and open the Pull Request against the target branch now.");
          await queries.updateTaskStatus(task.id, task.status, { nudge_sent: true });
        } catch (nudgeErr) {
          console.warn(`Failed to send nudge for session ${task.jules_session_id}:`, nudgeErr.message);
        }
      }
      
      // 2. Auto-retry fresh session if stalled for > 45 mins
      if (elapsedMins >= 45 && task.retry_count < 2) {
        const nextAttempt = task.retry_count + 1;
        console.log(`Task #${task.id} stalled for ${elapsedMins} mins. Initializing fresh Jules session (Attempt ${nextAttempt}/2)...`);
        
        const phase = await queries.getPhase(task.phase_id);
        const phaseBranch = phase ? phase.phase_branch : 'main';
        const prompt = `${task.description}

Target branch: ${phaseBranch}
Open your pull request against ${phaseBranch}.
Do not open your PR against main.
Do not merge into main.
Keep the change limited to this task.
Add or update tests when behavior changes.

⚡ DIRECT EXECUTION INSTRUCTION:
Proceed directly to implementation and code execution. Implement the changes, write unit tests, commit, push, and open the Pull Request against ${phaseBranch} immediately.`;

        const { sessionId } = await jules.createSession(prompt, phaseBranch, task.jules_notes);
        await queries.updateTaskStatus(task.id, 'running', {
          retry_count: nextAttempt,
          jules_session_id: sessionId,
          updated_at: new Date()
        });
        
        try {
          await telegram.sendNotification(`🔄 Task #${task.id} ("${task.title}") stalled for ${elapsedMins}m. Restarting fresh session (Attempt ${nextAttempt}/2)...`);
        } catch (tgErr) {}
      }
      break;
    }
  }
}
