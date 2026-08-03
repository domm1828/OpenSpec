/**
 * Telegram MarkdownV2 rendering.
 *
 * MarkdownV2 reserves eighteen characters and rejects the whole message with a
 * 400 if any of them appears unescaped — including inside text the user never
 * meant as markup. Task descriptions routinely contain `.`, `-`, `(` and `!`,
 * so escaping is not a nicety here: it is the difference between a bot that
 * delivers notifications and one that silently 400s on most of them.
 */

const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(RESERVED, (char) => `\\${char}`);
}

/** Telegram's hard limit on a single message body. */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Truncates to fit, cutting at a line boundary when one is close enough.
 *
 * The ellipsis is appended *after* escaping, and the budget accounts for it, so
 * a truncation can never split an escape sequence in half and produce the very
 * 400 the escaping exists to prevent.
 */
export function truncateForTelegram(text: string, limit = MAX_MESSAGE_LENGTH): string {
  const suffix = '\n…';
  if (text.length <= limit) return text;

  const budget = limit - suffix.length;
  const slice = text.slice(0, budget);
  const lastNewline = slice.lastIndexOf('\n');

  // Only prefer the line boundary when it does not throw away most of the body.
  const cut = lastNewline > budget * 0.7 ? lastNewline : budget;
  let body = slice.slice(0, cut);

  // Never end on a lone backslash: it would escape the newline in the suffix.
  while (body.endsWith('\\') && !body.endsWith('\\\\')) body = body.slice(0, -1);

  return body + suffix;
}

export function bold(text: string): string {
  return `*${escapeMarkdownV2(text)}*`;
}

export function code(text: string): string {
  // Inside a code span only backticks and backslashes need escaping.
  return `\`${text.replace(/[`\\]/g, (char) => `\\${char}`)}\``;
}

/** Renders a progress bar for a change, e.g. `▰▰▰▱▱ 3/5`. */
export function progressBar(completed: number, total: number, width = 5): string {
  if (total === 0) return 'no tasks';
  const filled = Math.round((completed / total) * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)} ${completed}/${total}`;
}
