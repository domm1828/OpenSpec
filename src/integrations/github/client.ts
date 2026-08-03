/**
 * Minimal GitHub REST client.
 *
 * Hand-rolled on `fetch` for the same reason `TrelloClient` is: this integration
 * touches seven endpoints, and Octokit would add a supply-chain surface and a
 * version to track for coverage these files already have.
 *
 * The one place it is genuinely more careful than the Trello client is rate
 * limiting. GitHub tells you what to do — `Retry-After` on secondary limits,
 * `x-ratelimit-reset` on primary ones — so guessing an exponential backoff
 * would either sleep too little (and burn the budget) or too long.
 */

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export interface GitHubUser {
  login: string;
}

export interface GitHubRepo {
  full_name: string;
  default_branch: string;
  permissions?: { push?: boolean; admin?: boolean };
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  head: { ref: string };
  base: { ref: string };
}

export interface GitHubClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Sent as the User-Agent; GitHub rejects requests without one. */
  userAgent?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';

/** Longest a single retry will wait. A reset window can be an hour away. */
const MAX_RETRY_DELAY_MS = 60_000;

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly userAgent: string;

  constructor(
    private readonly token: string,
    options: GitHubClientOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.userAgent = options.userAgent ?? 'openspec-integrations';
  }

  /**
   * How long to wait before retrying, or null when the response is not a
   * throttle at all.
   *
   * The 403-with-Retry-After case is the interesting one: GitHub reports
   * secondary rate limits (too many writes in a burst) as 403, and a client that
   * treats every 403 as "no permission" gives up on a request that would have
   * succeeded seconds later. A 403 without those headers really is a permission
   * problem and is surfaced immediately.
   */
  private retryDelayMs(response: Response): number | null {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset) {
      const resetMs = Number(reset) * 1000;
      if (Number.isFinite(resetMs)) {
        return Math.min(Math.max(resetMs - this.now(), 1000), MAX_RETRY_DELAY_MS);
      }
    }

    if (response.status === 429) return 1000;
    if (response.status >= 500) return 1000;
    return null;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    let lastError: GitHubApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': this.userAgent,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      }

      const raw = await response.text().catch(() => '');
      lastError = new GitHubApiError(
        `GitHub ${method} ${endpoint} failed with ${response.status}: ${describeBody(raw)}`,
        response.status,
        endpoint
      );

      const delay = this.retryDelayMs(response);
      if (delay === null || attempt === this.maxRetries) break;

      // Exponential only on top of GitHub's own advice, never instead of it.
      await this.sleep(Math.min(delay * 2 ** attempt, MAX_RETRY_DELAY_MS));
    }

    throw lastError;
  }

  /** Verifies the token and returns the authenticated login. */
  async whoami(): Promise<GitHubUser> {
    return this.request<GitHubUser>('GET', '/user');
  }

  async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request<GitHubRepo>('GET', `/repos${repoPath(owner, repo)}`);
  }

  /** The branch, or null when it does not exist — a 404 here is an answer. */
  async getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch | null> {
    try {
      return await this.request<GitHubBranch>(
        'GET',
        `/repos${repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}`
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Creates a branch on the remote, pointed at an existing commit. */
  async createRef(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.request('POST', `/repos${repoPath(owner, repo)}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  /**
   * Pull requests whose head is this branch, newest first, open or closed.
   *
   * `state=all` on purpose: opening a second pull request for a branch whose
   * first one was closed is worse than reporting the closed one, because the
   * board and the chat would then each point at a different URL for the same
   * change.
   */
  async findPullRequests(
    owner: string,
    repo: string,
    headBranch: string
  ): Promise<GitHubPullRequest[]> {
    const head = encodeURIComponent(`${owner}:${headBranch}`);
    return this.request<GitHubPullRequest[]>(
      'GET',
      `/repos${repoPath(owner, repo)}/pulls?head=${head}&state=all&sort=created&direction=desc`
    );
  }

  async createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body?: string; draft?: boolean }
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>('POST', `/repos${repoPath(owner, repo)}/pulls`, input);
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    input: { title?: string; body?: string; state?: 'open' | 'closed' }
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(
      'PATCH',
      `/repos${repoPath(owner, repo)}/pulls/${number}`,
      input
    );
  }
}

function repoPath(owner: string, repo: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * GitHub's error bodies are JSON with a `message` worth reading; anything else
 * is truncated so a stray HTML error page does not fill the terminal.
 */
function describeBody(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      const { message, errors } = parsed as { message?: unknown; errors?: unknown };
      const detail = Array.isArray(errors)
        ? errors
            .map((entry) =>
              entry && typeof entry === 'object' && 'message' in entry
                ? String((entry as { message: unknown }).message)
                : undefined
            )
            .filter(Boolean)
            .join('; ')
        : '';
      return detail ? `${String(message)} (${detail})` : String(message);
    }
  } catch {
    // Not JSON: fall through to the truncated raw body.
  }
  return raw.slice(0, 200);
}
