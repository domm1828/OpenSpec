/**
 * Minimal Trello REST client.
 *
 * Hand-rolled on `fetch` rather than pulled from an SDK: the sync touches nine
 * endpoints, and a dependency would add a supply-chain surface and a version to
 * track for no coverage this file does not already have.
 */

export interface TrelloCredentials {
  key: string;
  token: string;
}

export class TrelloApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string
  ) {
    super(message);
    this.name = 'TrelloApiError';
  }
}

/**
 * Token-bucket limiter sized to Trello's *token* budget, not its key budget.
 *
 * Trello allows 300 requests / 10s per API key and 100 requests / 10s per token.
 * Since every call this client makes carries the same token, the 100 ceiling is
 * the one that actually binds — pacing against 300 would earn a steady stream of
 * 429s. The margin below leaves room for clock skew and retries.
 */
const WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 90;

class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxPerWindow = MAX_REQUESTS_PER_WINDOW,
    private readonly windowMs = WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const cutoff = this.now() - this.windowMs;
      this.timestamps = this.timestamps.filter((t) => t > cutoff);

      if (this.timestamps.length < this.maxPerWindow) {
        this.timestamps.push(this.now());
        return;
      }

      const oldest = this.timestamps[0];
      await this.sleep(Math.max(1, oldest + this.windowMs - this.now()));
    }
  }
}

export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  closed: boolean;
  dateLastActivity: string;
  shortUrl?: string;
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state: 'complete' | 'incomplete';
  pos: number;
  idChecklist: string;
}

export interface TrelloChecklist {
  id: string;
  name: string;
  idCard: string;
  checkItems: TrelloCheckItem[];
}

export interface TrelloClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class TrelloClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly credentials: TrelloCredentials,
    options: TrelloClientOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? 'https://api.trello.com/1';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.limiter = new RateLimiter(MAX_REQUESTS_PER_WINDOW, WINDOW_MS, options.now, this.sleep);
  }

  private url(endpoint: string, params: Record<string, string | undefined> = {}): string {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    return url.toString();
  }

  /**
   * Issues one request, pacing against the rate limit and retrying 429/5xx.
   *
   * Retries only idempotent-by-effect failures: a 429 means the request was
   * rejected before it did anything, and a 5xx from Trello on these endpoints
   * has not been observed to half-apply. A 4xx other than 429 is a bug in the
   * caller's request and is surfaced immediately rather than retried.
   */
  private async request<T>(
    method: string,
    endpoint: string,
    params: Record<string, string | undefined> = {}
  ): Promise<T> {
    let lastError: TrelloApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();

      const response = await this.fetchImpl(this.url(endpoint, params), {
        method,
        headers: { Accept: 'application/json' },
      });

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      }

      const body = await response.text().catch(() => '');
      lastError = new TrelloApiError(
        `Trello ${method} ${endpoint} failed with ${response.status}: ${body.slice(0, 200)}`,
        response.status,
        endpoint
      );

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === this.maxRetries) break;

      // Trello does not send Retry-After on 429; back off exponentially from 1s.
      await this.sleep(1000 * 2 ** attempt);
    }

    throw lastError;
  }

  /**
   * Resolves a board reference to its canonical record.
   *
   * Accepts either form a user can paste: the 24-character id, or the short
   * link from the board URL (`trello.com/b/<shortLink>/name`). The distinction
   * matters — read endpoints accept both, but write endpoints that take a board
   * as a *parameter* (notably `POST /lists`, via `idBoard`) reject the short
   * link with a 400. Resolving once at link time keeps that asymmetry from
   * leaking into every later call.
   */
  async getBoard(boardId: string): Promise<{ id: string; name: string; closed: boolean }> {
    return this.request('GET', `/boards/${boardId}`, { fields: 'id,name,closed' });
  }

  async getBoardLists(boardId: string): Promise<TrelloList[]> {
    return this.request<TrelloList[]>('GET', `/boards/${boardId}/lists`, {
      fields: 'id,name,closed',
    });
  }

  /**
   * Creates a list on a board.
   *
   * `pos: 'bottom'` so repeated creations keep their given order instead of
   * stacking up in reverse, which is what `top` (Trello's other named position)
   * would produce.
   */
  async createList(boardId: string, name: string): Promise<TrelloList> {
    return this.request<TrelloList>('POST', '/lists', {
      name,
      idBoard: boardId,
      pos: 'bottom',
    });
  }

  /** Board cards with just enough fields to decide what changed. */
  async getBoardCards(boardId: string): Promise<TrelloCard[]> {
    return this.request<TrelloCard[]>('GET', `/boards/${boardId}/cards`, {
      fields: 'id,name,desc,idList,closed,dateLastActivity,shortUrl',
    });
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>('GET', `/cards/${cardId}`, {
      fields: 'id,name,desc,idList,closed,dateLastActivity,shortUrl',
    });
  }

  async createCard(input: {
    idList: string;
    name: string;
    desc?: string;
  }): Promise<TrelloCard> {
    return this.request<TrelloCard>('POST', '/cards', {
      idList: input.idList,
      name: input.name,
      desc: input.desc,
    });
  }

  async updateCard(
    cardId: string,
    input: { name?: string; desc?: string; idList?: string; closed?: boolean }
  ): Promise<TrelloCard> {
    return this.request<TrelloCard>('PUT', `/cards/${cardId}`, {
      name: input.name,
      desc: input.desc,
      idList: input.idList,
      closed: input.closed === undefined ? undefined : String(input.closed),
    });
  }

  async getCardChecklists(cardId: string): Promise<TrelloChecklist[]> {
    return this.request<TrelloChecklist[]>('GET', `/cards/${cardId}/checklists`);
  }

  async createChecklist(cardId: string, name: string): Promise<TrelloChecklist> {
    return this.request<TrelloChecklist>('POST', `/cards/${cardId}/checklists`, { name });
  }

  async createCheckItem(
    checklistId: string,
    input: { name: string; checked: boolean; pos?: number }
  ): Promise<TrelloCheckItem> {
    return this.request<TrelloCheckItem>('POST', `/checklists/${checklistId}/checkItems`, {
      name: input.name,
      checked: String(input.checked),
      pos: input.pos === undefined ? undefined : String(input.pos),
    });
  }

  /**
   * Updates a check item.
   *
   * Note the endpoint shape: Trello requires the *card* id here, not the
   * checklist id, and singular `checkItem`. Using the checklist-scoped path
   * (which exists for create and delete) returns 404 on update.
   */
  async updateCheckItem(
    cardId: string,
    checkItemId: string,
    input: { state?: 'complete' | 'incomplete'; name?: string; pos?: number }
  ): Promise<TrelloCheckItem> {
    return this.request<TrelloCheckItem>('PUT', `/cards/${cardId}/checkItem/${checkItemId}`, {
      state: input.state,
      name: input.name,
      pos: input.pos === undefined ? undefined : String(input.pos),
    });
  }

  async deleteCheckItem(checklistId: string, checkItemId: string): Promise<void> {
    await this.request<null>('DELETE', `/checklists/${checklistId}/checkItems/${checkItemId}`);
  }

  /** Verifies the credentials and returns the authenticated username. */
  async whoami(): Promise<{ id: string; username: string; fullName: string }> {
    return this.request('GET', '/members/me', { fields: 'id,username,fullName' });
  }
}
