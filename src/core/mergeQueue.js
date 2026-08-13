/**
 * Sequential Auto-Merge & Rebase Pipeline
 * Serializes pull request reviews and merges per phase branch to prevent
 * simultaneous merge race conditions and cascading merge conflicts.
 */

const branchQueues = new Map(); // branchName -> Promise chain

/**
 * Enqueues a PR review and merge operation on a specific branch.
 * Operations on the same target branch are executed sequentially.
 * Operations on different target branches can execute concurrently.
 * 
 * @param {string} branch - The target base branch name (e.g. feature/phase-24)
 * @param {Function} mergeFn - An async function that executes the review and merge
 * @returns {Promise<any>} The result of the mergeFn execution
 */
export async function enqueueMerge(branch, mergeFn) {
  const branchKey = branch || 'default';
  
  const currentQueue = branchQueues.get(branchKey) || Promise.resolve();

  let queueResolve, queueReject;
  const resultPromise = new Promise((resolve, reject) => {
    queueResolve = resolve;
    queueReject = reject;
  });

  // Chain this mergeFn execution after the previous merge in this branch queue
  const nextQueue = currentQueue
    .catch(() => {}) // Don't let previous failures break the queue chain
    .then(async () => {
      try {
        console.log(`[MergeQueue] Processing sequential merge slot for branch "${branchKey}"...`);
        const result = await mergeFn();
        queueResolve(result);
        return result;
      } catch (err) {
        console.error(`[MergeQueue] Error executing merge slot for branch "${branchKey}":`, err.message);
        queueReject(err);
      }
    });

  branchQueues.set(branchKey, nextQueue);

  // Clean up Map entry when queue goes idle
  nextQueue.finally(() => {
    if (branchQueues.get(branchKey) === nextQueue) {
      branchQueues.delete(branchKey);
    }
  });

  return resultPromise;
}

export function getQueueStatus() {
  return {
    activeBranches: [...branchQueues.keys()]
  };
}
