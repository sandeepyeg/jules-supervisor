import nodeFetch from 'node-fetch';
const fetch = (...args) => (globalThis.__mockFetch || nodeFetch)(...args);

const getHeaders = () => {
  const apiKey = process.env.JULES_API_KEY;
  if (!apiKey) {
    throw new Error('JULES_API_KEY is not defined in environment variables');
  }
  return {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': apiKey
  };
};

const getBaseUrl = () => {
  return process.env.JULES_BASE_URL || 'https://jules.googleapis.com/v1alpha';
};

/**
 * Creates a new Jules coding session.
 */
export async function createSession(prompt, sprintBranch, julesNotes) {
  const url = `${getBaseUrl()}/sessions`;
  
  const fullPrompt = `${julesNotes ? julesNotes + '\n\n' : ''}${prompt}`;
  const title = fullPrompt.substring(0, 80);
  
  const body = {
    prompt: fullPrompt,
    sourceContext: {
      source: process.env.JULES_REPO_SOURCE,
      githubRepoContext: {
        startingBranch: sprintBranch
      }
    },
    title: title,
    automationMode: 'AUTO_CREATE_PR',
    requirePlanApproval: false
  };

  console.log(`Creating Jules session: "${title}" on starting branch: "${sprintBranch}"`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create Jules session: ${response.statusText} - ${errText}`);
  }

  const data = await response.json();
  const sessionId = data.name.split('/').pop();
  return { sessionId };
}

/**
 * Retrieves the full session object.
 */
export async function getSession(sessionId) {
  const url = `${getBaseUrl()}/sessions/${sessionId}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders()
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to get Jules session ${sessionId}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Lists activities for a session.
 */
export async function listActivities(sessionId) {
  const url = `${getBaseUrl()}/sessions/${sessionId}/activities?pageSize=50`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders()
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to list activities for session ${sessionId}: ${response.statusText} - ${errText}`);
  }

  const data = await response.json();
  return data.activities || [];
}

/**
 * Filters the session activities to find the latest agent generated message.
 */
export async function getLatestAgentMessage(sessionId) {
  const activities = await listActivities(sessionId);
  
  // Sort activities chronologically by createTime if not already sorted, or find the latest.
  // The API returns them, but let's filter first: originator = 'agent' and messageGenerated exists
  const agentMessages = activities.filter(
    act => act.originator === 'agent' && act.messageGenerated && act.messageGenerated.message
  );

  if (agentMessages.length === 0) {
    return null;
  }

  // Sort by createTime ascending so we can grab the last (most recent) one, or just take the last element if API is pre-sorted
  agentMessages.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  const latest = agentMessages[agentMessages.length - 1];

  return {
    text: latest.messageGenerated.message,
    activityId: latest.name // Use name as unique activityId
  };
}

/**
 * Approves the plan for a session.
 */
export async function approvePlan(sessionId) {
  const url = `${getBaseUrl()}/sessions/${sessionId}:approvePlan`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to approve plan for session ${sessionId}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Sends a message/response back to the Jules agent.
 */
export async function sendMessage(sessionId, prompt) {
  const url = `${getBaseUrl()}/sessions/${sessionId}:sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ prompt })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to send message to session ${sessionId}: ${response.statusText} - ${errText}`);
  }

  return response.json();
}
