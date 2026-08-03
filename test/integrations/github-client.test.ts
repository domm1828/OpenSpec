import { describe, it, expect, vi } from 'vitest';
import { GitHubClient, GitHubApiError } from '../../src/integrations/github/client.js';

interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fakeFetch(responses: FakeResponse[]): {
  impl: typeof fetch;
  calls: Array<{ url: string; method: string; body?: unknown; headers: Record<string, string> }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    body?: unknown;
    headers: Record<string, string>;
  }> = [];
  let index = 0;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    const next = responses[Math.min(index++, responses.length - 1)];
    const headers = new Map(Object.entries(next.headers ?? {}));

    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

describe('GitHubClient', () => {
  it('authenticates with a bearer token and pins the API version', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { login: 'domm1828' } }]);
    const client = new GitHubClient('tok', { fetchImpl: impl });

    await client.whoami();

    expect(calls[0].url).toBe('https://api.github.com/user');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    // GitHub rejects requests without one.
    expect(calls[0].headers['User-Agent']).toBeTruthy();
  });

  it('honours Retry-After on a 403 secondary rate limit instead of giving up', async () => {
    // A 403 that carries Retry-After is a throttle, not a permission problem.
    // Treating every 403 as fatal abandons a request that would have worked.
    const sleep = vi.fn(async () => {});
    const { impl, calls } = fakeFetch([
      { status: 403, headers: { 'retry-after': '2' } },
      { status: 200, body: { login: 'domm1828' } },
    ]);
    const client = new GitHubClient('tok', { fetchImpl: impl, sleep });

    await client.whoami();

    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('waits until the reset when the primary budget is exhausted', async () => {
    const sleep = vi.fn(async () => {});
    const now = () => 1_000_000;
    const { impl } = fakeFetch([
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1_000_000 / 1000 + 30) },
      },
      { status: 200, body: { login: 'domm1828' } },
    ]);
    const client = new GitHubClient('tok', { fetchImpl: impl, sleep, now });

    await client.whoami();

    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('does not retry a 403 that is a real permission problem', async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = fakeFetch([
      { status: 403, body: { message: 'Resource not accessible by personal access token' } },
    ]);
    const client = new GitHubClient('tok', { fetchImpl: impl, sleep });

    await expect(client.whoami()).rejects.toBeInstanceOf(GitHubApiError);
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reads GitHub’s message out of the error body', async () => {
    const { impl } = fakeFetch([
      {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ message: 'No commits between develop and feature/add-auth' }],
        },
      },
    ]);
    const client = new GitHubClient('tok', { fetchImpl: impl, maxRetries: 0 });

    await expect(
      client.createPullRequest('o', 'r', { title: 't', head: 'h', base: 'b' })
    ).rejects.toThrow(/No commits between develop and feature\/add-auth/);
  });

  it('treats a 404 from getBranch as "no such branch", not an error', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { message: 'Branch not found' } }]);
    const client = new GitHubClient('tok', { fetchImpl: impl });

    await expect(client.getBranch('o', 'r', 'develop')).resolves.toBeNull();
  });

  it('asks for closed pull requests too, so a branch never gets a second one', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: [] }]);
    const client = new GitHubClient('tok', { fetchImpl: impl });

    await client.findPullRequests('domm1828', 'OpenSpec', 'feature/add-auth');

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('state')).toBe('all');
    expect(url.searchParams.get('head')).toBe('domm1828:feature/add-auth');
  });

  it('respects a custom base URL, for GitHub Enterprise', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { login: 'x' } }]);
    const client = new GitHubClient('tok', {
      fetchImpl: impl,
      baseUrl: 'https://github.acme.com/api/v3/',
    });

    await client.whoami();

    expect(calls[0].url).toBe('https://github.acme.com/api/v3/user');
  });
});
