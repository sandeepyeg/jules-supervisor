import test from 'node:test';
import assert from 'node:assert';

process.env.PRIMARY_SUPERVISOR_PROVIDER = 'google';
process.env.PRIMARY_SUPERVISOR_MODEL = 'gemini-primary';
process.env.BACKUP_SUPERVISOR_PROVIDER = 'openrouter';
process.env.BACKUP_SUPERVISOR_MODEL = 'qwen/qwen3.7-flash';
process.env.GOOGLE_FALLBACK_MODELS = 'gemini-secondary';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

const { reloadConfig } = await import('../src/core/config.js');
const ai = await import('../src/services/ai.js');

function mockResponse(body, ok = true, statusText = 'OK') {
  return {
    ok,
    statusText,
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

test('low-confidence Google answer does not spend paid fallback', async () => {
  reloadConfig();
  let openRouterCalls = 0;

  globalThis.__mockFetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return mockResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({ confidence: 4, answer: 'Unsure', reason: 'Not enough context' })
            }]
          }
        }]
      });
    }
    if (String(url).includes('openrouter.ai')) {
      openRouterCalls++;
      return mockResponse({});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await ai.askWithConfidence('context', 'question');

  assert.strictEqual(result.confidence, 4);
  assert.strictEqual(result.provider, 'google');
  assert.strictEqual(result.paidFallbackUsed, false);
  assert.strictEqual(openRouterCalls, 0);

  delete globalThis.__mockFetch;
});

test('Google fallback model is tried before paid fallback', async () => {
  reloadConfig();
  const calls = [];

  globalThis.__mockFetch = async (url) => {
    const textUrl = String(url);
    calls.push(textUrl);

    if (textUrl.includes('gemini-primary')) {
      return mockResponse({ error: { message: 'quota' } }, false, 'Too Many Requests');
    }
    if (textUrl.includes('gemini-secondary')) {
      return mockResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({ confidence: 9, answer: 'Use the existing interface.', reason: 'Context is clear' })
            }]
          }
        }]
      });
    }
    if (textUrl.includes('openrouter.ai')) {
      throw new Error('OpenRouter should not be called while Google fallback works');
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await ai.askWithConfidence('context', 'question');

  assert.strictEqual(result.confidence, 9);
  assert.strictEqual(result.provider, 'google');
  assert.strictEqual(result.model, 'gemini-secondary');
  assert.strictEqual(result.paidFallbackUsed, false);
  assert.ok(calls.some(url => url.includes('gemini-primary')));
  assert.ok(calls.some(url => url.includes('gemini-secondary')));
  assert.ok(!calls.some(url => url.includes('openrouter.ai')));

  delete globalThis.__mockFetch;
});

test('paid fallback is used only after all Google models fail', async () => {
  reloadConfig();
  const calls = [];

  globalThis.__mockFetch = async (url) => {
    const textUrl = String(url);
    calls.push(textUrl);

    if (textUrl.includes('generativelanguage.googleapis.com')) {
      return mockResponse({ error: { message: 'quota' } }, false, 'Too Many Requests');
    }
    if (textUrl.includes('openrouter.ai')) {
      return mockResponse({
        choices: [{
          message: {
            content: JSON.stringify({ confidence: 9, answer: 'Fallback answer', reason: 'Google unavailable' })
          }
        }]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await ai.askWithConfidence('context', 'question');

  assert.strictEqual(result.confidence, 9);
  assert.strictEqual(result.provider, 'openrouter');
  assert.strictEqual(result.model, 'qwen/qwen3.7-flash');
  assert.strictEqual(result.paidFallbackUsed, true);
  assert.ok(calls.some(url => url.includes('gemini-primary')));
  assert.ok(calls.some(url => url.includes('gemini-secondary')));
  assert.ok(calls.some(url => url.includes('openrouter.ai')));

  delete globalThis.__mockFetch;
});
