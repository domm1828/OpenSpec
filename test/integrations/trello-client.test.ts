import { describe, it, expect, vi } from 'vitest';
import { TrelloClient, TrelloApiError } from '../../src/integrations/trello/client.js';

interface FakeResponse {
  status: number;
  body?: unknown;
}

function fakeFetch(responses: FakeResponse[]): {
  impl: typeof fetch;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  let index = 0;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    const next = responses[Math.min(index++, responses.length - 1)];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    } as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const CREDS = { key: 'test-key', token: 'test-token' };

describe('TrelloClient', () => {
  it('puts credentials on the query string, never in a header', () => {
    // Trello authenticates via key/token query params; a bearer header is
    // silently ignored and every call comes back 401.
    const { impl, calls } = fakeFetch([{ status: 200, body: [] }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl });

    return client.getBoardLists('board1').then(() => {
      const url = new URL(calls[0].url);
      expect(url.searchParams.get('key')).toBe('test-key');
      expect(url.searchParams.get('token')).toBe('test-token');
      expect(url.pathname).toBe('/1/boards/board1/lists');
    });
  });

  it('omits undefined params instead of sending the string "undefined"', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { id: 'c1' } }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl });

    await client.createCard({ idList: 'l1', name: 'change-a' });

    const url = new URL(calls[0].url);
    expect(url.searchParams.has('desc')).toBe(false);
    expect(url.searchParams.get('name')).toBe('change-a');
  });

  it('retries a 429 and succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = fakeFetch([
      { status: 429 },
      { status: 429 },
      { status: 200, body: [{ id: 'l1', name: 'To Do', closed: false }] },
    ]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl, sleep });

    const lists = await client.getBoardLists('board1');

    expect(lists).toHaveLength(1);
    expect(calls).toHaveLength(3);
    // Exponential backoff: 1s then 2s.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('retries a 5xx', async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = fakeFetch([{ status: 503 }, { status: 200, body: [] }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl, sleep });

    await client.getBoardLists('board1');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 401 — a bad token will not fix itself', async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = fakeFetch([{ status: 401, body: 'invalid token' }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl, sleep });

    await expect(client.getBoardLists('board1')).rejects.toBeInstanceOf(TrelloApiError);
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxRetries and surfaces the status', async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = fakeFetch([{ status: 429 }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl, sleep, maxRetries: 2 });

    await expect(client.getBoardLists('board1')).rejects.toMatchObject({
      status: 429,
      endpoint: '/boards/board1/lists',
    });
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it('paces requests against the 100-per-10s token budget', async () => {
    // The client caps at 90/10s. Request 91 must wait rather than earn a 429.
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const { impl } = fakeFetch([{ status: 200, body: [] }]);
    const client = new TrelloClient(CREDS, {
      fetchImpl: impl,
      sleep,
      now: () => clock,
    });

    for (let i = 0; i < 90; i++) await client.getBoardLists('b');
    expect(sleep).not.toHaveBeenCalled();

    await client.getBoardLists('b');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it('uses the card-scoped path when updating a check item', async () => {
    // Trello's checklist-scoped path exists for create and delete but 404s on
    // update; only /cards/{id}/checkItem/{id} works.
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl });

    await client.updateCheckItem('card1', 'item1', { state: 'complete' });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/1/cards/card1/checkItem/item1');
    expect(calls[0].method).toBe('PUT');
    expect(url.searchParams.get('state')).toBe('complete');
  });

  it('resolves a board short link to its canonical 24-character id', async () => {
    // Found against the real API: read endpoints accept the short link from a
    // board URL, but `POST /lists` rejects it as `idBoard` with
    // "invalid value for idBoard". `trello link` resolves once and persists the
    // canonical id, so a config that reads fine cannot fail on the first write.
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: '6a6f95ebe77da03bcd1caf80', name: 'My Board', closed: false } },
    ]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl });

    const board = await client.getBoard('b0nmAtC9');

    expect(board.id).toBe('6a6f95ebe77da03bcd1caf80');
    expect(board.id).not.toBe('b0nmAtC9');
    expect(new URL(calls[0].url).pathname).toBe('/1/boards/b0nmAtC9');
  });

  it('creates a list at the bottom so repeated creations keep their order', async () => {
    // `top` would stack them in reverse, producing Archived/Review/Doing/To Do.
    const { impl, calls } = fakeFetch([{ status: 200, body: { id: 'l1', name: 'To Do' } }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl });

    await client.createList('board1', 'To Do');

    const url = new URL(calls[0].url);
    expect(calls[0].method).toBe('POST');
    expect(url.pathname).toBe('/1/lists');
    expect(url.searchParams.get('idBoard')).toBe('board1');
    expect(url.searchParams.get('name')).toBe('To Do');
    expect(url.searchParams.get('pos')).toBe('bottom');
  });

  it('returns an empty array for a board with no lists, rather than failing', async () => {
    // A real, reachable board can legitimately have zero columns; that must
    // surface as "nothing to map", not as an API error.
    const { impl } = fakeFetch([{ status: 200, body: [] }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl });

    await expect(client.getBoardLists('empty-board')).resolves.toEqual([]);
  });

  it('treats an empty body as null rather than throwing on JSON.parse', async () => {
    // DELETE returns 200 with no body.
    const { impl } = fakeFetch([{ status: 200 }]);
    const client = new TrelloClient(CREDS, { fetchImpl: impl });

    await expect(client.deleteCheckItem('cl1', 'item1')).resolves.toBeUndefined();
  });
});
