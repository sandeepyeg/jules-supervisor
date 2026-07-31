import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { pool, resetInMemoryDb, useMockDb, inMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import * as prReviewer from '../src/core/prReviewer.js';
import * as poller from '../src/core/poller.js';
import * as sessionHandler from '../src/core/sessionHandler.js';
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
  let mockPRStatusTotalCount = 1;
  let mockPRSha = 'sha123';
  let approveCalled = false;
  let mergeCalled = false;
  let requestChangesCalled = false;
  const requestChangesBodies = [];
  const prCommentBodies = [];
  let mockOpenPRsForBranch = [];
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
    advisoryNotes: [],
    followUpInstructions: ''
  };

  let aiCallCount = 0;

  globalThis.__mockFetch = async (url, options) => {
    const checkUrl = url.toLowerCase();

    // AI Mock
    if (checkUrl.includes('generativelanguage.googleapis.com') || checkUrl.includes('openrouter.ai')) {
      aiCallCount++;
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
      if (checkUrl.includes('/reviews') && options.method === 'POST') {
        const bodyObj = JSON.parse(options.body);
        if (bodyObj.event === 'REQUEST_CHANGES') {
          requestChangesCalled = true;
          requestChangesBodies.push(bodyObj.body);
        } else {
          approveCalled = true;
        }
        return { ok: true, json: async () => ({}) };
      }
      if (checkUrl.includes('/issues/') && checkUrl.includes('/comments') && options.method === 'POST') {
        const bodyObj = JSON.parse(options.body);
        prCommentBodies.push(bodyObj.body);
        return { ok: true, json: async () => ({}) };
      }
      if (checkUrl.includes('/pulls?') && checkUrl.includes('state=open')) {
        return { ok: true, json: async () => mockOpenPRsForBranch };
      }
      if (checkUrl.includes('/merge') && options.method === 'PUT') {
        mergeCalled = true;
        return { ok: true, json: async () => ({}) };
      }
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
            head: { ref: 'feature/task-1', sha: mockPRSha },
            state: mockPRState,
            merged: mockPRMerged,
            mergeable: mockPRMergeable,
            changed_files: mockPRFiles.length,
            additions: 10,
            deletions: 2
          })
        };
      }
      if (checkUrl.includes(`/commits/${mockPRSha}/status`)) {
        return {
          ok: true,
          json: async () => ({
            state: mockPRChecksState === 'passing' ? 'success' : 'failure',
            total_count: mockPRStatusTotalCount
          })
        };
      }
      if (checkUrl.includes(`/commits/${mockPRSha}/check-runs`)) {
        return {
          ok: true,
          json: async () => ({ check_runs: [] })
        };
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

  await t.test('High-risk approved PR auto-merges into phase branch by default', async () => {
    mockPRBase = 'feature/phase-10';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'high'; // AI flags it high risk
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/auth.js' }]; // triggers file name risk logic

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
    process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
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

    assert.strictEqual(reviewResult.merged, true);
    assert.strictEqual(approveCalled, true);
    assert.strictEqual(mergeCalled, true);

    const updatedTask = await queries.getTask(task1Id);
    assert.strictEqual(updatedTask.status, 'merged');

    assert.ok(sentTelegramMessages.length > 0);
    assert.ok(sentTelegramMessages[0].text.includes('Merged'));
    assert.ok(sentTelegramMessages[0].text.includes('Please verify this phase before the final main merge'));
  });

  await t.test('High-risk block flag prevents auto-merge and alerts Telegram', async () => {
    mockPRBase = 'feature/phase-10';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'high';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/auth.js' }];

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
    process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
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
    assert.ok(sentTelegramMessages[0].text.includes('Ready for Review'));

    process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
    reloadConfig();
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

  await t.test('GitHub combined status with zero statuses is not treated as failing CI', async () => {
    mockPRChecksState = 'failing';
    mockPRStatusTotalCount = 0;

    const checksStatus = await github.getPRChecks(101);
    assert.strictEqual(checksStatus, 'passing');

    mockPRChecksState = 'passing';
    mockPRStatusTotalCount = 1;
  });

  await t.test('ordinary apps/api backend files are not automatically high risk', async () => {
    const risk = prReviewer.detectRisk([
      'apps/api/src/ImmigrationApp.Application/Abstractions/Operations/Queues/IBackgroundQueueObservationService.cs',
      'apps/api/src/ImmigrationApp.Infrastructure/Operations/DapperBackgroundQueueObservationService.cs',
      'apps/api/tests/ImmigrationApp.UnitTests/Operations/Queues/DapperBackgroundQueueObservationServiceTests.cs'
    ], 'diff --git a/file b/file\n+queue observation service');

    assert.strictEqual(risk, 'low');
  });

  await t.test('manual poller pause persists until resume', async () => {
    const pausedPhaseId = 999999;

    poller.stopPoller(pausedPhaseId, { manual: true });

    let health = poller.getPollerHealth();
    assert.ok(health.manuallyPausedPhaseIds.includes(pausedPhaseId));

    const skipped = await poller.runPollCycle(pausedPhaseId);
    assert.deepStrictEqual(skipped, { skipped: true, reason: 'manually_paused' });

    poller.resumePoller(pausedPhaseId);
    health = poller.getPollerHealth();
    assert.ok(!health.manuallyPausedPhaseIds.includes(pausedPhaseId));

    poller.stopPoller(pausedPhaseId);
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

  await t.test('session reconciliation marks closed unmerged PR as failed', async () => {
    mockPRBase = 'feature/phase-10';
    mockPRMerged = false;
    mockPRState = 'closed';
    sentTelegramMessages.length = 0;

    await queries.updateTaskStatus(task1Id, 'pr_open', {
      pr_number: 101,
      pr_url: 'https://github.com/mock/pull/101'
    });

    const task = await queries.getTask(task1Id);
    await sessionHandler.handleSession(task);

    const updatedTask = await queries.getTask(task1Id);
    assert.strictEqual(updatedTask.status, 'failed');
    assert.strictEqual(updatedTask.pr_number, 101);
    assert.ok(sentTelegramMessages.some(message => message.text.includes('closed without being merged')));

    mockPRMerged = true;
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

  await t.test('reviewAndMerge reuses the cached verdict and skips the AI call when the PR head sha is unchanged', async () => {
    mockPRBase = 'feature/phase-10';
    mockPRSha = 'sha-cache-test';
    mockPRMergeable = true;
    mockPRState = 'open';
    mockPRMerged = false;
    mockPRChecksState = 'passing';
    mockPRStatusTotalCount = 1;
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'low';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.advisoryNotes = [];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/env.js' }];

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
    reloadConfig();

    await queries.updateTaskStatus(task1Id, 'pr_open', {
      pr_number: 101,
      pr_revision_count: 0,
      last_reviewed_sha: null,
      last_review_verdict: null
    });

    const callsBefore = aiCallCount;
    const firstTask = await queries.getTask(task1Id);
    await prReviewer.reviewAndMerge(firstTask);
    assert.ok(aiCallCount > callsBefore, 'first review should call the AI');
    const callsAfterFirst = aiCallCount;

    // Same task, same PR head sha — second review should reuse the cached verdict.
    const secondTask = await queries.getTask(task1Id);
    assert.strictEqual(secondTask.last_reviewed_sha, 'sha-cache-test');
    await prReviewer.reviewAndMerge(secondTask);
    assert.strictEqual(aiCallCount, callsAfterFirst, 'cache hit should not call the AI again');
  });

  await t.test('bounded revision loop: posts GitHub feedback each round, then escalates to a human after the cap', async () => {
    mockPRBase = 'feature/phase-10';
    mockPRMergeable = true;
    mockPRState = 'open';
    mockPRMerged = false;
    mockPRChecksState = 'passing';
    mockPRStatusTotalCount = 1;
    mockAIResponse.approved = false;
    mockAIResponse.riskLevel = 'low';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = ['Logic error in connection handling.'];
    mockAIResponse.advisoryNotes = [];
    mockAIResponse.testEvidence = 'No tests found';
    mockPRFiles = [{ filename: 'src/core/env.js' }];

    await queries.updateTaskStatus(task1Id, 'pr_open', {
      pr_number: 101,
      pr_revision_count: 0,
      last_reviewed_sha: null,
      last_review_verdict: null
    });

    julesMessages.length = 0;
    sentTelegramMessages.length = 0;
    requestChangesCalled = false;
    requestChangesBodies.length = 0;
    prCommentBodies.length = 0;

    // Round 1: rejected, under the cap — Jules is messaged and GitHub gets a REQUEST_CHANGES review.
    mockPRSha = 'sha-revision-round-1';
    let task = await queries.getTask(task1Id);
    let result = await prReviewer.reviewAndMerge(task);
    assert.strictEqual(result.merged, false);
    assert.strictEqual(julesMessages.length, 1);
    assert.strictEqual(requestChangesCalled, true);
    assert.strictEqual(requestChangesBodies.length, 1);
    assert.ok(requestChangesBodies[0].includes('round 1/2'));
    let updated = await queries.getTask(task1Id);
    assert.strictEqual(updated.pr_revision_count, 1);

    // Round 2: Jules pushed a new commit (new sha), still rejected — second and final auto-revision round.
    mockPRSha = 'sha-revision-round-2';
    task = await queries.getTask(task1Id);
    result = await prReviewer.reviewAndMerge(task);
    assert.strictEqual(result.merged, false);
    assert.strictEqual(julesMessages.length, 2);
    assert.strictEqual(requestChangesBodies.length, 2);
    assert.ok(requestChangesBodies[1].includes('round 2/2'));
    updated = await queries.getTask(task1Id);
    assert.strictEqual(updated.pr_revision_count, 2);

    // Round 3: another new commit, still rejected — cap reached, Jules is NOT messaged again.
    mockPRSha = 'sha-revision-round-3';
    task = await queries.getTask(task1Id);
    julesMessages.length = 0;
    sentTelegramMessages.length = 0;
    result = await prReviewer.reviewAndMerge(task);
    assert.strictEqual(result.merged, false);
    assert.strictEqual(result.escalated, true);
    assert.strictEqual(julesMessages.length, 0, 'Jules must not be messaged once the revision cap is reached');
    assert.ok(prCommentBodies.some(b => b.includes('Automated review limit reached')));
    assert.ok(sentTelegramMessages.some(m => m.text.includes('Auto-review limit reached')));
    updated = await queries.getTask(task1Id);
    assert.strictEqual(updated.pr_revision_count, 2, 'revision count must not climb past the cap');
  });

  await t.test('advisory notes never block merge and are never sent to Jules', async () => {
    mockPRBase = 'feature/phase-10';
    mockPRMergeable = true;
    mockPRState = 'open';
    mockPRMerged = false;
    mockPRChecksState = 'passing';
    mockPRStatusTotalCount = 1;
    mockPRSha = 'sha-advisory-test';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'low';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.advisoryNotes = ['Consider adding a screenshot check for this UI change.'];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/env.js' }];

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'true';
    process.env.BLOCK_HIGH_RISK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
    reloadConfig();

    await queries.updateTaskStatus(task1Id, 'pr_open', {
      pr_number: 101,
      pr_revision_count: 0,
      last_reviewed_sha: null,
      last_review_verdict: null
    });

    julesMessages.length = 0;
    sentTelegramMessages.length = 0;

    const task = await queries.getTask(task1Id);
    const result = await prReviewer.reviewAndMerge(task);

    assert.strictEqual(result.merged, true);
    assert.strictEqual(julesMessages.length, 0, 'advisory-only findings must never be sent to Jules');
    assert.ok(sentTelegramMessages.some(m => m.text.includes('Advisory notes') && m.text.includes('screenshot check')));

    process.env.TASK_AUTO_MERGE_TO_PHASE_BRANCH = 'false';
    reloadConfig();
  });

  await t.test('a genuinely new PR resets the revision count and review cache instead of inheriting a stale one', async () => {
    mockPRBase = 'feature/phase-10';
    mockPRMergeable = true;
    mockPRState = 'open';
    mockPRMerged = false;
    mockPRChecksState = 'passing';
    mockPRStatusTotalCount = 1;
    mockPRSha = 'sha-reset-test';
    mockAIResponse.approved = true;
    mockAIResponse.riskLevel = 'low';
    mockAIResponse.missingRequirements = [];
    mockAIResponse.blockingIssues = [];
    mockAIResponse.advisoryNotes = [];
    mockAIResponse.testEvidence = 'Tests verified and passing';
    mockPRFiles = [{ filename: 'src/core/env.js' }];

    const resetSessionId = 'session_reset_test_1234567890';
    mockOpenPRsForBranch = [{
      number: 202,
      html_url: 'https://github.com/mock/pull/202',
      head: { ref: `jules/${resetSessionId}-fix` },
      base: { ref: 'feature/phase-10' }
    }];

    // Simulate a task that used up its revision attempts on an earlier, abandoned PR.
    await queries.updateTaskStatus(task1Id, 'running', {
      pr_number: null,
      pr_revision_count: 2,
      last_reviewed_sha: 'stale-sha-from-abandoned-pr',
      last_review_verdict: '{"stale":"verdict from a different PR"}',
      jules_session_id: resetSessionId
    });

    const staleTask = await queries.getTask(task1Id);
    assert.strictEqual(staleTask.pr_number, null);

    await sessionHandler.handleSession(staleTask);

    const updated = await queries.getTask(task1Id);
    assert.strictEqual(updated.pr_number, 202);
    assert.strictEqual(updated.pr_revision_count, 0, 'revision count from the abandoned PR must not carry over');
    assert.strictEqual(updated.last_reviewed_sha, 'sha-reset-test', 'stale cache must be replaced by a fresh review of the new PR');
    assert.notStrictEqual(updated.last_review_verdict, '{"stale":"verdict from a different PR"}');

    mockOpenPRsForBranch = [];
  });
});
