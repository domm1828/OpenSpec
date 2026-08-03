import { describe, it, expect } from 'vitest';
import { deriveEvents, snapshotFromChanges, describeEvent } from '../../src/integrations/events.js';
import { taskKey } from '../../src/integrations/snapshot.js';
import type { ChangeSnapshot, TaskRef } from '../../src/integrations/types.js';

const NOW = '2026-08-01T12:00:00.000Z';

function task(description: string, done: boolean, lineIndex = 0): TaskRef {
  return { file: 'tasks.md', lineIndex, description, done, key: taskKey(description) };
}

function change(id: string, tasks: TaskRef[], lastModified = NOW): ChangeSnapshot {
  return {
    id,
    dir: `/project/openspec/changes/${id}`,
    tasks,
    completedTasks: tasks.filter((t) => t.done).length,
    totalTasks: tasks.length,
    lastModified,
  };
}

describe('deriveEvents', () => {
  it('reports a change that was not there before as created', () => {
    const events = deriveEvents({}, [change('add-auth', [task('Wire login', false)])], NOW);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'change.created', changeId: 'add-auth', at: NOW });
  });

  it('does not replay pre-existing ticks when a change first appears', () => {
    // Otherwise the first run in an established project floods the chat with
    // one notification per already-completed task.
    const events = deriveEvents({}, [
      change('add-auth', [task('Wire login', true), task('Add tests', true)]),
    ], NOW);

    expect(events.map((e) => e.type)).toEqual(['change.created']);
  });

  it('reports a task that flipped to done', () => {
    const before = snapshotFromChanges([change('add-auth', [task('Wire login', false)])]);
    const events = deriveEvents(before, [change('add-auth', [task('Wire login', true)], '2026-08-01T13:00:00.000Z')], NOW);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.checked');
    expect(events[0].task?.description).toBe('Wire login');
  });

  it('reports a task that was reopened', () => {
    const before = snapshotFromChanges([change('add-auth', [task('Wire login', true)])]);
    const events = deriveEvents(before, [change('add-auth', [task('Wire login', false)], '2026-08-01T13:00:00.000Z')], NOW);

    expect(events.map((e) => e.type)).toEqual(['task.unchecked']);
  });

  it('treats a task key that survives renumbering as the same task', () => {
    // Renumbering an outline is routine; it must not read as delete + add.
    const before = snapshotFromChanges([change('add-auth', [task('1.1 Wire login', false)])]);
    const events = deriveEvents(before, [change('add-auth', [task('2.4 Wire  login', true)], '2026-08-01T13:00:00.000Z')], NOW);

    expect(events.map((e) => e.type)).toEqual(['task.checked']);
  });

  it('ignores a newly added task, since it is not a state change', () => {
    const before = snapshotFromChanges([change('add-auth', [task('Wire login', false)])]);
    const events = deriveEvents(
      before,
      [change('add-auth', [task('Wire login', false), task('Add tests', true)], '2026-08-01T13:00:00.000Z')],
      NOW
    );

    expect(events.map((e) => e.type)).toEqual(['change.updated']);
  });

  it('reports prose-only edits as change.updated', () => {
    const before = snapshotFromChanges([change('add-auth', [task('Wire login', false)])]);
    const events = deriveEvents(
      before,
      [change('add-auth', [task('Wire login', false)], '2026-08-01T13:00:00.000Z')],
      NOW
    );

    expect(events.map((e) => e.type)).toEqual(['change.updated']);
  });

  it('does not emit change.updated alongside a task event for the same edit', () => {
    const before = snapshotFromChanges([change('add-auth', [task('Wire login', false)])]);
    const events = deriveEvents(
      before,
      [change('add-auth', [task('Wire login', true)], '2026-08-01T13:00:00.000Z')],
      NOW
    );

    expect(events.map((e) => e.type)).toEqual(['task.checked']);
  });

  it('emits nothing when nothing moved', () => {
    const snapshot = [change('add-auth', [task('Wire login', false)])];
    expect(deriveEvents(snapshotFromChanges(snapshot), snapshot, NOW)).toEqual([]);
  });

  it('reports a change that disappeared as archived', () => {
    const before = snapshotFromChanges([change('add-auth', [task('Wire login', true)])]);
    const events = deriveEvents(before, [], NOW);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'change.archived', changeId: 'add-auth' });
  });

  it('handles several changes moving independently in one pass', () => {
    const before = snapshotFromChanges([
      change('a', [task('t1', false)]),
      change('b', [task('t2', false)]),
    ]);
    const events = deriveEvents(
      before,
      [change('a', [task('t1', true)], '2026-08-01T13:00:00.000Z'), change('c', [task('t3', false)])],
      NOW
    );

    expect(events.map((e) => `${e.type}:${e.changeId}`).sort()).toEqual([
      'change.archived:b',
      'change.created:c',
      'task.checked:a',
    ]);
  });
});

describe('describeEvent', () => {
  it('includes task progress for task events', () => {
    const snapshot = change('add-auth', [task('Wire login', true), task('Add tests', false)]);
    const line = describeEvent({
      type: 'task.checked',
      changeId: 'add-auth',
      change: snapshot,
      task: snapshot.tasks[0],
      at: NOW,
    });

    expect(line).toBe('Task done in add-auth (1/2): Wire login');
  });

  it('truncates a very long task description', () => {
    const long = 'x'.repeat(400);
    const line = describeEvent({
      type: 'task.checked',
      changeId: 'a',
      task: task(long, true),
      at: NOW,
    });

    expect(line.length).toBeLessThan(200);
    expect(line.endsWith('…')).toBe(true);
  });
});
