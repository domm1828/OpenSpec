import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { ALL_EVENT_TYPES, type OpenSpecEventType } from './types.js';

/**
 * Integration settings live in `openspec/integrations.yaml`, beside the
 * project's `openspec/config.yaml`, rather than in the global config.
 *
 * Two reasons, both concrete:
 *  - a Trello board id and a Telegram chat allowlist are properties of *this*
 *    project, not of the user across every project;
 *  - `validateConfigKeyPath` in core/config-schema.ts rejects nested keys under
 *    any root but `featureFlags`, so `openspec config set integrations.trello.boardId`
 *    could never work without reworking that validator.
 *
 * Secrets are deliberately absent from this schema — see secrets.ts. This file
 * is meant to be committed; a bot token in it would be a credential leak.
 */

const EventTypeSchema = z.enum(ALL_EVENT_TYPES as unknown as [OpenSpecEventType, ...OpenSpecEventType[]]);

export const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Chats permitted to talk to the bot. Empty means nobody: an unset allowlist
   * must fail closed, because a leaked bot token would otherwise give anyone
   * who finds it write access to the repo.
   */
  allowedChatIds: z.array(z.number().int()).default([]),
  notifyOn: z.array(EventTypeSchema).default(['change.created', 'change.archived', 'task.checked']),
  /** Commit task edits made from chat. Off by default; committing is the user's call. */
  autoCommit: z.boolean().default(false),
});

export const TrelloListMapSchema = z.object({
  proposed: z.string().optional(),
  in_progress: z.string().optional(),
  review: z.string().optional(),
  archived: z.string().optional(),
});

export const TrelloConfigSchema = z.object({
  enabled: z.boolean().default(false),
  boardId: z.string().optional(),
  listMap: TrelloListMapSchema.default({}),
  /** Checklist that holds the change's tasks on each card. */
  checklistName: z.string().default('Tasks'),
  /**
   * Whether OpenSpec keeps moving a card between lists as work progresses.
   *
   * `once` (default) places the card when it is created and never moves it
   * again, so the board stays yours to organize — dragging a card somewhere is a
   * decision, and a sync that silently undoes it on the next run is the kind of
   * surprise that makes people stop trusting the integration.
   *
   * `always` re-derives the list from task progress on every sync, which keeps
   * the board mechanically consistent with tasks.md at the cost of overriding
   * any manual arrangement.
   */
  cardPlacement: z.enum(['once', 'always']).default('once'),
  /**
   * What happens to the card when its change is archived.
   *
   * `move` sends it to the list mapped as `archived` (and does nothing if that
   * role is unmapped), `close` uses Trello's own card archiving, `nothing`
   * leaves it alone.
   */
  onArchive: z.enum(['move', 'close', 'nothing']).default('move'),
  /**
   * What to do when a task changed on both sides since the last sync.
   * `manual` writes nothing and reports — silently overwriting the user's work
   * is the one failure mode with no recovery path.
   */
  conflictPolicy: z.enum(['manual', 'local-wins', 'remote-wins']).default('manual'),
  pollIntervalSec: z.number().int().min(10).default(60),
});

/**
 * `prefault` rather than `default`: Zod 4's `.default()` must satisfy the
 * *output* type, so `{}` would be rejected for a schema with required output
 * fields. `prefault` feeds `{}` through the schema instead, letting each field's
 * own default fill in — which is what "an absent `telegram:` block means all
 * defaults" actually requires.
 */
export const IntegrationsConfigSchema = z.object({
  telegram: TelegramConfigSchema.prefault({}),
  trello: TrelloConfigSchema.prefault({}),
});

export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type TrelloConfig = z.infer<typeof TrelloConfigSchema>;
export type IntegrationsConfig = z.infer<typeof IntegrationsConfigSchema>;

export const INTEGRATIONS_CONFIG_FILENAME = 'integrations.yaml';

export class IntegrationsConfigError extends Error {
  constructor(
    message: string,
    public readonly configPath: string
  ) {
    super(message);
    this.name = 'IntegrationsConfigError';
  }
}

export function getIntegrationsConfigPath(projectRoot: string): string {
  return path.join(projectRoot, 'openspec', INTEGRATIONS_CONFIG_FILENAME);
}

/**
 * Reads the project's integration config, applying schema defaults.
 *
 * A missing file yields the all-disabled default rather than an error: every
 * command in this layer needs to work in a project that has never configured an
 * integration, and "everything off" is the honest reading of "no file".
 */
export function readIntegrationsConfig(projectRoot: string): IntegrationsConfig {
  const configPath = getIntegrationsConfigPath(projectRoot);

  if (!existsSync(configPath)) {
    return IntegrationsConfigSchema.parse({});
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    throw new IntegrationsConfigError(
      `Could not parse ${configPath} as YAML: ${(error as Error).message}`,
      configPath
    );
  }

  // An empty file parses to null; treat it as "no settings", not as invalid.
  const result = IntegrationsConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new IntegrationsConfigError(`Invalid ${configPath}: ${detail}`, configPath);
  }

  return result.data;
}

export function writeIntegrationsConfig(projectRoot: string, config: IntegrationsConfig): void {
  const configPath = getIntegrationsConfigPath(projectRoot);
  mkdirSync(path.dirname(configPath), { recursive: true });
  const validated = IntegrationsConfigSchema.parse(config);
  writeFileSync(configPath, stringifyYaml(validated), 'utf-8');
}

/** Ids of adapters switched on in this project. */
export function enabledIntegrationIds(config: IntegrationsConfig): string[] {
  const ids: string[] = [];
  if (config.telegram.enabled) ids.push('telegram');
  if (config.trello.enabled) ids.push('trello');
  return ids;
}
