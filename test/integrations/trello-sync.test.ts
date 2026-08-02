import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { TrelloClient } from '../../src/integrations/trello/client.js';
import { archiveTrelloCard, syncTrello } from '../../src/integrations/trello/sync.js';
import { IntegrationsConfigSchema, type TrelloConfig } from '../../src/integrations/config.js';
import { readAdapterState } from '../../src/integrations/state.js';

/**
 * An in-memory Trello, wired in as a `fetch` implementation.
 *
 * Exercises the client and the sync orchestration together against real files,
 * which is where the interesting bugs live: a reconciler that is correct on
 * plain objects can still address the wrong line once paths, globs and CRLF are
 * involved.
 */
class FakeTrello {
  lists = [
    { id: 'list-todo', name: 'To Do', closed: false },
    { id: 'list-doing', name: 'In Progress', closed: false },
    { id: 'list-review', name: 'Review', closed: false },
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

  private seq = 0;
  private id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  itemsFor(checklistId: string) {
    return this.checkItems.filter((item) => item.idChecklist === checklistId);
  }

  cardNamed(name: string) {
    return this.cards.find((card) => card.name === name);
  }

  checklistForCard(cardId: string) {
    return this.checklists.find((list) => list.idCard === cardId);
  }

  readonly fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const segments = url.pathname.replace(/^\/1\//, '').split('/');
    const param = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;

    const ok = (body: unknown): Response =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

    // GET /boards/{id}/lists
    if (method === 'GET' && segments[0] === 'boards' && segments[2] === 'lists') {
      return ok(this.lists);
    }

    // GET /boards/{id}/cards
    if (method === 'GET' && segments[0] === 'boards' && segments[2] === 'cards') {
      return ok(this.cards);
    }

    // POST /cards
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

    // PUT /cards/{id}/checkItem/{itemId}
    if (method === 'PUT' && segments[0] === 'cards' && segments[2] === 'checkItem') {
      const item = this.checkItems.find((i) => i.id === segments[3]);
      if (!item) return { ok: false, status: 404, text: async () => 'not found' } as Response;
      const state = param('state');
      if (state === 'complete' || state === 'incomplete') item.state = state;
      const name = param('name');
      if (name !== undefined) item.name = name;
      return ok(item);
    }

    // PUT /cards/{id}
    if (method === 'PUT' && segments[0] === 'cards' && segments.length === 2) {
      const card = this.cards.find((c) => c.id === segments[1]);
      if (!card) return { ok: false, status: 404, text: async () => 'not found' } as Response;
      const idList = param('idList');
      if (idList) card.idList = idList;
      const closed = param('closed');
      if (closed !== undefined) card.closed = closed === 'true';
      const name = param('name');
      if (name !== undefined) card.name = name;
      const desc = param('desc');
      if (desc !== undefined) card.desc = desc;
      return ok(card);
    }

    // GET /cards/{id}/checklists
    if (method === 'GET' && segments[0] === 'cards' && segments[2] === 'checklists') {
      const lists = this.checklists.filter((l) => l.idCard === segments[1]);
      return ok(lists.map((l) => ({ ...l, checkItems: this.itemsFor(l.id) })));
    }

    // POST /cards/{id}/checklists
    if (method === 'POST' && segments[0] === 'cards' && segments[2] === 'checklists') {
      const list = { id: this.id('checklist'), name: param('name') ?? '', idCard: segments[1] };
      this.checklists.push(list);
      return ok({ ...list, checkItems: [] });
    }

    // POST /checklists/{id}/checkItems
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

    // DELETE /checklists/{id}/checkItems/{itemId}
    if (method === 'DELETE' && segments[0] === 'checklists' && segments[2] === 'checkItems') {
      this.checkItems = this.checkItems.filter((i) => i.id !== segments[3]);
      return ok(null);
    }

    // GET /members/me
    if (segments[0] === 'members') {
      return ok({ id: 'me', username: 'tester', fullName: 'Test User' });
    }

    return { ok: false, status: 404, text: async () => `unhandled ${method} ${url.pathname}` } as Response;
  }) as unknown as typeof fetch;
}

const TASKS = [
  '# Tasks',
  '',
  '## 1. Bot skeleton',
  '- [x] 1.1 Add grammY dependency',
  '- [ ] 1.2 Wire long polling',
  '  - [ ] 1.2.1 Handle SIGINT',
  '',
].join('\n');

describe('syncTrello end to end', () => {
  let projectRoot: string;
  let changeDir: string;
  let tasksPath: string;
  let trello: FakeTrello;
  let client: TrelloClient;
  let config: TrelloConfig;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-trello-sync-'));
    changeDir = path.join(projectRoot, 'openspec', 'changes', 'add-telegram-bot');
    await fs.mkdir(changeDir, { recursive: true });

    tasksPath = path.join(changeDir, 'tasks.md');
    await fs.writeFile(tasksPath, TASKS, 'utf-8');
    await fs.writeFile(
      path.join(changeDir, 'proposal.md'),
      '# Proposal\n\nAdd a bot.\n',
      'utf-8'
    );

    trello = new FakeTrello();
    client = new TrelloClient({ key: 'k', token: 't' }, { fetchImpl: trello.fetchImpl });
    config = IntegrationsConfigSchema.parse({
      trello: {
        enabled: true,
        boardId: 'board-1',
        listMap: { proposed: 'list-todo', in_progress: 'list-doing', review: 'list-review' },
      },
    }).trello;
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const sync = (overrides: Partial<Parameters<typeof syncTrello>[0]> = {}) =>
    syncTrello({ projectRoot, config, client, ...overrides });

  it('creates a card and a checklist mirroring tasks.md', async () => {
    const report = await sync();

    expect(report.errors).toEqual([]);

    const card = trello.cardNamed('add-telegram-bot');
    expect(card).toBeDefined();

    const checklist = trello.checklistForCard(card!.id);
    expect(checklist?.name).toBe('Tasks');

    const items = trello.itemsFor(checklist!.id);
    expect(items.map((i) => i.name)).toEqual([
      '1.1 Add grammY dependency',
      '1.2 Wire long polling',
      '1.2.1 Handle SIGINT',
    ]);
    expect(items.map((i) => i.state)).toEqual(['complete', 'incomplete', 'incomplete']);
  });

  it('puts a partially-done change in the in-progress list when it creates the card', async () => {
    await sync();
    expect(trello.cardNamed('add-telegram-bot')!.idList).toBe('list-doing');
  });

  it('does not undo a manual drag under the default cardPlacement: once', async () => {
    // Dragging a card somewhere is a decision. A sync that silently reverts it
    // on the next run is what makes people stop trusting the integration.
    await sync();
    const card = trello.cardNamed('add-telegram-bot')!;
    card.idList = 'list-review';

    await sync();

    expect(card.idList).toBe('list-review');
  });

  it('re-derives the list on every sync under cardPlacement: always', async () => {
    config = { ...config, cardPlacement: 'always' };
    await sync();
    const card = trello.cardNamed('add-telegram-bot')!;
    card.idList = 'list-review';

    await sync();

    expect(card.idList).toBe('list-doing');
  });

  it('moves a card to the review list once every task is done, under always', async () => {
    config = { ...config, cardPlacement: 'always' };
    await sync();

    await fs.writeFile(tasksPath, TASKS.replace(/- \[ \]/g, '- [x]'), 'utf-8');
    await sync();

    expect(trello.cardNamed('add-telegram-bot')!.idList).toBe('list-review');
  });

  it('writes nothing at all on a dry run', async () => {
    const report = await sync({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(trello.cards).toEqual([]);
    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(TASKS);
    // No baseline either: a dry run must not convince the next real run that
    // the work already happened.
    const state = await readAdapterState(projectRoot, 'trello');
    expect(state.changes).toEqual({});
  });

  it('is idempotent — a second sync changes nothing', async () => {
    await sync();
    const itemsAfterFirst = JSON.parse(JSON.stringify(trello.checkItems));

    const second = await sync();

    expect(trello.checkItems).toEqual(itemsAfterFirst);
    expect(second.changes[0]).toMatchObject({ created: 0, updated: 0, deleted: 0 });
  });

  it('pulls a tick made in Trello back into tasks.md, touching only that line', async () => {
    await sync();

    const checklist = trello.checklistForCard(trello.cardNamed('add-telegram-bot')!.id)!;
    const item = trello.itemsFor(checklist.id).find((i) => i.name === '1.2 Wire long polling')!;
    item.state = 'complete';

    await sync();

    const after = await fs.readFile(tasksPath, 'utf-8');
    expect(after).toBe(TASKS.replace('- [ ] 1.2 Wire long polling', '- [x] 1.2 Wire long polling'));
  });

  it('pushes a tick made in tasks.md to the card', async () => {
    await sync();

    await fs.writeFile(
      tasksPath,
      TASKS.replace('  - [ ] 1.2.1 Handle SIGINT', '  - [x] 1.2.1 Handle SIGINT'),
      'utf-8'
    );

    await sync();

    const checklist = trello.checklistForCard(trello.cardNamed('add-telegram-bot')!.id)!;
    const item = trello.itemsFor(checklist.id).find((i) => i.name === '1.2.1 Handle SIGINT')!;
    expect(item.state).toBe('complete');
  });

  it('removes a check item when its line leaves tasks.md', async () => {
    await sync();

    await fs.writeFile(
      tasksPath,
      TASKS.replace('  - [ ] 1.2.1 Handle SIGINT\n', ''),
      'utf-8'
    );

    await sync();

    const checklist = trello.checklistForCard(trello.cardNamed('add-telegram-bot')!.id)!;
    expect(trello.itemsFor(checklist.id).map((i) => i.name)).toEqual([
      '1.1 Add grammY dependency',
      '1.2 Wire long polling',
    ]);
  });

  it('reports an item added in Trello without inventing a tasks.md line', async () => {
    await sync();

    const checklist = trello.checklistForCard(trello.cardNamed('add-telegram-bot')!.id)!;
    trello.checkItems.push({
      id: 'item-manual',
      name: 'Something a human added on the card',
      state: 'incomplete',
      pos: 9,
      idChecklist: checklist.id,
    });

    const report = await sync();

    expect(report.changes[0].remoteOnly).toEqual(['Something a human added on the card']);
    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(TASKS);
  });

  it('honours --direction push by never editing tasks.md', async () => {
    await sync();

    const checklist = trello.checklistForCard(trello.cardNamed('add-telegram-bot')!.id)!;
    trello.itemsFor(checklist.id).find((i) => i.name === '1.2 Wire long polling')!.state = 'complete';

    await sync({ direction: 'push' });

    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(TASKS);
  });

  it('honours --direction pull by never editing the card', async () => {
    await sync();

    await fs.writeFile(
      tasksPath,
      TASKS.replace('- [ ] 1.2 Wire long polling', '- [x] 1.2 Wire long polling'),
      'utf-8'
    );

    const checklist = trello.checklistForCard(trello.cardNamed('add-telegram-bot')!.id)!;
    const before = JSON.parse(JSON.stringify(trello.itemsFor(checklist.id)));

    await sync({ direction: 'pull' });

    expect(trello.itemsFor(checklist.id)).toEqual(before);
  });

  it('preserves CRLF line endings when pulling a remote tick', async () => {
    const crlf = TASKS.split('\n').join('\r\n');
    await fs.writeFile(tasksPath, crlf, 'utf-8');
    await sync();

    const checklist = trello.checklistForCard(trello.cardNamed('add-telegram-bot')!.id)!;
    trello.itemsFor(checklist.id).find((i) => i.name === '1.2 Wire long polling')!.state = 'complete';

    await sync();

    const after = await fs.readFile(tasksPath, 'utf-8');
    expect(after).toBe(crlf.replace('- [ ] 1.2 Wire long polling', '- [x] 1.2 Wire long polling'));
  });

  it('records a baseline with remote ids so the next run pairs by id', async () => {
    await sync();

    const state = await readAdapterState(projectRoot, 'trello');
    const entry = state.changes['add-telegram-bot'];

    expect(entry.remoteId).toBe(trello.cardNamed('add-telegram-bot')!.id);
    expect(Object.values(entry.tasks).every((task) => task.remoteId)).toBe(true);
    expect(entry.lastSyncedAt).toBeTruthy();
  });

  it('fails with a pointed message when no board is configured', async () => {
    await expect(
      syncTrello({ projectRoot, config: { ...config, boardId: undefined }, client })
    ).rejects.toThrow(/openspec trello link/);
  });

  it('reports what is wrong when the board has no lists to map', async () => {
    // A reachable board with zero columns: found against a real account, where
    // the old message sent the user back to `trello link`, which cannot fix it.
    const report = await sync({ config: { ...config, listMap: {} } });

    expect(report.changes[0].skipped).toContain('no Trello list mapped');
    expect(trello.cards).toEqual([]);
  });
});

describe('archiveTrelloCard', () => {
  let projectRoot: string;
  let trello: FakeTrello;
  let client: TrelloClient;
  let config: TrelloConfig;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-trello-archive-'));
    const changeDir = path.join(projectRoot, 'openspec', 'changes', 'add-telegram-bot');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'tasks.md'), TASKS, 'utf-8');

    trello = new FakeTrello();
    trello.lists.push({ id: 'list-archived', name: 'Archived', closed: false });
    client = new TrelloClient({ key: 'k', token: 't' }, { fetchImpl: trello.fetchImpl });
    config = IntegrationsConfigSchema.parse({
      trello: {
        enabled: true,
        boardId: 'board-1',
        listMap: {
          proposed: 'list-todo',
          in_progress: 'list-doing',
          review: 'list-review',
          archived: 'list-archived',
        },
      },
    }).trello;

    // Establish the card and the state entry the archive path reads from.
    await syncTrello({ projectRoot, config, client });
    // The change is archived: its directory leaves openspec/changes/.
    await fs.rm(changeDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const archive = (overrides: Partial<TrelloConfig> = {}) =>
    archiveTrelloCard({
      projectRoot,
      config: { ...config, ...overrides },
      client,
      changeId: 'add-telegram-bot',
    });

  it('a plain sync never touches an archived change, which is why this path exists', async () => {
    // readAllChangeSnapshots skips openspec/changes/archive/, so the card would
    // otherwise sit in whatever list it last occupied forever.
    const before = trello.cardNamed('add-telegram-bot')!.idList;
    await syncTrello({ projectRoot, config, client });
    expect(trello.cardNamed('add-telegram-bot')!.idList).toBe(before);
  });

  it('moves the card to the archived list by default', async () => {
    const result = await archive();

    expect(result.action).toBe('moved');
    expect(trello.cardNamed('add-telegram-bot')!.idList).toBe('list-archived');
  });

  it('closes the card under onArchive: close', async () => {
    const result = await archive({ onArchive: 'close' });

    expect(result.action).toBe('closed');
    expect(trello.cardNamed('add-telegram-bot')!.closed).toBe(true);
  });

  it('leaves the card alone under onArchive: nothing', async () => {
    const before = trello.cardNamed('add-telegram-bot')!.idList;
    const result = await archive({ onArchive: 'nothing' });

    expect(result.action).toBe('skipped');
    expect(trello.cardNamed('add-telegram-bot')!.idList).toBe(before);
    expect(trello.cardNamed('add-telegram-bot')!.closed).toBe(false);
  });

  it('explains itself instead of failing when no archived list is mapped', async () => {
    const result = await archive({ listMap: { ...config.listMap, archived: undefined } });

    expect(result.action).toBe('skipped');
    expect(result.reason).toContain('onArchive: close');
  });

  it('forgets the change so a reused id does not inherit a stale baseline', async () => {
    await archive();

    const state = await readAdapterState(projectRoot, 'trello');
    expect(state.changes['add-telegram-bot']).toBeUndefined();
  });

  it('keeps the state entry when the call fails, so it can be retried', async () => {
    const failing = new TrelloClient(
      { key: 'k', token: 't' },
      {
        fetchImpl: (async () =>
          ({ ok: false, status: 500, text: async () => 'boom' }) as Response) as unknown as typeof fetch,
        sleep: async () => {},
      }
    );

    const result = await archiveTrelloCard({
      projectRoot,
      config,
      client: failing,
      changeId: 'add-telegram-bot',
    });

    expect(result.action).toBe('skipped');
    const state = await readAdapterState(projectRoot, 'trello');
    expect(state.changes['add-telegram-bot']?.remoteId).toBeTruthy();
  });

  it('is a no-op for a change that never had a card', async () => {
    const result = await archiveTrelloCard({
      projectRoot,
      config,
      client,
      changeId: 'never-synced',
    });

    expect(result.action).toBe('skipped');
    expect(result.reason).toContain('no card');
  });
});
