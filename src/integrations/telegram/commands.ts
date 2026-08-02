import path from 'path';
import { createChange, validateChangeName } from '../../utils/change-utils.js';
import { readAllChangeSnapshots, readChangeSnapshot, listChangeIds, taskFilePath } from '../snapshot.js';
import { applyCheckboxEdits } from '../task-writer.js';
import type { ChangeSnapshot } from '../types.js';
import { bold, code, escapeMarkdownV2, progressBar, truncateForTelegram } from './format.js';

/**
 * Bot command handlers.
 *
 * Written as plain async functions over a context object rather than as grammY
 * middleware, so the whole command surface — including every write path — is
 * exercisable in tests without a bot token or a network stub.
 */

export interface CommandContext {
  projectRoot: string;
  chatId: number;
  /** Whitespace-split arguments after the command word. */
  args: string[];
  /** Full argument string, for commands that take free text. */
  rest: string;
}

export interface CommandReply {
  text: string;
  /** Set when the reply is a question the user must confirm. */
  confirm?: { action: string; changeId: string };
}

const HELP = [
  '*OpenSpec bot*',
  '',
  '/changes — list active changes',
  '/change <id> — show one change',
  '/tasks <id> — list its tasks, numbered',
  '/check <id> <n> — tick task n',
  '/uncheck <id> <n> — untick task n',
  '/new <name> — create a change skeleton',
  '/archive <id> — archive a completed change',
  '/status — one-line project summary',
  '/help — this message',
].join('\n');

export async function handleHelp(): Promise<CommandReply> {
  // Written pre-escaped: the literal asterisks around the title are markup.
  return { text: HELP.replace(/^\/(\w+) — /gm, (_, name) => `/${name} \\— `) };
}

function changeLine(change: ChangeSnapshot): string {
  return `${code(change.id)} ${escapeMarkdownV2(progressBar(change.completedTasks, change.totalTasks))}`;
}

export async function handleChanges(ctx: CommandContext): Promise<CommandReply> {
  const changes = await readAllChangeSnapshots(ctx.projectRoot);

  if (changes.length === 0) {
    return { text: escapeMarkdownV2('No active changes.') };
  }

  const lines = [bold('Active changes'), '', ...changes.map(changeLine)];
  return { text: truncateForTelegram(lines.join('\n')) };
}

async function resolveChangeId(
  projectRoot: string,
  requested: string | undefined
): Promise<{ id: string } | { error: string }> {
  if (!requested) return { error: 'Usage: /change <id>' };

  const ids = await listChangeIds(projectRoot);
  if (ids.includes(requested)) return { id: requested };

  const prefixed = ids.filter((id) => id.startsWith(requested));
  if (prefixed.length === 1) return { id: prefixed[0] };
  if (prefixed.length > 1) {
    return { error: `"${requested}" is ambiguous: ${prefixed.join(', ')}` };
  }

  return { error: `No change named "${requested}". Try /changes.` };
}

export async function handleChange(ctx: CommandContext): Promise<CommandReply> {
  const resolved = await resolveChangeId(ctx.projectRoot, ctx.args[0]);
  if ('error' in resolved) return { text: escapeMarkdownV2(resolved.error) };

  const change = await readChangeSnapshot(ctx.projectRoot, resolved.id);

  const lines = [
    bold(change.id),
    '',
    change.goal ? `${bold('Goal')}: ${escapeMarkdownV2(change.goal)}` : undefined,
    change.summary ? escapeMarkdownV2(change.summary) : undefined,
    '',
    `${bold('Progress')}: ${escapeMarkdownV2(progressBar(change.completedTasks, change.totalTasks))}`,
    change.schema ? `${bold('Schema')}: ${code(change.schema)}` : undefined,
  ].filter((line) => line !== undefined);

  return { text: truncateForTelegram(lines.join('\n')) };
}

export async function handleTasks(ctx: CommandContext): Promise<CommandReply> {
  const resolved = await resolveChangeId(ctx.projectRoot, ctx.args[0]);
  if ('error' in resolved) return { text: escapeMarkdownV2(resolved.error) };

  const change = await readChangeSnapshot(ctx.projectRoot, resolved.id);

  if (change.tasks.length === 0) {
    return { text: escapeMarkdownV2(`${change.id} has no tasks yet.`) };
  }

  // Numbering is 1-based and positional, matching what /check expects. Derived
  // from the same snapshot the write path uses, so the number the user sees and
  // the line the writer edits cannot drift apart within a request.
  //
  // Bracketed rather than "1.", because task text usually carries its own
  // outline numbering: "1. ✅ 1.1 Add grammY" reads as a typo, while
  // "[1] ✅ 1.1 Add grammY" makes it obvious which number /check wants.
  const lines = change.tasks.map(
    (task, index) =>
      `${escapeMarkdownV2(`[${index + 1}]`)} ${task.done ? '✅' : '⬜'} ${escapeMarkdownV2(task.description)}`
  );

  return {
    text: truncateForTelegram(
      [bold(`Tasks — ${change.id}`), '', ...lines, '', escapeMarkdownV2('Tick one with /check ' + change.id + ' <n>')].join('\n')
    ),
  };
}

async function setTaskState(ctx: CommandContext, done: boolean): Promise<CommandReply> {
  const verb = done ? 'check' : 'uncheck';
  const resolved = await resolveChangeId(ctx.projectRoot, ctx.args[0]);
  if ('error' in resolved) return { text: escapeMarkdownV2(`Usage: /${verb} <id> <n>`) };

  const index = Number(ctx.args[1]);
  if (!Number.isInteger(index) || index < 1) {
    return { text: escapeMarkdownV2(`Usage: /${verb} <id> <n> — n is the number from /tasks`) };
  }

  const change = await readChangeSnapshot(ctx.projectRoot, resolved.id);
  const task = change.tasks[index - 1];

  if (!task) {
    return {
      text: escapeMarkdownV2(`${change.id} has ${change.tasks.length} task(s); ${index} is out of range.`),
    };
  }

  if (task.done === done) {
    return { text: escapeMarkdownV2(`Already ${done ? 'done' : 'open'}: ${task.description}`) };
  }

  const [outcome] = await applyCheckboxEdits([
    {
      filePath: taskFilePath(change, task),
      lineIndex: task.lineIndex,
      done,
      expectedDescription: task.description,
    },
  ]);

  if (outcome.status === 'skipped') {
    return { text: escapeMarkdownV2(`Could not update it: ${outcome.reason}`) };
  }

  const after = await readChangeSnapshot(ctx.projectRoot, change.id);
  return {
    text: [
      `${done ? '✅' : '⬜'} ${escapeMarkdownV2(task.description)}`,
      escapeMarkdownV2(progressBar(after.completedTasks, after.totalTasks)),
    ].join('\n'),
  };
}

export function handleCheck(ctx: CommandContext): Promise<CommandReply> {
  return setTaskState(ctx, true);
}

export function handleUncheck(ctx: CommandContext): Promise<CommandReply> {
  return setTaskState(ctx, false);
}

export async function handleNew(ctx: CommandContext): Promise<CommandReply> {
  const [name, ...goalParts] = ctx.rest.split(/\s+—\s+|\s+--\s+/);
  const trimmed = (name ?? '').trim();

  if (!trimmed) {
    return { text: escapeMarkdownV2('Usage: /new <kebab-case-name> — optional goal') };
  }

  const validation = validateChangeName(trimmed);
  if (!validation.valid) {
    return { text: escapeMarkdownV2(validation.error ?? 'Invalid change name.') };
  }

  const goal = goalParts.join(' ').trim();

  try {
    const result = await createChange(ctx.projectRoot, trimmed, {
      metadata: goal ? { goal } : {},
    });

    const relative = path.relative(ctx.projectRoot, result.changeDir).split(path.sep).join('/');

    return {
      text: [
        `${escapeMarkdownV2('Created')} ${code(trimmed)}`,
        `${escapeMarkdownV2('at')} ${code(relative)}`,
        '',
        // Said plainly rather than left to be discovered: OpenSpec does not run
        // a model, so this command produces the scaffold and nothing else. A
        // user who expects a written proposal would otherwise find an empty one.
        escapeMarkdownV2(
          'This is an empty scaffold — OpenSpec does not write the proposal itself. Ask your coding agent to fill it in with /opsx:propose.'
        ),
      ].join('\n'),
    };
  } catch (error) {
    return { text: escapeMarkdownV2(`Could not create it: ${(error as Error).message}`) };
  }
}

export async function handleStatus(ctx: CommandContext): Promise<CommandReply> {
  const changes = await readAllChangeSnapshots(ctx.projectRoot);
  const totals = changes.reduce(
    (acc, change) => ({
      completed: acc.completed + change.completedTasks,
      total: acc.total + change.totalTasks,
    }),
    { completed: 0, total: 0 }
  );

  const complete = changes.filter((c) => c.totalTasks > 0 && c.completedTasks === c.totalTasks);

  return {
    text: [
      bold('Project status'),
      '',
      escapeMarkdownV2(`${changes.length} active change(s)`),
      escapeMarkdownV2(`${complete.length} ready to archive`),
      escapeMarkdownV2(`Tasks: ${progressBar(totals.completed, totals.total)}`),
    ].join('\n'),
  };
}

/**
 * Archiving deletes a change directory and merges its specs, so it asks first.
 *
 * The confirmation is returned rather than performed: the bot layer turns it
 * into an inline keyboard, and the destructive step only runs once a callback
 * comes back from the same authorized chat.
 */
export async function handleArchive(ctx: CommandContext): Promise<CommandReply> {
  const resolved = await resolveChangeId(ctx.projectRoot, ctx.args[0]);
  if ('error' in resolved) return { text: escapeMarkdownV2(resolved.error) };

  const change = await readChangeSnapshot(ctx.projectRoot, resolved.id);
  const incomplete = change.totalTasks - change.completedTasks;

  const warning =
    incomplete > 0
      ? `\n\n⚠️ ${escapeMarkdownV2(`${incomplete} task(s) are still open.`)}`
      : '';

  return {
    text:
      `${escapeMarkdownV2('Archive')} ${code(change.id)}${escapeMarkdownV2('?')}` +
      `\n${escapeMarkdownV2('This merges its specs and moves it out of changes/.')}${warning}`,
    confirm: { action: 'archive', changeId: change.id },
  };
}
