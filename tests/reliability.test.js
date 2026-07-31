import '../src/core/env.js';
import test from 'node:test';
import assert from 'node:assert';
import { fetchWithRetry } from '../src/services/httpRetry.js';
import * as github from '../src/services/github.js';

function mockResponse(body, ok = true, status = 200, statusText = 'OK') {
  return {
    ok,
    status,
    statusText,
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

test('fetchWithRetry', async (t) => {
  t.after(() => {
    delete globalThis.__mockFetch;
  });

  await t.test('returns immediately on success without retrying', async () => {
    let calls = 0;
    globalThis.__mockFetch = async () => {
      calls++;
      return mockResponse({ ok: true });
    };

    const response = await fetchWithRetry('https://example.com/ok');
    assert.strictEqual(response.ok, true);
    assert.strictEqual(calls, 1);
  });

  await t.test('retries a transient network error and succeeds', async () => {
    let calls = 0;
    globalThis.__mockFetch = async () => {
      calls++;
      if (calls < 3) {
        throw new Error('ECONNRESET');
      }
      return mockResponse({ ok: true });
    };

    const response = await fetchWithRetry('https://example.com/flaky', {}, { maxRetries: 2, baseDelayMs: 1 });
    assert.strictEqual(response.ok, true);
    assert.strictEqual(calls, 3);
  });

  await t.test('retries a 503 response and succeeds', async () => {
    let calls = 0;
    globalThis.__mockFetch = async () => {
      calls++;
      if (calls === 1) {
        return mockResponse({}, false, 503, 'Service Unavailable');
      }
      return mockResponse({ ok: true });
    };

    const response = await fetchWithRetry('https://example.com/retryable-status', {}, { maxRetries: 2, baseDelayMs: 1 });
    assert.strictEqual(response.ok, true);
    assert.strictEqual(calls, 2);
  });

  await t.test('does not retry a non-retryable 404 response', async () => {
    let calls = 0;
    globalThis.__mockFetch = async () => {
      calls++;
      return mockResponse({}, false, 404, 'Not Found');
    };

    const response = await fetchWithRetry('https://example.com/missing', {}, { maxRetries: 2, baseDelayMs: 1 });
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.status, 404);
    assert.strictEqual(calls, 1);
  });

  await t.test('throws after exhausting all retries on persistent failure', async () => {
    let calls = 0;
    globalThis.__mockFetch = async () => {
      calls++;
      throw new Error('network down');
    };

    await assert.rejects(
      () => fetchWithRetry('https://example.com/always-fails', {}, { maxRetries: 2, baseDelayMs: 1 }),
      /network down/
    );
    assert.strictEqual(calls, 3); // initial attempt + 2 retries
  });
});

test('findOpenPRForTask matching heuristic', async (t) => {
  t.after(() => {
    delete globalThis.__mockFetch;
  });

  await t.test('matches a PR whose branch contains the full session ID', async () => {
    globalThis.__mockFetch = async () => mockResponse([
      { number: 1, head: { ref: 'unrelated-branch' } },
      { number: 2, head: { ref: 'jules/session_abcdef1234567890-work' } }
    ]);

    const match = await github.findOpenPRForTask('session_abcdef1234567890', 'feature/phase-1');
    assert.ok(match);
    assert.strictEqual(match.number, 2);
  });

  await t.test('matches a PR whose branch only contains the truncated session ID prefix', async () => {
    const longSessionId = 'session_abcdefghijklmnopqrstuvwxyz0123456789';
    globalThis.__mockFetch = async () => mockResponse([
      { number: 3, head: { ref: `jules/${longSessionId.substring(0, 16)}-truncated` } }
    ]);

    const match = await github.findOpenPRForTask(longSessionId, 'feature/phase-1');
    assert.ok(match);
    assert.strictEqual(match.number, 3);
  });

  await t.test('returns null without any network call for an undefined session ID', async () => {
    globalThis.__mockFetch = async () => {
      throw new Error('should not be called for an unsafe session ID');
    };

    const match = await github.findOpenPRForTask(undefined, 'feature/phase-1');
    assert.strictEqual(match, null);
  });

  await t.test('returns null without any network call for a too-short session ID', async () => {
    globalThis.__mockFetch = async () => {
      throw new Error('should not be called for an unsafe session ID');
    };

    const match = await github.findOpenPRForTask('short', 'feature/phase-1');
    assert.strictEqual(match, null);
  });

  await t.test('when multiple PRs match, returns the first match instead of throwing', async () => {
    const sessionId = 'session_ambiguous_1234567890';
    globalThis.__mockFetch = async () => mockResponse([
      { number: 10, head: { ref: `jules/${sessionId}-a` } },
      { number: 11, head: { ref: `jules/${sessionId}-b` } }
    ]);

    const match = await github.findOpenPRForTask(sessionId, 'feature/phase-1');
    assert.ok(match);
    assert.strictEqual(match.number, 10);
  });

  await t.test('returns null and does not throw when the GitHub API call fails', async () => {
    globalThis.__mockFetch = async () => {
      throw new Error('GitHub API unavailable');
    };

    const match = await github.findOpenPRForTask('session_network_failure_case', 'feature/phase-1');
    assert.strictEqual(match, null);
  });
});
