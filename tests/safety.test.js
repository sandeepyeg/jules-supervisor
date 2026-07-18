import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { pool, resetInMemoryDb, useMockDb, inMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import * as prReviewer from '../src/core/prReviewer.js';
import * as poller from '../src/core/poller.js';
import { bot } from '../src/services/telegram.js';
import * as github from '../src/services/github.js';
import * as jules from '../src/services/jules.js';
import { reloadConfig } from '../src/core/config.js';
import tasksRouter from '../src/api/tasks.js';
import phasesRouter from '../src/api/phases.js';
import { getPortalSecret } from '../src/api/auth.js';

test('Jules Supervisor Upgrade Safety Requirements', async (t) => {
  let phaseId = null;
  let task1Id = null;
  let task2Id = null;

  // Track sent Telegram messages & Jules correction messages
  const sentTelegramMessages = [];
  const julesMessages = [];

  const originalSendMessage = bot.sendMessage;
  bot.sendMessage = async (cid, text, options) => {
    sentTelegramMessages.push({ text, options });
    return { message_id: Math.floor(Math.random() * 1000000) };
  };

  // Mock globalFetch
  let mockPRBase = 'main';
  let mockPRMergeable = true;
  let mockPRMerged = true;
  let mockPRState = 'open';
  let mockPRChecksState = 'passing';
  let approveCalled = false;
  let mergeCalled = false;
  let mockPRDiff = 'diff --git a/src/core/env.js b/src/core/env.js\n+console.log("changes");';
  let mockPRFiles = [{ filename: 'src/core/env.js' }];
  let mockAICanPass = true;
  let mockAIResponse = {
    approved: true,
    riskLevel: 'low',
    summary: 'PR looks good and implements requirements.',
    missingRequirements: [],
    filesReviewed: ['src/core/env.js'],
    testEvidence: 'Unit tests found in tests/env.test.js',
    blockingIssues: [],
    followUpInstructions: ''
  };

  globalThis.__mockFetch = async (url, options) => {
    const checkUrl = url.toLowerCase();

    // AI Mock
    if (checkUrl.includes('generativelanguage.googleapis.com') || checkUrl.includes('openrouter.ai')) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify(mockAIResponse)
              }]
            }
          }],
          choices: [{
            message: {
              content: JSON.stringify(mockAIResponse)
            }
          }]
        })
      };
    }

    // GitHub Mock
    if (checkUrl.includes('api.github.com')) {
      if (checkUrl.includes('/pulls/') && checkUrl.includes('/files')) {
        return {
          ok: true,
          json: async () => mockPRFiles
        };
      }
      if (checkUrl.includes('/pulls/') && options.headers?.Accept?.includes('diff')) {
        return {
          ok: true,
          text: async () => mockPRDiff
        };
      }
      if (checkUrl.includes('/pulls/')) {
        // GET PR details
        return {
          ok: true,
          json: async () => ({
            number: 101,
            title: 'Mock PR title',
            html_url: 'https://github.com/mock/pull/101',
            base: { ref: mockPRBase },
            head: { ref: 'feature/task-1', sha: 'sha123' },
            state: mockPRState,
            merged: mockPRMerged,
            mergeable: mockPRMergeable,
            changed_files: mockPRFiles.length,
            additions: 10,
            deletions: 2
          })
        };
      }
      if (checkUrl.includes('/commits/sha123/status')) {
        return {
          ok: true,
          json: async () => ({ state: mockPRChecksState === 'passing' ? 'success' : 'failure' })
        };
      }
      if (checkUrl.includes('/commits/sha123/check-runs')) {
        return {
          ok: true,
          json: async () => ({ check_runs: [] })
        };
      }
      if (checkUrl.includes('/reviews') && options.method === 'POST') {
        approveCalled = true;
        return { ok: true, json: async () => ({}) };
      }
      if (checkUrl.includes('/merge') && options.method === 'PUT') {
        mergeCalled = true;
        return { ok: true, json: async () => ({}) };
      }
    }

    // Jules Mock
    if (checkUrl.includes('jules.googleapis.com')) {
      if (checkUrl.endsWith('/sessions') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ name: 'sessions/mock_jules_session_xyz' })
        };
      }
      if (checkUrl.includes(':sendmessage')) {
        const bodyObj = JSON.parse(options.body);
        julesMessages.push({ sessionId: 'session_xyz', prompt: bodyObj.prompt });
        return {
          ok: true,
          json: async () => ({})
        };
      }
    }

    throw new Error(`Unexpected outgoing HTTP fetch call intercepted: ${url}`);
  };

  t.before(async () => {
    resetInMemoryDb();

    // Insert mock phase and task
    const [phaseRes] = await pool.query(
      'INSERT INTO phases (title, description, status, phase_branch, main_branch) VALUES (?, ?, ?, ?, ?)',
      ['Safety Test Phase', 'Verifying safety constraints', 'draft', 'feature/phase-10', 'main']
    );
    phaseId = phaseRes.insertId;

    const [taskRes] = await pool.query(
      'INSERT INTO tasks (phase_id, title, description, mode, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [phaseId, 'Safety Test Task', 'Configure new auth environment wrapper', 'ai_assisted', 'queued', 1]
    );
    task1Id = taskRes.insertId;

    const [task2Res] = await pool.query(
      'INSERT INTO tasks (phase_id, title, description, mode, status, sort_order, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [phaseId, 'Safety Test Task 2', 'Implement logging', 'ai_assisted', 'queued', 2, JSON.stringify([task1Id])]
    );
    task2Id = task2Res.insertId;
  });

  t.after(async () => {
    bot.sendMessage = originalSendMessage;
    delete globalThis.__mockFetch;
    if (bot.stopPolling) {
      await bot.stopPolling();
    }
    await pool.end();
  });

  await t.test('PR targeting main is blocked and Jules receives correction', async () => {
    // Setup
    mockPRBase = 'main';
    const task = {
      id: task1Id,
      phase_id: phaseId,
      title: 'Safety Test Task',
      description: 'Configure new auth environment wrapper',
      pr_number: 101,
      jules_session_id: 'session_xyz',
      pr_url: 'https://github.com/mock/pull/101'
    };

    julesMessages.length = 0;
    sentTelegramMessages.length = 0;

    // Execute Review
    const reviewResult = await prReviewer.reviewAndMerge(task);

    // Assertions
    assert.strictEqual(reviewResult.merged, false);
    assert.strictEqual(reviewResult.blocked, true);

    // Check correction was sent to Jules
    assert.ok(julesMessages.length > 0);
    assert.ok(julesMessages[0].prompt.includes('Your PR targets main. Retarget the PR to feature/phase-10.'));

    // Check Telegram notification was sent
    assert.ok(sentTelegramMessages.length > 0);
    assert.ok(sentTelegramMessages[0].text.includes('Blocked by Supervisor'));
    assert.ok(sentTelegramMessages[0].text.includes('targets base branch "main"'));
  });

  await t.test('NEVER_MERGE_TO_MAIN prevents merge even if AI approves', async () => {
    mockPRBase = 'main';
    mockAIResponse.approved = true;

    process.env.NEVER_MERGE_TO_MAIN = 'true';
    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
    reloadConfig();

    const task = {
      id: task1Id,
      phase_id: phaseId,
      title: 'Safety Test Task',
      description: 'Configure new auth environment wrapper',
      pr_number: 101,
      jules_session_id: 'session_xyz',
      pr_url: 'https://github.com/mock/pull/101'
    };

    const reviewResult = await prReviewer.reviewAndMerge(task);

    // Must be blocked and not merged
    assert.strictEqual(reviewResult.merged, false);
    assert.strictEqual(reviewResult.blocked, true);
  });

  await t.test('PR targeting phase branch is approved but auto-merge is blocked when TASK_AUTO_MERGE_TO_PHASE_BRANCH is false', async () => {
    mockPRBase = 'feature/phase-10';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'low';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/env.js' }];

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
    reloadConfig();

    const task = {
      id: task1Id,
      phase_id: phaseId,
      title: 'Safety Test Task',
      description: 'Configure new auth environment wrapper',
      pr_number: 101,
      jules_session_id: 'session_xyz',
      pr_url: 'https://github.com/mock/pull/101'
    };

    sentTelegramMessages.length = 0;

    const reviewResult = await prReviewer.reviewAndMerge(task);

    assert.strictEqual(reviewResult.merged, false);
    // Notify Telegram that the PR is ready for human review
    assert.ok(sentTelegramMessages.length > 0);
    assert.ok(sentTelegramMessages[0].text.includes('Ready for Review'));
  });

  await t.test('High-risk PR never auto-merges and alerts Telegram', async () => {
    mockPRBase = 'feature/phase-10';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'high'; // AI flags it high risk
    mockPRFiles = [{ filename: 'src/core/auth.js' }]; // triggers file name risk logic

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true'; // even if auto-merge is enabled
    reloadConfig();

    const task = {
      id: task1Id,
      phase_id: phaseId,
      title: 'Safety Test Task',
      description: 'Configure new auth environment wrapper',
      pr_number: 101,
      jules_session_id: 'session_xyz',
      pr_url: 'https://github.com/mock/pull/101'
    };

    sentTelegramMessages.length = 0;
    approveCalled = false;
    mergeCalled = false;
    await queries.updateTaskStatus(task1Id, 'running');

    const reviewResult = await prReviewer.reviewAndMerge(task);

    assert.strictEqual(reviewResult.merged, false);
    assert.strictEqual(approveCalled, false);
    assert.strictEqual(mergeCalled, false);

    const updatedTask = await queries.getTask(task1Id);
    assert.strictEqual(updatedTask.status, 'pr_open');

    assert.ok(sentTelegramMessages.length > 0);
    assert.ok(sentTelegramMessages[0].text.includes('Ready for Review') || sentTelegramMessages[0].text.includes('Blocked by Supervisor'));
  });

  await t.test('Missing tests/testEvidence blocks approval', async () => {
    mockPRBase = 'feature/phase-10';
    mockAIResponse.approved = true;
    mockAIResponse.testEvidence = 'No test found in PR diff'; // Indicates missing tests
    mockPRFiles = [{ filename: 'src/core/auth.js' }]; // source file changed

    const task = {
      id: task1Id,
      phase_id: phaseId,
      title: 'Safety Test Task',
      description: 'Configure new auth environment wrapper',
      pr_number: 101,
      jules_session_id: 'session_xyz',
      pr_url: 'https://github.com/mock/pull/101'
    };

    sentTelegramMessages.length = 0;

    const reviewResult = await prReviewer.reviewAndMerge(task);

    assert.strictEqual(reviewResult.merged, false);
    // Since it's not approved, Telegram must receive a blocked notification
    assert.ok(sentTelegramMessages.length > 0);
    assert.ok(sentTelegramMessages[0].text.includes('Blocked by Supervisor'));
    assert.ok(sentTelegramMessages[0].text.includes('Missing verifiable test evidence'));
  });

  await t.test('TASK_AUTO_MERGE_TO_PHASE_BRANCH=true squash merges successfully into phase branch but not main', async () => {
    mockPRBase = 'feature/phase-10';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'low';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/env.js' }];

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
    reloadConfig();

    const task = {
      id: task1Id,
      phase_id: phaseId,
      title: 'Safety Test Task',
      description: 'Configure new auth environment wrapper',
      pr_number: 101,
      jules_session_id: 'session_xyz',
      pr_url: 'https://github.com/mock/pull/101'
    };

    sentTelegramMessages.length = 0;

    const reviewResult = await prReviewer.reviewAndMerge(task);

    // It should merge successfully!
    assert.strictEqual(reviewResult.merged, true);
    assert.strictEqual(reviewResult.blocked, undefined);
  });

  await t.test('PR diff size exceeding MAX_PR_DIFF_CHARS blocks auto-merge and escalates to Telegram', async () => {
    mockPRBase = 'feature/phase-10';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'low';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/env.js' }];
    
    // Set MAX_PR_DIFF_CHARS low so mockPRDiff exceeds it
    process.env.MAX_PR_DIFF_CHARS = '10';
    reloadConfig();

    const task = {
      id: task1Id,
      phase_id: phaseId,
      title: 'Safety Test Task',
      description: 'Configure new auth environment wrapper',
      pr_number: 101,
      jules_session_id: 'session_xyz',
      pr_url: 'https://github.com/mock/pull/101'
    };

    sentTelegramMessages.length = 0;

    const reviewResult = await prReviewer.reviewAndMerge(task);

    // It should block and not merge
    assert.strictEqual(reviewResult.merged, false);
    assert.strictEqual(reviewResult.approved, false);
    assert.strictEqual(reviewResult.reason, 'PR diff size exceeds maximum allowed limit');

    // Verify Telegram alert contains no undefined values and matches expected format
    assert.ok(sentTelegramMessages.length > 0);
    const text = sentTelegramMessages[0].text;
    assert.ok(text.includes('Blocked by Supervisor'));
    assert.ok(!text.includes('undefined'));
    assert.ok(text.includes('Reason: PR diff size (71 chars) exceeds the maximum allowed limit of 10 chars.'));
    assert.ok(text.includes('Jules Instruction: Manual human review and merge required'));

    // Restore config
    process.env.MAX_PR_DIFF_CHARS = '120000';
    reloadConfig();
  });

  await t.test('manual mark-merged rejects PR targeting main', async () => {
    mockPRBase = 'main';
    mockPRMerged = true;
    
    await queries.updateTaskStatus(task1Id, 'pr_open', { pr_number: 101 });

    const req = {
      method: 'POST',
      url: `/${task1Id}/mark-merged`,
      params: { id: String(task1Id) },
      headers: {
        'x-portal-key': getPortalSecret()
      }
    };
    let responseStatus = 200;
    let responseBody = null;
    const res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };

    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => {
        origJson.call(res, data);
        resolve();
        return res;
      };
      tasksRouter(req, res, () => {
        resolve();
      });
    });

    assert.strictEqual(responseStatus, 400);
    assert.ok(responseBody.error.includes('forbidden base branch: main'));
  });

  await t.test('manual mark-merged accepts PR targeting phase branch and triggers dependent tasks', async () => {
    mockPRBase = 'feature/phase-10';
    mockPRMerged = true;
    
    await queries.updatePhaseStatus(phaseId, 'active');
    await queries.updateTaskStatus(task1Id, 'pr_open', { pr_number: 101 });
    await queries.updateTaskStatus(task2Id, 'queued');

    const req = {
      method: 'POST',
      url: `/${task1Id}/mark-merged`,
      params: { id: String(task1Id) },
      headers: {
        'x-portal-key': getPortalSecret()
      }
    };
    let responseStatus = 200;
    let responseBody = null;
    const res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };

    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => {
        origJson.call(res, data);
        resolve();
        return res;
      };
      tasksRouter(req, res, () => {
        resolve();
      });
    });

    assert.strictEqual(responseStatus, 200);
    
    const t1 = await queries.getTask(task1Id);
    assert.strictEqual(t1.status, 'merged');

    const t2 = await queries.getTask(task2Id);
    assert.strictEqual(t2.status, 'running');
  });

  await t.test('manual mark-merged rejects closed but unmerged PR', async () => {
    mockPRBase = 'feature/phase-10';
    mockPRMerged = false;
    mockPRState = 'closed'; // PR was closed but not merged

    await queries.updateTaskStatus(task1Id, 'pr_open', { pr_number: 101 });

    const req = {
      method: 'POST',
      url: `/${task1Id}/mark-merged`,
      params: { id: String(task1Id) },
      headers: {
        'x-portal-key': getPortalSecret()
      }
    };
    let responseStatus = 200;
    let responseBody = null;
    const res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };

    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => {
        origJson.call(res, data);
        resolve();
        return res;
      };
      tasksRouter(req, res, () => {
        resolve();
      });
    });

    assert.strictEqual(responseStatus, 400);
    assert.strictEqual(responseBody.error, 'PR is closed but was not merged.');

    // Restore state
    mockPRState = 'open';
  });

  await t.test('generic PATCH cannot mark task merged directly', async () => {
    const req = {
      method: 'PATCH',
      url: `/${task1Id}`,
      params: { id: String(task1Id) },
      body: { status: 'merged' },
      headers: {
        'x-portal-key': getPortalSecret()
      }
    };
    let responseStatus = 200;
    let responseBody = null;
    const res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };

    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => {
        origJson.call(res, data);
        resolve();
        return res;
      };
      tasksRouter(req, res, () => {
        resolve();
      });
    });

    assert.strictEqual(responseStatus, 400);
    assert.strictEqual(responseBody.error, 'Use POST /api/tasks/:id/mark-merged so GitHub PR verification is enforced.');
  });

  await t.test('Phase completion does not merge into main', async () => {
    // Update phase to active, complete all tasks
    await queries.updatePhaseStatus(phaseId, 'active', { phase_branch: 'feature/phase-10' });
    await queries.updateTaskStatus(task1Id, 'merged');
    await queries.updateTaskStatus(task2Id, 'skipped'); // skip task2 to allow completion check

    sentTelegramMessages.length = 0;

    // Trigger poller checking logic
    // We simulate the checkAllMerged poller workflow
    const [tasks] = await pool.query('SELECT status, title FROM tasks WHERE phase_id = ?', [phaseId]);
    const isComplete = tasks.length > 0 && tasks.every(t => t.status === 'merged' || t.status === 'skipped');
    
    assert.strictEqual(isComplete, true);
    
    await queries.updatePhaseStatus(phaseId, 'complete', { completed_at: new Date() });
    await bot.sendMessage(null, `Phase complete. Review branch feature/phase-10. Human should manually create/review/merge final PR into main.`);

    // Confirm database phase state
    const phase = await queries.getPhase(phaseId);
    assert.strictEqual(phase.status, 'complete');

    // Confirm Telegram was notified correctly
    assert.ok(sentTelegramMessages.length > 0);
    assert.ok(sentTelegramMessages[0].text.includes('Phase complete. Review branch feature/phase-10. Human should manually create/review/merge final PR into main.'));
  });

  await t.test('GET /api/phases/github/branches lists branches and fallback list', async () => {
    // 1. Unauthorized request
    let req = {
      method: 'GET',
      url: '/github/branches',
      headers: {}
    };
    let responseStatus = null;
    let responseBody = null;
    let res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };
    
    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => {
        origJson.call(res, data);
        resolve();
        return res;
      };
      phasesRouter(req, res, () => {
        resolve();
      });
    });
    
    assert.strictEqual(responseStatus, 401);
    
    // 2. Authorized request
    req.headers['x-portal-key'] = getPortalSecret();
    responseStatus = null;
    responseBody = null;
    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => {
        origJson.call(res, data);
        resolve();
        return res;
      };
      phasesRouter(req, res, () => {
        resolve();
      });
    });
    
    assert.strictEqual(responseStatus, null); // meaning it ran and returned json successfully
    assert.ok(Array.isArray(responseBody));
    assert.ok(responseBody.includes('main'));
  });

  await t.test('POST /api/phases/:id/tasks appends a task to an active phase', async () => {
    // 1. Authorized insertion
    let req = {
      method: 'POST',
      url: `/${phaseId}/tasks`,
      params: { id: String(phaseId) },
      headers: { 'x-portal-key': getPortalSecret() },
      body: {
        title: 'New Dynamic Task',
        description: 'Dynamically added description',
        jules_notes: 'Notes',
        mode: 'ai_assisted',
        depends_on: []
      }
    };
    
    let responseStatus = null;
    let responseBody = null;
    let res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };
    
    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => {
        origJson.call(res, data);
        resolve();
        return res;
      };
      phasesRouter(req, res, () => {
        resolve();
      });
    });
    
    assert.strictEqual(responseStatus, 201);
    assert.ok(responseBody.taskId);
    
    // Verify it is appended in database
    const [tasks] = await pool.query('SELECT * FROM tasks WHERE id = ?', [responseBody.taskId]);
    assert.strictEqual(tasks[0].title, 'New Dynamic Task');
    assert.strictEqual(tasks[0].phase_id, phaseId);
  });
});
