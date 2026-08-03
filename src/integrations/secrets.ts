import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';
import { getGlobalConfigDir } from '../core/global-config.js';

/**
 * Credential resolution for integrations.
 *
 * Secrets never live in the project: `openspec/integrations.yaml` is committed,
 * and a bot token there would be published the moment the repo is pushed.
 *
 * Order of precedence:
 *   1. environment variable   — wins, so CI and one-off runs need no state
 *   2. the user's global config dir — persists across shells, outside any repo
 */

export const SECRET_ENV_VARS = {
  telegramBotToken: 'OPENSPEC_TELEGRAM_BOT_TOKEN',
  trelloKey: 'OPENSPEC_TRELLO_KEY',
  trelloToken: 'OPENSPEC_TRELLO_TOKEN',
  githubToken: 'OPENSPEC_GITHUB_TOKEN',
} as const;

export type SecretName = keyof typeof SECRET_ENV_VARS;

const SECRETS_FILENAME = 'integration-secrets.json';

export function getSecretsPath(): string {
  return path.join(getGlobalConfigDir(), SECRETS_FILENAME);
}

type SecretsFile = Partial<Record<SecretName, string>>;

function readSecretsFile(): SecretsFile {
  const secretsPath = getSecretsPath();
  if (!existsSync(secretsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(secretsPath, 'utf-8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SecretsFile;
    }
    return {};
  } catch {
    // A corrupt secrets file must not crash every command; the caller sees the
    // secret as missing and gets the normal "set this env var" guidance.
    return {};
  }
}

export function getSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[SECRET_ENV_VARS[name]];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();

  const fromFile = readSecretsFile()[name];
  return fromFile && fromFile.trim() !== '' ? fromFile.trim() : undefined;
}

/**
 * Persists a secret to the user's global config dir.
 *
 * chmod 600 is best-effort: it is a no-op on Windows, where the file instead
 * relies on the per-user ACL of the profile directory it lives in.
 */
export function setSecret(name: SecretName, value: string): string {
  const secretsPath = getSecretsPath();
  mkdirSync(path.dirname(secretsPath), { recursive: true });

  const secrets = readSecretsFile();
  secrets[name] = value;
  writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 'utf-8');

  try {
    chmodSync(secretsPath, 0o600);
  } catch {
    // Windows and some network filesystems reject chmod; not fatal.
  }

  return secretsPath;
}

export interface MissingSecret {
  name: SecretName;
  envVar: string;
  hint: string;
}

const SECRET_HINTS: Record<SecretName, string> = {
  telegramBotToken: 'Create a bot with @BotFather, then: openspec integrations secret set telegramBotToken <token>',
  trelloKey:
    'Generate an API key from a Power-Up at https://trello.com/power-ups/admin (API Key tab), then: openspec integrations secret set trelloKey <key>',
  trelloToken:
    'Authorize with https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<KEY>, then: openspec integrations secret set trelloToken <token>',
  githubToken:
    'Create a token with the "repo" scope at https://github.com/settings/tokens (or a fine-grained token with Contents and Pull requests write), then: openspec integrations secret set githubToken <token>',
};

/** Reports which of the requested secrets are unset, with the fix for each. */
export function findMissingSecrets(
  names: SecretName[],
  env: NodeJS.ProcessEnv = process.env
): MissingSecret[] {
  return names
    .filter((name) => getSecret(name, env) === undefined)
    .map((name) => ({ name, envVar: SECRET_ENV_VARS[name], hint: SECRET_HINTS[name] }));
}

/** Masks a secret for display: never print one in full, not even in --json. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}
