import test from 'node:test';
import assert from 'node:assert';
import { resetInMemoryDb, inMemoryDb } from '../src/db/connection.js';
import { checkStaleRunningTasks, clearAlertHistory } from '../src/core/staleWatcher.js';

test('StaleWatcher - detects running tasks older than threshold and alerts', async () => {
  resetInMemoryDb();
  clearAlertHistory();

  const phaseId = 10;
  inMemoryDb.phases.push({
    id: phaseId,
    title: 'Phase Stale Test',
    phase_branch: 'feature/phase-stale',
    status: 'active'
  });

  // Task running for 40 minutes (older than 30m threshold)
  const staleTime = new Date(Date.now() - 40 * 60 * 1000);
  inMemoryDb.tasks.push({
    id: 101,
    phase_id: phaseId,
    title: 'Stale Running Task',
    status: 'running',
    jules_session_id: 'session_stale_101',
    updated_at: staleTime
  });

  // Task running for 5 minutes (not stale)
  inMemoryDb.tasks.push({
    id: 102,
    phase_id: phaseId,
    title: 'Fresh Running Task',
    status: 'running',
    jules_session_id: 'session_fresh_102',
    updated_at: new Date()
  });

  const alertedCount = await checkStaleRunningTasks(30);
  assert.strictEqual(alertedCount, 1, 'Should alert for exactly 1 stale running task');
});
