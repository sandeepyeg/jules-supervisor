import nodeFetch from 'node-fetch';
import { recordRetry } from '../core/metrics.js';

const baseFetch = (...args) => (globalThis.__mockFetch || nodeFetch)(...args);

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 2;
// Real backoff in production; near-zero in the test suite so retries don't add wall-clock time.
const DEFAULT_BASE_DELAY_MS = process.env.JULES_SUPERVISOR_TEST === '1' ? 1 : 300;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch wrapper with exponential-backoff retry for transient failures
 * (network errors and 429/5xx responses). Only use this for idempotent/safe
 * calls (GET reads, or requests with no external side effect) — retrying a
 * mutating call (create/merge/send) risks duplicating the action if the
 * original request actually succeeded server-side before the response was lost.
 */
export async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const maxRetries = retryOptions.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = retryOptions.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const isLastAttempt = attempt === maxRetries;
    try {
      const response = await baseFetch(url, options);
      if (!response.ok && RETRYABLE_STATUS_CODES.has(response.status) && !isLastAttempt) {
        console.warn(`Retryable HTTP ${response.status} from ${url} (attempt ${attempt + 1}/${maxRetries + 1}). Retrying...`);
        recordRetry();
        await delay(baseDelayMs * 2 ** attempt);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (isLastAttempt) {
        throw err;
      }
      console.warn(`Network error calling ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying...`);
      recordRetry();
      await delay(baseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
