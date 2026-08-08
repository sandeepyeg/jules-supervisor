import '../src/core/env.js';
process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { pool, resetInMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import * as prReviewer from '../src/core/prReviewer.js';
import { bot } from '../src/services/telegram.js';

test('Conflict Handling and Task Rework Suite', async (t) => {
  resetInMemoryDb();
  let phaseId = null;
  let taskId = null;
  let mockUpdateBranchOk = true;
  let mockPRMergeable = true;
  let closedPRNumber = null;
  let closedPRComment = null;

  // Stub Telegram bot
  const originalSendMessage = bot.sendMessage;
  bot.sendMessage = async (cid, text, options) => {
    return { message_id: 12345 };
  };

  // Mock globalFetch for GitHub calls
  globalThis.__mockFetch = async (url, options) => {
    const checkUrl = url.toLowerCase();
    if (checkUrl.includes('/update-branch')) {
      return {
        ok: mockUpdateBranchOk,
        json: async () => ({ message: mockUpdateBranchOk ? 'success' : 'conflict' }),
        text: async () => 'conflict'
      };
    }
    if (checkUrl.includes('/pulls/999') && options.method === 'PATCH') {
      const body = JSON.parse(options.body || '{}');
      if (body.state === 'closed') {
        closedPRNumber = 999;
      }
      return { ok: true, json: async () => ({ state: 'closed' }) };
    }
    if (checkUrl.includes('/issues/999/comments') && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      closedPRComment = body.body;
      return { ok: true, json: async () => ({}) };
    }
    if (checkUrl.includes('/pulls/999') && options.method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          number: 999,
          title: 'Conflict Task',
          html_url: 'https://github.com/owner/repo/pull/999',
          base: { ref: 'feature/test-conflict-01' },
          head: { sha: 'head-sha-123' },
          state: 'open',
          mergeable: mockPRMergeable
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  t.after(async () => {
    bot.sendMessage = originalSendMessage;
    if (phaseId) {
      await pool.query('DELETE FROM phases WHERE id = ?', [phaseId]);
    }
  });

  // Setup test phase & task
  const [phaseRes] = await pool.query(
    'INSERT INTO phases (title, description, phase_branch, status) VALUES (?, ?, ?, ?)',
    ['Test Conflict Phase', 'Phase description', 'feature/test-conflict-01', 'active']
  );
  phaseId = phaseRes.insertId;

  const [taskRes] = await pool.query(
    'INSERT INTO tasks (phase_id, title, description, mode, status, sort_order, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [phaseId, 'Conflict Task', 'Task description', 'ai_assisted', 'pr_open', 1, null]
  );
  taskId = taskRes.insertId;

  await queries.updateTaskStatus(taskId, 'pr_open', {
    pr_number: 999,
    pr_url: 'https://github.com/owner/repo/pull/999',
    jules_session_id: 'session_xyz'
  });

  await t.test('unresolved conflict triggers task rework, closes PR and resets task to queued', async () => {
    mockUpdateBranchOk = false;
    mockPRMergeable = false;

    const task = await queries.getTask(taskId);
    const res = await prReviewer.reviewAndMerge(task);

    assert.strictEqual(res.merged, false);
    assert.strictEqual(res.restarted, true);
    assert.strictEqual(closedPRNumber, 999);
    assert.ok(closedPRComment.includes('PR closed by supervisor due to unresolved merge conflicts'));

    const updatedTask = await queries.getTask(taskId);
    assert.strictEqual(updatedTask.status, 'queued');
    assert.strictEqual(updatedTask.retry_count, 1);
    assert.strictEqual(updatedTask.pr_number, null);
    assert.strictEqual(updatedTask.jules_session_id, null);
  });
});
