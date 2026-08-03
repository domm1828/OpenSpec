import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  escapeMarkdownV2,
  truncateForTelegram,
  progressBar,
  MAX_MESSAGE_LENGTH,
} from '../../src/integrations/telegram/format.js';
import {
  createPairing,
  redeemPairing,
  generatePairingCode,
  getPairedChatIds,
  unpairChat,
  isAuthorized,
  PAIRING_CODE_TTL_MS,
} from '../../src/integrations/telegram/auth.js';
import {
  handleChanges,
  handleTasks,
  handleCheck,
  handleUncheck,
  handleStatus,
  handleArchive,
} from '../../src/integrations/telegram/commands.js';

describe('MarkdownV2 escaping', () => {
  it('escapes every character Telegram reserves', () => {
    // An unescaped reserved character makes Telegram reject the whole message
    // with a 400, so this is the difference between delivered and dropped.
    const reserved = '_*[]()~`>#+-=|{}.!\\';
    const escaped = escapeMarkdownV2(reserved);

    for (const char of reserved) {
      expect(escaped).toContain(`\\${char}`);
    }
  });

  it('escapes the punctuation that shows up in real task text', () => {
    expect(escapeMarkdownV2('1.2 Wire long-polling (see #42)!')).toBe(
      '1\\.2 Wire long\\-polling \\(see \\#42\\)\\!'
    );
  });

  it('leaves ordinary words alone', () => {
    expect(escapeMarkdownV2('Wire the client')).toBe('Wire the client');
  });
});

describe('truncateForTelegram', () => {
  it('leaves a short message untouched', () => {
    expect(truncateForTelegram('hello')).toBe('hello');
  });

  it('caps at the Telegram limit', () => {
    const long = 'x'.repeat(MAX_MESSAGE_LENGTH * 2);
    expect(truncateForTelegram(long).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it('prefers a line boundary when one is nearby', () => {
    const text = `${'a'.repeat(90)}\n${'b'.repeat(90)}`;
    const result = truncateForTelegram(text, 100);
    expect(result).toBe(`${'a'.repeat(90)}\n…`);
  });

  it('never leaves a dangling backslash that would escape the ellipsis', () => {
    // Cutting mid-escape-sequence produces exactly the 400 the escaping exists
    // to prevent.
    const text = `${'a'.repeat(97)}\\b`;
    const result = truncateForTelegram(text, 100);
    expect(result.replace(/\n…$/, '').endsWith('\\')).toBe(false);
  });
});

describe('progressBar', () => {
  it('reports the absence of tasks rather than an empty bar', () => {
    expect(progressBar(0, 0)).toBe('no tasks');
  });

  it('renders partial and full progress', () => {
    expect(progressBar(1, 4)).toBe('▰▱▱▱▱ 1/4');
    expect(progressBar(4, 4)).toBe('▰▰▰▰▰ 4/4');
  });
});

describe('pairing and authorization', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-telegram-auth-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('generates 8-digit codes that are not all identical', () => {
    const codes = new Set(Array.from({ length: 50 }, generatePairingCode));
    expect([...codes].every((code) => /^\d{8}$/.test(code))).toBe(true);
    // A CSPRNG must not collapse to a handful of values.
    expect(codes.size).toBeGreaterThan(40);
  });

  it('links a chat when the code matches', async () => {
    const pairing = await createPairing(projectRoot);
    const result = await redeemPairing(projectRoot, 12345, pairing.code);

    expect(result).toEqual({ ok: true, chatId: 12345 });
    expect(await getPairedChatIds(projectRoot)).toEqual([12345]);
  });

  it('rejects a wrong code without consuming the pairing', async () => {
    await createPairing(projectRoot);

    expect(await redeemPairing(projectRoot, 1, '00000000')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(await getPairedChatIds(projectRoot)).toEqual([]);
  });

  it('is single use — the same code cannot link a second chat', async () => {
    const pairing = await createPairing(projectRoot);
    await redeemPairing(projectRoot, 1, pairing.code);

    const second = await redeemPairing(projectRoot, 2, pairing.code);

    expect(second).toEqual({ ok: false, reason: 'no-pending' });
    expect(await getPairedChatIds(projectRoot)).toEqual([1]);
  });

  it('rejects an expired code', async () => {
    const issuedAt = new Date('2026-08-01T12:00:00Z');
    const pairing = await createPairing(projectRoot, issuedAt);

    const tooLate = new Date(issuedAt.getTime() + PAIRING_CODE_TTL_MS + 1000);
    expect(await redeemPairing(projectRoot, 1, pairing.code, tooLate)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects when nothing is pending', async () => {
    expect(await redeemPairing(projectRoot, 1, '12345678')).toEqual({
      ok: false,
      reason: 'no-pending',
    });
  });

  it('revokes a paired chat', async () => {
    const pairing = await createPairing(projectRoot);
    await redeemPairing(projectRoot, 7, pairing.code);

    expect(await unpairChat(projectRoot, 7)).toBe(true);
    expect(await getPairedChatIds(projectRoot)).toEqual([]);
  });

  it('fails closed when nothing is configured or paired', () => {
    // An empty allowlist meaning "allow everyone" would turn a leaked bot token
    // into anonymous write access to the repo.
    expect(isAuthorized(999, [], [])).toBe(false);
  });

  it('authorizes from either the config list or a pairing', () => {
    expect(isAuthorized(1, [1], [])).toBe(true);
    expect(isAuthorized(2, [1], [2])).toBe(true);
    expect(isAuthorized(3, [1], [2])).toBe(false);
  });
});

describe('bot commands', () => {
  let projectRoot: string;
  let tasksPath: string;

  const TASKS = [
    '# Tasks',
    '',
    '- [x] 1.1 Add grammY dependency',
    '- [ ] 1.2 Wire long polling',
    '- [ ] 1.3 Add the chat allowlist',
    '',
  ].join('\n');

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-telegram-cmd-'));
    const changeDir = path.join(projectRoot, 'openspec', 'changes', 'add-telegram-bot');
    await fs.mkdir(changeDir, { recursive: true });
    tasksPath = path.join(changeDir, 'tasks.md');
    await fs.writeFile(tasksPath, TASKS, 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const ctx = (args: string[] = []) => ({
    projectRoot,
    chatId: 1,
    args,
    rest: args.join(' '),
  });

  it('lists active changes with progress', async () => {
    const reply = await handleChanges(ctx());
    // The id is rendered as a code span, where `-` needs no escaping.
    expect(reply.text).toContain('`add-telegram-bot`');
    expect(reply.text).toContain('1/3');
  });

  it('numbers tasks with a bracketed handle, distinct from the outline numbers', async () => {
    const reply = await handleTasks(ctx(['add-telegram-bot']));
    expect(reply.text).toContain('\\[1\\] ✅ 1\\.1 Add grammY dependency');
    expect(reply.text).toContain('\\[2\\] ⬜ 1\\.2 Wire long polling');
  });

  it('resolves an unambiguous change-id prefix', async () => {
    const reply = await handleTasks(ctx(['add-tele']));
    expect(reply.text).toContain('Wire long polling');
  });

  it('ticks a task and writes only that line', async () => {
    const reply = await handleCheck(ctx(['add-telegram-bot', '2']));

    expect(reply.text).toContain('2/3');
    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(
      TASKS.replace('- [ ] 1.2 Wire long polling', '- [x] 1.2 Wire long polling')
    );
  });

  it('unticks a task', async () => {
    await handleUncheck(ctx(['add-telegram-bot', '1']));
    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(
      TASKS.replace('- [x] 1.1 Add grammY dependency', '- [ ] 1.1 Add grammY dependency')
    );
  });

  it('refuses an out-of-range task number without touching the file', async () => {
    const reply = await handleCheck(ctx(['add-telegram-bot', '99']));

    expect(reply.text).toContain('out of range');
    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(TASKS);
  });

  it('rejects a non-numeric task number', async () => {
    const reply = await handleCheck(ctx(['add-telegram-bot', 'two']));
    expect(reply.text).toContain('Usage');
    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(TASKS);
  });

  it('says so when the task is already in the requested state', async () => {
    const reply = await handleCheck(ctx(['add-telegram-bot', '1']));
    expect(reply.text).toContain('Already done');
    expect(await fs.readFile(tasksPath, 'utf-8')).toBe(TASKS);
  });

  it('reports an unknown change instead of guessing', async () => {
    const reply = await handleTasks(ctx(['nope']));
    expect(reply.text).toContain('No change named');
  });

  it('summarizes the project', async () => {
    const reply = await handleStatus(ctx());
    expect(reply.text).toContain('1 active change');
    expect(reply.text).toContain('1/3');
  });

  it('asks for confirmation before archiving, and warns about open tasks', async () => {
    const reply = await handleArchive(ctx(['add-telegram-bot']));

    expect(reply.confirm).toEqual({ action: 'archive', changeId: 'add-telegram-bot' });
    expect(reply.text).toContain('2 task');
  });
});
