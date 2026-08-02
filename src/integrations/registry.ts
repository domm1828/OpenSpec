import type {
  HealthReport,
  IntegrationAdapter,
  IntegrationContext,
  InboundChange,
  OpenSpecEvent,
} from './types.js';
import { readIntegrationsConfig, type IntegrationsConfig } from './config.js';

/**
 * Adapter factories, registered by id.
 *
 * Factories rather than instances so nothing is constructed — and no network
 * client is created, no token read — until an adapter is actually enabled.
 *
 * Async so a factory can `await import()` its transport. That matters more than
 * it looks: importing grammY statically pulled the deprecated `punycode` module
 * into *every* `openspec` invocation, and the resulting Node warning on stderr
 * broke the repo's contract that a `--json` run leaves stderr clean.
 */
export type AdapterFactory = (config: unknown) => IntegrationAdapter | Promise<IntegrationAdapter>;

const factories = new Map<string, AdapterFactory>();

export function registerAdapter(id: string, factory: AdapterFactory): void {
  factories.set(id, factory);
}

export function registeredAdapterIds(): string[] {
  return [...factories.keys()].sort();
}

export interface LoadAdaptersOptions {
  projectRoot: string;
  config?: IntegrationsConfig;
  /** Restrict to these ids, even if others are enabled. */
  only?: string[];
  log?: (message: string) => void;
  now?: () => string;
}

export interface LoadedAdapter {
  adapter: IntegrationAdapter;
  context: IntegrationContext;
  /**
   * Set when `init` threw — almost always a missing credential.
   *
   * The adapter is kept in the list rather than dropped, because `healthcheck`
   * is precisely the surface that explains this failure and hands back the fix.
   * Dropping it made `openspec integrations status` report "no integrations are
   * enabled" for a Trello that was enabled and merely lacked a token, sending
   * the user to re-run `enable` for a problem that command cannot solve.
   *
   * Work dispatch skips these; only diagnostics see them.
   */
  initError?: Error;
}

function configFor(config: IntegrationsConfig, id: string): { enabled: boolean; value: unknown } {
  switch (id) {
    case 'telegram':
      return { enabled: config.telegram.enabled, value: config.telegram };
    case 'trello':
      return { enabled: config.trello.enabled, value: config.trello };
    default:
      return { enabled: false, value: undefined };
  }
}

/**
 * Instantiates and initializes every enabled adapter.
 *
 * An adapter whose `init` throws is returned carrying its `initError` rather
 * than aborting the run: one misconfigured integration must not take the others
 * down with it, and it must still be visible to `healthcheck`, which is what
 * turns "init threw" into an actionable message.
 */
export async function loadAdapters(options: LoadAdaptersOptions): Promise<LoadedAdapter[]> {
  const {
    projectRoot,
    config = readIntegrationsConfig(projectRoot),
    only,
    log = () => {},
    now = () => new Date().toISOString(),
  } = options;

  const loaded: LoadedAdapter[] = [];

  for (const id of registeredAdapterIds()) {
    if (only && !only.includes(id)) continue;

    const { enabled, value } = configFor(config, id);
    if (!enabled) continue;

    const factory = factories.get(id);
    if (!factory) continue;

    const context: IntegrationContext = { projectRoot, config: value, log, now };

    let adapter: IntegrationAdapter;
    try {
      adapter = await factory(value);
    } catch (error) {
      // A factory that throws leaves nothing to diagnose with, so this one is
      // genuinely dropped.
      log(`Integration "${id}" could not be constructed: ${(error as Error).message}`);
      continue;
    }

    try {
      await adapter.init(context);
      loaded.push({ adapter, context });
    } catch (error) {
      loaded.push({ adapter, context, initError: error as Error });
    }
  }

  return loaded;
}

/** Adapters that started cleanly and can be given work. */
export function usableAdapters(adapters: LoadedAdapter[]): LoadedAdapter[] {
  return adapters.filter((entry) => entry.initError === undefined);
}

/**
 * Fans an event out to every adapter.
 *
 * Failures are collected, never thrown: an unreachable Trello must not stop the
 * Telegram notification for the same event, and the caller decides how loudly to
 * report the partial failure.
 */
export async function dispatchEvent(
  adapters: LoadedAdapter[],
  event: OpenSpecEvent
): Promise<Array<{ id: string; error: Error }>> {
  const failures: Array<{ id: string; error: Error }> = [];

  await Promise.all(
    usableAdapters(adapters).map(async ({ adapter }) => {
      if (!adapter.onEvent) return;
      try {
        await adapter.onEvent(event);
      } catch (error) {
        failures.push({ id: adapter.id, error: error as Error });
      }
    })
  );

  return failures;
}

export async function collectInbound(adapters: LoadedAdapter[]): Promise<InboundChange[]> {
  const batches = await Promise.all(
    usableAdapters(adapters).map(async ({ adapter }) => {
      if (!adapter.pull) return [];
      try {
        return await adapter.pull();
      } catch {
        return [];
      }
    })
  );
  return batches.flat();
}

export async function healthcheckAll(adapters: LoadedAdapter[]): Promise<HealthReport[]> {
  return Promise.all(
    adapters.map(async ({ adapter, initError }) => {
      try {
        const report = await adapter.healthcheck();
        // A healthcheck that says "ok" for an adapter that never started would
        // be worse than no check at all, so the init failure wins.
        if (initError && report.level === 'ok') {
          return { id: adapter.id, level: 'error' as const, message: initError.message };
        }
        return report;
      } catch (error) {
        return {
          id: adapter.id,
          level: 'error' as const,
          message: initError?.message ?? (error as Error).message,
        };
      }
    })
  );
}

export async function disposeAll(adapters: LoadedAdapter[]): Promise<void> {
  await Promise.all(
    usableAdapters(adapters).map(async ({ adapter }) => {
      try {
        await adapter.dispose?.();
      } catch {
        // Disposal is best-effort; a failing teardown must not mask the result
        // of the work that just completed.
      }
    })
  );
}

/** Test seam: drops every registration. */
export function clearAdapters(): void {
  factories.clear();
}
