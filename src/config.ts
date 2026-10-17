import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import type { AnalysisLanguage } from './language.ts';
export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol';
// Only send model-specific controls for families verified against official documentation.
export function reasoningEffort(model: string): 'low' | undefined {
  return [
    'gpt-6.1-sol',
    'gpt-6-sol',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ].includes(model)
    ? 'low'
    : undefined;
}
export interface Config {
  profilePath?: string;
  profileRevision?: string;
  menuBarEnabled?: boolean;
  analysisLanguage: AnalysisLanguage;
  address: string;
  password: string;
  host: string;
  port: number;
  mailbox: string;
  provider: 'openai' | 'ollama';
  model: string;
  apiKey: string;
  ollamaURL: string;
  dataDir: string;
  concurrency: number;
  classificationConcurrency: number;
  ollamaClassifier: string;
  triageChars: number;
  pollMinutes: number;
  openaiModel: string;
  ollamaModel: string;
}
export function loadConfig(envFile?: string | false, env: NodeJS.ProcessEnv = process.env): Config {
  let file: Record<string, string> = {};
  try {
    if (envFile !== false) file = parse(readFileSync(resolve(envFile || '.env')));
  } catch (e) {
    if (envFile) throw new Error('Could not read the requested --env file.');
  }
  // An explicit --env is a complete configuration boundary. Bun auto-loads .env
  // into process.env; merging it here can silently connect to the wrong account.
  const v = envFile ? file : { ...file, ...env };
  return configFromValues(v);
}

/** Shared by startup and offline setup validation; never persists or connects. */
export function configFromValues(v: NodeJS.ProcessEnv): Config {
  const provider = v.LLM_PROVIDER || 'openai';
  if (!['openai', 'ollama'].includes(provider))
    throw new Error('LLM_PROVIDER must be openai or ollama.');
  const analysisLanguage = v.ANALYSIS_LANGUAGE || 'en';
  if (analysisLanguage !== 'en' && analysisLanguage !== 'ru')
    throw new Error('ANALYSIS_LANGUAGE must be en or ru.');
  const port = Number(v.IMAP_PORT || 993);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid IMAP_PORT.');
  const ollamaURL = v.OLLAMA_API_BASE || 'http://127.0.0.1:11434';
  let u: URL;
  try {
    u = new URL(ollamaURL);
  } catch {
    throw new Error('OLLAMA_API_BASE must be a valid loopback HTTP(S) URL.');
  }
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    !['http:', 'https:'].includes(u.protocol)
  )
    throw new Error('Ollama must use a loopback URL for local processing.');
  return {
    analysisLanguage,
    address: v.EMAIL_ADDRESS || '',
    password: v.EMAIL_PASSWORD || '',
    host: v.IMAP_SERVER || '',
    port,
    mailbox: 'INBOX',
    provider: provider as Config['provider'],
    model:
      provider === 'openai'
        ? v.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
        : v.OLLAMA_MODEL || 'qwen3.5:4b',
    apiKey: v.OPENAI_API_KEY || '',
    ollamaURL: u.origin,
    dataDir: resolve(v.INBOXTOP_DATA_DIR || join(homedir(), '.local/share/inboxtop-terminal')),
    concurrency: provider === 'openai' ? 2 : 1,
    classificationConcurrency: provider === 'openai' ? 6 : 1,
    ollamaClassifier: v.OLLAMA_CLASSIFIER || v.OLLAMA_MODEL || 'qwen3.5:4b',
    triageChars: 3000,
    pollMinutes: 5,
    openaiModel: v.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    ollamaModel: v.OLLAMA_MODEL || 'qwen3.5:4b',
  };
}
export function accountID(config: Config): string {
  return createHash('sha256')
    .update(config.host.toLowerCase() + ':' + config.port + ':' + config.address.toLowerCase())
    .digest('hex')
    .slice(0, 24);
}
export function configErrors(config: Config, analysis = false): string[] {
  const missing = ['EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'IMAP_SERVER'].filter(
    (_, i) => ![config.address, config.password, config.host][i],
  );
  if (analysis && !config.model)
    missing.push(config.provider === 'openai' ? 'OPENAI_MODEL' : 'OLLAMA_MODEL');
  if (analysis && config.provider === 'openai' && !config.apiKey) missing.push('OPENAI_API_KEY');
  return missing;
}
