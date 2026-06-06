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
      
      // Extract PR URL
      let prUrl = session.output?.prUrl;
      if (!prUrl) {
        // Fallback: check activities for a PR URL or creation
        const activities = await jules.listActivities(task.jules_session_id);
        const prActivity = activities.find(
          act => act.originator === 'agent' && act.pullRequestCreated && act.pullRequestCreated.prUrl
        );
        if (prActivity) {
          prUrl = prActivity.pullRequestCreated.prUrl;
        }
      }
      
      if (!prUrl) {
        throw new Error(`Jules session completed but no Pull Request URL was found.`);
      }
      
      const prNumber = github.getPRNumber(prUrl);
      if (!prNumber) {
        throw new Error(`Failed to parse PR number from URL: ${prUrl}`);
      }

      console.log(`Pull Request URL: ${prUrl} (PR #${prNumber})`);
      
      // Update task in DB
      await queries.updateTaskStatus(task.id, 'pr_open', {
        pr_url: prUrl,
        pr_number: prNumber
      });
      
      // Fetch updated task from DB to pass to reviewer (contains new pr_url and pr_number)
      const updatedTask = await queries.getTask(task.id);
      
      // Trigger review and merge
      await prReviewer.reviewAndMerge(updatedTask);
      break;
    }
    
    case 'FAILED': {
      console.log(`Jules session ${task.jules_session_id} failed.`);
      
      if (task.retry_count < 1) {
        console.log(`Retrying task #${task.id}. Initializing a new Jules session.`);
        
        const phase = await queries.getPhase(task.phase_id);
        const phaseBranch = phase.phase_branch;
        
        const prompt = `${task.description}\n\nTarget branch: ${phaseBranch}\n\nNote: The previous attempt failed. Please try a different approach.`;
        
        // Launch a new session
        const { sessionId } = await jules.createSession(prompt, phaseBranch, task.jules_notes);
        
        // Update task database record
        await queries.updateTaskStatus(task.id, 'running', {
          retry_count: task.retry_count + 1,
          jules_session_id: sessionId
        });
        
        console.log(`Task #${task.id} retried. New Session ID: ${sessionId}`);
      } else {
        console.log(`Task #${task.id} failed after maximum retries.`);
        await queries.updateTaskStatus(task.id, 'failed');
        await telegram.sendNotification(`Task failed after retry limit: "${task.title}"`);
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
