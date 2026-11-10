import 'dotenv/config';

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
  /** The model that talks to the user and drives search. Non-thinking mode for latency. */
  chatModel: process.env.CHAT_MODEL ?? 'deepseek-flash',
  /** The model that writes long-term memory in the background. */
  memoryModel: process.env.MEMORY_MODEL ?? 'deepseek-flash',
  port: int('PORT', 3000),
  dbPath: process.env.DB_PATH ?? 'data/since.db',
  /** Search rounds per turn before the model must answer with what it has. */
  maxSearchSteps: int('MAX_SEARCH_STEPS', 3),
  /** Optional: an `upheld serve` endpoint, e.g. http://127.0.0.1:8000. Checks citations after each answer. */
  upheldUrl: (process.env.UPHELD_URL ?? '').replace(/\/+$/, ''),
  /** Fallback timezone when the client doesn't send one. */
  defaultTz: process.env.DEFAULT_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
};

export function assertConfig(): void {
  if (!config.deepseekApiKey) {
    console.error('\n  DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key.\n');
    process.exit(1);
  }
}
