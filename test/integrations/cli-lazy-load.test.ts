import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../helpers/run-cli.js';

/**
 * The integrations layer must cost nothing when it is not being used.
 *
 * `src/commands/integrations.ts` is imported by every `openspec` invocation in
 * order to register its commands. When it imported the Telegram adapter
 * statically, grammY came with it — and grammY pulls in Node's deprecated
 * `punycode` module, which prints a `DEP0040` warning to stderr on startup.
 *
 * That broke a contract this repo states explicitly: a `--json` run leaves
 * exactly one JSON document on stdout and nothing on stderr, because an agent
 * is parsing it. A stray deprecation warning is not cosmetic there.
 *
 * Enabling an integration must not change that for unrelated commands.
 */
describe('integrations do not load their transports on unrelated commands', () => {
  let projectRoot: string;
  let base: string;

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-lazy-'));
    projectRoot = path.join(base, 'project');

    const changeDir = path.join(projectRoot, 'openspec', 'changes', 'add-auth');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [ ] 1.1 First\n', 'utf-8');

    // Every integration on: the worst case for eager loading.
    await fs.writeFile(
      path.join(projectRoot, 'openspec', 'integrations.yaml'),
      [
        'telegram:',
        '  enabled: true',
        'trello:',
        '  enabled: true',
        'github:',
        '  enabled: true',
        '',
      ].join('\n'),
      'utf-8'
    );
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  for (const args of [['list', '--json'], ['list'], ['--help']]) {
    it(`leaves stderr empty for "openspec ${args.join(' ')}"`, async () => {
      const result = await runCLI(args, { cwd: projectRoot });

      expect(result.stderr).toBe('');
      expect(result.stderr).not.toContain('DEP0040');
    });
  }

  it('still exposes the integration commands in help', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain('integrations');
    expect(result.stdout).toContain('trello');
    expect(result.stdout).toContain('telegram');
    expect(result.stdout).toContain('github');
  });

  it('produces parseable JSON with the integrations enabled', async () => {
    const result = await runCLI(['list', '--json'], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});
