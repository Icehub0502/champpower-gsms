import { onRequest } from 'firebase-functions/v2/https';
import { app } from './app.js';
import { CLAUDE_API_KEY, GEMINI_API_KEY } from './lib/secrets.js';
import './lib/admin.js';

// asia-southeast1 (Singapore) — closest region to Thailand, keeps latency down for
// staff hitting this from the shop floor.
export const api = onRequest(
  { region: 'asia-southeast1', secrets: [CLAUDE_API_KEY, GEMINI_API_KEY] },
  app,
);

// Firestore triggers (jobs -> board, audit log) and scheduled cleanup jobs land here
// in a later phase — see apps/api/src/triggers/ and apps/api/src/scheduled/ in the
// migration plan. Not wired yet: the web app still talks to Firestore directly for
// reads/writes, this function only carries the AI proxy so far.
