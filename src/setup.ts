import { stat } from 'node:fs/promises';
import { configErrors, configFromValues, loadConfig, type Config } from './config.ts';
import { version } from '../package.json';
import { existsSync } from 'node:fs';
import { readProfile, userConfigPath, probeVault } from './credentials.ts';

// Environment-shaped input preserves the existing explicit --env account boundary.
// Secrets are accepted only through protected input, never echoed in a report.
const fields = {
  EMAIL_ADDRESS: { description: 'Email account used for IMAP authentication.' },
  EMAIL_PASSWORD: { description: 'IMAP app password where supported.', writeOnly: true },
  IMAP_SERVER: {
    description: 'IMAP host. Implicit TLS with certificate verification is required.',
  },
  IMAP_PORT: { description: 'Implicit TLS IMAP port, integer from 1 to 65535.', default: '993' },
  LLM_PROVIDER: { enum: ['openai', 'ollama'], default: 'openai' },
  OPENAI_API_KEY: { description: 'Required when using OpenAI.', writeOnly: true },
  OPENAI_MODEL: {
    description: 'Detailed-review API model ID; availability is not checked offline.',
  },
  OLLAMA_API_BASE: { description: 'HTTP(S) loopback URL only.', default: 'http://127.0.0.1:11434' },
  OLLAMA_MODEL: { description: 'Installed local detailed-review model tag.' },
  OLLAMA_CLASSIFIER: { description: 'Installed local classifier; defaults to OLLAMA_MODEL.' },
  ANALYSIS_LANGUAGE: { enum: ['en', 'ru'], default: 'en' },
  INBOXTOP_DATA_DIR: { description: 'Optional local account-storage directory.' },
} as const;

export function setupSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    'x-inboxtop-schema-version': 1,
    title: 'inboxtop configuration input',
    description:
      'Contract version 1. Pass a single JSON object to setup --check --stdin --json. ' +
      'Checks configuration only; does not save, connect, analyze or inspect saved settings. ' +
      'Use the check command for additional port/URL validation. All values are strings.',
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, metadata]) => [name, { type: 'string', ...metadata }]),
    ),
    required: ['EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'IMAP_SERVER'],
    allOf: [
      {
        if: {
          not: { properties: { LLM_PROVIDER: { const: 'ollama' } }, required: ['LLM_PROVIDER'] },
        },
        then: { required: ['OPENAI_API_KEY'] },
      },
    ],
  };
}

type Check = {
  id: string;
  status: 'pass' | 'fail' | 'warning' | 'not_checked';
  message: string;
  fix?: string;
  fields?: string[];
};
export type SetupReport = {
  schemaVersion: 1;
  command: 'doctor' | 'setup-check';
  version: string;
  ok: boolean;
  checks: Check[];
};
function report(command: SetupReport['command'], checks: Check[]): SetupReport {
  return {
    schemaVersion: 1,
    command,
    version,
    ok: !checks.some((c) => c.status === 'fail'),
    checks,
  };
}

function configurationChecks(config: Config): Check[] {
  const missing = configErrors(config, true);
  return [
    missing.length
      ? {
          id: 'configuration',
          status: 'fail',
          message: 'Required configuration is missing.',
          fields: missing,
          fix: 'Provide the listed fields. Run setup --schema for the input contract.',
        }
      : {
          id: 'configuration',
          status: 'pass',
          message: 'Required configuration is present and parses successfully.',
        },
    {
      id: 'credentials',
      status: 'not_checked',
      message: 'Authentication and credential validity have not been tested.',
    },
    {
      id: 'provider',
      status: 'not_checked',
      message: 'AI endpoint and model availability have not been tested. No requests were sent.',
      fix: 'Use Settings → Test provider with fictional content before analyzing mail.',
    },
    {
      id: 'saved_settings',
      status: 'not_checked',
      message:
        'Saved account settings may override provider, model and language defaults; they were not opened.',
    },
  ];
}
const invalidConfiguration: Check = {
  id: 'configuration',
  status: 'fail',
  message: 'Configuration could not be parsed.',
  fix: 'Check file readability, provider/language choices, IMAP port and loopback Ollama URL. Run setup --schema for accepted fields.',
};

export function checkSetupInput(input: unknown): SetupReport {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.entries(input).some(
      ([key, value]) => !Object.hasOwn(fields, key) || typeof value !== 'string',
    )
  ) {
    return report('setup-check', [
      {
        id: 'input',
        status: 'fail',
        message:
          'Expected an object containing only supported configuration fields with string values.',
        fix: 'Run setup --schema. Unknown names and submitted values are deliberately not echoed.',
      },
    ]);
  }
  try {
    return report('setup-check', configurationChecks(configFromValues(input as NodeJS.ProcessEnv)));
  } catch {
    // URL/parser exceptions can contain submitted credentials. Never forward them.
    return report('setup-check', [invalidConfiguration]);
  }
}

export async function diagnose(
  envFile?: string,
  env = process.env,
  profileFile?: string,
): Promise<SetupReport> {
  const checks: Check[] = [];
  const profile =
    profileFile || (!envFile && existsSync(userConfigPath(env)) ? userConfigPath(env) : undefined);
  try {
    if (profile) {
      const saved = await readProfile(profile);
      checks.push(
        ...configurationChecks(
          configFromValues({
            ...saved.values,
            EMAIL_PASSWORD: 'not-inspected',
            OPENAI_API_KEY: 'not-inspected',
          }),
        ),
      );
      const check = checks.find((c) => c.id === 'configuration');
      if (check?.status === 'pass')
        check.message =
          'Saved profile parses successfully. Credential presence and validity were not inspected.';
    } else checks.push(...configurationChecks(loadConfig(envFile, env)));
  } catch {
    checks.push(invalidConfiguration);
  }
  try {
    const info = await stat(profile || envFile || '.env');
    checks.push({
      id: 'config_file_permissions',
      status: process.platform === 'win32' ? 'not_checked' : info.mode & 0o077 ? 'warning' : 'pass',
      message:
        process.platform === 'win32'
          ? 'Windows file ACLs were not inspected.'
          : info.mode & 0o077
            ? 'The configuration file is accessible to the group or other users.'
            : 'The configuration file permissions restrict access to its owner.',
      fix: profile
        ? 'Keep account configuration private. Secrets are stored separately in the OS credential store.'
        : 'Configuration files contain plaintext secrets. Keep them outside version control and restrict access to your user.',
    });
  } catch {
    checks.push({
      id: 'config_file_permissions',
      status: 'not_checked',
      message: 'No readable configuration-file metadata was available.',
    });
  }
  checks.push({
    id: 'platform',
    status: 'warning',
    message:
      process.platform === 'darwin'
        ? 'macOS is the current development platform; standalone release validation is pending.'
        : process.platform === 'linux'
          ? 'Linux release verification is pending; no automatic login service is installed by the app.'
          : 'This platform is not release-verified; worker IPC and process management need portability work.',
  });
  checks.push({
    id: 'storage',
    status: 'not_checked',
    message: 'Local mail, storage writability and background-worker health were not inspected.',
  });
  return report('doctor', checks);
}

export const SETUP_HELP = `inboxtop setup

  setup                          Open keyboard-first onboarding
  setup --schema                 Print the versioned JSON input schema
  setup --check --stdin [--json]  Validate JSON from stdin; no saving or network
  doctor [--env PATH | --profile PATH] [--json]
                                 Check configuration defaults offline
  doctor --test-vault [--json]    Also create/read/delete a fictional credential
  --version                      Print application version

Try fictional mail with --demo. For your account, follow docs/AGENT-SETUP.md.
Setup stores secrets in the OS credential store; ordinary settings stay separate.
Never paste credentials into chat, command arguments or issue reports.
Offline checks do not authenticate, test AI, start workers or change mail.
Only --test-vault writes a temporary fictional credential; the wizard tests connections explicitly.
Exit codes: 0 checks passed (not connection proof), 1 configuration issue, 2 invalid command/input.`;

type CommandResult = { output: string; exitCode: number };
function render(value: SetupReport, json: boolean): CommandResult {
  return {
    output: json
      ? JSON.stringify(value, null, 2)
      : [
          `inboxtop ${value.command}: ${value.ok ? 'configuration checks passed' : 'configuration needs attention'} (offline)`,
          ...value.checks.map(
            (c) =>
              `[${c.status}] ${c.message}${c.fields ? '\n  Fields: ' + c.fields.join(', ') : ''}${c.fix ? '\n  Next: ' + c.fix : ''}`,
          ),
        ].join('\n'),
    exitCode: value.ok ? 0 : 1,
  };
}
const MAX_INPUT_BYTES = 64 * 1024;
async function readInput(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('stdin required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new Error('input too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Handle only offline commands, before UI/worker/storage initialization. */
export async function localCommand(args: string[]): Promise<CommandResult | undefined> {
  const command = args[0];
  if (!['doctor', 'setup', '--version'].includes(command)) return;
  const json = args.includes('--json');
  const invalid = (message: string): CommandResult => ({
    output: json
      ? JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'invalid_input', message } })
      : message + '\n\n' + SETUP_HELP,
    exitCode: 2,
  });
  if (command === '--version')
    return args.length === 1
      ? { output: version, exitCode: 0 }
      : invalid('Unexpected version options.');
  if (args.length === 2 && ['--help', '-h'].includes(args[1]))
    return { output: SETUP_HELP, exitCode: 0 };
  if (command === 'setup') {
    if (
      args.length === 1 ||
      (args.length === 3 && ['--env', '--profile'].includes(args[1]) && !args[2].startsWith('-'))
    )
      return;
    if (args.length === 2 && args[1] === '--schema')
      return { output: JSON.stringify(setupSchema(), null, 2), exitCode: 0 };
    if (
      !args.includes('--check') ||
      !args.includes('--stdin') ||
      args.slice(1).some((arg) => !['--check', '--stdin', '--json'].includes(arg)) ||
      new Set(args).size !== args.length
    )
      return invalid('Use setup --schema or setup --check --stdin [--json].');
    let input: unknown;
    try {
      input = JSON.parse(await readInput());
    } catch {
      return invalid(
        'Expected one JSON object on stdin, at most 64 KiB. Submitted input is never echoed.',
      );
    }
    const result = checkSetupInput(input);
    const rendered = render(result, json);
    if (result.checks.some((c) => c.id === 'input')) rendered.exitCode = 2;
    return rendered;
  }
  let envFile: string | undefined, profileFile: string | undefined;
  let seenJSON = false;
  let testVault = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json' && !seenJSON) seenJSON = true;
    else if (args[i] === '--test-vault' && !testVault) testVault = true;
    else if (
      args[i] === '--profile' &&
      !profileFile &&
      !envFile &&
      args[i + 1] &&
      !args[i + 1].startsWith('-')
    )
      profileFile = args[++i];
    else if (
      args[i] === '--env' &&
      envFile === undefined &&
      !profileFile &&
      args[i + 1] &&
      !args[i + 1].startsWith('-')
    )
      envFile = args[++i];
    else return invalid('Use doctor [--env PATH | --profile PATH] [--test-vault] [--json].');
  }
  const diagnosis = await diagnose(envFile, process.env, profileFile);
  if (testVault) {
    try {
      await probeVault();
      diagnosis.checks.push({
        id: 'credential_store',
        status: 'pass',
        message: 'Created, read and deleted a temporary fictional credential.',
      });
    } catch {
      diagnosis.ok = false;
      diagnosis.checks.push({
        id: 'credential_store',
        status: 'fail',
        message:
          'Credential-store test failed. Unlock the store and retry; no plaintext fallback was used.',
      });
    }
  }
  return render(diagnosis, json);
}
