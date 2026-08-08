import '../src/core/env.js';
process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { pool, resetInMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import * as prReviewer from '../src/core/prReviewer.js';
import { reloadConfig } from '../src/core/config.js';

test('Duplicate PR Cleanup Suite', async (t) => {
  resetInMemoryDb();
  let phaseId = null;
  let taskId = null;
  const closedPRs = [];

  // Mock globalFetch for GitHub calls
  globalThis.__mockFetch = async (url, options = {}) => {
    const checkUrl = url.toLowerCase();

    if (checkUrl.includes('/pulls?state=open')) {
      return {
        ok: true,
        json: async () => [
          {
            number: 101,
            title: 'Create shared components',
            head: { ref: 'feature/phase-1-session_1234567890' },
            base: { ref: 'feature/phase-1' }
          },
          {
            number: 102,
            title: 'Create shared components',
            head: { ref: 'feature/phase-1-session_1234567890-retry' },
            base: { ref: 'feature/phase-1' }
          }
        ],
        text: async () => ''
      };
    }

    if (checkUrl.includes('/pulls/101') && (options.method === 'PATCH' || options.method === 'POST')) {
      closedPRs.push(101);
      return { ok: true, json: async () => ({ state: 'closed' }), text: async () => '' };
    }

    if (checkUrl.includes('/pulls/102/merge') && options.method === 'PUT') {
      return { ok: true, json: async () => ({ merged: true }), text: async () => '' };
    }

    if (checkUrl.includes('/pulls/102/files')) {
      return { ok: true, json: async () => [{ filename: 'src/index.js' }], text: async () => '' };
    }

    if (checkUrl.includes('/pulls/102') && options.headers?.Accept === 'application/vnd.github.v3.diff') {
      return { ok: true, text: async () => 'diff --git a/src/index.js b/src/index.js\n+console.log("hello");', json: async () => ({}) };
    }

    if (checkUrl.includes('/pulls/102') && options.method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          number: 102,
          title: 'Create shared components',
          html_url: 'https://github.com/owner/repo/pull/102',
          base: { ref: 'feature/phase-1' },
          head: { sha: 'head-sha-102', ref: 'feature/phase-1-session_1234567890-retry' },
          state: 'open',
          mergeable: true
        }),
        text: async () => 'diff content'
      };
    }

    if (checkUrl.includes('generativelanguage.googleapis.com') || checkUrl.includes('openrouter.ai')) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  approved: true,
                  riskLevel: 'low',
                  summary: 'Clean implementation',
                  missingRequirements: [],
                  filesReviewed: ['src/index.js'],
                  testEvidence: 'Tests passing in unit test',
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
    'INSERT INTO phases (title, description, phase_branch, status) VALUES (?, ?, ?, ?)',
    ['Test Phase', 'Phase description', 'feature/phase-1', 'active']
  );
  phaseId = phaseRes.insertId;

  const [taskRes] = await pool.query(
    'INSERT INTO tasks (phase_id, title, description, mode, status, sort_order, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [phaseId, 'Create shared components', 'Task description', 'ai_assisted', 'pr_open', 1, null]
  );
  taskId = taskRes.insertId;

  await queries.updateTaskStatus(taskId, 'pr_open', {
    pr_number: 102,
    pr_url: 'https://github.com/owner/repo/pull/102',
    jules_session_id: 'session_1234567890'
  });

  process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
  process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
  reloadConfig();

  await t.test('merging PR #102 automatically closes older duplicate open PR #101 for same task', async () => {
    const task = await queries.getTask(taskId);
    const res = await prReviewer.reviewAndMerge(task);

    assert.strictEqual(res.merged, true);
    assert.ok(closedPRs.includes(102) === false, 'Merged PR #102 should stay merged, not closed');
    assert.ok(closedPRs.includes(101), 'Older duplicate PR #101 should be automatically closed');
  });
});
