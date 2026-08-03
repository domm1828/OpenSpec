import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { isolatedGitEnv } from '../helpers/store-git.js';
import * as git from '../../src/integrations/github/git.js';

/**
 * Real git, in a throwaway repository.
 *
 * The whole point of this module is what git actually does with a dirty tree, a
 * detached HEAD or a rebase in progress, and a mocked `execFile` would only
 * assert that we spell the arguments the way we already believe we do.
 */

let base: string;
let repo: string;
let options: git.GitOptions;

async function write(relative: string, content: string): Promise<void> {
  const file = path.join(repo, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf-8');
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-gh-git-'));
  repo = path.join(base, 'repo');
  await fs.mkdir(repo, { recursive: true });

  options = { cwd: repo, env: isolatedGitEnv(base) };

  await git.runGit(options, ['init', '--initial-branch=main']);
  await write('README.md', '# test\n');
  await git.stageAll(options);
  await git.commit(options, 'Initial commit');
  await git.createBranch(options, 'develop', 'main');
  await git.checkout(options, 'develop');
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('repository probes', () => {
  it('recognises a repository with commits', async () => {
    expect(await git.isRepository(options)).toBe(true);
    expect(await git.hasCommits(options)).toBe(true);
    expect(await git.currentBranch(options)).toBe('develop');
    expect(await git.isWorkingTreeClean(options)).toBe(true);
  });

  it('reports a plain directory as not a repository', async () => {
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain);
    expect(await git.isRepository({ cwd: plain, env: options.env })).toBe(false);
  });

  it('reports a detached HEAD as no branch at all', async () => {
    // Not the literal "HEAD" git prints: every caller is asking which change's
    // branch this is, and the honest answer there is "none".
    const sha = (await git.runGit(options, ['rev-parse', 'HEAD'])).trim();
    await git.checkout(options, sha);
    expect(await git.currentBranch(options)).toBeNull();
  });

  it('sees an untracked file as a dirty tree', async () => {
    await write('scratch.txt', 'wip\n');
    expect(await git.isWorkingTreeClean(options)).toBe(false);
  });
});

describe('branches', () => {
  it('creates from an explicit start point without moving HEAD', async () => {
    await git.createBranch(options, 'feature/add-auth', 'develop');

    expect(await git.localBranchExists(options, 'feature/add-auth')).toBe(true);
    expect(await git.currentBranch(options)).toBe('develop');

    await git.checkout(options, 'feature/add-auth');
    expect(await git.currentBranch(options)).toBe('feature/add-auth');
  });

  it('reports a branch that does not exist', async () => {
    expect(await git.localBranchExists(options, 'feature/nope')).toBe(false);
    expect(await git.remoteBranchExists(options, 'origin', 'develop')).toBe(false);
  });
});

describe('staging and committing', () => {
  it('commits what was staged and reports the sha', async () => {
    await write('src/app.ts', 'export const x = 1;\n');
    await git.stageAll(options);

    expect(await git.hasStagedChanges(options)).toBe(true);

    const sha = await git.commit(options, 'add-auth: wire the form', '- detail\n');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const log = await git.runGit(options, ['log', '-1', '--pretty=%s%n%b']);
    expect(log).toContain('add-auth: wire the form');
    expect(log).toContain('- detail');
    expect(await git.isWorkingTreeClean(options)).toBe(true);
  });

  it('reports nothing staged when there is nothing to commit', async () => {
    await git.stageAll(options);
    expect(await git.hasStagedChanges(options)).toBe(false);
  });

  it('stages deletions, so an archived change does not leave a phantom behind', async () => {
    await write('openspec/changes/add-auth/tasks.md', '- [ ] 1.1 First\n');
    await git.stageAll(options);
    await git.commit(options, 'add the change');

    await fs.rename(
      path.join(repo, 'openspec/changes/add-auth'),
      path.join(repo, 'openspec/changes/archive-add-auth')
    );
    await git.stageAll(options);
    await git.commit(options, 'archive it');

    const tracked = await git.runGit(options, ['ls-files']);
    expect(tracked).not.toContain('changes/add-auth/tasks.md');
    expect(tracked).toContain('changes/archive-add-auth/tasks.md');
  });

  it('limits staging to the given pathspec', async () => {
    await write('openspec/notes.md', 'note\n');
    await write('src/app.ts', 'code\n');

    await git.stageAll(options, ['openspec']);

    const staged = await git.runGit(options, ['diff', '--cached', '--name-only']);
    expect(staged).toContain('openspec/notes.md');
    expect(staged).not.toContain('src/app.ts');
  });
});

describe('in-progress operations', () => {
  it('sees nothing in a settled repository', async () => {
    expect(await git.inProgressOperation(options)).toBeNull();
  });

  it('detects a conflicted merge', async () => {
    // Committing in the middle of one rewrites the wrong thing.
    await git.checkout(options, 'main');
    await write('conflict.txt', 'from main\n');
    await git.stageAll(options);
    await git.commit(options, 'main side');

    await git.checkout(options, 'develop');
    await write('conflict.txt', 'from develop\n');
    await git.stageAll(options);
    await git.commit(options, 'develop side');

    await expect(git.runGit(options, ['merge', 'main'])).rejects.toBeInstanceOf(git.GitError);
    expect(await git.inProgressOperation(options)).toBe('merge');
  });
});

describe('parseOwnerRepo', () => {
  it('handles both spellings a remote can have', () => {
    expect(git.parseOwnerRepo('https://github.com/domm1828/OpenSpec.git')).toEqual({
      owner: 'domm1828',
      repo: 'OpenSpec',
    });
    expect(git.parseOwnerRepo('git@github.com:domm1828/OpenSpec.git')).toEqual({
      owner: 'domm1828',
      repo: 'OpenSpec',
    });
    expect(git.parseOwnerRepo('ssh://git@github.acme.com/team/tools')).toEqual({
      owner: 'team',
      repo: 'tools',
    });
  });

  it('returns null for something that is not a repository URL', () => {
    expect(git.parseOwnerRepo('not-a-url')).toBeNull();
  });
});

describe('remotes', () => {
  it('reads the configured origin without touching the network', async () => {
    await git.runGit(options, [
      'remote',
      'add',
      'origin',
      'https://github.com/domm1828/OpenSpec.git',
    ]);
    expect(await git.remoteUrl(options, 'origin')).toBe('https://github.com/domm1828/OpenSpec.git');
    expect(await git.remoteUrl(options, 'upstream')).toBeNull();
  });
});
