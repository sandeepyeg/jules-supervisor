import fetch from 'node-fetch';

/**
 * Calls Gemini Flash to generate content.
 */
export async function askGeminiFlash(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-latest';
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined in environment variables');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const body = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini Flash API request failed: ${response.statusText} - ${errText}`);
  }

  const data = await response.json();
  try {
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    throw new Error(`Unexpected Gemini response format: ${JSON.stringify(data)}`);
  }
}

/**
 * Calls DeepSeek via Kilo Gateway (OpenAI-compatible endpoint).
 */
export async function askDeepSeek(prompt, returnJson = false) {
  const apiKey = process.env.KILO_API_KEY;
  const baseUrl = process.env.KILO_BASE_URL || 'https://api.kilo.ai/v1';
  const model = process.env.KILO_MODEL || 'deepseek-v4-pro';
  
  if (!apiKey) {
    throw new Error('KILO_API_KEY is not defined in environment variables');
  }

  const url = `${baseUrl}/chat/completions`;
  
  const body = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3
  };

  if (returnJson) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API request failed: ${response.statusText} - ${errText}`);
  }

  const data = await response.json();
  try {
    return data.choices[0].message.content;
  } catch (error) {
    throw new Error(`Unexpected DeepSeek response format: ${JSON.stringify(data)}`);
  }
}

/**
 * Formats a query and retrieves a structured answer with confidence metrics from DeepSeek.
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
    const text = await askDeepSeek(prompt, true);
    // Strip markdown code block fences if any
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    
    return {
      confidence: Number(parsed.confidence),
      answer: parsed.answer,
      reason: parsed.reason
    };
  } catch (error) {
    console.error('Failed to get/parse answer with confidence:', error);
    return {
      confidence: 0,
      answer: '',
      reason: `Parsing or execution error: ${error.message}`
    };
  }
}
