import type { ChangeSnapshot, OpenSpecEvent, TaskRef } from './types.js';
import type { WatchSnapshot } from './state.js';
import { watchEntryFromSnapshot } from './state.js';

/**
 * Derives events by diffing the last observed state against the current one.
 *
 * This is the layer's primary event source, not a fallback. OpenSpec's CLI is an
 * ephemeral process, and in practice the AI agent does most of the mutating by
 * editing Markdown directly — so a design that only fired events from command
 * hooks would miss the majority of what happens in a project.
 *
 * Pure and snapshot-driven so it is testable without a filesystem watcher: the
 * watcher's only job is to decide *when* to call this.
 */
export function deriveEvents(
  previous: WatchSnapshot,
  current: ChangeSnapshot[],
  now: string
): OpenSpecEvent[] {
  const events: OpenSpecEvent[] = [];
  const seen = new Set<string>();

  for (const change of current) {
    seen.add(change.id);
    const before = previous[change.id];

    if (!before) {
      events.push({ type: 'change.created', changeId: change.id, change, at: now });
      // A change that appears with tasks already ticked reports the creation
      // only: replaying each pre-existing tick as a fresh event would spam the
      // chat on first run and on every fresh clone.
      continue;
    }

    const taskEvents = diffTasks(change, before.tasks, now);
    events.push(...taskEvents);

    // `change.updated` covers edits the task diff cannot see — a reworded
    // proposal, a new spec delta — so a notification still fires for prose-only
    // work. Suppressed when a task event already reported the same edit.
    if (taskEvents.length === 0 && before.lastModified !== change.lastModified) {
      events.push({ type: 'change.updated', changeId: change.id, change, at: now });
    }
  }

  for (const changeId of Object.keys(previous)) {
    if (!seen.has(changeId)) {
      // A change directory that disappears was archived (or deleted); from the
      // outside both look the same, and both mean "stop tracking it".
      events.push({ type: 'change.archived', changeId, at: now });
    }
  }

  return events;
}

function diffTasks(
  change: ChangeSnapshot,
  before: Record<string, boolean>,
  now: string
): OpenSpecEvent[] {
  const events: OpenSpecEvent[] = [];

  for (const task of change.tasks) {
    const wasDone = before[task.key];
    if (wasDone === undefined) continue; // new task: not a state change
    if (wasDone === task.done) continue;

    events.push({
      type: task.done ? 'task.checked' : 'task.unchecked',
      changeId: change.id,
      change,
      task,
      at: now,
    });
  }

  return events;
}

/** Rebuilds the watch snapshot from the changes just observed. */
export function snapshotFromChanges(changes: ChangeSnapshot[]): WatchSnapshot {
  const snapshot: WatchSnapshot = {};
  for (const change of changes) snapshot[change.id] = watchEntryFromSnapshot(change);
  return snapshot;
}

/** One-line rendering shared by every adapter, so notifications read alike. */
export function describeEvent(event: OpenSpecEvent): string {
  const change = event.changeId ?? event.specId ?? 'unknown';
  const progress = event.change ? ` (${event.change.completedTasks}/${event.change.totalTasks})` : '';

  switch (event.type) {
    case 'change.created':
      return `New change: ${change}${event.change?.goal ? ` — ${event.change.goal}` : ''}`;
    case 'change.updated':
      return `Change updated: ${change}${progress}`;
    case 'change.archived':
      return `Change archived: ${change}`;
    case 'change.validated':
      return `Change validated: ${change}`;
    case 'task.checked':
      return `Task done in ${change}${progress}: ${describeTask(event.task)}`;
    case 'task.unchecked':
      return `Task reopened in ${change}${progress}: ${describeTask(event.task)}`;
    case 'spec.updated':
      return `Spec updated: ${change}`;
  }
}

function describeTask(task: TaskRef | undefined): string {
  if (!task) return '(unknown task)';
  return task.description.length > 120 ? `${task.description.slice(0, 119)}…` : task.description;
}
