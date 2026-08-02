import { promises as fs } from 'fs';
import path from 'path';
import type { ChangeSnapshot } from './types.js';

/**
 * Sync bookkeeping — id mappings and the last-synced baseline.
 *
 * Kept out of each change's `.openspec.yaml` on purpose: `writeChangeMetadata`
 * re-serializes whatever `ChangeMetadataSchema` parses, and that schema drops
 * unknown keys without erroring, so a `trello:` block written there would
 * silently vanish on the next metadata write.
 *
 * Lives at the project root in `.openspec-integrations/`, gitignored: it is
 * machine-local cache, and committing card ids would make the file a merge
 * conflict magnet on every branch.
 */
export const STATE_DIR_NAME = '.openspec-integrations';

export function getStateDir(projectRoot: string): string {
  return path.join(projectRoot, STATE_DIR_NAME);
}

/**
 * `makeFallback` is a factory, not a value, on purpose.
 *
 * Handing back a shared object meant a caller that mutated the result of a
 * missing-file read was mutating a module-level constant — so the next project
 * to read a non-existent state file inherited the previous project's baseline.
 * In a watcher process spanning two repos that is silent cross-contamination of
 * sync state, and a dry run could leave a baseline behind despite writing nothing.
 */
async function readJson<T>(filePath: string, makeFallback: () => T): Promise<T> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    if (parsed !== null && typeof parsed === 'object') return parsed as T;
    return makeFallback();
  } catch {
    return makeFallback();
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

/**
 * The baseline: what both sides agreed on at the end of the last sync.
 *
 * Without it a two-way sync cannot tell "the remote changed" from "the local
 * changed" — it would only see that the two differ, and every difference would
 * become a coin flip. This is the `base` of the three-way merge.
 */
export interface TaskBaseline {
  key: string;
  description: string;
  done: boolean;
  /** Remote item id, when the remote has assigned one. */
  remoteId?: string;
}

export interface ChangeSyncState {
  /** Remote container for this change (a Trello card id). */
  remoteId?: string;
  /** Baseline per task key. */
  tasks: Record<string, TaskBaseline>;
  /** ISO-8601 of the last successful reconciliation. */
  lastSyncedAt?: string;
  /** Remote's own change marker at that time (Trello's `dateLastActivity`). */
  lastRemoteActivity?: string;
}

export interface AdapterState {
  changes: Record<string, ChangeSyncState>;
  /** Adapter-specific extras (board id caches, pairing codes, chat ids). */
  extra?: Record<string, unknown>;
}

function adapterStatePath(projectRoot: string, adapterId: string): string {
  return path.join(getStateDir(projectRoot), `${adapterId}-state.json`);
}

export async function readAdapterState(
  projectRoot: string,
  adapterId: string
): Promise<AdapterState> {
  const state = await readJson<AdapterState>(adapterStatePath(projectRoot, adapterId), () => ({
    changes: {},
  }));
  return { changes: state.changes ?? {}, extra: state.extra };
}

export async function writeAdapterState(
  projectRoot: string,
  adapterId: string,
  state: AdapterState
): Promise<void> {
  await writeJson(adapterStatePath(projectRoot, adapterId), state);
}

/** Builds a baseline from a snapshot — the shape to persist after a clean sync. */
export function baselineFromSnapshot(change: ChangeSnapshot): Record<string, TaskBaseline> {
  const baseline: Record<string, TaskBaseline> = {};
  for (const task of change.tasks) {
    baseline[task.key] = { key: task.key, description: task.description, done: task.done };
  }
  return baseline;
}

/**
 * The watcher's view of the world: enough per change to detect what moved,
 * without keeping whole file contents around.
 */
export interface WatchSnapshotEntry {
  lastModified: string;
  completedTasks: number;
  totalTasks: number;
  /** Task key → done, so the watcher can name which task flipped. */
  tasks: Record<string, boolean>;
}

export type WatchSnapshot = Record<string, WatchSnapshotEntry>;

function watchSnapshotPath(projectRoot: string): string {
  return path.join(getStateDir(projectRoot), 'watch-snapshot.json');
}

export async function readWatchSnapshot(projectRoot: string): Promise<WatchSnapshot> {
  return readJson<WatchSnapshot>(watchSnapshotPath(projectRoot), () => ({}));
}

export async function writeWatchSnapshot(
  projectRoot: string,
  snapshot: WatchSnapshot
): Promise<void> {
  await writeJson(watchSnapshotPath(projectRoot), snapshot);
}

export function watchEntryFromSnapshot(change: ChangeSnapshot): WatchSnapshotEntry {
  const tasks: Record<string, boolean> = {};
  for (const task of change.tasks) tasks[task.key] = task.done;
  return {
    lastModified: change.lastModified,
    completedTasks: change.completedTasks,
    totalTasks: change.totalTasks,
    tasks,
  };
}
