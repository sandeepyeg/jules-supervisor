import '../src/core/env.js';
process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { pool, resetInMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import * as prReviewer from '../src/core/prReviewer.js';
import * as poller from '../src/core/poller.js';
import { reloadConfig } from '../src/core/config.js';

test('Smart PR Reviewer Overhaul Suite', async (t) => {
  resetInMemoryDb();
  let phaseId = null;
  let taskId = null;
  let createdPhasePR = false;
  let aiPromptsSeen = [];

  // Mock globalFetch for GitHub and AI calls
  globalThis.__mockFetch = async (url, options = {}) => {
    const checkUrl = url.toLowerCase();

    if (options.method === 'POST' && checkUrl.includes('/pulls')) {
      createdPhasePR = true;
      return { ok: true, json: async () => ({ number: 999, html_url: 'https://github.com/owner/repo/pull/999' }), text: async () => '' };
    }

    if (checkUrl.includes('/pulls?state=open')) {
      return { ok: true, json: async () => [], text: async () => '' };
    }

    if (checkUrl.includes('/pulls/901/files')) {
      return { ok: true, json: async () => [{ filename: 'src/index.js' }], text: async () => '' };
    }

    if (checkUrl.includes('/pulls/901') && options.headers?.Accept === 'application/vnd.github.v3.diff') {
      return { ok: true, text: async () => 'diff --git a/src/index.js b/src/index.js\n+console.log("updated");', json: async () => ({}) };
    }

    if (checkUrl.includes('/pulls/901') && options.method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          number: 901,
          title: 'Add User Service',
          html_url: 'https://github.com/owner/repo/pull/901',
          base: { ref: 'feature/overhaul-phase' },
          head: { sha: 'sha-round-2', ref: 'feature/user-service-branch' },
          state: 'open',
          mergeable: true
        }),
        text: async () => ''
      };
    }

    if (checkUrl.includes('generativelanguage.googleapis.com') || checkUrl.includes('openrouter.ai')) {
      const body = JSON.parse(options.body || '{}');
      const promptText = JSON.stringify(body);
      aiPromptsSeen.push(promptText);

      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  approved: true,
                  riskLevel: 'low',
                  summary: 'Revised implementation addresses previous feedback completely.',
                  missingRequirements: [],
                  filesReviewed: ['src/index.js'],
                  testEvidence: 'Tests passing',
                  blockingIssues: [],
                  advisoryNotes: [],
                  followUpInstructions: ''
                })
              }]
            }
          }]
        }),
        text: async () => ''
      };
    }

    return { ok: true, json: async () => ([]), text: async () => '' };
  };

  // Setup test phase & task
  const [phaseRes] = await pool.query(
    'INSERT INTO phases (title, description, phase_branch, main_branch, status) VALUES (?, ?, ?, ?, ?)',
    ['Overhaul Test Phase', 'Build User Service feature', 'feature/overhaul-phase', 'develop', 'active']
  );
  phaseId = phaseRes.insertId;

  const [taskRes] = await pool.query(
    'INSERT INTO tasks (phase_id, title, description, mode, status, sort_order, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [phaseId, 'Add User Service', 'Implement user creation and authentication endpoints', 'ai_assisted', 'pr_open', 1, null]
  );
  taskId = taskRes.insertId;

  await queries.updateTaskStatus(taskId, 'pr_open', {
    pr_number: 901,
    pr_url: 'https://github.com/owner/repo/pull/901',
    jules_session_id: 'session_overhaul_123',
    pr_revision_count: 1,
    last_review_feedback: 'Missing password validation logic in User Service'
  });

  process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
  process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
  process.env.CREATE_FINAL_DRAFT_PR = 'true';
  reloadConfig();

  await t.test('Round 2 review includes previous revision feedback in AI prompt and auto-merges resolved PR', async () => {
    const task = await queries.getTask(taskId);
    const res = await prReviewer.reviewAndMerge(task);

    assert.strictEqual(res.merged, true);
    assert.ok(aiPromptsSeen.length > 0);
    assert.ok(aiPromptsSeen[0].includes('Missing password validation logic in User Service'));
    assert.ok(aiPromptsSeen[0].includes('REVISION HISTORY'));

    const updatedTask = await queries.getTask(taskId);
    assert.strictEqual(updatedTask.status, 'merged');
  });

  await t.test('Phase completion creates Phase PR into main_branch (develop)', async () => {
    const res = await poller.runPollCycle(phaseId);
    assert.strictEqual(res.completed, true);
    assert.strictEqual(createdPhasePR, true);
  });
});
