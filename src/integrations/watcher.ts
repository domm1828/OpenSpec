import { readAllChangeSnapshots } from './snapshot.js';
import { deriveEvents, snapshotFromChanges } from './events.js';
import { readWatchSnapshot, writeWatchSnapshot } from './state.js';
import { dispatchEvent, type LoadedAdapter } from './registry.js';
import type { OpenSpecEvent } from './types.js';

/**
 * Watches `openspec/` and turns what moved into events.
 *
 * Interval polling rather than `fs.watch`, deliberately. Recursive watching is
 * unreliable in exactly this workload: editors and AI agents write via
 * atomic-rename or write-truncate-write, which surfaces as delete-then-create
 * (or as two events, or as none) depending on platform and editor. Re-reading
 * the tree is a few milliseconds for a project of this size and is
 * self-correcting — a poll that is missed or that races a half-written file is
 * simply superseded by the next one.
 */

export interface WatcherOptions {
  projectRoot: string;
  adapters: LoadedAdapter[];
  intervalMs?: number;
  log?: (message: string) => void;
  now?: () => string;
  /** Called after every pass, mainly so tests can observe without timing. */
  onPass?: (events: OpenSpecEvent[]) => void;
}

export const DEFAULT_WATCH_INTERVAL_MS = 5_000;

/**
 * Runs one pass: read, diff, dispatch, persist.
 *
 * The snapshot is written only after dispatch resolves. If the process dies
 * mid-dispatch the same events are re-derived next time — a duplicate
 * notification is a far cheaper failure than a tick that never reaches Trello.
 */
export async function runWatchPass(options: WatcherOptions): Promise<OpenSpecEvent[]> {
  const { projectRoot, adapters, log = () => {}, now = () => new Date().toISOString() } = options;

  const previous = await readWatchSnapshot(projectRoot);
  const changes = await readAllChangeSnapshots(projectRoot);
  const events = deriveEvents(previous, changes, now());

  for (const event of events) {
    const failures = await dispatchEvent(adapters, event);
    for (const failure of failures) {
      log(`${failure.id} could not handle ${event.type}: ${failure.error.message}`);
    }
  }

  await writeWatchSnapshot(projectRoot, snapshotFromChanges(changes));
  return events;
}

export interface WatcherHandle {
  stop: () => void;
  /** Resolves when the loop has exited. */
  done: Promise<void>;
}

export function startWatcher(options: WatcherOptions): WatcherHandle {
  const { intervalMs = DEFAULT_WATCH_INTERVAL_MS, log = () => {}, onPass } = options;

  let stopped = false;
  let wake: (() => void) | undefined;

  const stop = (): void => {
    stopped = true;
    wake?.();
  };

  const done = (async () => {
    while (!stopped) {
      try {
        const events = await runWatchPass(options);
        onPass?.(events);
      } catch (error) {
        // A transient read error (a file being rewritten as we walk) must not
        // end the watch; the next pass sees a consistent tree.
        log(`Watch pass failed: ${(error as Error).message}`);
      }

      if (stopped) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();

  return { stop, done };
}

/**
 * Seeds the baseline without dispatching anything.
 *
 * Run before the first watch in an existing project: otherwise pass one sees
 * every change as new and fires a `change.created` for each.
 */
export async function primeWatchSnapshot(projectRoot: string): Promise<number> {
  const changes = await readAllChangeSnapshots(projectRoot);
  await writeWatchSnapshot(projectRoot, snapshotFromChanges(changes));
  return changes.length;
}
