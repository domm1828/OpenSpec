import { promises as fs } from 'fs';

/**
 * Matches only the checkbox cell of a task line, split so the state character
 * can be swapped without touching anything else on the line.
 *
 * Kept in lockstep with `TASK_LINE_PATTERN` in utils/task-progress.ts: that one
 * decides what counts as a task, this one decides where its box sits. If the
 * reader accepts a line this writer cannot address, the sync would silently
 * report success while writing nothing — hence `toggleCheckboxInLine` returns
 * null instead of guessing.
 */
const CHECKBOX_CELL_PATTERN = /^(\s*[-*]\s*\[)([\sxX])(\])/;

/**
 * Returns `line` with its checkbox set to `done`, or null when the line has no
 * addressable checkbox. Everything else on the line — indentation, bullet
 * character, description, trailing `\r` on CRLF files — is preserved verbatim.
 */
export function toggleCheckboxInLine(line: string, done: boolean): string | null {
  const match = line.match(CHECKBOX_CELL_PATTERN);
  if (!match) return null;

  const current = match[2].toLowerCase() === 'x';
  if (current === done) return line;

  return line.replace(CHECKBOX_CELL_PATTERN, `$1${done ? 'x' : ' '}$3`);
}

export interface CheckboxEdit {
  /** Absolute path to the file holding the task. */
  filePath: string;
  /** 0-based line index, as reported by `parseTaskLinesWithPositions`. */
  lineIndex: number;
  done: boolean;
  /**
   * The description the caller believes is on that line. Guards against a stale
   * snapshot addressing a line the agent has since rewritten.
   */
  expectedDescription?: string;
}

export type CheckboxEditOutcome =
  | { status: 'written'; filePath: string; lineIndex: number }
  | { status: 'unchanged'; filePath: string; lineIndex: number }
  | { status: 'skipped'; filePath: string; lineIndex: number; reason: string };

/**
 * Applies checkbox edits in place, one file at a time.
 *
 * Refuses rather than guesses: a line index past the end of the file, a line
 * with no checkbox, or a description that no longer matches all yield `skipped`
 * with a reason. Writing to the wrong line would corrupt the agent's work in a
 * way the user has no obvious way to notice, so a skipped edit that shows up in
 * the sync report is strictly the better failure.
 */
export async function applyCheckboxEdits(edits: CheckboxEdit[]): Promise<CheckboxEditOutcome[]> {
  const byFile = new Map<string, CheckboxEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.filePath);
    if (list) list.push(edit);
    else byFile.set(edit.filePath, [edit]);
  }

  const outcomes: CheckboxEditOutcome[] = [];

  for (const [filePath, fileEdits] of byFile) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      const reason = `cannot read file: ${(error as Error).message}`;
      for (const edit of fileEdits) {
        outcomes.push({ status: 'skipped', filePath, lineIndex: edit.lineIndex, reason });
      }
      continue;
    }

    const lines = content.split('\n');
    let dirty = false;

    for (const edit of fileEdits) {
      const { lineIndex } = edit;

      if (lineIndex < 0 || lineIndex >= lines.length) {
        outcomes.push({
          status: 'skipped',
          filePath,
          lineIndex,
          reason: `line ${lineIndex + 1} is outside the file (${lines.length} lines)`,
        });
        continue;
      }

      const line = lines[lineIndex];

      if (edit.expectedDescription !== undefined) {
        const actual = line.match(/^\s*[-*]\s*\[[\sxX]\]\s*(.*)/)?.[1]?.trim();
        if (actual !== edit.expectedDescription.trim()) {
          outcomes.push({
            status: 'skipped',
            filePath,
            lineIndex,
            reason: `line changed since the last sync (expected "${edit.expectedDescription}", found "${actual ?? line.trim()}")`,
          });
          continue;
        }
      }

      const updated = toggleCheckboxInLine(line, edit.done);
      if (updated === null) {
        outcomes.push({
          status: 'skipped',
          filePath,
          lineIndex,
          reason: 'line has no checkbox',
        });
        continue;
      }

      if (updated === line) {
        outcomes.push({ status: 'unchanged', filePath, lineIndex });
        continue;
      }

      lines[lineIndex] = updated;
      dirty = true;
      outcomes.push({ status: 'written', filePath, lineIndex });
    }

    if (dirty) {
      await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    }
  }

  return outcomes;
}
