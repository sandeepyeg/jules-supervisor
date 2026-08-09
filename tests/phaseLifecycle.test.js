import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { inMemoryDb, pool, resetInMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import { createEpicFromPayload, createPhaseFromPayload } from '../src/core/phaseImport.js';
import { pausePhase, resumePhase, startEpic, startPhase } from '../src/core/phaseLifecycle.js';
import * as poller from '../src/core/poller.js';

test('startPhase — the action /import on Telegram now triggers automatically', async (t) => {
  t.beforeEach(() => resetInMemoryDb());

  globalThis.__mockFetch = async (url, options) => {
    const checkUrl = String(url).toLowerCase();
    if (checkUrl.includes('/git/ref/heads/')) {
      return { ok: true, json: async () => ({ object: { sha: 'base-sha-123' } }) };
    }
    if (checkUrl.endsWith('/git/refs') && options.method === 'POST') {
      return { ok: true, json: async () => ({ ref: 'refs/heads/mock-branch' }) };
    }
    throw new Error(`Unexpected outgoing HTTP fetch call intercepted: ${url}`);
  };

  t.after(async () => {
    delete globalThis.__mockFetch;
    await pool.end();
  });

  await t.test('creates a branch, marks the phase active, and starts its poller', async () => {
    const { phaseId } = await createPhaseFromPayload({ title: 'Import Started via Telegram' });

    const result = await startPhase(phaseId);
    assert.strictEqual(result.started, true);
    assert.ok(result.branch.startsWith('feature/import-started-via-telegram-'));

    const phase = await queries.getPhase(phaseId);
    assert.strictEqual(phase.status, 'active');
    assert.strictEqual(phase.phase_branch, result.branch);
    assert.ok(phase.started_at);

    const health = poller.getPollerHealth();
    assert.ok(health.activePhaseIds.includes(phaseId), 'poller should be running for the started phase');

    poller.stopPoller(phaseId);
  });

  await t.test('rejects starting a phase that does not exist', async () => {
    await assert.rejects(() => startPhase(999999), /Phase not found/);
  });

  await t.test('rejects starting a phase that is already active', async () => {
    const { phaseId } = await createPhaseFromPayload({ title: 'Already Active Phase' });
    await startPhase(phaseId);

    await assert.rejects(
      () => startPhase(phaseId),
      /already started or completed/
    );

    poller.stopPoller(phaseId);
  });

  await t.test('creates a missing epic master branch from the epic target base branch', async () => {
    const calls = [];
    let epicMasterCreated = false;
    globalThis.__mockFetch = async (url, options = {}) => {
      const urlText = String(url);
      const method = options.method || 'GET';
      calls.push({ url: urlText, method, body: options.body });

      if (urlText.includes('/git/ref/heads/feature/epic-test-master')) {
        if (epicMasterCreated) {
          return { ok: true, status: 200, json: async () => ({ object: { sha: 'epic-master-sha' } }) };
        }
        return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"message":"Not Found"}' };
      }
      if (urlText.includes('/git/ref/heads/feature/selected-base')) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: 'selected-base-sha' } }) };
      }
      if (urlText.includes('/git/ref/heads/feature/')) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: 'epic-master-sha' } }) };
      }
      if (urlText.endsWith('/git/refs') && method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.ref === 'refs/heads/feature/epic-test-master') {
          epicMasterCreated = true;
        }
        return { ok: true, status: 201, json: async () => ({ ref: 'refs/heads/created' }) };
      }
      throw new Error(`Unexpected outgoing HTTP fetch call intercepted: ${url}`);
    };

    const { phaseIds } = await createEpicFromPayload({
      epic_title: 'Test Epic',
      master_feature_branch: 'feature/epic-test-master',
      target_base_branch: 'feature/selected-base',
      phases: [{ title: 'Epic Phase', tasks: [] }]
    });

    await startPhase(phaseIds[0]);

    const createdRefs = calls
      .filter(call => call.method === 'POST' && call.url.endsWith('/git/refs'))
      .map(call => JSON.parse(call.body));

    assert.strictEqual(createdRefs[0].ref, 'refs/heads/feature/epic-test-master');
    assert.strictEqual(createdRefs[0].sha, 'selected-base-sha');
    assert.ok(createdRefs[1].ref.startsWith('refs/heads/feature/epic-phase-'));
    assert.strictEqual(createdRefs[1].sha, 'epic-master-sha');

    poller.stopPoller(phaseIds[0]);
  });

  await t.test('does not fall back to main or develop when a phase base branch is missing', async () => {
    globalThis.__mockFetch = async (url) => {
      const urlText = String(url);
      assert.ok(!urlText.includes('/git/ref/heads/main'), 'must not fall back to main');
      assert.ok(!urlText.includes('/git/ref/heads/develop'), 'must not fall back to develop');
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"message":"Not Found"}' };
    };

    const { phaseId } = await createPhaseFromPayload({
      title: 'Missing Base Branch',
      mainBranch: 'feature/missing-base'
    });

    await assert.rejects(
      () => startPhase(phaseId),
      /feature\/missing-base: branch does not exist/
    );
  });

  await t.test('daily launch count only includes sessions launched in the last 24 hours', async () => {
    await pool.query(
      `INSERT INTO tasks (phase_id, title, description, status, jules_session_id)
       VALUES (?, ?, ?, ?, ?)`,
      [1, 'Recent Session', 'recent', 'running', 'recent-session']
    );
    await pool.query(
      `INSERT INTO tasks (phase_id, title, description, status, jules_session_id)
       VALUES (?, ?, ?, ?, ?)`,
      [1, 'Old Session', 'old', 'merged', 'old-session']
    );

    const oldTask = inMemoryDb.tasks.find(task => task.jules_session_id === 'old-session');
    oldTask.created_at = new Date(Date.now() - 48 * 60 * 60 * 1000);
    oldTask.jules_launched_at = new Date(Date.now() - 48 * 60 * 60 * 1000);
    oldTask.updated_at = oldTask.jules_launched_at;

    assert.strictEqual(await queries.getDailyLaunchedTaskCount(), 1);
  });

  await t.test('startEpic activates the first pending phase and queues downstream phases', async () => {
    let epicMasterCreated = false;
    globalThis.__mockFetch = async (url, options = {}) => {
      const urlText = String(url);
      const method = options.method || 'GET';

      if (urlText.includes('/git/ref/heads/feature/epic-autopilot')) {
        if (epicMasterCreated) {
          return { ok: true, status: 200, json: async () => ({ object: { sha: 'epic-sha' } }) };
        }
        return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"message":"Not Found"}' };
      }
      if (urlText.includes('/git/ref/heads/develop')) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: 'develop-sha' } }) };
      }
      if (urlText.includes('/git/ref/heads/feature/')) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: 'epic-sha' } }) };
      }
      if (urlText.endsWith('/git/refs') && method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.ref === 'refs/heads/feature/epic-autopilot') {
          epicMasterCreated = true;
        }
        return { ok: true, status: 201, json: async () => ({ ref: body.ref }) };
      }
      throw new Error(`Unexpected outgoing HTTP fetch call intercepted: ${url}`);
    };

    const { epicId, phaseIds } = await createEpicFromPayload({
      epic_title: 'Autopilot Epic',
      master_feature_branch: 'feature/epic-autopilot',
      target_base_branch: 'develop',
      phases: [
        { title: 'Autopilot Phase 1', tasks: [] },
        { title: 'Autopilot Phase 2', tasks: [] },
        { title: 'Autopilot Phase 3', tasks: [] }
      ]
    });

    const result = await startEpic(epicId);
    assert.strictEqual(result.started, true);
    assert.strictEqual(result.activePhaseId, phaseIds[0]);
    assert.deepStrictEqual(result.queuedPhaseIds, []);

    const phase1 = await queries.getPhase(phaseIds[0]);
    const phase2 = await queries.getPhase(phaseIds[1]);
    const phase3 = await queries.getPhase(phaseIds[2]);
    assert.strictEqual(phase1.status, 'active');
    assert.strictEqual(phase2.status, 'queued');
    assert.strictEqual(phase3.status, 'queued');

    poller.stopPoller(phaseIds[0]);
  });

  await t.test('pausePhase and resumePhase persist supervisor pause state', async () => {
    globalThis.__mockFetch = async (url, options = {}) => {
      const urlText = String(url).toLowerCase();
      if (urlText.includes('/git/ref/heads/')) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: 'pause-base-sha' } }) };
      }
      if (urlText.endsWith('/git/refs') && options.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ ref: 'refs/heads/pause-branch' }) };
      }
      throw new Error(`Unexpected outgoing HTTP fetch call intercepted: ${url}`);
    };

    const { phaseId } = await createPhaseFromPayload({ title: 'Pause Resume Phase' });
    await startPhase(phaseId);

    const pauseResult = await pausePhase(phaseId);
    assert.strictEqual(pauseResult.paused, true);
    let phase = await queries.getPhase(phaseId);
    assert.strictEqual(phase.status, 'paused');
    assert.ok(!poller.getPollerHealth().activePhaseIds.includes(phaseId));

    const skipped = await poller.runPollCycle(phaseId);
    assert.deepStrictEqual(skipped, { skipped: true, reason: 'manually_paused' });

    const resumeResult = await resumePhase(phaseId);
    assert.strictEqual(resumeResult.resumed, true);
    phase = await queries.getPhase(phaseId);
    assert.strictEqual(phase.status, 'active');
    assert.ok(poller.getPollerHealth().activePhaseIds.includes(phaseId));

    poller.stopPoller(phaseId);
  });
});
