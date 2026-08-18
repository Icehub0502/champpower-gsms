import { defineSecret } from 'firebase-functions/params';

type SecretParam = ReturnType<typeof defineSecret>;

// Set with: firebase functions:secrets:set CLAUDE_API_KEY --project <project>
// Replaces the old app's per-browser localStorage key (v1.2.0-3.x) — the key now never
// reaches the client, and every call is authenticated + logged server-side.
export const CLAUDE_API_KEY: SecretParam = defineSecret('CLAUDE_API_KEY');
export const GEMINI_API_KEY: SecretParam = defineSecret('GEMINI_API_KEY');
