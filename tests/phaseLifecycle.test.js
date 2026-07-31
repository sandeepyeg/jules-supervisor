import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { pool, resetInMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import { createPhaseFromPayload } from '../src/core/phaseImport.js';
import { startPhase } from '../src/core/phaseLifecycle.js';
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
});
