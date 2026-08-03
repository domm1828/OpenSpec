import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { runWatchPass, primeWatchSnapshot } from '../../src/integrations/watcher.js';
import type { LoadedAdapter } from '../../src/integrations/registry.js';
import type {
  HealthReport,
  IntegrationAdapter,
  IntegrationContext,
  OpenSpecEvent,
} from '../../src/integrations/types.js';

class RecordingAdapter implements IntegrationAdapter {
  readonly id = 'recorder';
  readonly seen: OpenSpecEvent[] = [];
  shouldThrow = false;

  async init(): Promise<void> {}

  async onEvent(event: OpenSpecEvent): Promise<void> {
    if (this.shouldThrow) throw new Error('adapter is down');
    this.seen.push(event);
  }

  async healthcheck(): Promise<HealthReport> {
    return { id: this.id, level: 'ok', message: 'fine' };
  }
}

describe('watcher', () => {
  let projectRoot: string;
  let changeDir: string;
  let tasksPath: string;
  let adapter: RecordingAdapter;
  let adapters: LoadedAdapter[];

  const TASKS = ['# Tasks', '', '- [ ] 1.1 First', '- [ ] 1.2 Second', ''].join('\n');

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-watcher-'));
    changeDir = path.join(projectRoot, 'openspec', 'changes', 'add-auth');
    await fs.mkdir(changeDir, { recursive: true });
    tasksPath = path.join(changeDir, 'tasks.md');
    await fs.writeFile(tasksPath, TASKS, 'utf-8');

    adapter = new RecordingAdapter();
    const context: IntegrationContext = {
      projectRoot,
      config: {},
      log: () => {},
      now: () => '2026-08-01T00:00:00.000Z',
    };
    adapters = [{ adapter, context }];
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('reports an unseen change as created on the first pass', async () => {
    const events = await runWatchPass({ projectRoot, adapters });

    expect(events.map((e) => e.type)).toEqual(['change.created']);
    expect(adapter.seen).toHaveLength(1);
  });

  it('priming suppresses the first-run flood', async () => {
    // Without this, adopting the watcher in an established project fires one
    // notification per existing change before anything has actually happened.
    const primed = await primeWatchSnapshot(projectRoot);
    expect(primed).toBe(1);

    const events = await runWatchPass({ projectRoot, adapters });
    expect(events).toEqual([]);
  });

  it('detects a checkbox flipped outside the CLI', async () => {
    // The whole reason the watcher exists: the agent edits Markdown directly,
    // so no command hook ever fires for this.
    await primeWatchSnapshot(projectRoot);

    await fs.writeFile(tasksPath, TASKS.replace('- [ ] 1.2 Second', '- [x] 1.2 Second'), 'utf-8');

    const events = await runWatchPass({ projectRoot, adapters });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.checked');
    expect(events[0].task?.description).toBe('1.2 Second');
  });

  it('emits nothing when nothing moved', async () => {
    await runWatchPass({ projectRoot, adapters });
    const second = await runWatchPass({ projectRoot, adapters });
    expect(second).toEqual([]);
  });

  it('reports a deleted change directory as archived', async () => {
    await primeWatchSnapshot(projectRoot);
    await fs.rm(changeDir, { recursive: true, force: true });

    const events = await runWatchPass({ projectRoot, adapters });
    expect(events.map((e) => e.type)).toEqual(['change.archived']);
  });

  it('still advances the snapshot when an adapter throws', async () => {
    await primeWatchSnapshot(projectRoot);
    adapter.shouldThrow = true;

    await fs.writeFile(tasksPath, TASKS.replace('- [ ] 1.1 First', '- [x] 1.1 First'), 'utf-8');

    const messages: string[] = [];
    const first = await runWatchPass({ projectRoot, adapters, log: (m) => messages.push(m) });

    expect(first.map((e) => e.type)).toEqual(['task.checked']);
    expect(messages.join(' ')).toContain('adapter is down');

    // The failure is reported, not retried forever: a permanently broken
    // adapter must not pin the watcher to the same event on every pass.
    adapter.shouldThrow = false;
    expect(await runWatchPass({ projectRoot, adapters })).toEqual([]);
  });

  it('survives a project with no openspec directory at all', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-watcher-empty-'));
    try {
      expect(await runWatchPass({ projectRoot: empty, adapters })).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
