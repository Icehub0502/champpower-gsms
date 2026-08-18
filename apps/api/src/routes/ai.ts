import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { CLAUDE_API_KEY, GEMINI_API_KEY } from '../lib/secrets.js';
import { friendlyApiError, MAX_AI_RETRIES, RETRYABLE_STATUSES, sleep } from '../lib/friendlyApiError.js';

export const aiRouter = Router();

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= MAX_AI_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { content?: { text?: string }[] };
      return data.content?.[0]?.text || '(ไม่มีผลลัพธ์)';
    }
    const errBody = await res.text();
    lastErr = new Error(friendlyApiError('claude', res.status, errBody));
    if (!RETRYABLE_STATUSES.includes(res.status) || attempt === MAX_AI_RETRIES) throw lastErr;
    await sleep(1200 * (attempt + 1));
  }
  throw lastErr;
}

// Gemini 2.5 Flash-Lite — current stable model with the most generous free-tier quota
// (gemini-2.0-flash was retired by Google; see the original app's v1.4.1 changelog entry).
async function callGemini(apiKey: string, prompt: string): Promise<string> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= MAX_AI_RETRIES; attempt++) {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' +
        encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '(ไม่มีผลลัพธ์)';
    }
    const errBody = await res.text();
    lastErr = new Error(friendlyApiError('gemini', res.status, errBody));
    if (!RETRYABLE_STATUSES.includes(res.status) || attempt === MAX_AI_RETRIES) throw lastErr;
    await sleep(1200 * (attempt + 1));
  }
  throw lastErr;
}

/**
 * POST /ai/summarize { prompt, model: 'claude' | 'gemini' }
 * Any signed-in staff member may call this — the shop's own key is used server-side,
 * never exposed to the client and never written into a JSON backup (the original app's
 * v1.2.0-3.x design, where the key lived in localStorage, is exactly what this replaces).
 */
aiRouter.post('/summarize', requireAuth, async (req, res) => {
  const { prompt, model } = req.body as { prompt?: string; model?: 'claude' | 'gemini' };
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'missing_prompt' });
    return;
  }
  try {
    const text =
      model === 'gemini'
        ? await callGemini(GEMINI_API_KEY.value(), prompt)
        : await callClaude(CLAUDE_API_KEY.value(), prompt);
    res.json({ text });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
