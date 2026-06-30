import test from 'node:test';
import assert from 'node:assert';
import { getQueuedReadyTasks } from '../src/db/queries.js';
import { pool } from '../src/db/connection.js';

test('Task Dependency Resolution Logic with Dummy Data', async (t) => {
  const originalQuery = pool.query;

  await t.test('returns tasks that start immediately when they have no dependencies', async () => {
    const dummyTasks = [
      { id: 'task_1', status: 'queued', depends_on: null },
      { id: 'task_2', status: 'queued', depends_on: JSON.stringify(['task_1']) }
    ];

    pool.query = async (sql, params) => {
      if (sql.includes('SELECT * FROM tasks WHERE phase_id = ?')) {
        return [dummyTasks];
      }
      return [[]];
    };

    const ready = await getQueuedReadyTasks(1);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].id, 'task_1');
  });

  await t.test('returns task 2 once task 1 is merged', async () => {
    const dummyTasks = [
      { id: 'task_1', status: 'merged', depends_on: null },
      { id: 'task_2', status: 'queued', depends_on: JSON.stringify(['task_1']) }
    ];

    pool.query = async (sql, params) => {
      if (sql.includes('SELECT * FROM tasks WHERE phase_id = ?')) {
        return [dummyTasks];
      }
      return [[]];
    };

    const ready = await getQueuedReadyTasks(1);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].id, 'task_2');
  });

  await t.test('handles parallel tasks that wait for the same merged predecessor', async () => {
    const dummyTasks = [
      { id: 'task_1', status: 'merged', depends_on: null },
      { id: 'task_2', status: 'queued', depends_on: JSON.stringify(['task_1']) },
      { id: 'task_3', status: 'queued', depends_on: JSON.stringify(['task_1']) }
    ];

    pool.query = async (sql, params) => {
      if (sql.includes('SELECT * FROM tasks WHERE phase_id = ?')) {
        return [dummyTasks];
      }
      return [[]];
    };

    const ready = await getQueuedReadyTasks(1);
    assert.strictEqual(ready.length, 2);
    assert.ok(ready.some(task => task.id === 'task_2'));
    assert.ok(ready.some(task => task.id === 'task_3'));
  });

  await t.test('handles independent tasks executing immediately in parallel with sequenced tasks', async () => {
    const dummyTasks = [
      { id: 'task_1', status: 'queued', depends_on: null }, // sequenced 1
      { id: 'task_2', status: 'queued', depends_on: JSON.stringify(['task_1']) }, // sequenced 2
      { id: 'task_3', status: 'queued', depends_on: null } // independent (starts immediately)
    ];

    pool.query = async (sql, params) => {
      if (sql.includes('SELECT * FROM tasks WHERE phase_id = ?')) {
        return [dummyTasks];
      }
      return [[]];
    };

    const ready = await getQueuedReadyTasks(1);
    assert.strictEqual(ready.length, 2);
    assert.ok(ready.some(task => task.id === 'task_1'));
    assert.ok(ready.some(task => task.id === 'task_3'));
  });

  await t.test('resolves custom dependencies only when all predecessors are merged or skipped', async () => {
    const dummyTasks = [
      { id: 'task_1', status: 'merged', depends_on: null },
      { id: 'task_2', status: 'running', depends_on: null },
      { id: 'task_3', status: 'queued', depends_on: JSON.stringify(['task_1', 'task_2']) }
    ];

    pool.query = async (sql, params) => {
      if (sql.includes('SELECT * FROM tasks WHERE phase_id = ?')) {
        return [dummyTasks];
      }
      return [[]];
    };

    const ready = await getQueuedReadyTasks(1);
    assert.strictEqual(ready.length, 0);
  });

  pool.query = originalQuery;
  
  t.after(async () => {
    await pool.end();
  });
});
