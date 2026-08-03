import path from 'path';
import type { ChangeSnapshot } from '../types.js';
import type { TrelloConfig } from '../config.js';
import {
  readAdapterState,
  writeAdapterState,
  type AdapterState,
  type ChangeSyncState,
} from '../state.js';
import { readAllChangeSnapshots, readChangeSnapshot } from '../snapshot.js';
import { applyCheckboxEdits, type CheckboxEditOutcome } from '../task-writer.js';
import { TrelloClient, type TrelloCard, type TrelloCheckItem, type TrelloChecklist } from './client.js';
import { reconcile, isNoopPlan, type ReconcilePlan, type ConflictReport } from './mapping.js';

export type SyncDirection = 'both' | 'push' | 'pull';

export interface SyncOptions {
  projectRoot: string;
  config: TrelloConfig;
  client: TrelloClient;
  direction?: SyncDirection;
  /** Compute and report the plan without writing anything, anywhere. */
  dryRun?: boolean;
  /** Restrict to these change ids. */
  changeIds?: string[];
  log?: (message: string) => void;
}

export interface ChangeSyncReport {
  changeId: string;
  cardId?: string;
  cardUrl?: string;
  created: number;
  updated: number;
  renamed: number;
  deleted: number;
  localEdits: CheckboxEditOutcome[];
  conflicts: ConflictReport[];
  /** Items present on the card that have no line in tasks.md. */
  remoteOnly: string[];
  skipped?: string;
}

export interface SyncReport {
  dryRun: boolean;
  direction: SyncDirection;
  changes: ChangeSyncReport[];
  errors: Array<{ changeId: string; message: string }>;
}

/**
 * Which board list a change belongs in, derived from task progress.
 *
 * Deliberately coarse: OpenSpec has no explicit status field on a change, so
 * inventing one here would be a second source of truth that drifts from
 * `openspec list`. Progress is the signal the CLI itself reports.
 */
export function listKeyForChange(change: ChangeSnapshot): keyof TrelloConfig['listMap'] {
  if (change.totalTasks === 0) return 'proposed';
  if (change.completedTasks === 0) return 'proposed';
  if (change.completedTasks < change.totalTasks) return 'in_progress';
  return 'review';
}

/** Card body: a pointer back to the repo, not a copy of the proposal. */
export function cardDescription(change: ChangeSnapshot, projectRoot: string): string {
  const relativeDir = path.relative(projectRoot, change.dir).split(path.sep).join('/');
  const lines = [
    change.goal ? `**Goal:** ${change.goal}` : undefined,
    change.summary,
    '',
    `Source: \`${relativeDir}\``,
    '',
    '_Managed by OpenSpec. Tick items here or in tasks.md — both sync._',
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

/**
 * The card that represents a change, from a set of cards already fetched.
 *
 * Two ways in, in this order: the id recorded at the last sync, and failing
 * that the card named after the change. The fallback is what keeps a change to
 * one card — after `.openspec-integrations/` is deleted, or on a second clone,
 * or once the archive path has dropped the state entry, the id is gone but the
 * card is still sitting on the board under the change's name.
 */
export function findCardIn(
  boardCards: TrelloCard[],
  changeId: string,
  remoteId?: string
): TrelloCard | undefined {
  const byId = remoteId ? boardCards.find((card) => card.id === remoteId) : undefined;
  return byId ?? boardCards.find((card) => card.name === changeId);
}

/**
 * Same, but does the fetching — and looks at closed cards too.
 *
 * Used by the paths that run after a change is archived, where the card may
 * have been closed by `onArchive: close` and would be invisible to the default
 * open-cards-only filter.
 */
export async function findCardForChange(options: {
  projectRoot: string;
  config: TrelloConfig;
  client: TrelloClient;
  changeId: string;
}): Promise<TrelloCard | undefined> {
  const { projectRoot, config, client, changeId } = options;
  if (!config.boardId) return undefined;

  const state = await readAdapterState(projectRoot, 'trello');
  const boardCards = await client.getBoardCards(config.boardId, 'all');
  return findCardIn(boardCards, changeId, state.changes[changeId]?.remoteId);
}

async function ensureCard(
  client: TrelloClient,
  config: TrelloConfig,
  change: ChangeSnapshot,
  state: ChangeSyncState,
  boardCards: TrelloCard[],
  projectRoot: string,
  dryRun: boolean
): Promise<{ card?: TrelloCard; created: boolean; error?: string }> {
  const existing = findCardIn(boardCards, change.id, state.remoteId);

  if (existing) return { card: existing, created: false };

  const listKey = listKeyForChange(change);
  const idList = config.listMap[listKey] ?? config.listMap.proposed;
  if (!idList) {
    return {
      card: undefined,
      created: false,
      error: `no Trello list mapped for "${listKey}" — run "openspec trello link <boardId>" or set listMap in openspec/integrations.yaml`,
    };
  }

  if (dryRun) return { card: undefined, created: true };

  const card = await client.createCard({
    idList,
    name: change.id,
    desc: cardDescription(change, projectRoot),
  });
  return { card, created: true };
}

async function ensureChecklist(
  client: TrelloClient,
  cardId: string,
  name: string,
  dryRun: boolean
): Promise<TrelloChecklist | undefined> {
  const checklists = await client.getCardChecklists(cardId);
  const existing = checklists.find((list) => list.name === name);
  if (existing) return existing;
  if (dryRun) return undefined;
  return client.createChecklist(cardId, name);
}

async function applyPlan(
  client: TrelloClient,
  cardId: string,
  checklistId: string,
  change: ChangeSnapshot,
  plan: ReconcilePlan,
  dryRun: boolean
): Promise<{ report: Omit<ChangeSyncReport, 'changeId' | 'conflicts' | 'remoteOnly'>; createdIds: Map<string, string> }> {
  const createdIds = new Map<string, string>();
  const localEdits: CheckboxEditOutcome[] = [];

  if (!dryRun) {
    for (const create of plan.remoteCreates) {
      const item = await client.createCheckItem(checklistId, {
        name: create.name,
        checked: create.checked,
        pos: create.pos,
      });
      createdIds.set(create.key, item.id);
    }

    for (const update of plan.remoteStateUpdates) {
      await client.updateCheckItem(cardId, update.checkItemId, { state: update.state });
    }

    for (const rename of plan.remoteRenames) {
      await client.updateCheckItem(cardId, rename.checkItemId, { name: rename.name });
    }

    for (const remove of plan.remoteDeletes) {
      await client.deleteCheckItem(checklistId, remove.checkItemId);
    }

    if (plan.localStateUpdates.length > 0) {
      const outcomes = await applyCheckboxEdits(
        plan.localStateUpdates.map((update) => ({
          filePath: path.join(change.dir, ...update.file.split('/')),
          lineIndex: update.lineIndex,
          done: update.done,
          // Guards against a snapshot that went stale while the network calls
          // above were in flight.
          expectedDescription: update.description,
        }))
      );
      localEdits.push(...outcomes);
    }
  }

  return {
    report: {
      created: plan.remoteCreates.length,
      updated: plan.remoteStateUpdates.length,
      renamed: plan.remoteRenames.length,
      deleted: plan.remoteDeletes.length,
      localEdits,
    },
    createdIds,
  };
}

export interface ArchiveCardResult {
  changeId: string;
  action: 'moved' | 'closed' | 'skipped';
  reason?: string;
  cardId?: string;
}

/**
 * Settles a change's card once the change has been archived.
 *
 * Driven entirely from the persisted state, because by the time this runs the
 * change directory is gone: `readAllChangeSnapshots` only walks
 * `openspec/changes/` and skips `archive/`, so a regular sync never visits an
 * archived change at all and its card would otherwise sit in whatever list it
 * last occupied, forever.
 *
 * The state entry is dropped either way — the change is no longer active, and
 * keeping its baseline around would make a later change that happens to reuse
 * the id inherit a stale one.
 */
export async function archiveTrelloCard(options: {
  projectRoot: string;
  config: TrelloConfig;
  client: TrelloClient;
  changeId: string;
}): Promise<ArchiveCardResult> {
  const { projectRoot, config, client, changeId } = options;

  const state = await readAdapterState(projectRoot, 'trello');
  const entry = state.changes[changeId];

  const forget = async (): Promise<void> => {
    delete state.changes[changeId];
    await writeAdapterState(projectRoot, 'trello', state);
  };

  if (!entry?.remoteId) {
    await forget();
    return { changeId, action: 'skipped', reason: 'no card was ever created for it' };
  }

  const cardId = entry.remoteId;

  if (config.onArchive === 'nothing') {
    await forget();
    return { changeId, action: 'skipped', cardId, reason: 'onArchive is "nothing"' };
  }

  try {
    if (config.onArchive === 'close') {
      await client.updateCard(cardId, { closed: true });
      await forget();
      return { changeId, action: 'closed', cardId };
    }

    const archivedList = config.listMap.archived;
    if (!archivedList) {
      await forget();
      return {
        changeId,
        action: 'skipped',
        cardId,
        reason: 'no list is mapped to "archived" — map one, or set onArchive: close',
      };
    }

    await client.updateCard(cardId, { idList: archivedList });
    await forget();
    return { changeId, action: 'moved', cardId };
  } catch (error) {
    // The state entry survives a failed call, so the next attempt can retry
    // rather than losing the card id and orphaning the card silently.
    return { changeId, action: 'skipped', cardId, reason: (error as Error).message };
  }
}

/**
 * Reconciles every selected change against the board.
 *
 * Baseline is persisted only for work that actually landed: on `dryRun`, and for
 * any change whose apply step threw, the previous baseline is left untouched so
 * the next run re-derives the same plan instead of assuming it succeeded.
 */
export async function syncTrello(options: SyncOptions): Promise<SyncReport> {
  const {
    projectRoot,
    config,
    client,
    direction = 'both',
    dryRun = false,
    changeIds,
    log = () => {},
  } = options;

  if (!config.boardId) {
    throw new Error(
      'No Trello board configured. Run "openspec trello link <boardId>" first.'
    );
  }

  const state: AdapterState = await readAdapterState(projectRoot, 'trello');

  const changes = changeIds
    ? await Promise.all(changeIds.map((id) => readChangeSnapshot(projectRoot, id)))
    : await readAllChangeSnapshots(projectRoot);

  const boardCards = await client.getBoardCards(config.boardId);

  const report: SyncReport = { dryRun, direction, changes: [], errors: [] };

  for (const change of changes) {
    const changeState: ChangeSyncState = state.changes[change.id] ?? { tasks: {} };

    try {
      const { card, error } = await ensureCard(
        client,
        config,
        change,
        changeState,
        boardCards,
        projectRoot,
        dryRun
      );

      if (error) {
        report.changes.push({
          changeId: change.id,
          created: 0,
          updated: 0,
          renamed: 0,
          deleted: 0,
          localEdits: [],
          conflicts: [],
          remoteOnly: [],
          skipped: error,
        });
        continue;
      }

      if (!card) {
        // Dry run with no card yet: everything is a create.
        report.changes.push({
          changeId: change.id,
          created: change.tasks.length,
          updated: 0,
          renamed: 0,
          deleted: 0,
          localEdits: [],
          conflicts: [],
          remoteOnly: [],
          skipped: 'card would be created',
        });
        continue;
      }

      const checklist = await ensureChecklist(client, card.id, config.checklistName, dryRun);
      const remoteItems: TrelloCheckItem[] = checklist?.checkItems ?? [];

      const plan = reconcile({
        local: change.tasks,
        remote: remoteItems,
        baseline: changeState.tasks,
        conflictPolicy: config.conflictPolicy,
        direction,
      });

      if (isNoopPlan(plan) && plan.conflicts.length === 0) {
        log(`${change.id}: already in sync`);
      }

      let applied = {
        created: plan.remoteCreates.length,
        updated: plan.remoteStateUpdates.length,
        renamed: plan.remoteRenames.length,
        deleted: plan.remoteDeletes.length,
        localEdits: [] as CheckboxEditOutcome[],
      };
      let createdIds = new Map<string, string>();

      if (checklist) {
        const result = await applyPlan(client, card.id, checklist.id, change, plan, dryRun);
        applied = result.report;
        createdIds = result.createdIds;
      }

      if (!dryRun) {
        // Attach ids assigned by the create calls, so the next run pairs by id.
        for (const [key, remoteId] of createdIds) {
          const entry = plan.nextBaseline[key];
          if (entry) entry.remoteId = remoteId;
        }

        // Do not bank a baseline for a local edit the writer refused: doing so
        // would declare the file in sync when it never got the change.
        for (const outcome of applied.localEdits) {
          if (outcome.status !== 'skipped') continue;
          const failed = plan.localStateUpdates.find(
            (update) =>
              update.lineIndex === outcome.lineIndex &&
              path.join(change.dir, ...update.file.split('/')) === outcome.filePath
          );
          if (failed) delete plan.nextBaseline[failed.key];
        }

        // Under `once`, placement happened when the card was created and the
        // board is the user's from then on; only `always` keeps re-deriving it.
        if (config.cardPlacement === 'always' && direction !== 'pull') {
          const targetList = config.listMap[listKeyForChange(change)];
          if (targetList && card.idList !== targetList) {
            await client.updateCard(card.id, { idList: targetList });
          }
        }

        state.changes[change.id] = {
          remoteId: card.id,
          tasks: plan.nextBaseline,
          lastSyncedAt: new Date().toISOString(),
          lastRemoteActivity: card.dateLastActivity,
        };
      }

      report.changes.push({
        changeId: change.id,
        cardId: card.id,
        cardUrl: card.shortUrl,
        ...applied,
        conflicts: plan.conflicts,
        remoteOnly: plan.remoteOnly.map((item) => item.name),
      });
    } catch (error) {
      report.errors.push({ changeId: change.id, message: (error as Error).message });
    }
  }

  if (!dryRun) {
    await writeAdapterState(projectRoot, 'trello', state);
  }

  return report;
}
