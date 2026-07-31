// Lightweight in-memory operational metrics. Intentionally not persisted — these
// reset on restart, which is fine for "is anything degraded right now" visibility;
// anything that needs to survive a restart belongs in the database instead.

let aiCallsTotal = 0;
let aiCallSuccesses = 0;
let aiCallFailures = 0;
let httpRetriesTotal = 0;

export function recordAiCall(success) {
  aiCallsTotal++;
  if (success) {
    aiCallSuccesses++;
  } else {
    aiCallFailures++;
  }
}

export function recordRetry() {
  httpRetriesTotal++;
}

export function getMetrics() {
  return {
    ai: {
      callsTotal: aiCallsTotal,
      successes: aiCallSuccesses,
      failures: aiCallFailures
    },
    httpRetriesTotal
  };
}
