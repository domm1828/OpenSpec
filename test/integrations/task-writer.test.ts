import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { toggleCheckboxInLine, applyCheckboxEdits } from '../../src/integrations/task-writer.js';

describe('toggleCheckboxInLine', () => {
  it('checks an unchecked box', () => {
    expect(toggleCheckboxInLine('- [ ] Wire the client', true)).toBe('- [x] Wire the client');
  });

  it('unchecks a checked box, including uppercase X', () => {
    expect(toggleCheckboxInLine('- [x] Wire the client', false)).toBe('- [ ] Wire the client');
    expect(toggleCheckboxInLine('- [X] Wire the client', false)).toBe('- [ ] Wire the client');
  });

  it('preserves indentation and the bullet character', () => {
    expect(toggleCheckboxInLine('    * [ ] 1.1.1 Nested', true)).toBe('    * [x] 1.1.1 Nested');
  });

  it('preserves the trailing carriage return of a CRLF file', () => {
    // The reader splits on \n, so on CRLF input every line still carries \r.
    // Dropping it here would rewrite the whole file's line endings.
    expect(toggleCheckboxInLine('- [ ] Task\r', true)).toBe('- [x] Task\r');
  });

  it('is a no-op when the box already has the requested state', () => {
    expect(toggleCheckboxInLine('- [x] Task', true)).toBe('- [x] Task');
  });

  it('returns null for a line with no checkbox', () => {
    expect(toggleCheckboxInLine('## Tasks', true)).toBeNull();
    expect(toggleCheckboxInLine('- plain bullet', true)).toBeNull();
  });
});

describe('applyCheckboxEdits', () => {
  let dir: string;
  let file: string;

  const CONTENT = [
    '# Tasks',
    '',
    '## 1. Setup',
    '- [ ] 1.1 Install deps',
    '- [x] 1.2 Configure lint',
    '  - [ ] 1.2.1 Nested detail',
    '',
    'Some prose the agent wrote.',
    '',
  ].join('\n');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-task-writer-'));
    file = path.join(dir, 'tasks.md');
    await fs.writeFile(file, CONTENT, 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('flips one checkbox and leaves every other byte alone', async () => {
    const outcomes = await applyCheckboxEdits([{ filePath: file, lineIndex: 3, done: true }]);

    expect(outcomes).toEqual([{ status: 'written', filePath: file, lineIndex: 3 }]);

    const after = await fs.readFile(file, 'utf-8');
    expect(after).toBe(CONTENT.replace('- [ ] 1.1 Install deps', '- [x] 1.1 Install deps'));
  });

  it('reports unchanged without writing when the state already matches', async () => {
    const before = await fs.stat(file);
    const outcomes = await applyCheckboxEdits([{ filePath: file, lineIndex: 4, done: true }]);

    expect(outcomes[0].status).toBe('unchanged');
    expect((await fs.readFile(file, 'utf-8'))).toBe(CONTENT);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('skips instead of writing when the line no longer matches the snapshot', async () => {
    const outcomes = await applyCheckboxEdits([
      {
        filePath: file,
        lineIndex: 3,
        done: true,
        expectedDescription: '1.1 Install dependencies',
      },
    ]);

    expect(outcomes[0].status).toBe('skipped');
    expect(outcomes[0]).toHaveProperty('reason', expect.stringContaining('changed since the last sync'));
    expect(await fs.readFile(file, 'utf-8')).toBe(CONTENT);
  });

  it('accepts a matching expectedDescription', async () => {
    const outcomes = await applyCheckboxEdits([
      { filePath: file, lineIndex: 3, done: true, expectedDescription: '1.1 Install deps' },
    ]);
    expect(outcomes[0].status).toBe('written');
  });

  it('skips a line index past the end of the file', async () => {
    const outcomes = await applyCheckboxEdits([{ filePath: file, lineIndex: 999, done: true }]);
    expect(outcomes[0].status).toBe('skipped');
    expect(await fs.readFile(file, 'utf-8')).toBe(CONTENT);
  });

  it('skips a line that is not a task', async () => {
    const outcomes = await applyCheckboxEdits([{ filePath: file, lineIndex: 7, done: true }]);
    expect(outcomes[0]).toMatchObject({ status: 'skipped', reason: 'line has no checkbox' });
  });

  it('skips every edit for an unreadable file rather than throwing', async () => {
    const missing = path.join(dir, 'nope.md');
    const outcomes = await applyCheckboxEdits([{ filePath: missing, lineIndex: 0, done: true }]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('skipped');
  });

  it('applies several edits to the same file in one write', async () => {
    const outcomes = await applyCheckboxEdits([
      { filePath: file, lineIndex: 3, done: true },
      { filePath: file, lineIndex: 5, done: true },
      { filePath: file, lineIndex: 4, done: false },
    ]);

    expect(outcomes.every((o) => o.status === 'written')).toBe(true);

    const after = await fs.readFile(file, 'utf-8');
    expect(after).toContain('- [x] 1.1 Install deps');
    expect(after).toContain('- [ ] 1.2 Configure lint');
    expect(after).toContain('  - [x] 1.2.1 Nested detail');
    expect(after).toContain('Some prose the agent wrote.');
  });

  it('round-trips a CRLF file without converting line endings', async () => {
    const crlf = CONTENT.split('\n').join('\r\n');
    await fs.writeFile(file, crlf, 'utf-8');

    await applyCheckboxEdits([{ filePath: file, lineIndex: 3, done: true }]);

    const after = await fs.readFile(file, 'utf-8');
    expect(after).toBe(crlf.replace('- [ ] 1.1 Install deps', '- [x] 1.1 Install deps'));
    expect(after).not.toContain('\n\n'); // no bare LF introduced
  });
});
