import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  branchNameFor,
  canCommit,
  canCreateBranch,
  commitMessageFor,
  prBodyFor,
  prTitleFor,
  sanitizeRefComponent,
  type RepoState,
} from '../../src/integrations/github/flow.js';
import { GithubConfigSchema } from '../../src/integrations/config.js';
import type { ChangeSnapshot } from '../../src/integrations/types.js';

const config = (overrides: Record<string, unknown> = {}) =>
  GithubConfigSchema.parse({ ...overrides });

const healthy: RepoState = {
  isRepository: true,
  hasCommits: true,
  operationInProgress: null,
  currentBranch: 'develop',
  workingTreeClean: true,
};

describe('branch naming', () => {
  it('prefixes the change id', () => {
    expect(branchNameFor('add-auth', config())).toBe('feature/add-auth');
  });

  it('honours a custom prefix', () => {
    expect(branchNameFor('add-auth', config({ gitflow: { featurePrefix: 'feat/' } }))).toBe(
      'feat/add-auth'
    );
  });

  it('strips characters git refuses in a ref', () => {
    // `git branch` would fail with a message about refs that says nothing about
    // the change it came from.
    expect(sanitizeRefComponent('add auth~2^:?*[')).toBe('add-auth-2');
    expect(sanitizeRefComponent('..add..auth..')).toBe('add.auth');
    expect(sanitizeRefComponent('')).toBe('change');
  });
});

describe('commit messages', () => {
  it('puts a single task in the subject', () => {
    const message = commitMessageFor('add-auth', ['1.1 Wire the login form']);
    expect(message.subject).toBe('add-auth: 1.1 Wire the login form');
    expect(message.body).toBeUndefined();
  });

  it('summarises several tasks and lists them in the body', () => {
    // Three descriptions in one subject line is unreadable, and picking one to
    // stand for the rest misdescribes the commit.
    const message = commitMessageFor('add-auth', ['Wire the form', 'Add the route', 'Test it']);
    expect(message.subject).toBe('add-auth: 3 tasks completed');
    expect(message.body).toBe('- Wire the form\n- Add the route\n- Test it');
  });

  it('keeps the subject short enough to read in a log', () => {
    const message = commitMessageFor('add-auth', ['x'.repeat(200)]);
    expect(message.subject.length).toBeLessThanOrEqual(72);
  });
});

describe('pull request rendering', () => {
  const change: ChangeSnapshot = {
    id: 'add-auth',
    dir: path.join('/repo', 'openspec', 'changes', 'archive', '2026-08-02-add-auth'),
    goal: 'Let users sign in',
    summary: 'Adds session handling.',
    tasks: [
      { file: 'tasks.md', lineIndex: 0, description: 'Wire the form', done: true, key: 'a' },
      { file: 'tasks.md', lineIndex: 1, description: 'Add the route', done: false, key: 'b' },
    ],
    completedTasks: 1,
    totalTasks: 2,
    lastModified: '2026-08-02T00:00:00.000Z',
  };

  it('titles the pull request with the change goal', () => {
    expect(prTitleFor(change)).toBe('add-auth: Let users sign in');
  });

  it('falls back to the id when there is no goal', () => {
    expect(prTitleFor({ ...change, goal: undefined })).toBe('add-auth');
  });

  it('renders the tasks as a checklist GitHub can display', () => {
    const body = prBodyFor(change, '/repo');
    expect(body).toContain('**Goal:** Let users sign in');
    expect(body).toContain('### Tasks (1/2)');
    expect(body).toContain('- [x] Wire the form');
    expect(body).toContain('- [ ] Add the route');
    // POSIX separators, whatever platform this runs on.
    expect(body).toContain('openspec/changes/archive/2026-08-02-add-auth');
  });
});

describe('branch guards', () => {
  it('allows a branch from a clean tree on develop', () => {
    expect(canCreateBranch(healthy, 'develop').ok).toBe(true);
  });

  it('refuses when the tree is dirty', () => {
    // Checking out carries uncommitted work across to the new branch.
    const guard = canCreateBranch({ ...healthy, workingTreeClean: false }, 'develop');
    expect(guard).toMatchObject({ ok: false });
    expect(guard.ok === false && guard.reason).toMatch(/uncommitted/);
  });

  it('refuses to yank HEAD away from another branch', () => {
    const guard = canCreateBranch({ ...healthy, currentBranch: 'feature/other' }, 'develop');
    expect(guard).toMatchObject({ ok: false });
    expect(guard.ok === false && guard.fix).toMatch(/openspec github start/);
  });

  it('lets the explicit command switch anyway, but still not over a dirty tree', () => {
    expect(
      canCreateBranch({ ...healthy, currentBranch: 'feature/other' }, 'develop', {
        requireBaseCheckout: false,
      }).ok
    ).toBe(true);

    expect(
      canCreateBranch({ ...healthy, workingTreeClean: false }, 'develop', {
        requireBaseCheckout: false,
      }).ok
    ).toBe(false);
  });

  it('refuses mid-rebase', () => {
    const guard = canCreateBranch({ ...healthy, operationInProgress: 'rebase' }, 'develop');
    expect(guard.ok === false && guard.reason).toMatch(/rebase/);
  });

  it('refuses without a configured development branch', () => {
    const guard = canCreateBranch(healthy, undefined);
    expect(guard.ok === false && guard.fix).toBe('openspec github link');
  });

  it('refuses in a directory that is not a repository', () => {
    expect(canCreateBranch({ ...healthy, isRepository: false }, 'develop').ok).toBe(false);
  });
});

describe('commit guards', () => {
  it('allows a commit on the change’s own branch', () => {
    expect(canCommit({ ...healthy, currentBranch: 'feature/add-auth' }, 'feature/add-auth').ok).toBe(
      true
    );
  });

  it('refuses to commit one change’s work onto another change’s branch', () => {
    // The failure this exists for: two active changes, one checked out, and a
    // watcher that commits regardless puts A's code in B's pull request.
    const guard = canCommit({ ...healthy, currentBranch: 'feature/other' }, 'feature/add-auth');
    expect(guard).toMatchObject({ ok: false });
    expect(guard.ok === false && guard.fix).toBe('git checkout feature/add-auth');
  });

  it('refuses on a detached HEAD', () => {
    const guard = canCommit({ ...healthy, currentBranch: null }, 'feature/add-auth');
    expect(guard.ok === false && guard.reason).toMatch(/detached/);
  });

  it('refuses when no branch was ever recorded for the change', () => {
    const guard = canCommit(healthy, undefined);
    expect(guard.ok === false && guard.fix).toMatch(/openspec github start/);
  });

  it('does not care about a dirty tree — that is what it is committing', () => {
    expect(
      canCommit(
        { ...healthy, currentBranch: 'feature/add-auth', workingTreeClean: false },
        'feature/add-auth'
      ).ok
    ).toBe(true);
  });
});
