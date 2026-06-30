import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { pool } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import * as taskManager from '../src/core/taskManager.js';
import * as sessionHandler from '../src/core/sessionHandler.js';
import * as questionHandler from '../src/core/questionHandler.js';
import { bot } from '../src/services/telegram.js';
import * as poller from '../src/core/poller.js';

test('End-to-End Real World Supervisor Workflow Simulator', async (t) => {
  let phaseId = null;
  let task1Id = null;
  let task2Id = null;

  // Set up mock Telegram bot responses and message storage
  const sentTelegramMessages = [];
  const originalSendMessage = bot.sendMessage;
  const originalStopPolling = bot.stopPolling;
  bot.sendMessage = async (cid, text, options) => {
    const messageId = Math.floor(Math.random() * 1000000) + 1000;
    sentTelegramMessages.push({ messageId, text, options });
    return { message_id: messageId };
  };

  // Mock global fetch interceptor to stub GitHub, Jules, and AI API endpoints
  let julesSessionState = 'COMPLETED'; // can toggle in test to simulate states
  let aiConfidence = 8; // toggle confidence scores

  globalThis.__mockFetch = async (url, options) => {
    const checkUrl = url.toLowerCase();
    
    // 1. Gemini / OpenRouter AI requests
    if (checkUrl.includes('generativelanguage.googleapis.com') || checkUrl.includes('openrouter.ai')) {
      const bodyStr = options.body || '';
      
      // If it's a confidence score request
      if (bodyStr.includes('confidence')) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  confidence: aiConfidence,
                  answer: 'Mocked AI answer recommendation.',
                  reason: 'Sufficient context from codebase.'
                })
              }
            }]
          })
        };
      }
      
      // If it's a PR Review request
      if (bodyStr.includes('approved')) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  approved: true,
                  reason: 'PR diff successfully implements the task description.'
                })
              }
            }]
          })
        };
      }
    }

    // 2. Jules API requests
    if (checkUrl.includes('jules.googleapis.com')) {
      // Create session
      if (checkUrl.endsWith('/sessions') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ name: 'sessions/mock_jules_session_xyz' })
        };
      }
      // Get session
      if (checkUrl.includes('/sessions/mock_jules_session_xyz') && options.method === 'GET' && !checkUrl.includes('activities')) {
        return {
          ok: true,
          json: async () => ({
            name: 'sessions/mock_jules_session_xyz',
            state: julesSessionState,
            output: {
              prUrl: 'https://github.com/sandeepyeg/project-jupitor/pull/105'
            }
          })
        };
      }
      // List activities
      if (checkUrl.includes('/activities')) {
        return {
          ok: true,
          json: async () => ({
            activities: [
              {
                name: 'activity_question_abc',
                originator: 'agent',
                createTime: new Date().toISOString(),
                messageGenerated: {
                  message: 'What database driver should we use?'
                }
              }
            ]
          })
        };
      }
      // Send message
      if (checkUrl.includes(':sendmessage')) {
        return {
          ok: true,
          json: async () => ({})
        };
      }
      // Approve plan
      if (checkUrl.includes(':approveplan')) {
        return {
          ok: true,
          json: async () => ({})
        };
      }
    }

    // 3. GitHub API requests
    if (checkUrl.includes('api.github.com')) {
      // Get branch reference
      if (checkUrl.includes('/git/ref/heads/')) {
        return {
          ok: true,
          json: async () => ({ object: { sha: 'sha1234567890abcdef' } })
        };
      }
      // Create branch reference
      if (checkUrl.endsWith('/git/refs') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({})
        };
      }
      // Get PR Files
      if (checkUrl.includes('/pulls/') && checkUrl.includes('/files')) {
        return {
          ok: true,
          json: async () => [{ filename: 'server.js' }]
        };
      }
      // Get PR diff
      if (checkUrl.includes('/pulls/') && options.headers?.Accept?.includes('diff')) {
        return {
          ok: true,
          text: async () => 'diff --git a/server.js b/server.js\n+console.log("system test passes");'
        };
      }
      // Get PR details metadata
      if (checkUrl.includes('/pulls/105') && options.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            number: 105,
            title: 'E2E Task 1 - Sequential Start',
            html_url: 'https://github.com/sandeepyeg/project-jupitor/pull/105',
            base: { ref: 'feature/phase-1' },
            head: { ref: 'feature/task-1', sha: 'sha1234567890abcdef' },
            state: 'open',
            mergeable: true,
            changed_files: 1,
            additions: 1,
            deletions: 0
          })
        };
      }
      // Get PR Checks combined status
      if (checkUrl.includes('/commits/sha1234567890abcdef/status')) {
        return {
          ok: true,
          json: async () => ({ state: 'success' })
        };
      }
      // Get PR Check runs
      if (checkUrl.includes('/commits/sha1234567890abcdef/check-runs')) {
        return {
          ok: true,
          json: async () => ({ check_runs: [] })
        };
      }
      // Approve PR
      if (checkUrl.includes('/reviews') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({})
        };
      }
      // Merge PR
      if (checkUrl.includes('/merge') && options.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({})
        };
      }
    }

    // Fallback error
    throw new Error(`Unexpected outgoing HTTP fetch call intercepted: ${url}`);
  };

  // Setup Phase & Tasks in database
  t.before(async () => {
    // Insert Phase
    const [phaseRes] = await pool.query(
      'INSERT INTO phases (title, description, status, main_branch) VALUES (?, ?, ?, ?)',
      ['E2E Test Phase', 'Verifying full loop execution logic', 'draft', 'main']
    );
    phaseId = phaseRes.insertId;

    // Insert Task 1 (Seq Start)
    const [task1Res] = await pool.query(
      'INSERT INTO tasks (phase_id, title, description, mode, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [phaseId, 'E2E Task 1 - Sequential Start', 'Create schema outline', 'ai_assisted', 'queued', 1]
    );
    task1Id = task1Res.insertId;

    // Insert Task 2 (Seq Dependent on Task 1)
    const [task2Res] = await pool.query(
      'INSERT INTO tasks (phase_id, title, description, mode, status, sort_order, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [phaseId, 'E2E Task 2 - Dependent', 'Implement connections module', 'ai_assisted', 'queued', 2, JSON.stringify([task1Id])]
    );
    task2Id = task2Res.insertId;
  });

  // Cleanup DB and mock hooks when test finishes
  t.after(async () => {
    bot.sendMessage = originalSendMessage;
    delete globalThis.__mockFetch;

    // Stop background poller loop to prevent hanging
    if (phaseId) {
      poller.stopPoller(phaseId);
    }

    // Stop Telegram polling loop to prevent process from hanging after tests
    if (bot.stopPolling) {
      await bot.stopPolling();
    }

    if (phaseId) {
      await pool.query('DELETE FROM phases WHERE id = ?', [phaseId]);
    }
    
    // End database pool so Node.js can exit cleanly
    await pool.end();
  });

  // Simulated Execution Timeline
  await t.test('1. Phase launch & start initial queued tasks', async () => {
    const branchName = `feature/phase-${phaseId}`;
    
    // We update status to active (simulating POST /api/phases/:id/start endpoint logic)
    await queries.updatePhaseStatus(phaseId, 'active', {
      phase_branch: branchName,
      started_at: new Date()
    });
    
    // Start ready tasks
    const started = await taskManager.startReadyTasks(phaseId, branchName);
    assert.strictEqual(started, 1, 'Only Task 1 (independent sequential start) should begin');

    // Retrieve updated tasks
    const t1 = await queries.getTask(task1Id);
    const t2 = await queries.getTask(task2Id);

    assert.strictEqual(t1.status, 'running');
    assert.strictEqual(t1.jules_session_id, 'mock_jules_session_xyz');
    assert.strictEqual(t2.status, 'queued', 'Task 2 should still be queued');
  });

  await t.test('2. Task 1 completes successfully, PR is merged, dependent Task 2 is unblocked', async () => {
    julesSessionState = 'COMPLETED';
    
    // Fetch running tasks
    const activeTasks = await queries.getActiveTasks(phaseId);
    assert.strictEqual(activeTasks.length, 1);
    
    // Handle the completed session
    await sessionHandler.handleSession(activeTasks[0]);
    
    // Check that Task 1 is now merged
    const t1 = await queries.getTask(task1Id);
    assert.strictEqual(t1.status, 'merged');

    // Poller tick: start next ready tasks
    const started = await taskManager.startReadyTasks(phaseId, `feature/phase-${phaseId}`);
    assert.strictEqual(started, 1, 'Task 2 should now start since Task 1 is merged');

    const t2 = await queries.getTask(task2Id);
    assert.strictEqual(t2.status, 'running');
    assert.strictEqual(t2.jules_session_id, 'mock_jules_session_xyz');
  });

  await t.test('3. Task 2 requests feedback, triggers Telegram escalation on low AI confidence', async () => {
    julesSessionState = 'AWAITING_USER_FEEDBACK';
    aiConfidence = 4; // Under threshold (7)
    
    const activeTasks = await queries.getActiveTasks(phaseId);
    assert.strictEqual(activeTasks.length, 1);
    
    // Handle the feedback request
    await sessionHandler.handleSession(activeTasks[0]);
    
    // Task 2 should go into waiting_answer state
    const t2 = await queries.getTask(task2Id);
    assert.strictEqual(t2.status, 'waiting_answer');
    assert.strictEqual(t2.last_activity_id, 'activity_question_abc');

    // Verify Telegram message was dispatched
    assert.strictEqual(sentTelegramMessages.length, 1);
    assert.ok(sentTelegramMessages[0].text.includes('Low AI Confidence: 4/10'));
    
    // Check telegram_pending record exists
    const [pending] = await pool.query('SELECT * FROM telegram_pending WHERE task_id = ?', [task2Id]);
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].resolved, 0);
  });

  await t.test('4. Webhook receives developer answer via Telegram reply, updates Task 2 back to running', async () => {
    const telegramMsg = sentTelegramMessages[0];
    
    // Simulate incoming Telegram webhook call with the answer text
    await questionHandler.handleTelegramReply(telegramMsg.messageId, 'Use pg-promise for PostgreSQL connection pooling.');
    
    // Task 2 should be returned to running state
    const t2 = await queries.getTask(task2Id);
    assert.strictEqual(t2.status, 'running');

    // Check pending telegram record is now resolved
    const [pending] = await pool.query('SELECT * FROM telegram_pending WHERE task_id = ?', [task2Id]);
    assert.strictEqual(pending[0].resolved, 1);
    
    // Check QA log entry
    const [qaLogs] = await pool.query('SELECT * FROM qa_log WHERE task_id = ? ORDER BY id DESC', [task2Id]);
    assert.ok(qaLogs.length >= 1);
    assert.strictEqual(qaLogs[0].answer, 'Use pg-promise for PostgreSQL connection pooling.');
  });
});
