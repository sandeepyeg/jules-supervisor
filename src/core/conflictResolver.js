import * as github from '../services/github.js';
import * as ai from '../services/ai.js';
import * as jules from '../services/jules.js';

let aiQuotaExceededUntil = 0;

/**
 * Smart AI Line-by-Line Conflict Resolver Engine
 * Automatically resolves merge conflicts between a PR branch and base phase branch
 * using AI logic synthesis to combine both code changes cleanly without closing PRs.
 */
export async function smartResolvePRMergeConflicts(prNumber, task, phaseBranch) {
  const now = Date.now();
  if (now < aiQuotaExceededUntil) {
    const remainingMins = Math.round((aiQuotaExceededUntil - now) / 60000);
    console.log(`[SmartConflictResolver] AI Conflict Resolver in quota cooldown for next ${remainingMins}m. Skipping AI resolution for PR #${prNumber}.`);
    return false;
  }

  try {
    console.log(`[SmartConflictResolver] Starting AI conflict resolution for PR #${prNumber}...`);
    
    // 1. Get PR details and changed files
    const pr = await github.getPR(prNumber);
    const headBranch = pr.head?.ref;
    if (!headBranch) {
      console.warn(`[SmartConflictResolver] Could not get head branch for PR #${prNumber}`);
      return false;
    }

    const files = await github.getPRFiles(prNumber);
    if (!files || files.length === 0) return false;

    // Filter files that are modified or have status 'modified' / 'renamed'
    const modifiedFiles = files.filter(f => f.status === 'modified' || f.status === 'renamed' || f.changes > 0);
    let resolvedCount = 0;

    for (const file of modifiedFiles) {
      const filePath = file.filename;
      
      // Fetch contents from both base phase branch and PR head branch
      const baseContent = await github.getFileContent(phaseBranch, filePath).catch(() => null);
      const headContent = await github.getFileContent(headBranch, filePath).catch(() => null);

      if (!baseContent || !headContent) continue;
      if (baseContent === headContent) continue; // Same content, no conflict

      console.log(`[SmartConflictResolver] AI Synthesizing clean merge for ${filePath} in PR #${prNumber}...`);

      const prompt = `You are an expert Git Merge & Code Integration Engine.
Task Objective: "${task.title}" (${task.description || ''})

File: ${filePath}

VERSION A (Base Phase Branch "${phaseBranch}"):
\`\`\`
${baseContent}
\`\`\`

VERSION B (Task PR Branch "${headBranch}"):
\`\`\`
${headContent}
\`\`\`

INSTRUCTIONS:
1. Merge both versions cleanly into a single valid source file.
2. PRESERVE all existing imports, methods, types, and logic from Version A.
3. INCLUDE all new feature logic, routes, and data models added in Version B for the task "${task.title}".
4. Remove any duplicate imports or syntax errors.
5. Return ONLY the raw resolved file contents. No explanation, no markdown backticks, no conflict markers (<<<<<<< or >>>>>>>).`;

      let resolvedCode = null;
      try {
        resolvedCode = await ai.askModel('openrouter', 'qwen/qwen3.7-flash', prompt, { temperature: 0.1 });
      } catch (openrouterErr) {
        console.warn(`[SmartConflictResolver] OpenRouter failed for ${filePath}: ${openrouterErr.message}. Trying Google Gemini...`);
        try {
          resolvedCode = await ai.askModel('google', 'gemini-3.1-flash-lite', prompt, { temperature: 0.1 });
        } catch (geminiErr) {
          console.warn(`[SmartConflictResolver] Google Gemini failed for ${filePath}: ${geminiErr.message}`);
          const combinedMsg = `${openrouterErr.message} ${geminiErr.message}`.toLowerCase();
          if (combinedMsg.includes('429') || combinedMsg.includes('quota') || combinedMsg.includes('resource_exhausted') || combinedMsg.includes('too many requests')) {
            aiQuotaExceededUntil = Date.now() + 10 * 60 * 1000; // 10 min circuit breaker
            console.warn(`[SmartConflictResolver] Quota exceeded on AI providers. Entering 10-minute circuit breaker.`);
            return false;
          }
        }
      }

      if (resolvedCode && resolvedCode.length > 10 && !resolvedCode.includes('<<<<<<<')) {
        // Commit the resolved file directly to headBranch via GitHub API
        const cleanedCode = resolvedCode.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
        await github.updateFileContent(
          headBranch,
          filePath,
          cleanedCode,
          `Supervisor: AI auto-resolve merge conflict with ${phaseBranch}`
        );
        resolvedCount++;
        console.log(`[SmartConflictResolver] Successfully committed AI resolved file ${filePath} to ${headBranch}`);
      }
    }

    if (resolvedCount > 0) {
      console.log(`[SmartConflictResolver] ${resolvedCount} conflicting file(s) AI resolved and committed. Waiting 4s for GitHub ref settlement...`);
      await new Promise(r => setTimeout(r, 4000));

      // Re-trigger update-branch with retry to finalize merge
      let isCleanNow = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          isCleanNow = await github.updatePRBranch(prNumber);
          if (isCleanNow) break;
        } catch (_) {}
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
      }

      if (isCleanNow) {
        console.log(`[SmartConflictResolver] PR #${prNumber} conflicts completely resolved and merged with base branch!`);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn(`[SmartConflictResolver] Error during smart conflict resolution for PR #${prNumber}:`, err.message);
    return false;
  }
}
