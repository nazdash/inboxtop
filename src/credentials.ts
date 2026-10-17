import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { configFromValues, configErrors, loadConfig, type Config } from './config.ts';

const SERVICE = 'dev.inboxtop.credentials';
const valueNames = [
  'EMAIL_ADDRESS',
  'IMAP_SERVER',
  'IMAP_PORT',
  'LLM_PROVIDER',
  'OPENAI_MODEL',
  'OLLAMA_API_BASE',
  'OLLAMA_MODEL',
  'OLLAMA_CLASSIFIER',
  'ANALYSIS_LANGUAGE',
  'INBOXTOP_DATA_DIR',
] as const;
const Values = z.partialRecord(z.enum(valueNames), z.string().max(4096));
const Profile = z.object({ version: z.literal(1), credential: z.uuid(), values: Values }).strict();
const Secrets = z.object({ password: z.string().max(8192), apiKey: z.string().max(8192) }).strict();
export interface CredentialVault {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  remove(ref: string): Promise<void>;
}
const vaultError = () =>
  new Error(
    'Could not access the system credential store. Unlock it and retry. On Linux, install secret-tool and start a Secret Service session. No plaintext fallback was used.',
  );

/** Native credentials only; secrets never enter argv or environment variables. */
export class SystemVault implements CredentialVault {
  private async operation(
    ref: string,
    method: 'get' | 'set' | 'remove',
    value?: string,
  ): Promise<string | null> {
    try {
      if (process.platform === 'linux') {
        const args =
          method === 'set'
            ? ['store', '--label=inboxtop credentials', 'service', SERVICE, 'account', ref]
            : [method === 'get' ? 'lookup' : 'clear', 'service', SERVICE, 'account', ref];
        const child = Bun.spawn(['secret-tool', ...args], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        });
        const timer = setTimeout(() => child.kill(), 30000);
        try {
          if (value !== undefined) child.stdin.write(value);
          child.stdin.end();
          const result = await new Response(child.stdout).text();
          if ((await child.exited) !== 0) throw vaultError();
          return method === 'get' ? result.replace(/\n$/, '') : null;
        } finally {
          clearTimeout(timer);
        }
      }
      if (!['darwin', 'win32'].includes(process.platform)) throw vaultError();
      const { AsyncEntry } = await import('@napi-rs/keyring');
      const entry = new AsyncEntry(SERVICE, ref);
      const signal = AbortSignal.timeout(30000);
      if (method === 'get') return (await entry.getPassword(signal)) ?? null;
      if (method === 'set') await entry.setPassword(value!, signal);
      else await entry.deletePassword(signal);
      return null;
    } catch {
      throw vaultError();
    }
  }
  get(ref: string) {
    return this.operation(ref, 'get');
  }
  async set(ref: string, value: string) {
    await this.operation(ref, 'set', value);
  }
  async remove(ref: string) {
    await this.operation(ref, 'remove');
  }
}
export async function probeVault(vault: CredentialVault = new SystemVault()) {
  const ref = randomUUID();
  try {
    await vault.set(ref, 'inboxtop fictional credential-store test');
    if ((await vault.get(ref)) !== 'inboxtop fictional credential-store test') throw vaultError();
  } finally {
    await vault.remove(ref);
  }
}
export function userConfigPath(env = process.env): string {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support')
      : process.platform === 'win32'
        ? env.APPDATA || join(homedir(), 'AppData/Roaming')
        : env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'inboxtop', 'config.json');
}
export function publicValues(c: Config) {
  return {
    EMAIL_ADDRESS: c.address,
    IMAP_SERVER: c.host,
    IMAP_PORT: String(c.port),
    LLM_PROVIDER: c.provider,
    OPENAI_MODEL: c.openaiModel,
    OLLAMA_API_BASE: c.ollamaURL,
    OLLAMA_MODEL: c.ollamaModel,
    OLLAMA_CLASSIFIER: c.ollamaClassifier,
    ANALYSIS_LANGUAGE: c.analysisLanguage,
    INBOXTOP_DATA_DIR: c.dataDir,
  };
}
export async function readProfile(path: string) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 65536) throw new Error();
    return Profile.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error(
      'Could not read the saved configuration. Restore a valid config file or run inboxtop setup. Your mail history has not been changed.',
    );
  }
}
export async function loadProfile(
  path: string,
  vault: CredentialVault = new SystemVault(),
): Promise<Config> {
  const profile = await readProfile(path);
  let secrets: z.infer<typeof Secrets>;
  try {
    secrets = Secrets.parse(JSON.parse((await vault.get(profile.credential)) || 'null'));
  } catch {
    throw vaultError();
  }
  const config = configFromValues({
    ...profile.values,
    EMAIL_PASSWORD: secrets.password,
    OPENAI_API_KEY: secrets.apiKey,
  });
  if (configErrors(config, true).length)
    throw new Error('Saved credentials are incomplete. Run inboxtop setup to reconnect.');
  return { ...config, profilePath: resolve(path), profileRevision: profile.credential };
}

export async function loadRuntimeConfig(
  envFile?: string,
  profilePath?: string,
  env = process.env,
): Promise<Config> {
  if (envFile && profilePath) throw new Error('Choose --env or --profile, not both.');
  if (profilePath) return loadProfile(profilePath);
  if (!envFile && existsSync(userConfigPath(env))) return loadProfile(userConfigPath(env));
  // Legacy configuration remains a whole account boundary, never a partial merge.
  if (
    envFile ||
    existsSync('.env') ||
    [...valueNames, 'EMAIL_PASSWORD', 'OPENAI_API_KEY'].some((key) => env[key])
  )
    return loadConfig(envFile, env);
  const path = userConfigPath(env);
  return existsSync(path) ? loadProfile(path) : loadConfig(false, {});
}

/** Immutable credential revision + atomic profile switch preserves the old account on failure. */
export async function saveProfile(
  config: Config,
  path = userConfigPath(),
  vault: CredentialVault = new SystemVault(),
): Promise<Config> {
  if (configErrors(config, true).length)
    throw new Error('Complete email and AI settings before saving.');
  const values = Values.parse(publicValues(config));
  const secrets = Secrets.parse({ password: config.password, apiKey: config.apiKey });
  const credential = randomUUID();
  const temporary = path + '.' + credential + '.tmp';
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(path + '.lock', 'wx', 0o600).catch(() => {
    throw new Error(
      'Another setup may be saving. Close it and retry. If interrupted, inspect the config.json.lock file before removing it.',
    );
  });
  let committed = false;
  let previous: z.infer<typeof Profile> | undefined;
  try {
    if (existsSync(path)) previous = await readProfile(path);
    const value = JSON.stringify(secrets);
    await vault.set(credential, value);
    if ((await vault.get(credential)) !== value) throw vaultError();
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, credential, values }, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    committed = true;
  } catch {
    throw new Error(
      'Could not save setup securely. Unlock the credential store, check config-directory permissions and retry. The previous configuration is unchanged.',
    );
  } finally {
    if (!committed) await vault.remove(credential).catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    await lock.close().catch(() => {});
    await rm(path + '.lock', { force: true }).catch(() => {});
  }
  if (previous) await vault.remove(previous.credential).catch(() => {});
  return { ...config, profilePath: resolve(path), profileRevision: credential };
}
