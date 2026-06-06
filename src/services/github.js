import nodeFetch from 'node-fetch';
const fetch = (...args) => (globalThis.__mockFetch || nodeFetch)(...args);

const getHeaders = (extraHeaders = {}) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not defined in environment variables');
  }
  return {
    'Authorization': `Bearer ${token}`,
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
  const getRefResponse = await fetch(refUrl, {
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
  
  const response = await fetch(url, {
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
 * Merges a pull request using the squash method.
 */
export async function mergePR(prNumber, prTitle) {
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
