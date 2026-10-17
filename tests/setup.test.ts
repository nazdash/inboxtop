import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSetupInput, diagnose, localCommand, setupSchema } from '../src/setup.ts';
import { configFromValues, configErrors } from '../src/config.ts';

const fixture = {
  EMAIL_ADDRESS: 'fixture@example.invalid',
  EMAIL_PASSWORD: 'fictional-private-password',
  IMAP_SERVER: 'imap.example.invalid',
  OPENAI_API_KEY: 'fictional-private-api-key',
};
const entry = resolve(import.meta.dir, '../src/index.ts');
async function cli(cwd: string, args: string[], input = '', env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    env: { PATH: process.env.PATH || '', ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(input);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'inboxtop-setup-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('setup uses startup validation, supports local AI and exposes no submitted values', () => {
  for (const values of [fixture, { ...fixture, LLM_PROVIDER: 'ollama', OPENAI_API_KEY: '' }]) {
    const checked = checkSetupInput(values);
    expect(configErrors(configFromValues(values), true)).toEqual([]);
    expect(checked.ok).toBe(true);
    const output = JSON.stringify(checked);
    for (const secret of Object.values(fixture)) expect(output).not.toContain(secret);
    expect(checked.checks.filter((c) => c.status === 'not_checked').map((c) => c.id)).toEqual([
      'credentials',
      'provider',
      'saved_settings',
    ]);
  }
  const missing = checkSetupInput({});
  expect(missing.ok).toBe(false);
  expect(missing.checks[0].fields).toEqual(configErrors(configFromValues({}), true));
});

test('invalid fields, malformed URLs and parser failures cannot echo secrets', () => {
  for (const value of [
    { ...fixture, IMAP_PORT: 'not-a-port-private-value' },
    { ...fixture, LLM_PROVIDER: 'private-provider-value' },
    { ...fixture, ANALYSIS_LANGUAGE: 'private-language-value' },
    { ...fixture, OLLAMA_API_BASE: 'http://user:secret@private-host.invalid' },
    { ...fixture, OLLAMA_API_BASE: 'private-invalid-url-value' },
    { ...fixture, 'secret-as-field-name': 'secret-value' },
    { ...fixture, IMAP_PORT: 993 },
    null,
    [],
    'secret-raw-string',
  ]) {
    const checked = checkSetupInput(value);
    expect(checked.ok).toBe(false);
    const serialized = JSON.stringify(checked);
    for (const marker of [
      'private-',
      'secret-as-field-name',
      'secret-value',
      'secret-raw-string',
      ...Object.values(fixture),
    ])
      expect(serialized).not.toContain(marker);
  }
});

test('schema marks secrets and both CLI and machine version are discoverable offline', async () => {
  const schema = setupSchema();
  expect(schema['x-inboxtop-schema-version']).toBe(1);
  expect(schema.properties.EMAIL_PASSWORD).toMatchObject({ writeOnly: true });
  expect(schema.properties.OPENAI_API_KEY).toMatchObject({ writeOnly: true });
  expect(schema.additionalProperties).toBe(false);
  expect(await localCommand(['--demo'])).toBeUndefined();
  expect(await localCommand(['setup'])).toBeUndefined();
  expect(JSON.parse((await localCommand(['setup', '--schema']))!.output)).toEqual(schema);
});

test('doctor isolates explicit files, never opens account data and redacts paths and values', async () => {
  await temporary(async (directory) => {
    const file = join(directory, 'private-config.env');
    const data = join(directory, 'private-storage');
    await writeFile(data, 'sentinel: must never be opened as a store');
    await writeFile(file, `EMAIL_ADDRESS=fixture@example.invalid\nINBOXTOP_DATA_DIR=${data}\n`, {
      mode: 0o600,
    });
    const checked = await diagnose(file, fixture);
    expect(checked.ok).toBe(false);
    expect(checked.checks[0].fields).toEqual(['EMAIL_PASSWORD', 'IMAP_SERVER', 'OPENAI_API_KEY']);
    expect(JSON.stringify(checked)).not.toContain(directory);
    expect(JSON.stringify(checked)).not.toContain('fixture@example.invalid');
    await writeFile(
      file,
      Object.entries({ ...fixture, INBOXTOP_DATA_DIR: data })
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    expect((await diagnose(file, {})).ok).toBe(true);
    expect(await readFile(data, 'utf8')).toBe('sentinel: must never be opened as a store');
    expect((await readdir(directory)).sort()).toEqual(['private-config.env', 'private-storage']);
    if (process.platform !== 'win32') {
      await chmod(file, 0o644);
      expect(
        (await diagnose(file, {})).checks.find((c) => c.id === 'config_file_permissions')?.status,
      ).toBe('warning');
    }
  });
});

test('real CLI returns one JSON object, ignores inherited config for stdin and has no filesystem side effects', async () => {
  await temporary(async (directory) => {
    await writeFile(
      join(directory, '.env'),
      Object.entries(fixture)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    const empty = await cli(directory, ['setup', '--check', '--stdin', '--json'], '{}', fixture);
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.stdout).checks[0].fields).toContain('EMAIL_PASSWORD');
    expect(empty.stderr).toBe('');
    const valid = await cli(
      directory,
      ['setup', '--check', '--stdin', '--json'],
      JSON.stringify({
        ...fixture,
        INBOXTOP_DATA_DIR: join(directory, 'data-not-to-create'),
      }),
    );
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout).ok).toBe(true);
    expect(valid.stderr).toBe('');
    for (const value of Object.values(fixture)) expect(valid.stdout).not.toContain(value);
    const doctor = await cli(directory, ['doctor', '--json'], '', {
      INBOXTOP_DATA_DIR: join(directory, 'data-not-to-create'),
    });
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout).command).toBe('doctor');
    expect(doctor.stderr).toBe('');
    expect(await readdir(directory)).toEqual(['.env']);
  });
});

test('real CLI rejects malformed and oversized input and unsafe/ambiguous options without echoing them', async () => {
  await temporary(async (directory) => {
    for (const [args, input] of [
      [['setup', '--check', '--stdin', '--json'], '{private-secret:broken}'],
      [
        ['setup', '--check', '--stdin', '--json'],
        JSON.stringify({ EMAIL_PASSWORD: 'x'.repeat(65536) }),
      ],
      [['setup', '--check', '--stdin', '--json'], '{"private-secret-name":"private-secret-value"}'],
      [['setup', '--check', '--stdin', '--json', '--env', 'private-secret-path'], '{}'],
      [['doctor', '--env', '--json'], ''],
      [['doctor', '--json', '--json'], ''],
      [['doctor', '--json', '--once'], ''],
      [['setup', '--check', '--stdin', '--json', '--check'], '{}'],
    ] as [string[], string][]) {
      const result = await cli(directory, args, input);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).ok).toBe(false);
      expect(result.stdout).not.toContain('private-secret');
      expect(result.stderr).toBe('');
    }
    const absent = await cli(directory, [
      'doctor',
      '--env',
      join(directory, 'private-secret-path'),
      '--json',
    ]);
    expect(absent.code).toBe(1);
    expect(JSON.parse(absent.stdout).checks[0].id).toBe('configuration');
    expect(absent.stdout).not.toContain(directory);
    expect(absent.stdout).not.toContain('private-secret');
  });
});
