import nodeFetch from 'node-fetch';
import {
  PRIMARY_SUPERVISOR_PROVIDER,
  PRIMARY_SUPERVISOR_MODEL,
  BACKUP_SUPERVISOR_PROVIDER,
  BACKUP_SUPERVISOR_MODEL,
  AI_CONFIDENCE_THRESHOLD
} from '../core/config.js';

const fetch = (...args) => (globalThis.__mockFetch || nodeFetch)(...args);

/**
 * A generic function to call an AI provider/model.
 * Supports provider "google" (Gemini) and "openrouter" (DeepSeek/others).
 * Never logs API keys or secrets.
 */
export async function askModel(provider, model, prompt, options = {}) {
  const temperature = options.temperature !== undefined ? options.temperature : 0.2;
  const returnJson = !!options.returnJson;

  if (provider === 'google') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not defined in environment variables');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      generationConfig: {
        temperature: temperature
      }
    };

    if (returnJson) {
      body.generationConfig.responseMimeType = "application/json";
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google Gemini API request failed: ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    try {
      return data.candidates[0].content.parts[0].text;
    } catch (error) {
      throw new Error(`Unexpected Gemini response format: ${JSON.stringify(data)}`);
    }
  } else if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not defined in environment variables');
    }

    const url = `${baseUrl}/chat/completions`;
    const body = {
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: temperature
    };

    if (returnJson) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/sandeepyeg/jules-supervisor',
        'X-Title': 'Jules Supervisor'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API request failed: ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    try {
      return data.choices[0].message.content;
    } catch (error) {
      throw new Error(`Unexpected OpenRouter response format: ${JSON.stringify(data)}`);
    }
  } else {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }
}

/**
 * Backward compatibility: Calls Gemini Flash.
 */
export async function askGeminiFlash(prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-latest';
  return askModel('google', model, prompt, { temperature: 0.3 });
}

/**
 * Backward compatibility: Calls DeepSeek via OpenRouter.
 */
export async function askDeepSeek(prompt, returnJson = false) {
  const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';
  return askModel('openrouter', model, prompt, { returnJson, temperature: 0.3 });
}

/**
 * Formats a query and retrieves a structured answer with confidence metrics from the model.
 * Defaults to PRIMARY_SUPERVISOR_PROVIDER/MODEL.
 * Falls back to BACKUP_SUPERVISOR_PROVIDER/MODEL when:
 * 1. Primary call fails
 * 2. JSON parse fails
 * 3. Confidence is lower than the threshold
 */
export async function askWithConfidence(contextPrompt, question) {
  const prompt = `You are a supervisor for an AI coding agent. Given this project context and the agent's question, provide the best answer you can.
     
PROJECT CONTEXT:
${contextPrompt}
     
AGENT QUESTION:
${question}
     
Respond ONLY with valid JSON in this exact format:
{ "confidence": <number 1-10>, "answer": "<your answer>", "reason": "<why this confidence>" }`;

  let lastError = null;
  let text = null;
  let providerUsed = PRIMARY_SUPERVISOR_PROVIDER;
  let modelUsed = PRIMARY_SUPERVISOR_MODEL;
  let parsed = null;

  // Try primary
  try {
    text = await askModel(PRIMARY_SUPERVISOR_PROVIDER, PRIMARY_SUPERVISOR_MODEL, prompt, { returnJson: true, temperature: 0.2 });
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (error) {
    console.error(`Primary AI call failed (${PRIMARY_SUPERVISOR_PROVIDER}/${PRIMARY_SUPERVISOR_MODEL}):`, error);
    lastError = error;
  }

  // Backup conditions
  const needsBackup = !parsed || parsed.confidence < AI_CONFIDENCE_THRESHOLD;

  if (needsBackup) {
    const reasonForBackup = !parsed 
      ? 'Primary model call or JSON parsing failed' 
      : `Primary confidence (${parsed.confidence}) was below threshold (${AI_CONFIDENCE_THRESHOLD})`;
    
    console.log(`Routing to backup model (${BACKUP_SUPERVISOR_PROVIDER}/${BACKUP_SUPERVISOR_MODEL}) because: ${reasonForBackup}`);
    
    try {
      const backupText = await askModel(BACKUP_SUPERVISOR_PROVIDER, BACKUP_SUPERVISOR_MODEL, prompt, { returnJson: true, temperature: 0.2 });
      const cleanBackup = backupText.replace(/```json|```/g, '').trim();
      const parsedBackup = JSON.parse(cleanBackup);
      
      // If backup succeeded, use it
      parsed = parsedBackup;
      providerUsed = BACKUP_SUPERVISOR_PROVIDER;
      modelUsed = BACKUP_SUPERVISOR_MODEL;
    } catch (backupError) {
      console.error(`Backup AI call failed (${BACKUP_SUPERVISOR_PROVIDER}/${BACKUP_SUPERVISOR_MODEL}):`, backupError);
      
      // If backup fails but we had a valid primary response (with lower confidence), fallback to the primary response
      if (!parsed) {
        return {
          confidence: 0,
          answer: '',
          reason: `Both primary and backup models failed. Primary error: ${lastError?.message || 'unknown'}. Backup error: ${backupError.message}`
        };
      }
    }
  }

  return {
    confidence: Number(parsed.confidence),
    answer: parsed.answer,
    reason: parsed.reason,
    provider: providerUsed,
    model: modelUsed
  };
}
