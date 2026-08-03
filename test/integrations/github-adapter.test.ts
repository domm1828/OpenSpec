import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { isolatedGitEnv } from '../helpers/store-git.js';
import * as git from '../../src/integrations/github/git.js';
import { GithubAdapter, type GithubChangeState } from '../../src/integrations/github/adapter.js';
import { GithubConfigSchema, type GithubConfig } from '../../src/integrations/config.js';
import { readAdapterState } from '../../src/integrations/state.js';
import type { GitHubClient, GitHubPullRequest } from '../../src/integrations/github/client.js';
import type { IntegrationContext, OpenSpecEvent } from '../../src/integrations/types.js';

/**
 * The adapter against a real repository and a fake GitHub.
 *
 * Real git because every guard in this integration is a claim about what git
 * does, and a mock would only confirm our own assumptions back to us. Fake
 * GitHub because the network is not the thing under test.
 */

let base: string;
let projectRoot: string;
let gitOptions: git.GitOptions;
let logs: string[];
let emitted: OpenSpecEvent[];
let createdPulls: Array<{ title: string; head: string; base: string; body?: string }>;
let pulls: GitHubPullRequest[];

const CHANGE = 'add-auth';

function fakeClient(): GitHubClient {
  return {
    whoami: async () => ({ login: 'tester' }),
    getRepo: async () => ({ full_name: 'domm1828/OpenSpec', default_branch: 'main' }),
    getBranch: async (_o: string, _r: string, branch: string) =>
      branch === 'develop' || branch === 'main' ? { name: branch, commit: { sha: 'abc' } } : null,
    createRef: async () => undefined,
    findPullRequests: async () => pulls,
    createPullRequest: async (
      _o: string,
      _r: string,
      input: { title: string; head: string; base: string; body?: string }
    ) => {
      createdPulls.push(input);
      const pr: GitHubPullRequest = {
        number: 7,
        html_url: 'https://github.com/domm1828/OpenSpec/pull/7',
        state: 'open',
        head: { ref: input.head },
        base: { ref: input.base },
      };
      pulls = [pr];
      return pr;
    },
    updatePullRequest: async (_o: string, _r: string, number: number) => ({
      ...pulls.find((pr) => pr.number === number)!,
    }),
  } as unknown as GitHubClient;
}

function makeConfig(overrides: Partial<GithubConfig> = {}): GithubConfig {
  return GithubConfigSchema.parse({
    enabled: true,
    owner: 'domm1828',
    repo: 'OpenSpec',
    gitflow: { main: 'main', develop: 'develop' },
    ...overrides,
  });
}

async function makeAdapter(config = makeConfig()): Promise<GithubAdapter> {
  const adapter = new GithubAdapter(config, { client: fakeClient(), env: gitOptions.env });
  const ctx: IntegrationContext = {
    projectRoot,
    config,
    log: (message) => logs.push(message),
    now: () => '2026-08-02T00:00:00.000Z',
    emit: async (event) => {
      emitted.push(event);
    },
  };
  await adapter.init(ctx);
  return adapter;
}

async function write(relative: string, content: string): Promise<void> {
  const file = path.join(projectRoot, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf-8');
}

const created = (changeId = CHANGE): OpenSpecEvent => ({
  type: 'change.created',
  changeId,
  at: '2026-08-02T00:00:00.000Z',
});

const checked = (description: string, changeId = CHANGE): OpenSpecEvent => ({
  type: 'task.checked',
  changeId,
  at: '2026-08-02T00:00:00.000Z',
  task: { file: 'tasks.md', lineIndex: 0, description, done: true, key: description },
});

const archived = (changeId = CHANGE): OpenSpecEvent => ({
  type: 'change.archived',
  changeId,
  at: '2026-08-02T00:00:00.000Z',
});

async function commitSubjects(): Promise<string[]> {
  const log = await git.runGit(gitOptions, ['log', '--pretty=%s']);
  return log.trim().split('\n').filter(Boolean);
}

async function stateFor(changeId = CHANGE): Promise<GithubChangeState | undefined> {
  const state = await readAdapterState<GithubChangeState>(projectRoot, 'github');
  return state.changes[changeId];
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-gh-adapter-'));
  projectRoot = path.join(base, 'repo');
  await fs.mkdir(projectRoot, { recursive: true });

  logs = [];
  emitted = [];
  createdPulls = [];
  pulls = [];

  gitOptions = { cwd: projectRoot, env: isolatedGitEnv(base) };

  // A bare repository stands in for the remote, so push is exercised for real
  // without a network.
  const remote = path.join(base, 'remote.git');
  await fs.mkdir(remote, { recursive: true });
  await git.runGit({ cwd: remote, env: gitOptions.env }, ['init', '--bare']);

  await git.runGit(gitOptions, ['init', '--initial-branch=main']);
  await write('README.md', '# test\n');
  await git.stageAll(gitOptions);
  await git.commit(gitOptions, 'Initial commit');
  await git.createBranch(gitOptions, 'develop', 'main');
  await git.checkout(gitOptions, 'develop');
  await git.runGit(gitOptions, ['remote', 'add', 'origin', remote]);

  await write(
    `openspec/changes/${CHANGE}/tasks.md`,
    '- [ ] 1.1 Wire the form\n- [ ] 1.2 Add the route\n'
  );
  await write(`openspec/changes/${CHANGE}/proposal.md`, '# Add auth\n\nAdds session handling.\n');
  await git.stageAll(gitOptions);
  await git.commit(gitOptions, 'add the change');
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('change.created', () => {
  it('creates and checks out the feature branch from develop', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    expect(await git.currentBranch(gitOptions)).toBe('feature/add-auth');
    expect((await stateFor())?.branch).toBe('feature/add-auth');
    expect(emitted.map((event) => event.type)).toContain('vcs.branch.created');
  });

  it('refuses over a dirty tree, and says how to proceed', async () => {
    await write('scratch.txt', 'wip\n');
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    expect(await git.currentBranch(gitOptions)).toBe('develop');
    expect(logs.join('\n')).toMatch(/uncommitted changes.*openspec github start/s);
  });

  it('does not yank HEAD off another change’s branch', async () => {
    // Which is also what stops an unprimed watcher from stampeding through every
    // existing change on its first pass.
    await git.createBranch(gitOptions, 'feature/other', 'develop');
    await git.checkout(gitOptions, 'feature/other');

    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    expect(await git.currentBranch(gitOptions)).toBe('feature/other');
    expect(await git.localBranchExists(gitOptions, 'feature/add-auth')).toBe(false);
  });

  it('adopts a branch that already exists instead of failing', async () => {
    await git.createBranch(gitOptions, 'feature/add-auth', 'develop');

    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    expect((await stateFor())?.branch).toBe('feature/add-auth');
  });

  it('stays out of the way when autoBranch is off', async () => {
    const adapter = await makeAdapter(makeConfig({ autoBranch: false }));
    await adapter.onEvent(created());

    expect(await git.localBranchExists(gitOptions, 'feature/add-auth')).toBe(false);
  });
});

describe('task.checked → commits', () => {
  it('makes one commit per pass, not one per task', async () => {
    // Three ticks in one edit are one working tree. Committing per event would
    // put the whole diff in the first commit and leave two empty ones behind.
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    await write('src/app.ts', 'export const login = () => {};\n');
    await write(`openspec/changes/${CHANGE}/tasks.md`, '- [x] 1.1 Wire the form\n- [x] 1.2 Add the route\n');

    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.onEvent(checked('1.2 Add the route'));

    const before = (await commitSubjects()).length;
    await adapter.flush();
    const after = await commitSubjects();

    expect(after.length).toBe(before + 1);
    expect(after[0]).toBe('add-auth: 2 tasks completed');

    const body = await git.runGit(gitOptions, ['log', '-1', '--pretty=%b']);
    expect(body).toContain('- 1.1 Wire the form');
    expect(body).toContain('- 1.2 Add the route');
  });

  it('names the task in the subject when only one was ticked', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    await write('src/app.ts', 'code\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    expect((await commitSubjects())[0]).toBe('add-auth: 1.1 Wire the form');
  });

  it('commits nothing when the tree is clean', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    const before = await commitSubjects();
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    expect(await commitSubjects()).toEqual(before);
    expect(logs.join('\n')).toMatch(/nothing to commit/);
  });

  it('never sweeps the local sync state into a commit', async () => {
    // `.openspec-integrations/` is machine-local cache; a project that has not
    // gitignored it would otherwise get it in every automatic commit.
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    await write('src/app.ts', 'code\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    const files = await git.runGit(gitOptions, ['show', '--name-only', '--pretty=', 'HEAD']);
    expect(files).toContain('src/app.ts');
    expect(files).not.toContain('.openspec-integrations');
  });

  it('never commits onto another change’s branch', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    await git.checkout(gitOptions, 'develop');
    await write('src/app.ts', 'code\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    expect(await git.currentBranch(gitOptions)).toBe('develop');
    expect(await commitSubjects()).not.toContain('add-auth: 1.1 Wire the form');
    expect(logs.join('\n')).toMatch(/HEAD is on develop, not feature\/add-auth/);
  });

  it('keeps the tasks pending so the next pass retries them', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    await git.checkout(gitOptions, 'develop');
    await write('src/app.ts', 'code\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    expect((await stateFor())?.pendingTasks).toEqual(['1.1 Wire the form']);

    await git.checkout(gitOptions, 'feature/add-auth');
    await adapter.flush();

    expect((await commitSubjects())[0]).toBe('add-auth: 1.1 Wire the form');
    expect((await stateFor())?.pendingTasks).toEqual([]);
  });

  it('does not commit when a task is unticked', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    await write('src/app.ts', 'code\n');
    await adapter.onEvent({ ...checked('1.1 Wire the form'), type: 'task.unchecked' });
    await adapter.flush();

    expect(await commitSubjects()).not.toContain('add-auth: 1.1 Wire the form');
  });

  it('limits the commit to openspec/ when asked', async () => {
    const adapter = await makeAdapter(makeConfig({ commitScope: 'openspec-only' }));
    await adapter.onEvent(created());

    await write('src/app.ts', 'code\n');
    await write(`openspec/changes/${CHANGE}/tasks.md`, '- [x] 1.1 Wire the form\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    const files = await git.runGit(gitOptions, ['show', '--name-only', '--pretty=', 'HEAD']);
    expect(files).toContain('tasks.md');
    expect(files).not.toContain('src/app.ts');
  });

  it('stays out of the way when autoCommit is off', async () => {
    const adapter = await makeAdapter(makeConfig({ autoCommit: false }));
    await adapter.onEvent(created());

    await write('src/app.ts', 'code\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    expect(await git.isWorkingTreeClean(gitOptions)).toBe(false);
  });
});

describe('change.archived → pull request', () => {
  async function archiveOnDisk(): Promise<void> {
    const from = path.join(projectRoot, 'openspec', 'changes', CHANGE);
    const to = path.join(projectRoot, 'openspec', 'changes', 'archive', `2026-08-02-${CHANGE}`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  it('commits the archive, pushes, and opens the pull request', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());

    await write('src/app.ts', 'code\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    await archiveOnDisk();
    await adapter.onEvent(archived());

    expect((await commitSubjects())[0]).toBe('add-auth: archive change');
    expect(createdPulls).toHaveLength(1);
    expect(createdPulls[0]).toMatchObject({ head: 'feature/add-auth', base: 'develop' });
    expect(createdPulls[0].title).toContain('add-auth');
    // The branch really reached the remote.
    expect(
      await git.remoteBranchExists(gitOptions, 'origin', 'feature/add-auth')
    ).toBe(true);

    expect((await stateFor())?.prUrl).toBe('https://github.com/domm1828/OpenSpec/pull/7');
    expect(emitted.filter((event) => event.type === 'vcs.pr.opened')).toHaveLength(1);
  });

  it('refreshes the existing pull request instead of opening a second one', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent(created());
    await write('src/app.ts', 'code\n');
    await adapter.onEvent(checked('1.1 Wire the form'));
    await adapter.flush();

    await archiveOnDisk();
    await adapter.onEvent(archived());
    await adapter.onEvent(archived());

    expect(createdPulls).toHaveLength(1);
  });

  it('opens nothing when the change was deleted rather than archived', async () => {
    // A directory that disappears looks identical either way; inventing a pull
    // request for discarded work is worse than doing nothing.
    const adapter = await makeAdapter();
    await adapter.onEvent(created());
    await fs.rm(path.join(projectRoot, 'openspec', 'changes', CHANGE), {
      recursive: true,
      force: true,
    });

    await adapter.onEvent(archived());

    expect(createdPulls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/not in the archive/);
  });

  it('opens nothing when openPrOnArchive is off', async () => {
    const adapter = await makeAdapter(makeConfig({ openPrOnArchive: false }));
    await adapter.onEvent(created());
    await archiveOnDisk();
    await adapter.onEvent(archived());

    expect(createdPulls).toHaveLength(0);
    expect((await commitSubjects())[0]).toBe('add-auth: archive change');
  });

  it('does nothing for a change it never branched', async () => {
    const adapter = await makeAdapter();
    await archiveOnDisk();
    await adapter.onEvent(archived());

    expect(createdPulls).toHaveLength(0);
  });
});

describe('healthcheck', () => {
  it('reports the repository and the branch mapping when everything is set', async () => {
    const adapter = await makeAdapter();
    const report = await adapter.healthcheck();

    expect(report).toMatchObject({ id: 'github', level: 'ok' });
    expect(report.message).toContain('domm1828/OpenSpec');
    expect(report.message).toContain('develop');
  });

  it('says to run link when the branches are not declared', async () => {
    const adapter = await makeAdapter(GithubConfigSchema.parse({ enabled: true }));
    const report = await adapter.healthcheck();

    expect(report).toMatchObject({ level: 'error', fix: 'openspec github link' });
  });

  it('reports being off rather than broken when disabled', async () => {
    const adapter = await makeAdapter(makeConfig({ enabled: false }));
    expect(await adapter.healthcheck()).toMatchObject({ level: 'disabled' });
  });

  it('flags a token that cannot write, instead of waiting for the 403', async () => {
    const config = makeConfig();
    const client = fakeClient();
    vi.spyOn(client, 'getRepo').mockResolvedValue({
      full_name: 'domm1828/OpenSpec',
      default_branch: 'main',
      permissions: { push: false },
    });

    const adapter = new GithubAdapter(config, { client, env: gitOptions.env });
    await adapter.init({
      projectRoot,
      config,
      log: (m) => logs.push(m),
      now: () => '2026-08-02T00:00:00.000Z',
    });

    expect(await adapter.healthcheck()).toMatchObject({ level: 'error' });
  });
});
