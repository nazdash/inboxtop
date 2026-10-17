import { z } from 'zod';
import type { Config } from './config.ts';

export const SettingsSchema = z
  .object({
    menuBarEnabled: z.boolean().default(false),
    analysisLanguage: z.enum(['en', 'ru']).default('en'),
    provider: z.enum(['openai', 'ollama']),
    openaiModel: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_.:/-]+$/),
    ollamaModel: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_.:/-]+$/),
    ollamaClassifier: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_.:/-]+$/)
      .default('qwen3.5:4b'),
    triageChars: z.number().int().min(1000).max(6000),
    pollMinutes: z.number().int().min(1).max(60),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export function settingsFrom(config: Config): Settings {
  return SettingsSchema.parse({
    menuBarEnabled: config.menuBarEnabled ?? false,
    analysisLanguage: config.analysisLanguage,
    provider: config.provider,
    openaiModel: config.openaiModel,
    ollamaModel: config.ollamaModel,
    ollamaClassifier: config.ollamaClassifier,
    triageChars: config.triageChars,
    pollMinutes: config.pollMinutes,
  });
}
export function applySettings(config: Config, value: Settings) {
  const settings = SettingsSchema.parse(value);
  Object.assign(config, settings, {
    model: settings.provider === 'openai' ? settings.openaiModel : settings.ollamaModel,
    concurrency: settings.provider === 'openai' ? 2 : 1,
    classificationConcurrency: settings.provider === 'openai' ? 6 : 1,
  });
}
export async function installedModels(config: Config): Promise<string[]> {
  const response = await fetch(config.ollamaURL + '/api/tags', {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Could not list local Ollama models.');
  const data = (await response.json()) as {
    models?: { name: string; remote_model?: string; remote_host?: string }[];
  };
  return (data.models ?? [])
    .filter((m) => !m.remote_model && !m.remote_host && !m.name.endsWith(':cloud'))
    .map((m) => m.name)
    .sort();
}
