import { Command } from 'commander';
import path from 'path';
import { TrelloClient } from '../integrations/trello/client.js';
import { syncTrello, type SyncDirection, type SyncReport } from '../integrations/trello/sync.js';
import { createPairing, getPairedChatIds, unpairChat } from '../integrations/telegram/auth.js';
import {
  enabledIntegrationIds,
  getIntegrationsConfigPath,
  readIntegrationsConfig,
  writeIntegrationsConfig,
} from '../integrations/config.js';
import {
  findMissingSecrets,
  getSecret,
  maskSecret,
  setSecret,
  SECRET_ENV_VARS,
  type SecretName,
} from '../integrations/secrets.js';
import {
  healthcheckAll,
  loadAdapters,
  registerAdapter,
  registeredAdapterIds,
  usableAdapters,
} from '../integrations/registry.js';
import {
  DEFAULT_WATCH_INTERVAL_MS,
  primeWatchSnapshot,
  startWatcher,
} from '../integrations/watcher.js';
import { resolveRootForCommand } from '../core/root-selection.js';

/**
 * CLI surface for the integrations layer.
 *
 * Registered from one line in cli/index.ts so the fork's diff against upstream
 * stays small: everything else this file needs lives under src/integrations/.
 */

/**
 * Adapters are imported lazily, at the moment one is actually enabled.
 *
 * This file is loaded by every `openspec` invocation in order to register the
 * commands, so a static `import` of an adapter drags its transport into `openspec
 * list`. grammY made that concrete: it pulls in the deprecated `punycode` module,
 * and Node's warning on stderr broke the repo's rule that a `--json` run leaves
 * stderr empty for the agent parsing it.
 */
registerAdapter('telegram', async (config) => {
  const { createTelegramAdapter } = await import('../integrations/telegram/adapter.js');
  return createTelegramAdapter(config);
});
registerAdapter('trello', async (config) => {
  const { createTrelloAdapter } = await import('../integrations/trello/adapter.js');
  return createTrelloAdapter(config);
});

async function resolveProjectRoot(options: { store?: string }): Promise<string | undefined> {
  const root = await resolveRootForCommand(options, {});
  return root?.path;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string, fix?: string): void {
  console.error(`Error: ${message}`);
  if (fix) console.error(`Fix: ${fix}`);
  process.exitCode = 1;
}

// -----------------------------------------------------------------------------
// openspec integrations ...
// -----------------------------------------------------------------------------

function registerIntegrationsGroup(program: Command): void {
  const group = program
    .command('integrations')
    .description('Manage Telegram/Trello integrations');

  group
    .command('list')
    .description('Show which integrations are registered and enabled')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const config = readIntegrationsConfig(projectRoot);
      const enabled = new Set(enabledIntegrationIds(config));
      const rows = registeredAdapterIds().map((id) => ({ id, enabled: enabled.has(id) }));

      if (options.json) {
        printJson({ integrations: rows, configPath: getIntegrationsConfigPath(projectRoot) });
        return;
      }

      console.log(`Config: ${getIntegrationsConfigPath(projectRoot)}`);
      for (const row of rows) {
        console.log(`  ${row.enabled ? '●' : '○'} ${row.id}${row.enabled ? '' : ' (disabled)'}`);
      }
    });

  for (const verb of ['enable', 'disable'] as const) {
    group
      .command(`${verb} <integration>`)
      .description(`${verb === 'enable' ? 'Turn on' : 'Turn off'} an integration for this project`)
      .action(async (integration: string) => {
        const projectRoot = await resolveProjectRoot({});
        if (!projectRoot) return;

        if (!registeredAdapterIds().includes(integration)) {
          fail(`Unknown integration "${integration}"`, `Known: ${registeredAdapterIds().join(', ')}`);
          return;
        }

        const config = readIntegrationsConfig(projectRoot);
        if (integration === 'telegram') config.telegram.enabled = verb === 'enable';
        if (integration === 'trello') config.trello.enabled = verb === 'enable';
        writeIntegrationsConfig(projectRoot, config);

        console.log(`${integration} ${verb}d in ${getIntegrationsConfigPath(projectRoot)}`);
      });
  }

  group
    .command('status')
    .description('Health-check every enabled integration')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      // Silent here: a failed init is not a stray log line, it is the finding
      // this command exists to report, and healthcheckAll surfaces it with a fix.
      const adapters = await loadAdapters({ projectRoot });
      const reports = await healthcheckAll(adapters);

      if (options.json) {
        printJson({ integrations: reports });
        return;
      }

      if (reports.length === 0) {
        console.log('No integrations are enabled. Try: openspec integrations enable trello');
        return;
      }

      const icons = { ok: '✓', warn: '!', error: '✗', disabled: '○' } as const;
      for (const report of reports) {
        console.log(`${icons[report.level]} ${report.id}: ${report.message}`);
        if (report.fix) console.log(`    Fix: ${report.fix}`);
      }
      if (reports.some((r) => r.level === 'error')) process.exitCode = 1;
    });

  const secret = group.command('secret').description('Manage integration credentials');

  secret
    .command('set <name> <value>')
    .description(`Store a credential outside the repo. Names: ${Object.keys(SECRET_ENV_VARS).join(', ')}`)
    .action((name: string, value: string) => {
      if (!(name in SECRET_ENV_VARS)) {
        fail(`Unknown secret "${name}"`, `Known: ${Object.keys(SECRET_ENV_VARS).join(', ')}`);
        return;
      }
      const location = setSecret(name as SecretName, value);
      console.log(`Saved ${name} to ${location}`);
    });

  secret
    .command('list')
    .description('Show which credentials are set (values are masked)')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const rows = (Object.keys(SECRET_ENV_VARS) as SecretName[]).map((name) => {
        const value = getSecret(name);
        return {
          name,
          envVar: SECRET_ENV_VARS[name],
          set: value !== undefined,
          preview: value ? maskSecret(value) : undefined,
        };
      });

      if (options.json) {
        printJson({ secrets: rows });
        return;
      }
      for (const row of rows) {
        console.log(`  ${row.set ? '●' : '○'} ${row.name}${row.preview ? ` = ${row.preview}` : ' (unset)'}`);
      }
    });

  group
    .command('watch')
    .description('Watch openspec/ and forward changes to every enabled integration')
    .option('--interval <ms>', 'Poll interval in milliseconds', String(DEFAULT_WATCH_INTERVAL_MS))
    .option('--prime', 'Record the current state and exit, without notifying')
    .action(async (options: { interval?: string; prime?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      if (options.prime) {
        const count = await primeWatchSnapshot(projectRoot);
        console.log(`Baseline recorded for ${count} change(s). Future edits will be reported.`);
        return;
      }

      const loaded = await loadAdapters({ projectRoot, log: (m) => console.error(m) });
      const adapters = usableAdapters(loaded);

      // Distinguish "nothing is on" from "something is on but broken": the two
      // need different fixes, and conflating them sends the user in circles.
      for (const entry of loaded) {
        if (entry.initError) {
          console.error(`Skipping ${entry.adapter.id}: ${entry.initError.message}`);
        }
      }

      if (adapters.length === 0) {
        fail(
          loaded.length === 0
            ? 'No integrations are enabled'
            : 'Every enabled integration failed to start',
          loaded.length === 0
            ? 'openspec integrations enable trello'
            : 'openspec integrations status'
        );
        return;
      }

      // Telegram also answers commands while watching, so the two run together
      // rather than forcing the user to keep two processes alive.
      for (const { adapter } of adapters) {
        await adapter.start?.();
      }

      const intervalMs = Number(options.interval) || DEFAULT_WATCH_INTERVAL_MS;
      console.log(
        `Watching ${path.join(projectRoot, 'openspec')} every ${intervalMs}ms — ${adapters
          .map((a) => a.adapter.id)
          .join(', ')}. Ctrl-C to stop.`
      );

      const handle = startWatcher({
        projectRoot,
        adapters,
        intervalMs,
        log: (m) => console.error(m),
        onPass: (events) => {
          for (const event of events) console.log(`  ${event.type} ${event.changeId ?? ''}`);
        },
      });

      const shutdown = (): void => {
        handle.stop();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);

      await handle.done;
    });
}

// -----------------------------------------------------------------------------
// openspec trello ...
// -----------------------------------------------------------------------------

function buildTrelloClient(): TrelloClient | undefined {
  const missing = findMissingSecrets(['trelloKey', 'trelloToken']);
  if (missing.length > 0) {
    fail(`Missing credentials: ${missing.map((m) => m.name).join(', ')}`, missing[0].hint);
    return undefined;
  }
  return new TrelloClient({ key: getSecret('trelloKey')!, token: getSecret('trelloToken')! });
}

function printSyncReport(report: SyncReport): void {
  if (report.dryRun) console.log('Dry run — nothing was written.\n');

  for (const change of report.changes) {
    const parts = [
      change.created ? `${change.created} created` : undefined,
      change.updated ? `${change.updated} state change(s)` : undefined,
      change.renamed ? `${change.renamed} renamed` : undefined,
      change.deleted ? `${change.deleted} deleted` : undefined,
      change.localEdits.filter((e) => e.status === 'written').length
        ? `${change.localEdits.filter((e) => e.status === 'written').length} local edit(s)`
        : undefined,
    ].filter(Boolean);

    console.log(`${change.changeId}: ${parts.length > 0 ? parts.join(', ') : 'in sync'}`);
    if (change.cardUrl) console.log(`  ${change.cardUrl}`);
    if (change.skipped) console.log(`  skipped: ${change.skipped}`);

    for (const conflict of change.conflicts) {
      console.log(
        `  ⚠ conflict (${conflict.kind}) on "${conflict.description}": local=${conflict.localValue} remote=${conflict.remoteValue} → ${conflict.resolution}`
      );
    }
    for (const outcome of change.localEdits) {
      if (outcome.status === 'skipped') console.log(`  ⚠ skipped local edit: ${outcome.reason}`);
    }
    // Never silently drop coverage: an item that exists only on the card is
    // reported every run, because nothing else will ever mention it.
    for (const name of change.remoteOnly) {
      console.log(`  ⚠ only on the card, no line in tasks.md: ${name}`);
    }
  }

  for (const error of report.errors) {
    console.error(`  ✗ ${error.changeId}: ${error.message}`);
  }

  const conflicts = report.changes.reduce((n, c) => n + c.conflicts.length, 0);
  if (conflicts > 0) {
    console.log(
      `\n${conflicts} conflict(s) were not written. Resolve them by hand, or set trello.conflictPolicy in openspec/integrations.yaml.`
    );
  }
}

function registerTrelloGroup(program: Command): void {
  const group = program.command('trello').description('Sync changes and tasks with a Trello board');

  group
    .command('link <boardId>')
    .description('Discover the board lists and write listMap into openspec/integrations.yaml')
    .option('--create-lists', 'Create the standard lists on the board if they are missing')
    .option('--json', 'Output as JSON')
    .action(async (boardId: string, options: { json?: boolean; createLists?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const client = buildTrelloClient();
      if (!client) return;

      try {
        // Resolve first, and persist the canonical id rather than whatever the
        // user pasted. Read endpoints accept the short link from a board URL,
        // but `POST /lists` rejects it as `idBoard` with a 400 — so storing the
        // short link produces a config that reads fine and fails on write.
        const board = await client.getBoard(boardId);
        const resolvedId = board.id;

        let lists = (await client.getBoardLists(resolvedId)).filter((list) => !list.closed);

        // An empty board is a dead end without this: there is nothing to map, so
        // linking "succeeds" with everything unmapped and the next sync refuses
        // to create a card. Creating the columns is a write, hence opt-in.
        if (options.createLists) {
          const created: string[] = [];
          for (const name of ['To Do', 'In Progress', 'Review', 'Archived']) {
            if (lists.some((list) => list.name.toLowerCase() === name.toLowerCase())) continue;
            const list = await client.createList(resolvedId, name);
            lists.push(list);
            created.push(name);
          }
          if (created.length > 0 && !options.json) {
            console.log(`Created ${created.length} list(s): ${created.join(', ')}`);
          }
        }

        if (lists.length === 0) {
          fail(
            `Board "${board.name}" has no open lists, so there is nothing to map`,
            `Add columns in Trello, or run: openspec trello link ${boardId} --create-lists`
          );
          return;
        }

        // Matched by name so an existing board works untouched; anything that
        // does not match is left unmapped rather than guessed at.
        const byName = (pattern: RegExp): string | undefined =>
          lists.find((list) => pattern.test(list.name))?.id;

        const config = readIntegrationsConfig(projectRoot);
        config.trello.enabled = true;
        config.trello.boardId = resolvedId;
        config.trello.listMap = {
          proposed: byName(/propos|backlog|to ?do|new/i) ?? lists[0]?.id,
          in_progress: byName(/progress|doing|wip/i) ?? lists[1]?.id,
          review: byName(/review|done|complete/i) ?? lists[2]?.id,
          archived: byName(/archiv/i),
        };
        writeIntegrationsConfig(projectRoot, config);

        if (options.json) {
          printJson({ boardId: resolvedId, boardName: board.name, lists, listMap: config.trello.listMap });
          return;
        }

        console.log(`Linked "${board.name}" (${lists.length} lists, id ${resolvedId}).`);
        for (const [role, id] of Object.entries(config.trello.listMap)) {
          const name = lists.find((list) => list.id === id)?.name;
          console.log(`  ${role.padEnd(12)} → ${name ?? '(unmapped)'}`);
        }
        console.log(`\nEdit ${getIntegrationsConfigPath(projectRoot)} to change the mapping.`);
      } catch (error) {
        fail((error as Error).message);
      }
    });

  group
    .command('sync')
    .description('Reconcile tasks.md with the board')
    .option('--direction <direction>', 'both | push | pull', 'both')
    .option('--dry-run', 'Show the plan without writing anything')
    .option('--change <id>', 'Limit to one change')
    .option('--json', 'Output as JSON')
    .action(async (options: { direction?: string; dryRun?: boolean; change?: string; json?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const direction = (options.direction ?? 'both') as SyncDirection;
      if (!['both', 'push', 'pull'].includes(direction)) {
        fail(`Unknown direction "${direction}"`, 'Use both, push, or pull');
        return;
      }

      const client = buildTrelloClient();
      if (!client) return;

      const config = readIntegrationsConfig(projectRoot);

      try {
        const report = await syncTrello({
          projectRoot,
          config: config.trello,
          client,
          direction,
          dryRun: options.dryRun,
          changeIds: options.change ? [options.change] : undefined,
          log: (m) => !options.json && console.log(m),
        });

        if (options.json) {
          printJson(report);
        } else {
          printSyncReport(report);
        }

        if (report.errors.length > 0) process.exitCode = 1;
      } catch (error) {
        fail((error as Error).message);
      }
    });

  group
    .command('status')
    .description('Check the Trello connection and mapping')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const adapters = await loadAdapters({ projectRoot, only: ['trello'], log: (m) => console.error(m) });
      const [report] = await healthcheckAll(adapters);

      if (!report) {
        if (options.json) printJson({ trello: null });
        else console.log('Trello is not enabled. Try: openspec integrations enable trello');
        return;
      }

      if (options.json) printJson({ trello: report });
      else {
        console.log(`${report.level}: ${report.message}`);
        if (report.fix) console.log(`Fix: ${report.fix}`);
      }
    });
}

// -----------------------------------------------------------------------------
// openspec telegram ...
// -----------------------------------------------------------------------------

function registerTelegramGroup(program: Command): void {
  const group = program.command('telegram').description('Run and manage the Telegram bot');

  group
    .command('pair')
    .description('Generate a one-time code to link a chat')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const pairing = await createPairing(projectRoot);

      if (options.json) {
        printJson(pairing);
        return;
      }

      console.log(`Pairing code: ${pairing.code}`);
      console.log(`Expires: ${pairing.expiresAt}`);
      console.log('\nWith the bot running ("openspec telegram serve"), send it:');
      console.log(`  /link ${pairing.code}`);
    });

  group
    .command('chats')
    .description('List linked chats')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const config = readIntegrationsConfig(projectRoot);
      const paired = await getPairedChatIds(projectRoot);
      const rows = [
        ...config.telegram.allowedChatIds.map((id) => ({ id, source: 'config' })),
        ...paired.map((id) => ({ id, source: 'paired' })),
      ];

      if (options.json) {
        printJson({ chats: rows });
        return;
      }

      if (rows.length === 0) {
        console.log('No chats linked. Run: openspec telegram pair');
        return;
      }
      for (const row of rows) console.log(`  ${row.id} (${row.source})`);
    });

  group
    .command('unpair <chatId>')
    .description('Revoke a linked chat')
    .action(async (chatId: string) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const removed = await unpairChat(projectRoot, Number(chatId));
      console.log(
        removed
          ? `Chat ${chatId} unlinked.`
          : `Chat ${chatId} was not in the paired list (a chat set in integrations.yaml must be removed there).`
      );
    });

  group
    .command('test')
    .description('Verify the token and notify every linked chat')
    .action(async () => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const adapters = await loadAdapters({ projectRoot, only: ['telegram'], log: (m) => console.error(m) });
      if (adapters.length === 0) {
        fail('Telegram is not enabled', 'openspec integrations enable telegram');
        return;
      }

      const [report] = await healthcheckAll(adapters);
      console.log(`${report.level}: ${report.message}`);
      if (report.fix) console.log(`Fix: ${report.fix}`);
      if (report.level === 'error') {
        process.exitCode = 1;
        return;
      }

      await adapters[0].adapter.onEvent?.({
        type: 'change.created',
        changeId: 'openspec-test-message',
        at: new Date().toISOString(),
      });
      console.log('Test notification sent (if the event type is in notifyOn).');
    });

  group
    .command('serve')
    .description('Run the bot with long polling, and watch openspec/ for changes')
    .option('--interval <ms>', 'Watch poll interval in milliseconds', String(DEFAULT_WATCH_INTERVAL_MS))
    .action(async (options: { interval?: string }) => {
      const projectRoot = await resolveProjectRoot({});
      if (!projectRoot) return;

      const loaded = await loadAdapters({ projectRoot, log: (m) => console.error(m) });
      const adapters = usableAdapters(loaded);
      const telegram = adapters.find((a) => a.adapter.id === 'telegram');

      if (!telegram) {
        const broken = loaded.find((a) => a.adapter.id === 'telegram');
        fail(
          broken ? `Telegram could not start: ${broken.initError?.message}` : 'Telegram is not enabled',
          broken ? 'openspec integrations status' : 'openspec integrations enable telegram'
        );
        return;
      }

      await telegram.adapter.start?.();
      console.log('Bot is polling. Ctrl-C to stop.');

      const handle = startWatcher({
        projectRoot,
        adapters,
        intervalMs: Number(options.interval) || DEFAULT_WATCH_INTERVAL_MS,
        log: (m) => console.error(m),
      });

      const shutdown = (): void => handle.stop();
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);

      await handle.done;
      await telegram.adapter.dispose?.();
    });
}

export function registerIntegrationCommands(program: Command): void {
  registerIntegrationsGroup(program);
  registerTrelloGroup(program);
  registerTelegramGroup(program);
}
