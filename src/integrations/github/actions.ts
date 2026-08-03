import { existsSync } from 'fs';
import path from 'path';
import type { GithubConfig } from '../config.js';
import { readAdapterState, writeAdapterState, STATE_DIR_NAME } from '../state.js';
import { changesDirFor, readChangeSnapshot } from '../snapshot.js';
import type { ChangeSnapshot } from '../types.js';
import { GitHubClient } from './client.js';
import { readArchivedChangeSnapshot } from './archived.js';
import * as git from './git.js';
import { branchNameFor, canCreateBranch, cleanlinessPathspecs } from './flow.js';
import { GithubAdapter, type GithubChangeState } from './adapter.js';

/**
 * The things `openspec github ...` does, kept out of the command definitions.
 *
 * Two callers need them and they must not drift: the CLI, and the adapter's own
 * automatic path. `start` in particular exists precisely because the automatic
 * path refused to act — so it has to reach the same end state the watcher would
 * have, including the recorded branch, or the commits that follow are skipped
 * for a branch nobody remembers.
 */

export interface LinkResult {
  owner: string;
  repo: string;
  main: string;
  develop?: string;
  /** True when `--create-develop` actually created the branch. */
  createdDevelop: boolean;
  /** Set when no development branch could be found or created. */
  problem?: string;
}

/** Branch names commonly used for the integration branch, in preference order. */
const DEVELOP_CANDIDATES = ['develop', 'development', 'dev'];

/**
 * Discovers the repository and declares the git flow branches.
 *
 * Nothing is guessed: the development branch is either found on the remote,
 * named by the user, or created on request. A silent fall back to the default
 * branch would open every pull request against the release branch, which is the
 * one mistake git flow exists to prevent.
 */
export async function linkRepository(options: {
  projectRoot: string;
  client: GitHubClient;
  config: GithubConfig;
  repoSlug?: string;
  main?: string;
  develop?: string;
  createDevelop?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<LinkResult> {
  const { projectRoot, client, config, repoSlug, createDevelop } = options;
  const gitOptions: git.GitOptions = { cwd: projectRoot, env: options.env };

  const target = repoSlug
    ? parseSlug(repoSlug)
    : await resolveFromRemote(gitOptions, config.remote);

  if (!target) {
    throw new Error(
      `Could not work out the GitHub repository from the "${config.remote}" remote. Pass --repo <owner/name>.`
    );
  }

  const repository = await client.getRepo(target.owner, target.repo);
  const main = options.main ?? repository.default_branch;

  const requested = options.develop;
  let develop: string | undefined;
  let problem: string | undefined;

  if (requested) {
    const exists = await client.getBranch(target.owner, target.repo, requested);
    if (exists) develop = requested;
    else problem = `Branch "${requested}" does not exist on ${repository.full_name}.`;
  } else {
    for (const candidate of DEVELOP_CANDIDATES) {
      if (await client.getBranch(target.owner, target.repo, candidate)) {
        develop = candidate;
        break;
      }
    }
    if (!develop) {
      problem = `No development branch found (looked for ${DEVELOP_CANDIDATES.join(', ')}).`;
    }
  }

  let createdDevelop = false;
  if (!develop && createDevelop) {
    const name = requested ?? DEVELOP_CANDIDATES[0];
    const from = await client.getBranch(target.owner, target.repo, main);
    if (!from) throw new Error(`Branch "${main}" does not exist on ${repository.full_name}.`);
    await client.createRef(target.owner, target.repo, name, from.commit.sha);
    develop = name;
    createdDevelop = true;
    problem = undefined;
  }

  return { owner: target.owner, repo: target.repo, main, develop, createdDevelop, problem };
}

export interface StartResult {
  branch: string;
  action: 'created' | 'checked-out' | 'already-current' | 'skipped';
  startPoint?: string;
  reason?: string;
  fix?: string;
}

/**
 * Creates and checks out a change's feature branch, on purpose.
 *
 * The "HEAD is already on develop" guard is skipped here — asking for this by
 * name *is* the confirmation that check was waiting for. The clean-tree guard is
 * not skipped, because it protects uncommitted work rather than the user's
 * attention.
 */
export async function startChangeBranch(options: {
  projectRoot: string;
  config: GithubConfig;
  changeId: string;
  from?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StartResult> {
  const { projectRoot, config, changeId } = options;
  const gitOptions: git.GitOptions = { cwd: projectRoot, env: options.env };

  const branch = branchNameFor(changeId, config);
  const base = options.from ?? config.gitflow.develop;

  const state: RepoStateForGuard = {
    isRepository: await git.isRepository(gitOptions),
    hasCommits: await git.hasCommits(gitOptions),
    operationInProgress: await git.inProgressOperation(gitOptions),
    currentBranch: await git.currentBranch(gitOptions),
    workingTreeClean: await git.isWorkingTreeClean(
      gitOptions,
      cleanlinessPathspecs(STATE_DIR_NAME)
    ),
  };

  const guard = canCreateBranch(state, base, { requireBaseCheckout: false });
  if (!guard.ok) {
    return { branch, action: 'skipped', reason: guard.reason, fix: guard.fix };
  }

  if (state.currentBranch === branch) {
    await rememberBranch(projectRoot, changeId, branch);
    return { branch, action: 'already-current' };
  }

  if (await git.localBranchExists(gitOptions, branch)) {
    await git.checkout(gitOptions, branch);
    await rememberBranch(projectRoot, changeId, branch);
    return { branch, action: 'checked-out' };
  }

  const startPoint = (await git.localBranchExists(gitOptions, base!))
    ? base!
    : (await git.remoteBranchExists(gitOptions, config.remote, base!))
      ? `${config.remote}/${base!}`
      : undefined;

  if (!startPoint) {
    return {
      branch,
      action: 'skipped',
      reason: `neither "${base}" nor "${config.remote}/${base}" exists in this clone`,
      fix: 'openspec github link --create-develop, then: git fetch',
    };
  }

  await git.createBranch(gitOptions, branch, startPoint);
  await git.checkout(gitOptions, branch);
  await rememberBranch(projectRoot, changeId, branch);

  return { branch, action: 'created', startPoint };
}

/**
 * Opens (or refreshes) the pull request for a change, on demand.
 *
 * Runs through the adapter rather than around it so the automatic and manual
 * paths cannot disagree about idempotency, the body, or the announcement other
 * adapters hear.
 */
export async function openChangePullRequest(options: {
  projectRoot: string;
  config: GithubConfig;
  changeId: string;
  client?: GitHubClient;
  draft?: boolean;
  dryRun?: boolean;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<{ url?: string; number?: number; problem?: string }> {
  const { projectRoot, config, changeId, log = () => {} } = options;

  const state = await readAdapterState<GithubChangeState>(projectRoot, 'github');
  const branch = state.changes[changeId]?.branch;
  if (!branch) {
    return {
      problem: `No branch is recorded for ${changeId}. Run: openspec github start ${changeId}`,
    };
  }

  const change = await readChangeAnywhere(projectRoot, changeId);
  if (!change) return { problem: `Change "${changeId}" was not found, active or archived.` };

  const adapter = new GithubAdapter(config, { client: options.client, env: options.env });
  await adapter.init({
    projectRoot,
    config,
    log,
    now: () => new Date().toISOString(),
  });

  const pr = await adapter.openPullRequest(changeId, change, branch, {
    draft: options.draft,
    dryRun: options.dryRun,
  });

  return pr ? { url: pr.html_url, number: pr.number } : {};
}

/** A change wherever it currently lives: still active, or already archived. */
export async function readChangeAnywhere(
  projectRoot: string,
  changeId: string
): Promise<ChangeSnapshot | null> {
  if (existsSync(path.join(changesDirFor(projectRoot), changeId))) {
    return readChangeSnapshot(projectRoot, changeId);
  }
  return readArchivedChangeSnapshot(projectRoot, changeId);
}

type RepoStateForGuard = Parameters<typeof canCreateBranch>[0];

async function rememberBranch(
  projectRoot: string,
  changeId: string,
  branch: string
): Promise<void> {
  const state = await readAdapterState<GithubChangeState>(projectRoot, 'github');
  state.changes[changeId] = { ...state.changes[changeId], branch };
  await writeAdapterState<GithubChangeState>(projectRoot, 'github', state);
}

function parseSlug(slug: string): { owner: string; repo: string } | null {
  const match = slug.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  return match ? { owner: match[1], repo: match[2].replace(/\.git$/, '') } : null;
}

async function resolveFromRemote(
  gitOptions: git.GitOptions,
  remote: string
): Promise<{ owner: string; repo: string } | null> {
  const url = await git.remoteUrl(gitOptions, remote);
  return url ? git.parseOwnerRepo(url) : null;
}
