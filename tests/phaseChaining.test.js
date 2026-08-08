import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { resetInMemoryDb, useMockDb } from '../src/db/connection.js';
import * as queries from '../src/db/queries.js';
import { createEpicFromPayload, createPhaseInEpicFromPayload, createPhaseFromPayload } from '../src/core/phaseImport.js';
import * as github from '../src/services/github.js';
import * as poller from '../src/core/poller.js';

test('Dependent Phases, Epics & Auto-Merge Suite', async (t) => {
  t.beforeEach(() => {
    resetInMemoryDb();
  });

  await t.test('1. Imports multi-phase JSON roadmap and creates linked Epic & phases', async () => {
    const payload = {
      epic_title: 'Test Epic Roadmap',
      master_feature_branch: 'feature/epic-test-101',
      target_base_branch: 'develop',
      phases: [
        {
          title: 'Phase 1: Foundations',
          tasks: [
            { title: 'Task 1.1', description: 'Setup base' }
          ]
        },
        {
          title: 'Phase 2: Core Features',
          depends_on_index: 0,
          tasks: [
            { title: 'Task 2.1', description: 'Build feature', depends_on: [0] }
          ]
        }
      ]
    };

    const result = await createEpicFromPayload(payload);
    assert.ok(result.epicId > 0);
    assert.strictEqual(result.masterBranch, 'feature/epic-test-101');
    assert.strictEqual(result.phaseIds.length, 2);

    const phase1 = await queries.getPhase(result.phaseIds[0]);
    assert.strictEqual(phase1.title, 'Phase 1: Foundations');
    assert.strictEqual(phase1.status, 'draft');
    assert.strictEqual(phase1.depends_on_phase_id, null);

    const phase2 = await queries.getPhase(result.phaseIds[1]);
    assert.strictEqual(phase2.title, 'Phase 2: Core Features');
    assert.strictEqual(phase2.status, 'queued');
    assert.strictEqual(phase2.depends_on_phase_id, result.phaseIds[0]);
  });

  await t.test('2. Appends single phase JSON payload into an existing Epic container', async () => {
    const epicId = await queries.createEpic({
      title: 'Manual Epic',
      master_feature_branch: 'feature/epic-manual-202',
      target_base_branch: 'develop'
    });

    const phasePayload1 = {
      title: 'Single Phase A',
      tasks: [{ title: 'Subtask A' }]
    };

    const import1 = await createPhaseInEpicFromPayload(epicId, phasePayload1);
    assert.strictEqual(import1.epicId, epicId);
    assert.ok(import1.phaseId > 0);

    const phasePayload2 = {
      title: 'Single Phase B',
      tasks: [{ title: 'Subtask B' }]
    };

    const import2 = await createPhaseInEpicFromPayload(epicId, phasePayload2);
    assert.strictEqual(import2.dependsOnPhaseId, import1.phaseId);
  });

  await t.test('3. getQueuedPhasesReadyToStart returns queued phases when parent completes', async () => {
    const parentPhaseId = await queries.createPhase({
      title: 'Parent Phase',
      status: 'complete'
    });

    const childPhaseId = await queries.createPhase({
      title: 'Child Phase',
      status: 'queued',
      depends_on_phase_id: parentPhaseId
    });

    const readyPhases = await queries.getQueuedPhasesReadyToStart();
    assert.ok(readyPhases.some(p => p.id === childPhaseId));
  });

  await t.test('4. github.mergeBranch handles branch merging safely', async () => {
    // Intercept fetch for mock
    let mergedCalled = false;
    globalThis.__mockFetch = async (url, opts) => {
      if (url.includes('/merges')) {
        mergedCalled = true;
        return {
          ok: true,
          json: async () => ({ sha: 'mock_merged_sha_123', merged: true })
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    try {
      const res = await github.mergeBranch('feature/phase-1', 'feature/epic-main', 'Auto merge phase 1');
      assert.strictEqual(res.merged, true);
      assert.strictEqual(mergedCalled, true);
    } finally {
      delete globalThis.__mockFetch;
    }
  });

  await t.test('5. queries.getEpics returns all created epics sorted by id desc', async () => {
    const epic1 = await queries.createEpic({ title: 'Epic 1', master_feature_branch: 'feature/epic-1' });
    const epic2 = await queries.createEpic({ title: 'Epic 2', master_feature_branch: 'feature/epic-2' });

    const epics = await queries.getEpics();
    assert.ok(epics.length >= 2);
    assert.strictEqual(epics[0].id, epic2);
    assert.strictEqual(epics[1].id, epic1);
  });

  await t.test('6. Single-screen Epic roadmap aggregates all phases and tasks for an Epic', async () => {
    const epicId = await queries.createEpic({
      title: 'Full Website Rebuild 2026',
      master_feature_branch: 'feature/epic-website-2026',
      target_base_branch: 'develop'
    });

    const phase1Res = await createPhaseInEpicFromPayload(epicId, {
      title: 'Phase 1: Design Tokens',
      tasks: [{ title: 'Token CSS', description: 'Tokens description' }]
    });

    const phase2Res = await createPhaseInEpicFromPayload(epicId, {
      title: 'Phase 2: Auth Flow',
      tasks: [{ title: 'OAuth Route', description: 'Auth description' }]
    });

    const allPhases = await queries.getPhases();
    const epicPhases = allPhases.filter(p => p.epic_id === epicId);

    assert.strictEqual(epicPhases.length, 2);
    const p1 = epicPhases.find(p => p.id === phase1Res.phaseId);
    const p2 = epicPhases.find(p => p.id === phase2Res.phaseId);
    assert.strictEqual(p1.title, 'Phase 1: Design Tokens');
    assert.strictEqual(p2.title, 'Phase 2: Auth Flow');

    const tasksP1 = await queries.getTasksForPhase(phase1Res.phaseId);
    const tasksP2 = await queries.getTasksForPhase(phase2Res.phaseId);

    assert.strictEqual(tasksP1.length, 1);
    assert.strictEqual(tasksP1[0].title, 'Token CSS');
    assert.strictEqual(tasksP2.length, 1);
    assert.strictEqual(tasksP2[0].title, 'OAuth Route');
  });
});
