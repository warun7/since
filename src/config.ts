// Settings come from the environment: .env on Node (loaded by each entry point with
// dotenv), and the Worker's variables and secrets on Cloudflare. They are read when used,
// not at import, so the hosted Worker can fill process.env before the first request.
const env = (name: string): string | undefined => process.env[name] || undefined;

function int(name: string, fallback: number): number {
  const n = Number.parseInt(env(name) ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  get deepseekApiKey() {
    return env('DEEPSEEK_API_KEY') ?? '';
  },
  get deepseekBaseUrl() {
    return (env('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  },
  /** The model that talks to the user and drives search. Non-thinking mode for latency. */
  get chatModel() {
    return env('CHAT_MODEL') ?? 'deepseek-flash';
  },
  /** The model that writes long-term memory in the background. */
  get memoryModel() {
    return env('MEMORY_MODEL') ?? 'deepseek-flash';
  },
  get port() {
    return int('PORT', 3000);
  },
  /** False (LOG_DETAILS=0) logs errors by kind and status only, without their text. */
  get logDetails() {
    return env('LOG_DETAILS') !== '0';
  },
  get dbPath() {
    return env('DB_PATH') ?? 'data/since.db';
  },
  /** Search rounds per turn before the model must answer with what it has. */
  get maxSearchSteps() {
    return int('MAX_SEARCH_STEPS', 3);
  },
  /** Optional: an `upheld serve` endpoint, e.g. http://127.0.0.1:8000. Checks citations after each answer. */
  get upheldUrl() {
    return (env('UPHELD_URL') ?? '').replace(/\/+$/, '');
  },
  /** Fallback timezone when the client doesn't send one. */
  get defaultTz() {
    return env('DEFAULT_TZ') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  },
};

export function assertConfig(): void {
  if (!config.deepseekApiKey) {
    console.error('\n  DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key.\n');
    process.exit(1);
  }
}
