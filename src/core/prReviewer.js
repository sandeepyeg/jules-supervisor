import * as github from '../services/github.js';
import * as ai from '../services/ai.js';
import * as jules from '../services/jules.js';
import { updateTaskStatus, logQA } from '../db/queries.js';

/**
 * Reviews a task's Pull Request and merges it if approved, otherwise requests revisions.
 */
export async function reviewAndMerge(task) {
  console.log(`Reviewing PR #${task.pr_number} for task #${task.id} ("${task.title}")`);

  try {
    // 1. Get PR diff
    const rawDiff = await github.getPRDiff(task.pr_number);
    
    // 2. Limit diff to first 4000 characters to keep context clean and save tokens
    const diff = rawDiff.substring(0, 4000);
    
    // 3. Build review prompt
    const prompt = `You are reviewing a code change. The task was:
${task.title}: ${task.description}

The PR diff is:
${diff}

Does this diff reasonably implement the task? Answer ONLY with JSON:
{ "approved": true, "reason": "one sentence explanation" }
OR
{ "approved": false, "reason": "one sentence explanation of why it fails" }`;

    // 4. Ask DeepSeek for JSON evaluation
    const responseText = await ai.askDeepSeek(prompt, true);
    const clean = responseText.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    
    console.log(`PR Review Result for Task #${task.id}: Approved=${result.approved}. Reason: ${result.reason}`);
    
    // Log the review action in qa_log
    await logQA(
      task.id,
      `[PR Review Command] PR #${task.pr_number}`,
      `Approved: ${result.approved}. Reason: ${result.reason}`,
      'system',
      null
    );

    // 6. Action based on approval status
    if (result.approved) {
      console.log(`Approving PR #${task.pr_number}...`);
      await github.approvePR(task.pr_number);
      
      console.log(`Merging PR #${task.pr_number}...`);
      await github.mergePR(task.pr_number, task.title);
      
      // Update task to merged status
      await updateTaskStatus(task.id, 'merged');
      return { merged: true };
    } else {
      console.log(`PR #${task.pr_number} rejected. Requesting revision from Jules...`);
      const revisionPrompt = `Please revise: ${result.reason}`;
      await jules.sendMessage(task.jules_session_id, revisionPrompt);
      
      // Update task status back to running
      await updateTaskStatus(task.id, 'running');
      return { merged: false, reason: result.reason };
    }
  } catch (error) {
    console.error(`Error reviewing/merging PR #${task.pr_number} for task #${task.id}:`, error);
    // Log error to console and keep the task in PR open state for the next poller check or manual intervention
    throw error;
  }
}
