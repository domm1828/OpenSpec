import path from 'path';
import type { ChangeSnapshot } from '../types.js';
import type { GithubConfig } from '../config.js';
import type { GitOperation } from './git.js';

/**
 * The git-flow rules: what a branch is called, what a commit says, what the
 * pull request looks like, and — most of it — when none of that is allowed to
 * happen.
 *
 * Pure by design, like `trello/mapping.ts`. Every interesting failure mode of an
 * unattended integration that writes to git is a decision made in this file, so
 * it is worth being able to exercise all of them from a table of plain objects
 * instead of a repository fixture.
 */

/**
 * Turns a change id into something git will accept as a branch name.
 *
 * Change ids are directory names and are almost always already safe; this exists
 * for the ones that are not. Git's ref rules reject a handful of characters
 * outright, and a name that fails them makes `git branch` error out with a
 * message about refs that says nothing about OpenSpec.
 */
export function sanitizeRefComponent(value: string): string {
  const cleaned = value
    .replace(/[\s~^:?*[\\]+/g, '-')
    .replace(/@\{/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/\/+/g, '/')
    .replace(/^[-./]+|[-./]+$/g, '')
    .replace(/\.lock$/i, '');
  return cleaned.length > 0 ? cleaned : 'change';
}

export function branchNameFor(changeId: string, config: GithubConfig): string {
  const prefix = config.gitflow.featurePrefix ?? 'feature/';
  return `${prefix}${sanitizeRefComponent(changeId)}`;
}

export interface CommitMessage {
  subject: string;
  body?: string;
}

/**
 * The message for one pass's worth of ticked tasks.
 *
 * One task gets its description in the subject, which is what makes `git log
 * --oneline` readable. Several get a count and the list in the body — putting
 * three descriptions in a subject line produces something no one can scan, and
 * picking one of the three to represent the rest would be a lie about what the
 * commit contains.
 */
export function commitMessageFor(changeId: string, tasks: string[]): CommitMessage {
  const cleaned = tasks.map((task) => task.replace(/\s+/g, ' ').trim()).filter(Boolean);

  if (cleaned.length === 0) {
    return { subject: `${changeId}: progress` };
  }

  if (cleaned.length === 1) {
    return { subject: truncate(`${changeId}: ${cleaned[0]}`, 72) };
  }

  return {
    subject: `${changeId}: ${cleaned.length} tasks completed`,
    body: cleaned.map((task) => `- ${task}`).join('\n'),
  };
}

export function prTitleFor(change: ChangeSnapshot): string {
  const goal = change.goal?.replace(/\s+/g, ' ').trim();
  return truncate(goal ? `${change.id}: ${goal}` : change.id, 100);
}

/**
 * The pull request body: what the change set out to do, and what was done.
 *
 * Task state is rendered as a checklist because GitHub renders it as one, and a
 * reviewer opening this wants the same list the change tracked — not a link to a
 * file they would have to check out the branch to read.
 */
export function prBodyFor(change: ChangeSnapshot, projectRoot: string): string {
  const relativeDir = path.relative(projectRoot, change.dir).split(path.sep).join('/');

  const sections: Array<string | undefined> = [
    change.goal ? `**Goal:** ${change.goal}` : undefined,
    change.summary,
    change.tasks.length > 0
      ? [
          `### Tasks (${change.completedTasks}/${change.totalTasks})`,
          '',
          ...change.tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.description}`),
        ].join('\n')
      : undefined,
    `Change: \`${relativeDir}\``,
    '_Opened by OpenSpec when the change was archived._',
  ];

  return sections.filter((section) => section !== undefined).join('\n\n');
}

/**
 * Paths this integration is allowed to touch, and the one it must not.
 *
 * `.openspec-integrations/` is machine-local sync state — card ids, baselines,
 * the branch record this adapter itself writes. Two things follow, and both are
 * bugs if forgotten:
 *
 *  - it must never enter a commit, or a project that has not gitignored it gets
 *    a baseline on every branch, which is a merge conflict waiting to happen;
 *  - it must never count as a dirty working tree, or the integration blocks
 *    itself: writing the branch record dirties the tree, and the next guarded
 *    action sees uncommitted changes it caused.
 */
export function commitPathspecs(config: GithubConfig, stateDirName: string): string[] {
  const root = config.commitScope === 'openspec-only' ? 'openspec' : '.';
  return [root, `:(exclude)${stateDirName}`];
}

/**
 * What "clean" means for the branch guard.
 *
 * Deliberately the whole tree, not `commitScope`: checking out carries *any*
 * uncommitted work across, including work outside `openspec/` that this
 * integration would never commit itself.
 */
export function cleanlinessPathspecs(stateDirName: string): string[] {
  return ['.', `:(exclude)${stateDirName}`];
}

/** The facts about the repository a guard needs. Gathered by the adapter. */
export interface RepoState {
  isRepository: boolean;
  hasCommits: boolean;
  operationInProgress: GitOperation | null;
  currentBranch: string | null;
  workingTreeClean: boolean;
}

export type GuardResult = { ok: true } | { ok: false; reason: string; fix?: string };

const ok: GuardResult = { ok: true };

/**
 * Guards shared by every write path.
 *
 * Split out because "is this a repository at all" and "is git mid-rebase" fail
 * the same way for branching, committing and pushing, and a check that exists in
 * two of the three paths is a bug waiting for the third.
 */
function baseGuards(state: RepoState): GuardResult {
  if (!state.isRepository) {
    return { ok: false, reason: 'this project is not a git repository', fix: 'git init' };
  }
  if (!state.hasCommits) {
    return {
      ok: false,
      reason: 'the repository has no commits yet, so there is nothing to branch from',
      fix: 'git commit --allow-empty -m "Initial commit"',
    };
  }
  if (state.operationInProgress) {
    return {
      ok: false,
      reason: `a ${state.operationInProgress} is in progress`,
      fix: `finish or abort the ${state.operationInProgress} first`,
    };
  }
  return ok;
}

/**
 * Whether a feature branch may be created and checked out right now.
 *
 * Two conditions, and they guard different things:
 *
 *  - **A clean tree.** Checking out carries uncommitted work across, so
 *    branching over a dirty tree silently moves whatever the user or the agent
 *    had in flight into a change it has nothing to do with. This one is about
 *    not losing work and holds even for the explicit command.
 *  - **HEAD already on the development branch.** Being somewhere else usually
 *    means another change is being worked on right now, and yanking the working
 *    directory out from under it is exactly the kind of surprise that makes
 *    people turn an integration off. `openspec github start` is the way to say
 *    "yes, switch me anyway", so this check is skippable and the other is not.
 */
export function canCreateBranch(
  state: RepoState,
  base: string | undefined,
  options: { requireBaseCheckout?: boolean } = {}
): GuardResult {
  const guard = baseGuards(state);
  if (!guard.ok) return guard;

  if (!base) {
    return {
      ok: false,
      reason: 'no development branch is configured',
      fix: 'openspec github link',
    };
  }

  if (!state.workingTreeClean) {
    return {
      ok: false,
      reason: 'the working tree has uncommitted changes',
      fix: 'commit or stash them, then: openspec github start <change-id>',
    };
  }

  if (options.requireBaseCheckout !== false && state.currentBranch !== base) {
    return {
      ok: false,
      reason: `HEAD is on ${state.currentBranch ?? 'a detached commit'}, not the development branch ${base}`,
      fix: 'openspec github start <change-id>',
    };
  }

  return ok;
}

/**
 * Whether this change's tasks may be committed right now.
 *
 * The branch check is not a formality. With two changes active there are two
 * feature branches, only one of them is checked out, and a watcher that
 * committed regardless would put change A's work in change B's branch — which
 * looks fine until the pull request is opened and carries someone else's code.
 */
export function canCommit(state: RepoState, expectedBranch: string | undefined): GuardResult {
  const guard = baseGuards(state);
  if (!guard.ok) return guard;

  if (!expectedBranch) {
    return {
      ok: false,
      reason: 'no branch is recorded for this change',
      fix: 'openspec github start <change-id>',
    };
  }

  if (state.currentBranch !== expectedBranch) {
    return {
      ok: false,
      reason: `HEAD is on ${state.currentBranch ?? 'a detached commit'}, not ${expectedBranch}`,
      fix: `git checkout ${expectedBranch}`,
    };
  }

  return ok;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
