import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { pool, resetInMemoryDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import { createPhaseFromPayload } from '../src/core/phaseImport.js';
import phasesRouter from '../src/api/phases.js';
import { getPortalSecret } from '../src/api/auth.js';

test('createPhaseFromPayload — bulk phase/task import (shared by the dashboard and Telegram)', async (t) => {
  t.beforeEach(() => resetInMemoryDb());
  t.after(async () => {
    await pool.end();
  });

  await t.test('creates a phase and tasks, resolving index-based depends_on to real task ids', async () => {
    const { phaseId, taskCount } = await createPhaseFromPayload({
      title: 'Imported Phase',
      description: 'Created from one JSON blob.',
      mainBranch: 'main',
      tasks: [
        { title: 'Task A', description: 'first' },
        { title: 'Task B', description: 'second', depends_on: [0] }
      ]
    });

    assert.strictEqual(taskCount, 2);

    const phase = await queries.getPhase(phaseId);
    assert.strictEqual(phase.title, 'Imported Phase');
    assert.strictEqual(phase.status, 'draft');

    const [tasks] = await pool.query('SELECT * FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC', [phaseId]);
    assert.strictEqual(tasks.length, 2);
    const taskA = tasks[0];
    const taskB = tasks[1];
    const depsB = JSON.parse(taskB.depends_on);
    assert.deepStrictEqual(depsB, [taskA.id]);
  });

  await t.test('rejects a payload with no title', async () => {
    await assert.rejects(
      () => createPhaseFromPayload({ tasks: [{ title: 'Task A' }] }),
      /title.*required/i
    );
  });

  await t.test('rejects a task missing a title', async () => {
    await assert.rejects(
      () => createPhaseFromPayload({ title: 'Phase X', tasks: [{ description: 'no title here' }] }),
      /missing a "title"/i
    );
  });

  await t.test('rejects a non-array tasks field', async () => {
    await assert.rejects(
      () => createPhaseFromPayload({ title: 'Phase X', tasks: 'not-an-array' }),
      /must be an array/i
    );
  });

  await t.test('accepts a phase with no tasks at all', async () => {
    const { taskCount } = await createPhaseFromPayload({ title: 'Empty Phase' });
    assert.strictEqual(taskCount, 0);
  });

  await t.test('POST /api/phases uses the same shared path end-to-end', async () => {
    const req = {
      method: 'POST',
      url: '/',
      headers: { 'x-portal-key': getPortalSecret() },
      body: {
        title: 'Router Import Test',
        tasks: [{ title: 'Only task' }]
      }
    };
    let responseStatus = null;
    let responseBody = null;
    const res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };

    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => { origJson.call(res, data); resolve(); return res; };
      phasesRouter(req, res, () => resolve());
    });

    assert.strictEqual(responseStatus, 201);
    assert.ok(responseBody.phaseId);
  });

  await t.test('POST /api/phases returns 400 (not 500) for a validation failure', async () => {
    const req = {
      method: 'POST',
      url: '/',
      headers: { 'x-portal-key': getPortalSecret() },
      body: { tasks: [{ title: 'Orphan task, no phase title' }] }
    };
    let responseStatus = null;
    let responseBody = null;
    const res = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };

    await new Promise((resolve) => {
      const origJson = res.json;
      res.json = (data) => { origJson.call(res, data); resolve(); return res; };
      phasesRouter(req, res, () => resolve());
    });

    assert.strictEqual(responseStatus, 400);
    assert.ok(responseBody.error.includes('title'));
  });
});
