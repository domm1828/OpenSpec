import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { TrelloClient } from '../../src/integrations/trello/client.js';
import { TrelloAdapter } from '../../src/integrations/trello/adapter.js';
import { archiveTrelloCard, syncTrello } from '../../src/integrations/trello/sync.js';
import { IntegrationsConfigSchema, type TrelloConfig } from '../../src/integrations/config.js';
import { readAdapterState } from '../../src/integrations/state.js';
import type { OpenSpecEvent } from '../../src/integrations/types.js';

/**
 * A pull request has to land on the change's existing card.
 *
 * The hard part is not the attachment, it is finding the card: archiving drops
 * the recorded card id on purpose, and event dispatch is concurrent, so the
 * announcement can arrive after the id is gone and the card has been closed.
 * These tests pin the property that makes that survivable — the card is found by
 * name, and the outcome does not depend on which adapter finishes first.
 */

class FakeTrello {
  lists = [
    { id: 'list-todo', name: 'To Do', closed: false },
    { id: 'list-review', name: 'Review', closed: false },
    { id: 'list-archived', name: 'Archived', closed: false },
  ];
  cards: Array<{
    id: string;
    name: string;
    desc: string;
    idList: string;
    closed: boolean;
    dateLastActivity: string;
    shortUrl: string;
  }> = [];
  checklists: Array<{ id: string; name: string; idCard: string }> = [];
  checkItems: Array<{
    id: string;
    name: string;
    state: 'complete' | 'incomplete';
    pos: number;
    idChecklist: string;
  }> = [];
  attachments: Array<{ cardId: string; url: string; name?: string }> = [];
  comments: Array<{ cardId: string; text: string }> = [];
  /** Every card listing, with the filter it asked for. */
  cardQueries: Array<string | null> = [];

  private seq = 0;
  private id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  cardNamed(name: string) {
    return this.cards.find((card) => card.name === name);
  }

  readonly fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const segments = url.pathname.replace(/^\/1\//, '').split('/');
    const param = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;

    const ok = (body: unknown): Response =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

    if (method === 'GET' && segments[0] === 'boards' && segments[2] === 'lists') {
      return ok(this.lists);
    }

    if (method === 'GET' && segments[0] === 'boards' && segments[2] === 'cards') {
      const filter = url.searchParams.get('filter');
      this.cardQueries.push(filter);
      // Trello's own default is open cards only; the fake has to behave the same
      // or the test would pass for the wrong reason.
      return ok(filter === 'all' ? this.cards : this.cards.filter((card) => !card.closed));
    }

    if (method === 'POST' && segments[0] === 'cards' && segments.length === 1) {
      const card = {
        id: this.id('card'),
        name: param('name') ?? '',
        desc: param('desc') ?? '',
        idList: param('idList') ?? '',
        closed: false,
        dateLastActivity: '2026-08-01T00:00:00.000Z',
        shortUrl: `https://trello.com/c/${this.seq}`,
      };
      this.cards.push(card);
      return ok(card);
    }

    if (method === 'PUT' && segments[0] === 'cards' && segments.length === 2) {
      const card = this.cards.find((c) => c.id === segments[1]);
      if (!card) return { ok: false, status: 404, text: async () => 'not found' } as Response;
      const idList = param('idList');
      if (idList) card.idList = idList;
      const closed = param('closed');
      if (closed !== undefined) card.closed = closed === 'true';
      return ok(card);
    }

    if (method === 'POST' && segments[0] === 'cards' && segments[2] === 'attachments') {
      this.attachments.push({ cardId: segments[1], url: param('url') ?? '', name: param('name') });
      return ok({ id: this.id('attachment') });
    }

    if (method === 'POST' && segments[0] === 'cards' && segments[2] === 'actions') {
      this.comments.push({ cardId: segments[1], text: param('text') ?? '' });
      return ok({ id: this.id('comment') });
    }

    if (method === 'GET' && segments[0] === 'cards' && segments[2] === 'checklists') {
      const lists = this.checklists.filter((l) => l.idCard === segments[1]);
      return ok(
        lists.map((l) => ({
          ...l,
          checkItems: this.checkItems.filter((item) => item.idChecklist === l.id),
        }))
      );
    }

    if (method === 'POST' && segments[0] === 'cards' && segments[2] === 'checklists') {
      const list = { id: this.id('checklist'), name: param('name') ?? '', idCard: segments[1] };
      this.checklists.push(list);
      return ok({ ...list, checkItems: [] });
    }

    if (method === 'POST' && segments[0] === 'checklists' && segments[2] === 'checkItems') {
      const item = {
        id: this.id('item'),
        name: param('name') ?? '',
        state: param('checked') === 'true' ? ('complete' as const) : ('incomplete' as const),
        pos: Number(param('pos') ?? 1),
        idChecklist: segments[1],
      };
      this.checkItems.push(item);
      return ok(item);
    }

    if (segments[0] === 'members') {
      return ok({ id: 'me', username: 'tester', fullName: 'Test User' });
    }

    return {
      ok: false,
      status: 404,
      text: async () => `unhandled ${method} ${url.pathname}`,
    } as Response;
  }) as unknown as typeof fetch;
}

const CHANGE = 'add-auth';

const prOpened = (): OpenSpecEvent => ({
  type: 'vcs.pr.opened',
  changeId: CHANGE,
  at: '2026-08-02T00:00:00.000Z',
  meta: {
    url: 'https://github.com/domm1828/OpenSpec/pull/7',
    number: 7,
    branch: 'feature/add-auth',
    base: 'develop',
  },
});

describe('a pull request lands on the change’s existing card', () => {
  let projectRoot: string;
  let trello: FakeTrello;
  let client: TrelloClient;
  let config: TrelloConfig;

  async function makeAdapter(): Promise<TrelloAdapter> {
    const adapter = new TrelloAdapter(config, { client });
    await adapter.init({
      projectRoot,
      config,
      log: () => {},
      now: () => '2026-08-02T00:00:00.000Z',
    });
    return adapter;
  }

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-gh-trello-'));
    const changeDir = path.join(projectRoot, 'openspec', 'changes', CHANGE);
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [x] 1.1 Wire the form\n', 'utf-8');

    trello = new FakeTrello();
    client = new TrelloClient({ key: 'k', token: 't' }, { fetchImpl: trello.fetchImpl });
    config = IntegrationsConfigSchema.parse({
      trello: {
        enabled: true,
        boardId: 'board-1',
        listMap: { proposed: 'list-todo', review: 'list-review', archived: 'list-archived' },
      },
    }).trello;

    await syncTrello({ projectRoot, config, client });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('attaches the pull request to the card, without creating a second one', async () => {
    const adapter = await makeAdapter();
    const before = trello.cards.length;

    await adapter.onEvent(prOpened());

    expect(trello.cards).toHaveLength(before);
    expect(trello.attachments).toHaveLength(1);
    expect(trello.attachments[0]).toMatchObject({
      cardId: trello.cardNamed(CHANGE)!.id,
      url: 'https://github.com/domm1828/OpenSpec/pull/7',
      name: 'Pull request #7',
    });
    expect(trello.comments[0].text).toContain('feature/add-auth');
  });

  it('finds the card after archiving forgot its id', async () => {
    // archiveTrelloCard drops the state entry by design, so the announcement has
    // nothing but the change id to go on.
    await archiveTrelloCard({ projectRoot, config, client, changeId: CHANGE });

    const state = await readAdapterState(projectRoot, 'trello');
    expect(state.changes[CHANGE]).toBeUndefined();

    const adapter = await makeAdapter();
    await adapter.onEvent(prOpened());

    expect(trello.attachments[0].cardId).toBe(trello.cardNamed(CHANGE)!.id);
  });

  it('finds the card even when Trello has closed it', async () => {
    await archiveTrelloCard({
      projectRoot,
      config: { ...config, onArchive: 'close' },
      client,
      changeId: CHANGE,
    });
    expect(trello.cardNamed(CHANGE)!.closed).toBe(true);

    const adapter = await makeAdapter();
    await adapter.onEvent(prOpened());

    // The lookup had to ask for closed cards; the default filter would have
    // missed this one entirely.
    expect(trello.cardQueries).toContain('all');
    expect(trello.attachments).toHaveLength(1);
  });

  it('does nothing when the change has no card at all', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent({ ...prOpened(), changeId: 'never-synced' });

    expect(trello.attachments).toHaveLength(0);
    expect(trello.cards).toHaveLength(1);
  });

  it('records the branch on the card when one is created', async () => {
    const adapter = await makeAdapter();
    await adapter.onEvent({
      type: 'vcs.branch.created',
      changeId: CHANGE,
      at: '2026-08-02T00:00:00.000Z',
      meta: { branch: 'feature/add-auth', base: 'develop' },
    });

    expect(trello.comments[0].text).toContain('feature/add-auth');
    expect(trello.attachments).toHaveLength(0);
  });
});
