import '../src/core/env.js';
process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { enqueueMerge, getQueueStatus } from '../src/core/mergeQueue.js';

test('Sequential Auto-Merge Pipeline Suite', async (t) => {
  await t.test('executes concurrent merge requests sequentially for the same target branch', async () => {
    const executionOrder = [];
    const branch = 'feature/phase-test-queue';

    const p1 = enqueueMerge(branch, async () => {
      await new Promise(r => setTimeout(r, 50));
      executionOrder.push('PR-1');
      return 'PR-1-MERGED';
    });

    const p2 = enqueueMerge(branch, async () => {
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push('PR-2');
      return 'PR-2-MERGED';
    });

    const p3 = enqueueMerge(branch, async () => {
      await new Promise(r => setTimeout(r, 10));
      executionOrder.push('PR-3');
      return 'PR-3-MERGED';
    });

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    assert.strictEqual(res1, 'PR-1-MERGED');
    assert.strictEqual(res2, 'PR-2-MERGED');
    assert.strictEqual(res3, 'PR-3-MERGED');

    // Despite PR-2 and PR-3 having shorter timeout, PR-1 MUST finish before PR-2, and PR-2 before PR-3
    assert.deepStrictEqual(executionOrder, ['PR-1', 'PR-2', 'PR-3']);
  });

  await t.test('allows concurrent execution across different target branches', async () => {
    const executionOrder = [];

    const p1 = enqueueMerge('feature/phase-A', async () => {
      await new Promise(r => setTimeout(r, 50));
      executionOrder.push('Branch-A');
      return 'A-DONE';
    });

    const p2 = enqueueMerge('feature/phase-B', async () => {
      await new Promise(r => setTimeout(r, 10));
      executionOrder.push('Branch-B');
      return 'B-DONE';
    });

    await Promise.all([p1, p2]);

    // Branch B finishes faster because it runs on a separate queue
    assert.deepStrictEqual(executionOrder, ['Branch-B', 'Branch-A']);
  });
});
