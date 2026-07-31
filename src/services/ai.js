import nodeFetch from 'node-fetch';
import {
  PRIMARY_SUPERVISOR_PROVIDER,
  PRIMARY_SUPERVISOR_MODEL,
  BACKUP_SUPERVISOR_PROVIDER,
  BACKUP_SUPERVISOR_MODEL,
  GOOGLE_FALLBACK_MODELS
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

export function parseAiJson(str) {
  if (!str) return null;
  try {
    const match = str.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (_) {}
  return null;
}

function getGoogleModelFallbackOrder(primaryProvider, primaryModel) {
  const models = [];
  if (primaryProvider === 'google' && primaryModel) {
    models.push(primaryModel);
  }
  models.push(
    ...GOOGLE_FALLBACK_MODELS
      .split(',')
      .map(model => model.trim())
      .filter(Boolean)
  );
  return [...new Set(models)];
}

/**
 * Calls Google models first and only spends paid fallback tokens when every
 * configured Google model fails to return usable JSON.
 */
export async function askJsonGoogleFirst(primaryProvider, primaryModel, prompt, options = {}, isUsable = () => true) {
  const googleErrors = [];

  for (const model of getGoogleModelFallbackOrder(primaryProvider, primaryModel)) {
    try {
      const text = await askModel('google', model, prompt, options);
      const parsed = parseAiJson(text);
      if (parsed && isUsable(parsed)) {
        return { text, parsed, provider: 'google', model, paidFallbackUsed: false };
      }
      googleErrors.push(`google/${model}: returned invalid JSON shape`);
    } catch (error) {
      googleErrors.push(`google/${model}: ${error.message}`);
      console.warn(`Google AI call failed (${model}); trying next Google model if available:`, error.message);
    }
  }

  console.log(`All configured Google models failed or returned unusable JSON. Routing to paid fallback (${BACKUP_SUPERVISOR_PROVIDER}/${BACKUP_SUPERVISOR_MODEL}).`);

  try {
    const text = await askModel(BACKUP_SUPERVISOR_PROVIDER, BACKUP_SUPERVISOR_MODEL, prompt, options);
    const parsed = parseAiJson(text);
    if (parsed && isUsable(parsed)) {
      return { text, parsed, provider: BACKUP_SUPERVISOR_PROVIDER, model: BACKUP_SUPERVISOR_MODEL, paidFallbackUsed: true };
    }
    throw new Error('paid fallback returned invalid JSON shape');
  } catch (error) {
    throw new Error(`All Google models failed and paid fallback failed. Google errors: ${googleErrors.join(' | ')}. Paid fallback error: ${error.message}`);
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
 * Uses paid fallback only when every configured Google model fails to return
 * usable JSON. Low-confidence Google answers are escalated to Telegram instead
 * of spending paid fallback tokens.
 */
export async function askWithConfidence(contextPrompt, question) {
  const prompt = `You are a supervisor for an AI coding agent. Given this project context and the agent's question, provide the best answer you can.
     
PROJECT CONTEXT:
${contextPrompt}
     
AGENT QUESTION:
${question}
     
Respond ONLY with valid JSON in this exact format:
{ "confidence": <number 1-10>, "answer": "<your answer>", "reason": "<why this confidence>" }`;

  try {
    const result = await askJsonGoogleFirst(
      PRIMARY_SUPERVISOR_PROVIDER,
      PRIMARY_SUPERVISOR_MODEL,
      prompt,
      { returnJson: true, temperature: 0.2 },
      parsed => !isNaN(Number(parsed.confidence))
    );

    return {
      confidence: Number(result.parsed.confidence),
      answer: result.parsed.answer,
      reason: result.parsed.reason,
      provider: result.provider,
      model: result.model,
      paidFallbackUsed: result.paidFallbackUsed
    };
  } catch (error) {
    console.error('AI confidence call failed across Google and paid fallback:', error.message);
    return {
      confidence: 0,
      answer: '',
      reason: error.message,
      provider: BACKUP_SUPERVISOR_PROVIDER,
      model: BACKUP_SUPERVISOR_MODEL,
      paidFallbackUsed: true
    };
  }
}
