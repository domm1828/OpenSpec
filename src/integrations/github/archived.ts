import { promises as fs } from 'fs';
import path from 'path';
import { changesDirFor, readChangeSnapshotFromDir } from '../snapshot.js';
import type { ChangeSnapshot } from '../types.js';

/**
 * Reading a change *after* it has been archived.
 *
 * `change.archived` is derived from a directory disappearing out of
 * `openspec/changes/`, so by the time the event arrives the snapshot the pull
 * request body needs is no longer where snapshots are read from — it has moved
 * under `archive/`, usually with a date prefix (`2026-08-02-add-auth`), and
 * sometimes without one when the change name already carried a date.
 */

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export function archiveDirFor(projectRoot: string): string {
  return path.join(changesDirFor(projectRoot), 'archive');
}

/**
 * Locates an archived change, or null if nothing there matches.
 *
 * Null is a meaningful answer, not just a miss: a change directory can also
 * vanish because someone deleted or renamed it, and both look identical to the
 * watcher. Opening a pull request for a change that was *deleted* would be the
 * integration inventing work that no longer exists, so the adapter treats an
 * absent archive as "not an archive" and does nothing.
 */
export async function findArchivedChangeDir(
  projectRoot: string,
  changeId: string
): Promise<string | null> {
  const archiveDir = archiveDirFor(projectRoot);

  let entries: string[];
  try {
    entries = (await fs.readdir(archiveDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  const exact = entries.find((name) => name === changeId);
  if (exact) return path.join(archiveDir, exact);

  // Newest first, so a change id archived more than once (renamed, re-created,
  // archived again) resolves to the archive that just appeared.
  const dated = entries
    .filter((name) => DATE_PREFIX.test(name) && name.slice(11) === changeId)
    .sort()
    .reverse();

  return dated.length > 0 ? path.join(archiveDir, dated[0]) : null;
}

/** Snapshot of an archived change, or null when it is not in the archive. */
export async function readArchivedChangeSnapshot(
  projectRoot: string,
  changeId: string
): Promise<ChangeSnapshot | null> {
  const dir = await findArchivedChangeDir(projectRoot, changeId);
  if (!dir) return null;
  return readChangeSnapshotFromDir(projectRoot, changeId, dir);
}
