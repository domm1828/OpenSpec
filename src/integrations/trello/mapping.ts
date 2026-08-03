import type { TaskRef } from '../types.js';
import type { TaskBaseline } from '../state.js';
import { taskKey } from '../snapshot.js';
import type { TrelloCheckItem } from './client.js';

/**
 * Three-way reconciliation between tasks.md, a Trello checklist, and the
 * baseline recorded at the end of the last sync.
 *
 * Pure on purpose: no client, no filesystem. Every interesting failure mode of
 * a two-way sync is a decision this function makes, so it is worth being able to
 * exercise all of them from a table of plain objects.
 */

export type ConflictPolicy = 'manual' | 'local-wins' | 'remote-wins';

export interface MatchedPair {
  key: string;
  local?: TaskRef;
  remote?: TrelloCheckItem;
  base?: TaskBaseline;
}

export interface ConflictReport {
  key: string;
  kind: 'state-no-baseline' | 'rename';
  description: string;
  localValue: string;
  remoteValue: string;
  /** What the plan did about it: `manual` skips, the others pick a side. */
  resolution: 'skipped' | 'local-wins' | 'remote-wins';
}

export interface RemoteCreate {
  key: string;
  name: string;
  checked: boolean;
  pos: number;
}

export interface RemoteStateUpdate {
  key: string;
  checkItemId: string;
  state: 'complete' | 'incomplete';
}

export interface RemoteRename {
  key: string;
  checkItemId: string;
  name: string;
}

export interface RemoteDelete {
  key: string;
  checkItemId: string;
  name: string;
}

export interface LocalStateUpdate {
  key: string;
  file: string;
  lineIndex: number;
  description: string;
  done: boolean;
}

export interface ReconcilePlan {
  remoteCreates: RemoteCreate[];
  remoteStateUpdates: RemoteStateUpdate[];
  remoteRenames: RemoteRename[];
  remoteDeletes: RemoteDelete[];
  localStateUpdates: LocalStateUpdate[];
  conflicts: ConflictReport[];
  /** Baseline to persist once the plan has been applied without error. */
  nextBaseline: Record<string, TaskBaseline>;
  /** Remote items with no local counterpart and no baseline: added in Trello. */
  remoteOnly: TrelloCheckItem[];
}

export interface ReconcileInput {
  local: TaskRef[];
  remote: TrelloCheckItem[];
  baseline: Record<string, TaskBaseline>;
  conflictPolicy: ConflictPolicy;
  /** Direction filter; `both` is the full two-way reconciliation. */
  direction?: 'both' | 'push' | 'pull';
}

function normalizeForSimilarity(text: string): string {
  return text
    .replace(/^[\d.]+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Sørensen–Dice coefficient over character bigrams, in [0, 1].
 *
 * Chosen over edit distance because it is length-normalized and insensitive to
 * word order, which is how task descriptions actually get reworded ("Wire the
 * login form" → "Wire login form v2").
 */
export function similarity(a: string, b: string): number {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);

  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i++) {
    const gram = left.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < right.length - 1; i++) {
    const gram = right.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      hits++;
    }
  }

  return (2 * hits) / (left.length - 1 + right.length - 1);
}

/**
 * How similar two descriptions must be before they are treated as the same task
 * reworded. Set high: a false rename silently merges two distinct tasks, which
 * is worse than the delete-and-recreate this threshold falls back to.
 */
export const RENAME_SIMILARITY_THRESHOLD = 0.6;

/**
 * Pairs local tasks with remote check items.
 *
 * Three passes, in this order deliberately:
 *  1. by recorded remote id — survives a rename on the *remote* side, since the
 *     baseline is keyed by the local description and that has not moved;
 *  2. by normalized text — catches items created since the last sync, and
 *     absorbs renumbering (`1.1` → `2.4`) and whitespace churn;
 *  3. by text similarity, but only against a remote item the baseline proves was
 *     synced — this is the *local* rename case, where the local description hash
 *     no longer indexes into the baseline at all.
 *
 * Pass 3 exists because the obvious fallback loses data. Without it, a locally
 * reworded task looks like "old task deleted, new task added", so the plan is
 * delete-then-create — and the new item is created with the *local* checkbox
 * state, silently discarding a tick someone made in Trello since the last sync.
 *
 * Position is never used as identity at any stage. Inserting a task at the top
 * of tasks.md shifts every ordinal below it, and an ordinal-matched sync would
 * then rewrite every task's state to its neighbour's.
 */
export function matchTasks(
  local: TaskRef[],
  remote: TrelloCheckItem[],
  baseline: Record<string, TaskBaseline>
): MatchedPair[] {
  const pairs = new Map<string, MatchedPair>();
  const claimedRemote = new Set<string>();

  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const baselineByRemoteId = new Map<string, TaskBaseline>();
  for (const entry of Object.values(baseline)) {
    if (entry.remoteId) baselineByRemoteId.set(entry.remoteId, entry);
  }

  const pairFor = (key: string): MatchedPair => {
    let pair = pairs.get(key);
    if (!pair) {
      pair = { key, base: baseline[key] };
      pairs.set(key, pair);
    }
    return pair;
  };

  // Pass 1 — id-based, anchored on the baseline.
  for (const task of local) {
    const base = baseline[task.key];
    const pair = pairFor(task.key);
    pair.local = task;

    if (base?.remoteId) {
      const item = remoteById.get(base.remoteId);
      if (item) {
        pair.remote = item;
        claimedRemote.add(item.id);
      }
    }
  }

  // Pass 2 — exact normalized text.
  for (const task of local) {
    const pair = pairFor(task.key);
    if (pair.remote) continue;

    const match = remote.find(
      (item) => !claimedRemote.has(item.id) && taskKey(item.name) === task.key
    );
    if (match) {
      pair.remote = match;
      claimedRemote.add(match.id);
    }
  }

  // Pass 3 — similarity, restricted to previously-synced remote items.
  const stillUnpaired = local.filter((task) => !pairFor(task.key).remote);
  if (stillUnpaired.length > 0) {
    const candidates: Array<{ task: TaskRef; item: TrelloCheckItem; score: number }> = [];

    for (const task of stillUnpaired) {
      for (const item of remote) {
        if (claimedRemote.has(item.id)) continue;
        // Requiring a baseline entry keeps this from hijacking an item someone
        // genuinely just added in Trello.
        if (!baselineByRemoteId.has(item.id)) continue;

        const score = similarity(task.description, item.name);
        if (score >= RENAME_SIMILARITY_THRESHOLD) candidates.push({ task, item, score });
      }
    }

    // Greedy best-first, so the strongest pairing wins when several tasks are
    // plausible matches for the same item.
    candidates.sort((a, b) => b.score - a.score);
    const pairedLocal = new Set<string>();

    for (const { task, item } of candidates) {
      if (pairedLocal.has(task.key) || claimedRemote.has(item.id)) continue;

      const pair = pairFor(task.key);
      pair.remote = item;
      // Carry the old baseline forward under the new key: it is what makes the
      // state reconciliation below able to tell which side moved.
      pair.base = baselineByRemoteId.get(item.id);

      claimedRemote.add(item.id);
      pairedLocal.add(task.key);
    }
  }

  // Remote items nothing claimed: added in Trello, or orphaned by a deletion.
  for (const item of remote) {
    if (claimedRemote.has(item.id)) continue;
    const key = taskKey(item.name);
    const pair = pairFor(key);
    if (pair.remote === undefined && pair.local === undefined) {
      pair.remote = item;
      pair.base = baselineByRemoteId.get(item.id) ?? pair.base;
      claimedRemote.add(item.id);
    }
  }

  // Baseline-only entries: the task existed at the last sync and is now gone
  // from both sides, or gone from one. Kept so deletions can be reasoned about.
  for (const [key, base] of Object.entries(baseline)) {
    if (!pairs.has(key)) pairs.set(key, { key, base });
  }

  // A baseline entry whose task was renamed locally is now represented by the
  // new key; drop the stale one so it is not also read as a deletion.
  for (const [key, pair] of pairs) {
    if (pair.local === undefined && pair.remote === undefined) pairs.delete(key);
  }

  return [...pairs.values()];
}

const isDone = (item: TrelloCheckItem): boolean => item.state === 'complete';

export function reconcile(input: ReconcileInput): ReconcilePlan {
  const { local, remote, baseline, conflictPolicy, direction = 'both' } = input;
  const allowPush = direction !== 'pull';
  const allowPull = direction !== 'push';

  const plan: ReconcilePlan = {
    remoteCreates: [],
    remoteStateUpdates: [],
    remoteRenames: [],
    remoteDeletes: [],
    localStateUpdates: [],
    conflicts: [],
    nextBaseline: {},
    remoteOnly: [],
  };

  const pairs = matchTasks(local, remote, baseline);
  const localOrder = new Map(local.map((task, index) => [task.key, index]));

  for (const pair of pairs) {
    const { key, local: localTask, remote: remoteItem, base } = pair;

    // Present locally, absent remotely.
    //
    // Two situations, one action. Either it is new here, or it was synced before
    // and someone deleted the check item in Trello. Both resolve to "create it
    // on the card": a line is never removed from tasks.md in response to a
    // remote deletion, because the local file is the source of truth for what
    // work exists and a deleted line is unrecoverable, while a check item that
    // reappears is merely annoying.
    //
    // Gated on allowPush for both — `--direction=pull` promises never to write
    // to the board, and a re-creation is still a write.
    if (localTask && !remoteItem) {
      if (allowPush) {
        plan.remoteCreates.push({
          key,
          name: localTask.description,
          checked: localTask.done,
          pos: (localOrder.get(key) ?? 0) + 1,
        });
        plan.nextBaseline[key] = {
          key,
          description: localTask.description,
          done: localTask.done,
        };
      }
      // On a pull-only run nothing was reconciled, so no baseline is recorded:
      // claiming one would tell the next run this task is in sync when the board
      // has never heard of it.
      continue;
    }

    // Present remotely, absent locally.
    if (!localTask && remoteItem) {
      if (base) {
        // It was synced before and has since left tasks.md: the user deleted the
        // task. Mirroring that on the card is safe because the baseline proves
        // the item existed here and was in sync — this is not a guess.
        if (allowPush) {
          plan.remoteDeletes.push({ key, checkItemId: remoteItem.id, name: remoteItem.name });
        }
      } else {
        // Never seen locally: created directly in Trello. Reported, not written,
        // because turning a card item into a tasks.md line means inventing where
        // in the document it belongs.
        plan.remoteOnly.push(remoteItem);
        plan.nextBaseline[key] = {
          key,
          description: remoteItem.name,
          done: isDone(remoteItem),
          remoteId: remoteItem.id,
        };
      }
      continue;
    }

    // Gone from both sides: drop it from the baseline.
    if (!localTask || !remoteItem) continue;

    const localDone = localTask.done;
    const remoteDone = isDone(remoteItem);

    let resolvedDone = localDone;

    if (localDone === remoteDone) {
      resolvedDone = localDone;
    } else if (base === undefined) {
      /**
       * The only way a boolean state can genuinely conflict.
       *
       * With a baseline present there is no ambiguity to resolve: `done` has two
       * values, so if local and remote disagree, exactly one of them still equals
       * the baseline — and the other is, unambiguously, the side that changed.
       * The three-way table collapses to a two-way one. It is the *absence* of a
       * baseline (a first sync, or a task created independently on both sides)
       * that leaves the question genuinely open.
       */
      const resolution =
        conflictPolicy === 'manual'
          ? 'skipped'
          : conflictPolicy === 'local-wins'
            ? 'local-wins'
            : 'remote-wins';

      plan.conflicts.push({
        key,
        kind: 'state-no-baseline',
        description: localTask.description,
        localValue: localDone ? 'done' : 'not done',
        remoteValue: remoteDone ? 'done' : 'not done',
        resolution,
      });

      if (resolution === 'skipped') {
        // Write nothing and record nothing: persisting a baseline here would
        // silently declare a winner on the next run.
        continue;
      }

      resolvedDone = resolution === 'local-wins' ? localDone : remoteDone;
      if (resolvedDone !== remoteDone && allowPush) {
        plan.remoteStateUpdates.push({
          key,
          checkItemId: remoteItem.id,
          state: resolvedDone ? 'complete' : 'incomplete',
        });
      }
      if (resolvedDone !== localDone && allowPull) {
        plan.localStateUpdates.push({
          key,
          file: localTask.file,
          lineIndex: localTask.lineIndex,
          description: localTask.description,
          done: resolvedDone,
        });
      }
    } else if (localDone === base.done) {
      // Local matches the baseline, so the remote is what moved.
      resolvedDone = remoteDone;
      if (allowPull) {
        plan.localStateUpdates.push({
          key,
          file: localTask.file,
          lineIndex: localTask.lineIndex,
          description: localTask.description,
          done: remoteDone,
        });
      } else {
        resolvedDone = localDone;
        if (allowPush) {
          plan.remoteStateUpdates.push({
            key,
            checkItemId: remoteItem.id,
            state: localDone ? 'complete' : 'incomplete',
          });
        }
      }
    } else {
      // Remote matches the baseline, so the local file is what moved.
      resolvedDone = localDone;
      if (allowPush) {
        plan.remoteStateUpdates.push({
          key,
          checkItemId: remoteItem.id,
          state: localDone ? 'complete' : 'incomplete',
        });
      } else {
        resolvedDone = remoteDone;
        if (allowPull) {
          plan.localStateUpdates.push({
            key,
            file: localTask.file,
            lineIndex: localTask.lineIndex,
            description: localTask.description,
            done: remoteDone,
          });
        }
      }
    }

    // Text drift. Unlike state, this one can conflict with a baseline present:
    // a description has more than two possible values, so both sides really can
    // have moved to different new ones.
    let resolvedName = localTask.description;
    if (localTask.description !== remoteItem.name) {
      const localMoved = base ? base.description !== localTask.description : true;
      const remoteMoved = base ? base.description !== remoteItem.name : true;

      if (localMoved && remoteMoved) {
        const resolution =
          conflictPolicy === 'manual'
            ? 'skipped'
            : conflictPolicy === 'local-wins'
              ? 'local-wins'
              : 'remote-wins';

        plan.conflicts.push({
          key,
          kind: 'rename',
          description: base?.description ?? localTask.description,
          localValue: localTask.description,
          remoteValue: remoteItem.name,
          resolution,
        });

        if (resolution === 'local-wins' && allowPush) {
          plan.remoteRenames.push({ key, checkItemId: remoteItem.id, name: localTask.description });
        } else if (resolution === 'remote-wins') {
          // Renaming a tasks.md line is out of scope for a checkbox writer: it
          // would rewrite prose the agent owns. The card keeps its name and the
          // divergence is reported.
          resolvedName = remoteItem.name;
        } else {
          resolvedName = base?.description ?? localTask.description;
        }
      } else if (localMoved && allowPush) {
        plan.remoteRenames.push({ key, checkItemId: remoteItem.id, name: localTask.description });
      } else if (remoteMoved) {
        resolvedName = remoteItem.name;
      }
    }

    plan.nextBaseline[key] = {
      key,
      description: resolvedName,
      done: resolvedDone,
      remoteId: remoteItem.id,
    };
  }

  return plan;
}

/** True when the plan would write nothing anywhere. */
export function isNoopPlan(plan: ReconcilePlan): boolean {
  return (
    plan.remoteCreates.length === 0 &&
    plan.remoteStateUpdates.length === 0 &&
    plan.remoteRenames.length === 0 &&
    plan.remoteDeletes.length === 0 &&
    plan.localStateUpdates.length === 0
  );
}
