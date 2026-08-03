import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Local Git mechanics for the GitHub integration.
 *
 * Two rules shape this file, and both are about a watcher that runs unattended
 * next to an AI agent editing the same tree:
 *
 *  - The write surface is deliberately tiny — branch, checkout, add, commit,
 *    push. There is no `reset`, no `rebase`, no `checkout -- <path>`, and no
 *    `push --force` anywhere in this integration, because none of them can be
 *    undone by the user noticing a minute later.
 *  - Every read is local. Nothing here fetches, so a branch check is a fact
 *    about this clone and never a network call that stalls a watch pass.
 *
 * `env` is threaded through every call so tests can run against a real
 * repository without inheriting the host's gitconfig (signing, hooks,
 * templates), the same way the store tests do.
 */

export interface GitOptions {
  /** Repository root — every command runs with this as its working directory. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitNotInstalledError extends GitError {
  constructor(args: string[]) {
    super('Git is not installed, or is not on PATH.', args, '');
    this.name = 'GitNotInstalledError';
  }
}

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function envFor(options: GitOptions): NodeJS.ProcessEnv {
  return options.env ? { ...process.env, ...options.env } : process.env;
}

/** Runs git, throwing a `GitError` carrying stderr when it fails. */
export async function runGit(options: GitOptions, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: options.cwd,
      env: envFor(options),
      // A commit message or a status listing can be long; the default 1MB cap
      // truncates into a parse error rather than failing loudly.
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isSpawnNotFoundError(error)) throw new GitNotInstalledError(args);
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
    throw new GitError(
      `git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`,
      args,
      stderr
    );
  }
}

/** Runs git, returning null instead of throwing. For probes, never for writes. */
async function probeGit(options: GitOptions, args: string[]): Promise<string | null> {
  try {
    return await runGit(options, args);
  } catch {
    return null;
  }
}

export async function isGitAvailable(options: GitOptions): Promise<boolean> {
  return (await probeGit(options, ['--version'])) !== null;
}

export async function isRepository(options: GitOptions): Promise<boolean> {
  const stdout = await probeGit(options, ['rev-parse', '--is-inside-work-tree']);
  return stdout?.trim() === 'true';
}

export async function hasCommits(options: GitOptions): Promise<boolean> {
  return (await probeGit(options, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null;
}

/**
 * The checked-out branch, or null on a detached HEAD.
 *
 * Detached is null rather than the literal `HEAD` git prints, because every
 * caller here is asking "which change's branch am I on", and the answer in that
 * state is "none" — not "a branch named HEAD".
 */
export async function currentBranch(options: GitOptions): Promise<string | null> {
  const stdout = await probeGit(options, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = stdout?.trim();
  if (!name || name === 'HEAD') return null;
  return name;
}

/**
 * Whether there is anything uncommitted.
 *
 * `pathspecs` narrows the question, which the callers need rather than want:
 * this integration writes its own state under the project root, and a check that
 * counted that would report a tree the integration itself just dirtied — so
 * creating one branch would block the next.
 */
export async function isWorkingTreeClean(
  options: GitOptions,
  pathspecs?: string[]
): Promise<boolean> {
  const args = ['status', '--porcelain'];
  if (pathspecs && pathspecs.length > 0) args.push('--', ...pathspecs);

  const stdout = await probeGit(options, args);
  return stdout !== null && stdout.trim().length === 0;
}

export async function hasStagedChanges(options: GitOptions): Promise<boolean> {
  // `--quiet` exits 1 when there *are* differences, which probeGit reports as
  // null. Inverted on purpose: an error and "no changes" must not look alike.
  return (await probeGit(options, ['diff', '--cached', '--quiet'])) === null;
}

export async function localBranchExists(options: GitOptions, branch: string): Promise<boolean> {
  return (
    (await probeGit(options, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
  );
}

/** Whether this clone already knows a remote branch. Reads refs only — no fetch. */
export async function remoteBranchExists(
  options: GitOptions,
  remote: string,
  branch: string
): Promise<boolean> {
  return (
    (await probeGit(options, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${remote}/${branch}`,
    ])) !== null
  );
}

export async function remoteUrl(options: GitOptions, remote: string): Promise<string | null> {
  const stdout = await probeGit(options, ['remote', 'get-url', remote]);
  const url = stdout?.trim();
  return url ? url : null;
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

/**
 * Whether git is in the middle of something.
 *
 * Committing during a rebase rewrites the wrong thing and leaves the user with a
 * conflicted history they did not ask for, so every write path checks this
 * first. Detected by the marker files git itself uses, which is the same signal
 * the shell prompt integrations read.
 */
export async function inProgressOperation(options: GitOptions): Promise<GitOperation | null> {
  const stdout = await probeGit(options, ['rev-parse', '--absolute-git-dir']);
  const gitDir = stdout?.trim();
  if (!gitDir) return null;

  const markers: Array<[GitOperation, string]> = [
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
    ['merge', 'MERGE_HEAD'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
    ['bisect', 'BISECT_LOG'],
  ];

  for (const [operation, marker] of markers) {
    if (existsSync(path.join(gitDir, marker))) return operation;
  }
  return null;
}

export async function createBranch(
  options: GitOptions,
  branch: string,
  startPoint: string
): Promise<void> {
  await runGit(options, ['branch', branch, startPoint]);
}

export async function checkout(options: GitOptions, branch: string): Promise<void> {
  await runGit(options, ['checkout', branch]);
}

/**
 * Stages everything, or just the given paths.
 *
 * `-A` includes deletions, which matters more than it sounds here: archiving a
 * change *moves* its directory, and staging without deletions would commit the
 * new location while leaving the old one behind as a phantom.
 */
export async function stageAll(options: GitOptions, pathspecs?: string[]): Promise<void> {
  const paths = pathspecs && pathspecs.length > 0 ? pathspecs : ['.'];
  await runGit(options, ['add', '-A', '--', ...paths]);
}

/**
 * Commits what is staged.
 *
 * Hooks are never skipped: a repo with a failing pre-commit hook is telling the
 * truth about its own rules, and an integration that quietly passes
 * `--no-verify` would commit code the project considers broken.
 */
export async function commit(
  options: GitOptions,
  subject: string,
  body?: string
): Promise<string> {
  const args = ['commit', '-m', subject];
  if (body && body.trim().length > 0) args.push('-m', body);
  await runGit(options, args);
  return (await runGit(options, ['rev-parse', 'HEAD'])).trim();
}

/** Pushes a branch, setting upstream on first push. Never forces. */
export async function push(options: GitOptions, remote: string, branch: string): Promise<void> {
  await runGit(options, ['push', '--set-upstream', remote, branch]);
}

export interface OwnerRepo {
  owner: string;
  repo: string;
}

/**
 * Pulls `owner/repo` out of a remote URL.
 *
 * Handles both spellings a remote can have — `https://github.com/o/r.git` and
 * `git@github.com:o/r.git` — plus the `ssh://` form some hosts hand out. Host
 * is not validated, so a GitHub Enterprise remote parses the same way; the API
 * base URL is a separate setting.
 */
export function parseOwnerRepo(url: string): OwnerRepo | null {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const match = trimmed.match(/[/:]([^/:]+)\/([^/]+)$/);
  if (!match) return null;

  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo };
}
