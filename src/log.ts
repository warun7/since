import { config } from './config.js';

/**
 * How an error goes into the server log. In full by default (`npm run dev` logs stay on your
 * machine). With LOG_DETAILS=0, as on the hosted demo, only its kind and status: an error's text
 * can quote the user's words (a JSON parse error quotes its input, a provider error can echo a
 * query), and logs shouldn't outlive the memory they came from.
 */
export function describeError(err: unknown): unknown {
  if (config.logDetails) return err;
  if (!(err instanceof Error)) return typeof err;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? `${err.name} (status ${status})` : err.name;
}
