import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { inMemoryDb, resetInMemoryDb } from '../src/db/connection.js';
import { startReadyTasks, getRateLimitStatus, resetLaunchThrottlesForTests } from '../src/core/taskManager.js';
import * as queries from '../src/db/queries.js';

test('Task launch throttling keeps phases draining over time', async (t) => {
  t.beforeEach(() => {
    resetInMemoryDb();
    resetLaunchThrottlesForTests();
    let sessionCounter = 0;
    globalThis.__mockFetch = async (url, options = {}) => {
      if (String(url).includes('/sessions') && options.method === 'POST') {
        sessionCounter += 1;
        return {
          ok: true,
          json: async () => ({ name: `sessions/mock-session-${sessionCounter}` }),
          text: async () => ''
        };
      }
      return { ok: true, json: async () => ({}), text: async () => '' };
    };
  });

  t.afterEach(() => {
    delete globalThis.__mockFetch;
    resetLaunchThrottlesForTests();
  });

  async function insertRecentLaunchedTasks(count) {
    for (let i = 0; i < count; i++) {
      inMemoryDb.tasks.push({
        id: 10000 + i,
        phase_id: 999,
        title: `Historical Session ${i}`,
        description: '',
        status: 'merged',
        sort_order: i,
        depends_on: JSON.stringify([]),
        jules_session_id: `historical-${i}`,
        created_at: new Date(Date.now() - 60 * 60 * 1000),
        jules_launched_at: new Date(Date.now() - 60 * 60 * 1000),
        updated_at: new Date()
      });
    }
  }

  async function createReadyPhase(taskCount) {
    const phaseId = await queries.createPhase({
      title: 'Launch Throttle Phase',
      status: 'active',
      phase_branch: 'feature/launch-throttle',
      main_branch: 'feature/epic'
    });

    for (let i = 0; i < taskCount; i++) {
      inMemoryDb.tasks.push({
        id: 20000 + i,
        phase_id: phaseId,
        title: `Ready Task ${i}`,
        description: 'Ready to launch',
        status: 'queued',
        sort_order: i,
        depends_on: JSON.stringify([]),
        jules_session_id: null,
        jules_launched_at: null,
        created_at: new Date(),
        updated_at: new Date()
      });
    }

    return phaseId;
  }

  await t.test('concurrency limit holds launching when 15 sessions are active', async () => {
    const phaseId = await createReadyPhase(1);
    // Simulate 15 active running tasks
    for (let i = 0; i < 15; i++) {
      inMemoryDb.tasks.push({
        id: 40000 + i,
        phase_id: 999,
        title: `Active Task ${i}`,
        status: 'running',
        jules_session_id: `active-session-${i}`
      });
    }

    const started = await startReadyTasks(phaseId, 'feature/launch-throttle');
    assert.strictEqual(started, 0);

    const task = inMemoryDb.tasks.find(t => t.phase_id === phaseId);
    assert.strictEqual(task.status, 'queued');
  });

  await t.test('Jules FAILED_PRECONDITION launch response holds queued tasks with short 2m backoff', async () => {
    globalThis.__mockFetch = async (url, options = {}) => {
      if (String(url).includes('/sessions') && options.method === 'POST') {
        return {
          ok: false,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({
            error: {
              code: 400,
              message: 'Precondition check failed.',
              status: 'FAILED_PRECONDITION'
            }
          })
        };
      }
      return { ok: true, json: async () => ({}), text: async () => '' };
    };

    const phaseId = await createReadyPhase(2);
    const started = await startReadyTasks(phaseId, 'feature/launch-throttle');
    const phaseTasks = inMemoryDb.tasks.filter(t => t.phase_id === phaseId);

    assert.strictEqual(started, 0);
    assert.strictEqual(phaseTasks.filter(t => t.status === 'queued').length, 2);
    assert.strictEqual(phaseTasks.filter(t => t.jules_session_id).length, 0);
    assert.strictEqual(getRateLimitStatus().isDailyLimited, true);
  });
});
