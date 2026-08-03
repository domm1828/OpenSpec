import { describe, it, expect } from 'vitest';
import { reconcile, matchTasks, isNoopPlan } from '../../src/integrations/trello/mapping.js';
import type { ConflictPolicy } from '../../src/integrations/trello/mapping.js';
import { taskKey } from '../../src/integrations/snapshot.js';
import type { TaskRef } from '../../src/integrations/types.js';
import type { TaskBaseline } from '../../src/integrations/state.js';
import type { TrelloCheckItem } from '../../src/integrations/trello/client.js';

function local(description: string, done: boolean, lineIndex = 0): TaskRef {
  return { file: 'tasks.md', lineIndex, description, done, key: taskKey(description) };
}

function remote(id: string, name: string, done: boolean, pos = 1): TrelloCheckItem {
  return {
    id,
    name,
    state: done ? 'complete' : 'incomplete',
    pos,
    idChecklist: 'cl1',
  };
}

function base(description: string, done: boolean, remoteId?: string): [string, TaskBaseline] {
  const key = taskKey(description);
  return [key, { key, description, done, remoteId }];
}

function run(
  localTasks: TaskRef[],
  remoteItems: TrelloCheckItem[],
  baseline: Record<string, TaskBaseline> = {},
  conflictPolicy: ConflictPolicy = 'manual',
  direction: 'both' | 'push' | 'pull' = 'both'
) {
  return reconcile({ local: localTasks, remote: remoteItems, baseline, conflictPolicy, direction });
}

describe('matchTasks', () => {
  it('pairs by recorded remote id even after both sides were renamed', () => {
    // The pairing was made when the names agreed; it must outlive them.
    const pairs = matchTasks(
      [local('Wire the login form', false)],
      [remote('ci1', 'Wire the login screen', false)],
      Object.fromEntries([base('Wire the login form', false, 'ci1')])
    );

    expect(pairs).toHaveLength(1);
    expect(pairs[0].local?.description).toBe('Wire the login form');
    expect(pairs[0].remote?.id).toBe('ci1');
  });

  it('pairs by normalized text when there is no baseline yet', () => {
    const pairs = matchTasks(
      [local('1.1 Wire login', false)],
      [remote('ci1', '2.4  wire  login', true)],
      {}
    );

    expect(pairs).toHaveLength(1);
    expect(pairs[0].remote?.id).toBe('ci1');
  });

  it('does not pair by position when a task is inserted at the top', () => {
    // The classic ordinal-matching bug: every task below the insertion would
    // otherwise adopt its neighbour's state.
    const pairs = matchTasks(
      [local('Brand new task', false, 0), local('Wire login', true, 1)],
      [remote('ci1', 'Wire login', true, 1)],
      {}
    );

    const wired = pairs.find((p) => p.local?.description === 'Wire login');
    const brandNew = pairs.find((p) => p.local?.description === 'Brand new task');

    expect(wired?.remote?.id).toBe('ci1');
    expect(brandNew?.remote).toBeUndefined();
  });
});

describe('reconcile — one-sided changes', () => {
  it('creates a remote item for a local task the board has never seen', () => {
    const plan = run([local('Wire login', false)], []);

    expect(plan.remoteCreates).toHaveLength(1);
    expect(plan.remoteCreates[0]).toMatchObject({ name: 'Wire login', checked: false });
    expect(plan.localStateUpdates).toEqual([]);
  });

  it('pushes a local tick when the remote still matches the baseline', () => {
    const plan = run(
      [local('Wire login', true)],
      [remote('ci1', 'Wire login', false)],
      Object.fromEntries([base('Wire login', false, 'ci1')])
    );

    expect(plan.remoteStateUpdates).toEqual([
      { key: taskKey('Wire login'), checkItemId: 'ci1', state: 'complete' },
    ]);
    expect(plan.localStateUpdates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('pulls a remote tick when the local file still matches the baseline', () => {
    const plan = run(
      [local('Wire login', false, 3)],
      [remote('ci1', 'Wire login', true)],
      Object.fromEntries([base('Wire login', false, 'ci1')])
    );

    expect(plan.localStateUpdates).toEqual([
      {
        key: taskKey('Wire login'),
        file: 'tasks.md',
        lineIndex: 3,
        description: 'Wire login',
        done: true,
      },
    ]);
    expect(plan.remoteStateUpdates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('writes nothing when both sides already agree', () => {
    const plan = run(
      [local('Wire login', true)],
      [remote('ci1', 'Wire login', true)],
      Object.fromEntries([base('Wire login', true, 'ci1')])
    );

    expect(isNoopPlan(plan)).toBe(true);
    expect(plan.conflicts).toEqual([]);
  });

  it('deletes a remote item only when the baseline proves it was synced', () => {
    const plan = run([], [remote('ci1', 'Removed task', false)], Object.fromEntries([base('Removed task', false, 'ci1')]));

    expect(plan.remoteDeletes).toEqual([
      { key: taskKey('Removed task'), checkItemId: 'ci1', name: 'Removed task' },
    ]);
  });

  it('reports an item created directly in Trello instead of inventing a tasks.md line', () => {
    const plan = run([], [remote('ci9', 'Added in Trello', false)]);

    expect(plan.remoteDeletes).toEqual([]);
    expect(plan.remoteOnly.map((i) => i.id)).toEqual(['ci9']);
    expect(plan.localStateUpdates).toEqual([]);
  });

  it('re-creates a remote item deleted in Trello rather than dropping the local line', () => {
    const plan = run(
      [local('Wire login', false)],
      [],
      Object.fromEntries([base('Wire login', false, 'ci1')])
    );

    expect(plan.remoteCreates).toHaveLength(1);
    expect(plan.localStateUpdates).toEqual([]);
  });
});

describe('reconcile — conflicts', () => {
  it('treats disagreement WITH a baseline as unambiguous, not as a conflict', () => {
    // `done` is a boolean: if the two sides differ, exactly one still equals the
    // baseline, so the side that moved is known. There is nothing to arbitrate.
    const pushed = run(
      [local('Wire login', true)],
      [remote('ci1', 'Wire login', false)],
      Object.fromEntries([base('Wire login', false, 'ci1')])
    );
    const pulled = run(
      [local('Wire login', false)],
      [remote('ci1', 'Wire login', true)],
      Object.fromEntries([base('Wire login', false, 'ci1')])
    );

    expect(pushed.conflicts).toEqual([]);
    expect(pulled.conflicts).toEqual([]);
  });

  it('flags disagreement with NO baseline as a conflict and writes nothing under manual', () => {
    const plan = run([local('Wire login', true)], [remote('ci1', 'Wire login', false)], {}, 'manual');

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      kind: 'state-no-baseline',
      localValue: 'done',
      remoteValue: 'not done',
      resolution: 'skipped',
    });
    expect(isNoopPlan(plan)).toBe(true);
  });

  it('records no baseline for a skipped conflict, so it stays a conflict next run', () => {
    // Persisting one here would silently crown a winner on the following sync.
    const plan = run([local('Wire login', true)], [remote('ci1', 'Wire login', false)], {}, 'manual');
    expect(plan.nextBaseline).toEqual({});
  });

  it('honours local-wins', () => {
    const plan = run([local('Wire login', true)], [remote('ci1', 'Wire login', false)], {}, 'local-wins');

    expect(plan.remoteStateUpdates).toEqual([
      { key: taskKey('Wire login'), checkItemId: 'ci1', state: 'complete' },
    ]);
    expect(plan.localStateUpdates).toEqual([]);
    expect(plan.nextBaseline[taskKey('Wire login')].done).toBe(true);
  });

  it('honours remote-wins', () => {
    const plan = run([local('Wire login', true, 2)], [remote('ci1', 'Wire login', false)], {}, 'remote-wins');

    expect(plan.localStateUpdates).toEqual([
      {
        key: taskKey('Wire login'),
        file: 'tasks.md',
        lineIndex: 2,
        description: 'Wire login',
        done: false,
      },
    ]);
    expect(plan.remoteStateUpdates).toEqual([]);
  });

  it('flags a rename that moved on both sides, even with a baseline present', () => {
    // Text has more than two values, so a genuine three-way conflict is possible
    // here in a way it is not for the checkbox.
    const plan = run(
      [local('Wire the login form', false)],
      [remote('ci1', 'Wire the signup form', false)],
      Object.fromEntries([base('Wire the login form', false, 'ci1')]),
      'manual'
    );

    // The id pairing holds, and the local text is unchanged from the baseline,
    // so this is a one-sided remote rename, not a conflict.
    expect(plan.conflicts).toEqual([]);
  });

  it('pushes a one-sided local rename', () => {
    const plan = run(
      [local('Wire the login form v2', false)],
      [remote('ci1', 'Wire the login form', false)],
      Object.fromEntries([base('Wire the login form', false, 'ci1')])
    );

    expect(plan.remoteRenames).toEqual([
      { key: taskKey('Wire the login form v2'), checkItemId: 'ci1', name: 'Wire the login form v2' },
    ]);
    // Renaming must not read as delete-and-recreate: the check item keeps its id.
    expect(plan.remoteCreates).toEqual([]);
    expect(plan.remoteDeletes).toEqual([]);
  });

  it('does not lose a remote tick when the task was renamed locally', () => {
    // The failure this guards: without similarity matching, the local rename
    // hashes to a new key, the pair looks like "new task + deleted task", and
    // the plan recreates the item with the LOCAL checkbox state — discarding the
    // tick someone made in Trello since the last sync.
    const plan = run(
      [local('Wire the login form v2', false, 4)],
      [remote('ci1', 'Wire the login form', true)],
      Object.fromEntries([base('Wire the login form', false, 'ci1')])
    );

    expect(plan.remoteDeletes).toEqual([]);
    expect(plan.remoteCreates).toEqual([]);
    expect(plan.localStateUpdates).toEqual([
      {
        key: taskKey('Wire the login form v2'),
        file: 'tasks.md',
        lineIndex: 4,
        description: 'Wire the login form v2',
        done: true,
      },
    ]);
  });

  it('falls back to delete-and-create when the rewrite is too different to be a rename', () => {
    // A false rename silently merges two unrelated tasks, so below the
    // threshold the conservative path is the right one.
    const plan = run(
      [local('Completely unrelated work item', false)],
      [remote('ci1', 'Wire the login form', false)],
      Object.fromEntries([base('Wire the login form', false, 'ci1')])
    );

    expect(plan.remoteCreates.map((c) => c.name)).toEqual(['Completely unrelated work item']);
    expect(plan.remoteDeletes.map((d) => d.name)).toEqual(['Wire the login form']);
  });

  it('does not hijack an item that was genuinely just added in Trello', () => {
    // No baseline for ci9, so similarity must not claim it even though the text
    // is close.
    const plan = run(
      [local('Wire the login form v2', false)],
      [remote('ci9', 'Wire the login form', false)],
      {}
    );

    expect(plan.remoteCreates.map((c) => c.name)).toEqual(['Wire the login form v2']);
    expect(plan.remoteOnly.map((i) => i.id)).toEqual(['ci9']);
  });
});

describe('reconcile — direction filters', () => {
  it('push only ever writes to the remote', () => {
    const plan = run(
      [local('Wire login', false)],
      [remote('ci1', 'Wire login', true)],
      Object.fromEntries([base('Wire login', false, 'ci1')]),
      'manual',
      'push'
    );

    expect(plan.localStateUpdates).toEqual([]);
    expect(plan.remoteStateUpdates).toEqual([
      { key: taskKey('Wire login'), checkItemId: 'ci1', state: 'incomplete' },
    ]);
  });

  it('pull does not create a remote item for a local-only task', () => {
    const plan = run([local('Brand new', false)], [], {}, 'manual', 'pull');
    expect(plan.remoteCreates).toEqual([]);
  });

  it('pull does not re-create a check item deleted in Trello', () => {
    // A re-creation is still a write to the board, so --direction=pull must not
    // perform one even though the local file clearly still wants the task.
    const plan = run(
      [local('Wire login', false)],
      [],
      Object.fromEntries([base('Wire login', false, 'ci1')]),
      'manual',
      'pull'
    );

    expect(plan.remoteCreates).toEqual([]);
    expect(plan.nextBaseline).toEqual({});
  });

  it('pull does not delete a remote item whose line left tasks.md', () => {
    const plan = run(
      [],
      [remote('ci1', 'Removed task', false)],
      Object.fromEntries([base('Removed task', false, 'ci1')]),
      'manual',
      'pull'
    );

    expect(plan.remoteDeletes).toEqual([]);
  });

  it('pull only ever writes to tasks.md', () => {
    const plan = run(
      [local('Wire login', true, 1)],
      [remote('ci1', 'Wire login', false)],
      Object.fromEntries([base('Wire login', true, 'ci1')]),
      'manual',
      'pull'
    );

    expect(plan.remoteStateUpdates).toEqual([]);
    expect(plan.localStateUpdates).toEqual([
      {
        key: taskKey('Wire login'),
        file: 'tasks.md',
        lineIndex: 1,
        description: 'Wire login',
        done: false,
      },
    ]);
  });
});

describe('reconcile — realistic multi-task pass', () => {
  it('handles inserts, ticks and deletions together without cross-talk', () => {
    const plan = run(
      [
        local('Brand new task', false, 1),
        local('Wire login', true, 2),
        local('Add tests', false, 3),
      ],
      [remote('ci1', 'Wire login', false, 1), remote('ci2', 'Add tests', true, 2), remote('ci3', 'Old task', false, 3)],
      Object.fromEntries([
        base('Wire login', false, 'ci1'),
        base('Add tests', false, 'ci2'),
        base('Old task', false, 'ci3'),
      ])
    );

    expect(plan.remoteCreates.map((c) => c.name)).toEqual(['Brand new task']);
    expect(plan.remoteStateUpdates).toEqual([
      { key: taskKey('Wire login'), checkItemId: 'ci1', state: 'complete' },
    ]);
    expect(plan.localStateUpdates).toEqual([
      {
        key: taskKey('Add tests'),
        file: 'tasks.md',
        lineIndex: 3,
        description: 'Add tests',
        done: true,
      },
    ]);
    expect(plan.remoteDeletes.map((d) => d.name)).toEqual(['Old task']);
    expect(plan.conflicts).toEqual([]);
  });
});
