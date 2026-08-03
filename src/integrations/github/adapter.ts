import type {
  ChangeSnapshot,
  HealthReport,
  IntegrationAdapter,
  IntegrationContext,
  OpenSpecEvent,
} from '../types.js';
import type { GithubConfig } from '../config.js';
import { getSecret } from '../secrets.js';
import {
  readAdapterState,
  writeAdapterState,
  STATE_DIR_NAME,
  type AdapterState,
} from '../state.js';
import { GitHubClient, GitHubApiError, type GitHubPullRequest } from './client.js';
import { readArchivedChangeSnapshot } from './archived.js';
import * as git from './git.js';
import type { GitOptions, OwnerRepo } from './git.js';
import {
  branchNameFor,
  canCommit,
  canCreateBranch,
  cleanlinessPathspecs,
  commitMessageFor,
  commitPathspecs,
  prBodyFor,
  prTitleFor,
  type GuardResult,
  type RepoState,
} from './flow.js';

/**
 * GitHub adapter: turns a change's life cycle into a git-flow one.
 *
 *   change.created  → feature/<change-id>, branched off develop
 *   task.checked    → a commit on that branch, one per watch pass
 *   change.archived → push, then a pull request against develop
 *
 * Every step is guarded and every guard failure is a logged skip, never a
 * throw. This runs unattended, in the same working tree an AI agent is editing;
 * an integration that reacted to an inconvenient repository state by writing
 * anyway would eventually eat someone's work, and one that aborted the watch
 * pass would take Telegram and Trello down with it.
 */

/** Per-change bookkeeping in `.openspec-integrations/github-state.json`. */
export interface GithubChangeState {
  /** The feature branch created for this change. */
  branch?: string;
  /**
   * Tasks ticked but not yet committed.
   *
   * Persisted rather than kept in memory alone so a commit that fails — a hook
   * rejecting it, a lock file, a full disk — is retried on the next pass with
   * the same message, instead of the descriptions being lost and the work
   * landing in whatever the next commit happens to be called.
   */
  pendingTasks?: string[];
  prNumber?: number;
  prUrl?: string;
}

type GithubState = AdapterState<GithubChangeState>;

export interface GithubAdapterDeps {
  /** Injected in tests; otherwise built from the stored token. */
  client?: GitHubClient;
  /** Injected in tests to isolate git from the host's gitconfig. */
  env?: NodeJS.ProcessEnv;
}

export class GithubAdapter implements IntegrationAdapter {
  readonly id = 'github';

  private ctx?: IntegrationContext;
  private client?: GitHubClient;
  private ownerRepo?: OwnerRepo;
  private gitOptions: GitOptions = { cwd: process.cwd() };

  /** Tasks ticked during the current pass, per change. Mirrored into state. */
  private readonly pending = new Map<string, string[]>();

  constructor(
    private readonly config: GithubConfig,
    private readonly deps: GithubAdapterDeps = {}
  ) {}

  async init(ctx: IntegrationContext): Promise<void> {
    this.ctx = ctx;
    this.gitOptions = { cwd: ctx.projectRoot, env: this.deps.env };

    if (this.deps.client) {
      this.client = this.deps.client;
    } else {
      const token = getSecret('githubToken');
      if (token) {
        this.client = new GitHubClient(token, { baseUrl: this.config.apiBaseUrl });
      } else if (this.config.openPrOnArchive) {
        // Only fatal when a pull request is actually expected: branching and
        // committing are local git and need no credentials at all, so a project
        // that only wants those should not be forced to mint a token.
        throw new Error(
          'GitHub credentials are not set. Run "openspec integrations secret set githubToken <token>", or set github.openPrOnArchive: false.'
        );
      }
    }

    this.ownerRepo = await this.resolveOwnerRepo();
  }

  async onEvent(event: OpenSpecEvent): Promise<void> {
    if (!this.ctx || !event.changeId) return;

    switch (event.type) {
      case 'change.created':
        await this.handleChangeCreated(event.changeId);
        return;
      case 'task.checked':
        this.bufferTask(event.changeId, event.task?.description ?? '');
        await this.persistPending(event.changeId);
        return;
      case 'task.unchecked':
        // Reopening a task is not a commit: there is no new work to record, and
        // the tick's removal rides along with the next real commit.
        this.log(`reopened task in ${event.changeId}; nothing committed`);
        return;
      case 'change.archived':
        await this.handleArchived(event.changeId);
        return;
      default:
        return;
    }
  }

  /**
   * Commits what this pass ticked — once per change, not once per task.
   *
   * An agent that ticks three checkboxes in one edit produces three events over
   * one working tree. Committing per event would put the entire diff in the
   * first commit and leave two empty ones behind it, describing work that is
   * not in them.
   */
  async flush(): Promise<void> {
    if (!this.ctx || !this.config.autoCommit) return;

    const state = await this.readState();
    const changeIds = new Set<string>([
      ...this.pending.keys(),
      // Anything left pending by a failed commit on an earlier pass gets
      // another attempt here, which is the whole point of persisting it.
      ...Object.entries(state.changes)
        .filter(([, entry]) => (entry.pendingTasks?.length ?? 0) > 0)
        .map(([changeId]) => changeId),
    ]);

    for (const changeId of changeIds) {
      try {
        await this.commitPending(changeId);
      } catch (error) {
        // Left pending on purpose: the next pass retries with the same message.
        this.log(`could not commit ${changeId}: ${(error as Error).message}`);
      }
    }
  }

  async healthcheck(): Promise<HealthReport> {
    if (!this.config.enabled) {
      return { id: this.id, level: 'disabled', message: 'GitHub integration is off' };
    }

    if (!(await git.isGitAvailable(this.gitOptions))) {
      return {
        id: this.id,
        level: 'error',
        message: 'Git is not installed, or is not on PATH',
        fix: 'Install Git: https://git-scm.com/downloads',
      };
    }

    if (!(await git.isRepository(this.gitOptions))) {
      return {
        id: this.id,
        level: 'error',
        message: 'This project is not a git repository',
        fix: 'git init',
      };
    }

    if (!this.config.gitflow.develop || !this.config.gitflow.main) {
      return {
        id: this.id,
        level: 'error',
        message: 'The git flow branches are not declared',
        fix: 'openspec github link',
      };
    }

    if (!this.ownerRepo) {
      return {
        id: this.id,
        level: 'error',
        message: `Could not work out the GitHub repository from the "${this.config.remote}" remote`,
        fix: 'openspec github link --repo <owner/name>',
      };
    }

    if (!this.client) {
      return {
        id: this.id,
        level: this.config.openPrOnArchive ? 'error' : 'warn',
        message: 'No GitHub token is set, so pull requests cannot be opened',
        fix: 'openspec integrations secret set githubToken <token>',
      };
    }

    const { owner, repo } = this.ownerRepo;

    try {
      const me = await this.client.whoami();
      const repository = await this.client.getRepo(owner, repo);

      const develop = this.config.gitflow.develop;
      if (!(await this.client.getBranch(owner, repo, develop))) {
        return {
          id: this.id,
          level: 'error',
          message: `Connected as ${me.login}, but ${repository.full_name} has no "${develop}" branch`,
          fix: `openspec github link --create-develop`,
        };
      }

      if (repository.permissions && repository.permissions.push === false) {
        // Reads succeed with a read-only token, so this would otherwise only
        // surface as a 403 at the moment the pull request is created.
        return {
          id: this.id,
          level: 'error',
          message: `Connected as ${me.login}, but the token cannot write to ${repository.full_name}`,
          fix: 'Issue a token with the "repo" scope (or Contents + Pull requests write)',
        };
      }

      return {
        id: this.id,
        level: 'ok',
        message: `Connected as ${me.login}; ${repository.full_name}, ${this.config.gitflow.featurePrefix}<change-id> → ${develop}`,
      };
    } catch (error) {
      return { id: this.id, level: 'error', message: (error as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async handleChangeCreated(changeId: string): Promise<void> {
    if (!this.config.autoBranch) return;

    const branch = branchNameFor(changeId, this.config);
    const base = this.config.gitflow.develop;

    if (await git.localBranchExists(this.gitOptions, branch)) {
      // Already there — a re-primed watcher, or a branch made by hand. Record it
      // so commits are allowed on it, and leave the checkout alone.
      await this.rememberBranch(changeId, branch);
      return;
    }

    const guard = canCreateBranch(await this.repoState(), base);
    if (!guard.ok) {
      this.logSkip(`create ${branch}`, guard, changeId);
      return;
    }

    const startPoint = await this.resolveStartPoint(base!);
    if (!startPoint) {
      this.log(
        `no "${base}" branch to start from. Fix: openspec github link --create-develop, or create it locally`
      );
      return;
    }

    await git.createBranch(this.gitOptions, branch, startPoint);
    await git.checkout(this.gitOptions, branch);
    await this.rememberBranch(changeId, branch);

    this.log(`created and checked out ${branch} from ${startPoint}`);
    await this.emit({
      type: 'vcs.branch.created',
      changeId,
      meta: { branch, base: base!, startPoint },
    });
  }

  /**
   * Settles a change that has left `openspec/changes/`: commit, push, open the
   * pull request.
   *
   * Archiving itself is a diff — it moves the change directory and merges spec
   * deltas — so it has to be committed before the pull request, or the pull
   * request describes a change whose paperwork is missing from the branch.
   */
  private async handleArchived(changeId: string): Promise<void> {
    const state = await this.readState();
    const entry = state.changes[changeId];
    if (!entry?.branch) return;

    const change = await readArchivedChangeSnapshot(this.ctx!.projectRoot, changeId);
    if (!change) {
      // A change directory also disappears when it is deleted or renamed, and
      // from the outside the two are identical. Opening a pull request for work
      // that was thrown away is worse than doing nothing.
      this.log(
        `${changeId} is gone but is not in the archive; assuming it was deleted, so no pull request`
      );
      return;
    }

    await this.commitPending(changeId);
    await this.commitArchive(changeId, entry.branch);

    if (!this.config.openPrOnArchive) {
      this.log(`${changeId} archived; openPrOnArchive is off, so no pull request`);
      return;
    }

    await this.openPullRequest(changeId, change, entry.branch);
  }

  // ---------------------------------------------------------------------------
  // Git actions
  // ---------------------------------------------------------------------------

  private bufferTask(changeId: string, description: string): void {
    if (!this.config.autoCommit || !description) return;
    const tasks = this.pending.get(changeId) ?? [];
    if (!tasks.includes(description)) tasks.push(description);
    this.pending.set(changeId, tasks);
  }

  private async persistPending(changeId: string): Promise<void> {
    const state = await this.readState();
    const entry = state.changes[changeId] ?? {};
    entry.pendingTasks = this.pending.get(changeId) ?? [];
    state.changes[changeId] = entry;
    await this.writeState(state);
  }

  /** Commits this change's outstanding ticks, if the guards allow it. */
  private async commitPending(changeId: string): Promise<void> {
    const state = await this.readState();
    const entry = state.changes[changeId];
    const tasks = [...new Set([...(entry?.pendingTasks ?? []), ...(this.pending.get(changeId) ?? [])])];
    if (tasks.length === 0) return;

    const guard = canCommit(await this.repoState(), entry?.branch);
    if (!guard.ok) {
      this.logSkip(`commit ${tasks.length} task(s)`, guard, changeId);
      return;
    }

    await git.stageAll(this.gitOptions, this.pathspecs());

    if (!(await git.hasStagedChanges(this.gitOptions))) {
      // The tick is already in history — someone committed by hand, or a pull
      // from Trello wrote a checkbox that was already committed. An empty commit
      // would add a message with nothing under it.
      this.log(`nothing to commit for ${changeId}; the ticked tasks are already in history`);
      this.pending.delete(changeId);
      await this.clearPending(changeId);
      return;
    }

    const message = commitMessageFor(changeId, tasks);
    const sha = await git.commit(this.gitOptions, message.subject, message.body);

    this.pending.delete(changeId);
    await this.clearPending(changeId);

    this.log(`committed ${sha.slice(0, 7)} on ${entry!.branch}: ${message.subject}`);

    if (this.config.pushOnCommit) await this.push(entry!.branch!);

    await this.emit({
      type: 'vcs.commit.created',
      changeId,
      meta: { sha, subject: message.subject, branch: entry!.branch!, tasks },
    });
  }

  /** Commits the file moves the archive itself performed, if any are left. */
  private async commitArchive(changeId: string, branch: string): Promise<void> {
    const guard = canCommit(await this.repoState(), branch);
    if (!guard.ok) {
      this.logSkip('commit the archive', guard, changeId);
      return;
    }

    await git.stageAll(this.gitOptions, this.pathspecs());
    if (!(await git.hasStagedChanges(this.gitOptions))) return;

    const sha = await git.commit(this.gitOptions, `${changeId}: archive change`);
    this.log(`committed ${sha.slice(0, 7)} on ${branch}: archive`);
  }

  private async push(branch: string): Promise<void> {
    try {
      await git.push(this.gitOptions, this.config.remote, branch);
    } catch (error) {
      this.log(`could not push ${branch}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Pull request
  // ---------------------------------------------------------------------------

  /**
   * Opens the pull request, or reports the one that already exists.
   *
   * Exposed because `openspec github pr` does the same thing on demand, for the
   * case where the branch is ready but the change is not being archived yet.
   */
  async openPullRequest(
    changeId: string,
    change: ChangeSnapshot,
    branch: string,
    options: { dryRun?: boolean; draft?: boolean } = {}
  ): Promise<GitHubPullRequest | null> {
    const base = this.config.gitflow.develop;
    if (!this.client || !this.ownerRepo || !base) {
      this.log(
        `cannot open a pull request for ${changeId}: ${
          !base ? 'no development branch is configured' : 'GitHub is not configured'
        }. Fix: openspec github link`
      );
      return null;
    }

    const { owner, repo } = this.ownerRepo;
    const title = prTitleFor(change);
    const body = prBodyFor(change, this.ctx!.projectRoot);

    if (options.dryRun) {
      this.log(`would open "${title}" (${branch} → ${base})`);
      return null;
    }

    try {
      await this.push(branch);
    } catch {
      // push() already reported it; without the branch on the remote there is
      // nothing to open a pull request from.
      return null;
    }

    const existing = await this.client.findPullRequests(owner, repo, branch);
    const open = existing.find((pr) => pr.state === 'open');

    if (open) {
      // Refresh rather than duplicate: the task list in the body has almost
      // certainly moved since it was opened.
      const updated = await this.client.updatePullRequest(owner, repo, open.number, { title, body });
      await this.rememberPullRequest(changeId, updated);
      this.log(`updated pull request #${updated.number}: ${updated.html_url}`);
      await this.emitPullRequest(changeId, updated, branch, base);
      return updated;
    }

    if (existing.length > 0) {
      // Closed or merged. Opening a second one would either fail with "no
      // commits between" or split the change's history across two URLs.
      const previous = existing[0];
      this.log(
        `${changeId} already had pull request #${previous.number} (${previous.state}): ${previous.html_url}`
      );
      await this.rememberPullRequest(changeId, previous);
      return null;
    }

    try {
      const created = await this.client.createPullRequest(owner, repo, {
        title,
        head: branch,
        base,
        body,
        draft: options.draft ?? this.config.draftPr,
      });
      await this.rememberPullRequest(changeId, created);
      this.log(`opened pull request #${created.number}: ${created.html_url}`);
      await this.emitPullRequest(changeId, created, branch, base);
      return created;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        // 422 here means "no commits between base and head" often enough that
        // the raw message is more confusing than helpful on its own.
        this.log(
          `GitHub refused the pull request for ${changeId}: ${error.message}. This usually means ${branch} has no commits that ${base} does not.`
        );
        return null;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private pathspecs(): string[] {
    return commitPathspecs(this.config, STATE_DIR_NAME);
  }

  private async repoState(): Promise<RepoState> {
    return {
      isRepository: await git.isRepository(this.gitOptions),
      hasCommits: await git.hasCommits(this.gitOptions),
      operationInProgress: await git.inProgressOperation(this.gitOptions),
      currentBranch: await git.currentBranch(this.gitOptions),
      workingTreeClean: await git.isWorkingTreeClean(
        this.gitOptions,
        cleanlinessPathspecs(STATE_DIR_NAME)
      ),
    };
  }

  /**
   * Where a new feature branch starts.
   *
   * Prefers the local development branch, falling back to the remote-tracking
   * ref this clone already knows — which is the normal state of a fresh clone,
   * where `develop` exists on the remote and has never been checked out. Reads
   * refs only; nothing here fetches.
   */
  private async resolveStartPoint(base: string): Promise<string | null> {
    if (await git.localBranchExists(this.gitOptions, base)) return base;

    const remoteRef = `${this.config.remote}/${base}`;
    if (await git.remoteBranchExists(this.gitOptions, this.config.remote, base)) return remoteRef;

    return null;
  }

  private async resolveOwnerRepo(): Promise<OwnerRepo | undefined> {
    if (this.config.owner && this.config.repo) {
      return { owner: this.config.owner, repo: this.config.repo };
    }

    const url = await git.remoteUrl(this.gitOptions, this.config.remote);
    if (!url) return undefined;
    return git.parseOwnerRepo(url) ?? undefined;
  }

  private async readState(): Promise<GithubState> {
    return readAdapterState<GithubChangeState>(this.ctx!.projectRoot, this.id);
  }

  private async writeState(state: GithubState): Promise<void> {
    await writeAdapterState<GithubChangeState>(this.ctx!.projectRoot, this.id, state);
  }

  private async rememberBranch(changeId: string, branch: string): Promise<void> {
    const state = await this.readState();
    state.changes[changeId] = { ...state.changes[changeId], branch };
    await this.writeState(state);
  }

  private async rememberPullRequest(changeId: string, pr: GitHubPullRequest): Promise<void> {
    const state = await this.readState();
    state.changes[changeId] = {
      ...state.changes[changeId],
      prNumber: pr.number,
      prUrl: pr.html_url,
    };
    await this.writeState(state);
  }

  private async clearPending(changeId: string): Promise<void> {
    const state = await this.readState();
    const entry = state.changes[changeId];
    if (!entry) return;
    entry.pendingTasks = [];
    await this.writeState(state);
  }

  private async emitPullRequest(
    changeId: string,
    pr: GitHubPullRequest,
    branch: string,
    base: string
  ): Promise<void> {
    await this.emit({
      type: 'vcs.pr.opened',
      changeId,
      meta: { url: pr.html_url, number: pr.number, branch, base, draft: pr.draft ?? false },
    });
  }

  private async emit(event: Omit<OpenSpecEvent, 'at'>): Promise<void> {
    await this.ctx?.emit?.({ ...event, at: this.ctx.now() } as OpenSpecEvent);
  }

  private log(message: string): void {
    this.ctx?.log(`GitHub: ${message}`);
  }

  private logSkip(action: string, guard: GuardResult, changeId: string): void {
    if (guard.ok) return;
    this.log(
      `skipped ${action} for ${changeId} — ${guard.reason}${guard.fix ? `. Fix: ${guard.fix}` : ''}`
    );
  }
}

export function createGithubAdapter(config: unknown, deps?: GithubAdapterDeps): IntegrationAdapter {
  return new GithubAdapter(config as GithubConfig, deps);
}
