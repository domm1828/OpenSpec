import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { resolveArtifactOutputs, resolveSchema } from '../core/artifact-graph/index.js';
import type { Artifact, SchemaYaml } from '../core/artifact-graph/index.js';
import { resolveSchemaForChange } from '../utils/change-metadata.js';
import { readChangeMetadata } from '../utils/change-metadata.js';
import { parseTaskLinesWithPositions } from '../utils/task-progress.js';
import type { ChangeSnapshot, TaskRef } from './types.js';

/**
 * Normalizes a task description into a matching key.
 *
 * Collapses whitespace, drops leading outline numbering (`1.`, `2.3`, `-`) and
 * lowercases, so `- [ ] 1.2 Wire the client` and `- [x] 1.2  wire the client`
 * are the same task after a reorder or a renumber. Deliberately not a content
 * hash of the raw line: renumbering is routine in these files and would
 * otherwise read as "old task deleted, new task added" on every sync.
 */
export function taskKey(description: string): string {
  const normalized = description
    .replace(/^[\d.]+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

/** Mirrors `findTrackedTasksArtifact` in utils/task-progress.ts. */
function findTrackedTasksArtifact(schema: SchemaYaml): Artifact | undefined {
  const tracks = schema.apply?.tracks;
  if (tracks != null) {
    return schema.artifacts.find((a) => a.generates === tracks);
  }
  return schema.artifacts.find((a) => a.id === 'tasks');
}

/**
 * Resolves the files holding a change's tracked tasks.
 *
 * Uses the same artifact resolution `openspec status` uses, then falls back to a
 * lone top-level `tasks.md` — the same fallback `getTaskProgressForChange` takes
 * when the schema is unresolvable. Returning absolute paths keeps the writer
 * honest about which file it is editing.
 */
async function resolveTaskFiles(changeDir: string, projectRoot: string): Promise<string[]> {
  try {
    const schemaName = resolveSchemaForChange(changeDir, undefined, projectRoot);
    const schema = resolveSchema(schemaName, projectRoot);
    const generates = findTrackedTasksArtifact(schema)?.generates;
    if (generates) {
      const files = resolveArtifactOutputs(changeDir, generates);
      if (files.length > 0) return files;
    }
  } catch {
    // Fall through to the single-file fallback, exactly as task-progress does.
  }

  const fallback = path.join(changeDir, 'tasks.md');
  try {
    await fs.access(fallback);
    return [fallback];
  } catch {
    return [];
  }
}

/** Most recent mtime under `dir`, or the directory's own mtime when it is empty. */
async function lastModified(dir: string): Promise<Date> {
  let latest: Date | null = null;

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const stat = await fs.stat(full);
        if (latest === null || stat.mtime > latest) latest = stat.mtime;
      }
    }
  }

  try {
    await walk(dir);
  } catch {
    // A change directory that vanishes mid-walk falls back to its own stat below.
  }

  if (latest === null) {
    try {
      return (await fs.stat(dir)).mtime;
    } catch {
      return new Date(0);
    }
  }
  return latest;
}

/** First non-heading, non-empty paragraph of proposal.md, truncated for chat/card use. */
async function readSummary(changeDir: string, maxLength = 400): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(changeDir, 'proposal.md'), 'utf-8');
    const paragraph = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .slice(0, 4)
      .join(' ');
    if (!paragraph) return undefined;
    return paragraph.length > maxLength ? `${paragraph.slice(0, maxLength - 1)}…` : paragraph;
  } catch {
    return undefined;
  }
}

export function changesDirFor(projectRoot: string): string {
  return path.join(projectRoot, 'openspec', 'changes');
}

/** Builds a snapshot for one change. Never throws; a broken change yields zero tasks. */
export async function readChangeSnapshot(
  projectRoot: string,
  changeId: string
): Promise<ChangeSnapshot> {
  const changeDir = path.join(changesDirFor(projectRoot), changeId);
  const files = await resolveTaskFiles(changeDir, projectRoot);

  const tasks: TaskRef[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const relative = path.relative(changeDir, file).split(path.sep).join('/');
    for (const parsed of parseTaskLinesWithPositions(content)) {
      tasks.push({
        file: relative,
        lineIndex: parsed.lineIndex,
        description: parsed.description,
        done: parsed.done,
        key: taskKey(parsed.description),
      });
    }
  }

  let metadata: ReturnType<typeof readChangeMetadata> = null;
  try {
    metadata = readChangeMetadata(changeDir, projectRoot);
  } catch {
    // Invalid metadata must not hide the change from an integration; the goal
    // and schema fields simply stay undefined.
  }

  return {
    id: changeId,
    dir: changeDir,
    goal: metadata?.goal,
    schema: metadata?.schema,
    tasks,
    completedTasks: tasks.filter((t) => t.done).length,
    totalTasks: tasks.length,
    lastModified: (await lastModified(changeDir)).toISOString(),
    summary: await readSummary(changeDir),
  };
}

/** Lists active change ids (everything under openspec/changes/ except `archive`). */
export async function listChangeIds(projectRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(changesDirFor(projectRoot), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Snapshots every active change. */
export async function readAllChangeSnapshots(projectRoot: string): Promise<ChangeSnapshot[]> {
  const ids = await listChangeIds(projectRoot);
  return Promise.all(ids.map((id) => readChangeSnapshot(projectRoot, id)));
}

/** Absolute path of a task's file, for handing to the writer. */
export function taskFilePath(change: ChangeSnapshot, task: TaskRef): string {
  return path.join(change.dir, ...task.file.split('/'));
}
