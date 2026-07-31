import * as jules from '../services/jules.js';
import * as github from '../services/github.js';
import * as queries from '../db/queries.js';
import * as telegram from '../services/telegram.js';
import * as questionHandler from './questionHandler.js';
import * as prReviewer from './prReviewer.js';

/**
 * Manages the state machine transitions of an active Jules session.
 */
export async function handleSession(task) {
  console.log(`Checking session ${task.jules_session_id} for task #${task.id} (Status: ${task.status})`);
  
  // 0. Self-Healing PR Reconciliation: Check if PR exists and is merged on GitHub
  if (task.status === 'running' || task.status === 'pr_open') {
    try {
      if (task.pr_number) {
        const pr = await github.getPR(task.pr_number);
        if (pr && (pr.merged || pr.state === 'closed')) {
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
      }
    } catch (reconcileErr) {
      console.warn(`PR self-healing check warning for task #${task.id}:`, reconcileErr.message);
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
      
      // If this is the same activity we already processed, do nothing
      if (agentMsg.activityId === task.last_activity_id) {
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
        if (prState && (prState.merged || prState.state === 'closed')) {
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
      } catch (prCheckErr) {
        console.warn(`Could not check PR #${prNumber} state from GitHub:`, prCheckErr.message);
      }
      
      // Update task in DB
      await queries.updateTaskStatus(task.id, 'pr_open', {
        pr_url: prUrl,
        pr_number: prNumber
      });
      
      // Send Telegram PR created alert
      try {
        await telegram.sendPRCreatedNotification(task.title, task.id, prUrl);
      } catch (tgErr) {
        console.error('Failed to send Telegram PR notification:', tgErr);
      }

      // Fetch updated task from DB to pass to reviewer
      const updatedTask = await queries.getTask(task.id);
      
      // Trigger review and merge
      await prReviewer.reviewAndMerge(updatedTask);
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
      console.log(`Session ${task.jules_session_id} is in progress. Waiting for next poll.`);
      break;
    }
  }
}
