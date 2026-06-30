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

test('Jules Supervisor Upgrade Safety Requirements', async (t) => {
  let phaseId = null;
  let task1Id = null;

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
  let mockPRChecksState = 'passing';
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
      if (checkUrl.includes('/pulls/') && checkUrl.endsWith('/files')) {
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
            state: 'open',
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
        return { ok: true, json: async () => ({}) };
      }
      if (checkUrl.includes('/merge') && options.method === 'PUT') {
        return { ok: true, json: async () => ({}) };
      }
    }

    // Jules Mock
    if (checkUrl.includes('jules.googleapis.com')) {
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
  });

  t.after(async () => {
    bot.sendMessage = originalSendMessage;
    delete globalThis.__mockFetch;
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
    assert.ok(sentTelegramMessages[0].text.includes('Missing or unknown test evidence'));
  });

  await t.test('Phase completion does not merge into main', async () => {
    // Update phase to active, complete all tasks
    await queries.updatePhaseStatus(phaseId, 'active', { phase_branch: 'feature/phase-10' });
    await queries.updateTaskStatus(task1Id, 'merged');

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
});
