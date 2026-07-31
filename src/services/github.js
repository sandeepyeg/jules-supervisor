import nodeFetch from 'node-fetch';
import { NEVER_MERGE_TO_MAIN } from '../core/config.js';
import { fetchWithRetry } from './httpRetry.js';

// Mutating calls (branch/PR creation, approve, merge, update-branch) intentionally
// use this raw, non-retrying fetch: retrying them on a lost response risks duplicating
// the action (e.g. two branches, a double merge attempt) if the original request
// already succeeded server-side. Read-only calls below use fetchWithRetry instead.
const fetch = (...args) => (globalThis.__mockFetch || nodeFetch)(...args);

const getHeaders = (extraHeaders = {}) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not defined in environment variables');
  }
  const authHeader = token.startsWith('ghp_') || token.startsWith('github_pat_')
    ? `token ${token}`
    : `Bearer ${token}`;
  return {
    'Authorization': authHeader,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'jules-supervisor',
    ...extraHeaders
  };
};

const getRepoUrl = () => {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    throw new Error('GITHUB_OWNER and GITHUB_REPO must be defined in environment variables');
  }
  return `https://api.github.com/repos/${owner}/${repo}`;
};

/**
 * Creates a branch from a reference branch.
 */
export async function createBranch(newBranchName, fromBranch) {
  const repoUrl = getRepoUrl();
  
  // 1. Get reference branch SHA
  const refUrl = `${repoUrl}/git/ref/heads/${fromBranch}`;
  const getRefResponse = await fetchWithRetry(refUrl, {
    method: 'GET',
    headers: getHeaders()
  });

  if (!getRefResponse.ok) {
    const errText = await getRefResponse.text();
    throw new Error(`Failed to get branch ref for ${fromBranch}: ${getRefResponse.statusText} - ${errText}`);
  }

  const refData = await getRefResponse.json();
  const sha = refData.object.sha;

  // 2. Create the new branch ref
  const createRefUrl = `${repoUrl}/git/refs`;
  const body = {
    ref: `refs/heads/${newBranchName}`,
    sha: sha
  };

  const createResponse = await fetch(createRefUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!createResponse.ok) {
    const errText = await createResponse.text();
    // If branch already exists, we might want to log it or handle it. Let's throw for now so supervisor knows.
    throw new Error(`Failed to create branch ${newBranchName}: ${createResponse.statusText} - ${errText}`);
  }

  return createResponse.json();
}

/**
 * Retrieves the raw diff for a pull request.
 */
export async function getPRDiff(prNumber) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls/${prNumber}`;

  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: getHeaders({ 'Accept': 'application/vnd.github.diff' })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to get diff for PR #${prNumber}: ${response.statusText} - ${errText}`);
  }

  return response.text();
}

/**
 * Approves a pull request.
 */
export async function approvePR(prNumber) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls/${prNumber}/reviews`;
  
  const body = {
    event: 'APPROVE',
    body: 'Approved by Jules Supervisor after automated review.'
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to approve PR #${prNumber}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Posts a "request changes" review on a pull request, giving blocking feedback a
 * durable, visible record on GitHub in addition to the internal Jules session message.
 */
export async function requestChangesOnPR(prNumber, body) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls/${prNumber}/reviews`;

  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ event: 'REQUEST_CHANGES', body })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to request changes on PR #${prNumber}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Posts a plain (non-review) comment on a pull request. Used as a fallback when
 * requestChangesOnPR fails (e.g. a self-review restriction), and for informational
 * notes like "auto-review limit reached" that aren't a formal change request.
 */
export async function addPRComment(prNumber, body) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/issues/${prNumber}/comments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ body })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to comment on PR #${prNumber}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Merges a pull request using the squash method.
 */
export async function mergePR(prNumber, prTitle, expectedBaseBranch) {
  // 1. Fetch current PR details to verify base branch
  const pr = await getPR(prNumber);
  const baseBranch = pr.base?.ref;

  if (!baseBranch) {
    throw new Error(`Failed to retrieve base branch for PR #${prNumber}`);
  }

  // 2. Validate expectedBaseBranch if provided
  if (expectedBaseBranch && baseBranch !== expectedBaseBranch) {
    throw new Error(`PR #${prNumber} base branch "${baseBranch}" does not match expected branch "${expectedBaseBranch}". Merge aborted.`);
  }

  // 3. Refuse merge if base branch is main
  if (baseBranch === 'main') {
    throw new Error(`Squash merge of PR #${prNumber} into "main" is strictly forbidden.`);
  }

  // 4. Final hard guard NEVER_MERGE_TO_MAIN
  if (NEVER_MERGE_TO_MAIN && baseBranch === 'main') {
    throw new Error(`Squash merge of PR #${prNumber} into "main" is blocked by NEVER_MERGE_TO_MAIN.`);
  }

  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls/${prNumber}/merge`;
  
  const body = {
    commit_title: prTitle,
    merge_method: 'squash'
  };

  const response = await fetch(url, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to merge PR #${prNumber}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Parses the PR number from a pull request URL.
 */
export function getPRNumber(prUrl) {
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Builds the web (non-API) PR URL for the currently configured GITHUB_OWNER/GITHUB_REPO.
 */
export function getPRWebUrl(prNumber) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    throw new Error('GITHUB_OWNER and GITHUB_REPO must be defined in environment variables');
  }
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

/**
 * Retrieves structured PR metadata.
 */
export async function getPR(prNumber) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls/${prNumber}`;
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: getHeaders()
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to get PR #${prNumber} metadata: ${response.statusText} - ${errText}`);
  }

  const data = await response.json();
  return {
    number: data.number,
    title: data.title,
    html_url: data.html_url,
    base: {
      ref: data.base?.ref
    },
    head: {
      ref: data.head?.ref,
      sha: data.head?.sha
    },
    state: data.state,
    merged: data.merged,
    mergeable: data.mergeable,
    mergeable_state: data.mergeable_state,
    draft: data.draft,
    changed_files: data.changed_files,
    additions: data.additions,
    deletions: data.deletions
  };
}

/**
 * Lists all open PRs targeting a specific base branch.
 */
export async function getPRsForBranch(baseBranch) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&per_page=100`;
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: getHeaders()
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to list PRs for branch ${baseBranch}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Finds an open PR on GitHub whose head branch contains the task's Jules session ID.
 * This is the primary GitHub-first PR detection mechanism used when Jules session
 * is still IN_PROGRESS but the PR was already opened.
 */
export async function findOpenPRForTask(sessionId, baseBranch) {
  const sessionIdStr = sessionId === undefined || sessionId === null ? '' : String(sessionId);

  // Require a reasonably long identifier before matching. A short/empty ID (e.g. from an
  // undefined sessionId turning into the literal string "undefined") could coincidentally
  // match an unrelated branch name and route review to the wrong PR.
  if (sessionIdStr.length < 8) {
    if (sessionIdStr) {
      console.warn(`findOpenPRForTask: session identifier "${sessionIdStr}" is too short to match safely. Skipping.`);
    }
    return null;
  }

  try {
    const prs = await getPRsForBranch(baseBranch);
    // Jules names branches with the (possibly truncated) session ID embedded in the head ref.
    const prefix = sessionIdStr.substring(0, 16);
    const matches = prs.filter(pr =>
      pr.head?.ref?.includes(sessionIdStr) || pr.head?.ref?.includes(prefix)
    );

    if (matches.length > 1) {
      console.warn(`findOpenPRForTask: ${matches.length} PRs matched session ${sessionIdStr} on branch ${baseBranch} (branches: ${matches.map(pr => pr.head?.ref).join(', ')}). Using the first match, PR #${matches[0].number}.`);
    }

    return matches[0] || null;
  } catch (err) {
    console.warn(`findOpenPRForTask error for session ${sessionIdStr}:`, err.message);
    return null;
  }
}

/**
 * Fetches all changed files in a PR, paginated if needed.
 */
export async function getPRFiles(prNumber) {
  const repoUrl = getRepoUrl();
  let files = [];
  let page = 1;
  while (true) {
    const url = `${repoUrl}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: getHeaders()
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to get files for PR #${prNumber}: ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    if (!data || data.length === 0) {
      break;
    }
    files = files.concat(data);
    if (data.length < 100) {
      break;
    }
    page++;
  }
  return files;
}

/**
 * Best-effort fetch of check runs and commit status.
 * Returns "passing", "failing", or "unknown".
 */
export async function getPRChecks(prNumber) {
  try {
    const pr = await getPR(prNumber);
    const sha = pr.head?.sha;
    if (!sha) return 'unknown';

    const repoUrl = getRepoUrl();
    
    // 1. Combined status
    const statusUrl = `${repoUrl}/commits/${sha}/status`;
    const statusResponse = await fetchWithRetry(statusUrl, {
      method: 'GET',
      headers: getHeaders()
    });
    
    let statusState = 'unknown';
    if (statusResponse.ok) {
      const statusData = await statusResponse.json();
      // GitHub returns "pending" for the combined status when no statuses exist.
      // Treat that as unknown so repos without CI do not look like failing CI.
      if (Number(statusData.total_count || 0) > 0) {
        statusState = statusData.state; // failure, pending, success, or error
      }
    }

    // 2. Check runs
    const checkRunsUrl = `${repoUrl}/commits/${sha}/check-runs`;
    const checksResponse = await fetchWithRetry(checkRunsUrl, {
      method: 'GET',
      headers: getHeaders()
    });

    let checkRunsState = 'unknown';
    if (checksResponse.ok) {
      const checksData = await checksResponse.json();
      const runs = checksData.check_runs || [];
      if (runs.length > 0) {
        const hasFailed = runs.some(run => run.status === 'completed' && ['failure', 'timed_out', 'action_required'].includes(run.conclusion));
        const hasPending = runs.some(run => run.status !== 'completed' || run.conclusion === null);
        if (hasFailed) {
          checkRunsState = 'failure';
        } else if (hasPending) {
          checkRunsState = 'pending';
        } else {
          checkRunsState = 'success';
        }
      } else {
        checkRunsState = 'success';
      }
    }

    // Combine states
    if (statusState === 'failure' || statusState === 'error' || checkRunsState === 'failure') {
      return 'failing';
    }
    if (statusState === 'pending' || checkRunsState === 'pending') {
      return 'failing';
    }
    if (statusState === 'success' && checkRunsState === 'success') {
      return 'passing';
    }
    if ((statusState === 'success' || statusState === 'unknown') && (checkRunsState === 'success' || checkRunsState === 'unknown')) {
      if (statusState === 'unknown' && checkRunsState === 'unknown') {
        return 'unknown';
      }
      return 'passing';
    }
    return 'unknown';
  } catch (error) {
    console.error(`Error getting PR checks for PR #${prNumber}:`, error);
    return 'unknown';
  }
}

/**
 * Creates a draft PR from phase branch to main.
 */
export async function createDraftPR(phaseBranch, mainBranch, title) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls`;
  const body = {
    title: title,
    head: phaseBranch,
    base: mainBranch,
    draft: true,
    body: `Automated draft PR created by Jules Supervisor to merge ${phaseBranch} into ${mainBranch} after phase completion. Please review manually.`
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create draft PR from ${phaseBranch} to ${mainBranch}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Fetches all heads/branches in the repository.
 */
export async function listBranches() {
  const repoUrl = getRepoUrl();
  const allBranches = [];
  let page = 1;

  while (true) {
    const url = `${repoUrl}/branches?per_page=100&page=${page}`;
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: getHeaders()
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to list branches: ${response.statusText} - ${errText}`);
    }

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    allBranches.push(...batch);
    if (batch.length < 100) break; // last page
    page++;
  }

  return allBranches;
}

/**
 * Automatically merges/rebases base branch updates into an open PR.
 */
export async function updatePRBranch(prNumber) {
  const repoUrl = getRepoUrl();
  const url = `${repoUrl}/pulls/${prNumber}/update-branch`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: getHeaders()
  });

  if (!response.ok) {
    const errText = await response.text();
    console.warn(`Could not auto-update branch for PR #${prNumber}: ${response.statusText} - ${errText}`);
    return false;
  }

  const data = await response.json();
  console.log(`Auto-updated base branch for PR #${prNumber}:`, data.message || 'success');
  return true;
}
