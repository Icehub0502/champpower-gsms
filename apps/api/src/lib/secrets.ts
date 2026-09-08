// Plain env-var secrets, replacing firebase-functions/params' defineSecret(). Set via
// the process environment (.env locally, pm2 env / systemd env in production) — never
// committed, never exposed to the client, never logged.
interface SecretParam {
  value(): string;
}

function envSecret(name: string): SecretParam {
  return {
    value(): string {
      return process.env[name] || '';
    },
  };
}

export const CLAUDE_API_KEY: SecretParam = envSecret('CLAUDE_API_KEY');
export const GEMINI_API_KEY: SecretParam = envSecret('GEMINI_API_KEY');
