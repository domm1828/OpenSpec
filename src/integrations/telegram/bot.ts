import { Bot, InlineKeyboard, type Context } from 'grammy';
import { ArchiveCommand } from '../../core/archive.js';
import type { TelegramConfig } from '../config.js';
import { getPairedChatIds, isAuthorized, redeemPairing } from './auth.js';
import {
  handleArchive,
  handleChange,
  handleChanges,
  handleCheck,
  handleHelp,
  handleNew,
  handleStatus,
  handleTasks,
  handleUncheck,
  type CommandContext,
  type CommandReply,
} from './commands.js';
import { escapeMarkdownV2, truncateForTelegram } from './format.js';

export interface BotDeps {
  projectRoot: string;
  config: TelegramConfig;
  token: string;
  log?: (message: string) => void;
}

type Handler = (ctx: CommandContext) => Promise<CommandReply>;

const HANDLERS: Record<string, Handler> = {
  help: handleHelp,
  changes: handleChanges,
  change: handleChange,
  tasks: handleTasks,
  check: handleCheck,
  uncheck: handleUncheck,
  new: handleNew,
  status: handleStatus,
  archive: handleArchive,
};

function parseCommand(text: string): { name: string; args: string[]; rest: string } | undefined {
  // Group chats deliver commands as `/tasks@my_bot`, so the mention is stripped.
  const match = text.match(/^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/);
  if (!match) return undefined;
  const rest = match[2].trim();
  return { name: match[1].toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest };
}

/**
 * Builds the bot.
 *
 * Long polling rather than webhooks: a webhook needs a publicly reachable HTTPS
 * endpoint, which a developer machine behind NAT does not have without a tunnel.
 * Polling costs one idle connection and works everywhere.
 */
export function createBot(deps: BotDeps): Bot {
  const { projectRoot, config, token, log = () => {} } = deps;
  const bot = new Bot(token);

  const reply = async (ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> => {
    await ctx.reply(truncateForTelegram(text), {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  };

  const authorized = async (chatId: number): Promise<boolean> =>
    isAuthorized(chatId, config.allowedChatIds, await getPairedChatIds(projectRoot));

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id;
    if (await authorized(chatId)) {
      await reply(ctx, escapeMarkdownV2('Already linked. Send /help for commands.'));
      return;
    }
    await reply(
      ctx,
      escapeMarkdownV2(
        `This chat is not linked. Run "openspec telegram pair" in the project and send me /link <code>. (This chat id is ${chatId}.)`
      )
    );
  });

  bot.command('link', async (ctx) => {
    const chatId = ctx.chat.id;

    if (await authorized(chatId)) {
      await reply(ctx, escapeMarkdownV2('This chat is already linked.'));
      return;
    }

    const codeArg = (ctx.match ?? '').toString().trim();
    if (!codeArg) {
      await reply(ctx, escapeMarkdownV2('Usage: /link <code>'));
      return;
    }

    const result = await redeemPairing(projectRoot, chatId, codeArg);

    if (result.ok) {
      log(`Telegram chat ${chatId} linked`);
      await reply(ctx, escapeMarkdownV2('Linked. Send /help for commands.'));
      return;
    }

    const message =
      result.reason === 'expired'
        ? 'That code has expired. Run "openspec telegram pair" again.'
        : result.reason === 'no-pending'
          ? 'There is no pending pairing. Run "openspec telegram pair" first.'
          : 'That code is not right.';

    await reply(ctx, escapeMarkdownV2(message));
  });

  /**
   * Everything below this point requires authorization.
   *
   * Unauthorized updates are dropped without a reply. Answering would confirm
   * to a stranger that the bot is live and attached to a real project, and would
   * make the bot a free relay for anyone who guesses its handle.
   */
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!(await authorized(chatId))) {
      log(`Ignored update from unauthorized chat ${chatId}`);
      return;
    }
    await next();
  });

  bot.on('message:text', async (ctx) => {
    const parsed = parseCommand(ctx.message.text);
    if (!parsed) return;
    if (parsed.name === 'start' || parsed.name === 'link') return;

    const handler = HANDLERS[parsed.name];
    if (!handler) {
      await reply(ctx, escapeMarkdownV2(`Unknown command /${parsed.name}. Try /help.`));
      return;
    }

    try {
      const result = await handler({
        projectRoot,
        chatId: ctx.chat.id,
        args: parsed.args,
        rest: parsed.rest,
      });

      const keyboard = result.confirm
        ? new InlineKeyboard()
            .text('Archive it', `confirm:${result.confirm.action}:${result.confirm.changeId}`)
            .text('Cancel', 'cancel')
        : undefined;

      await reply(ctx, result.text, keyboard);
    } catch (error) {
      log(`Command /${parsed.name} failed: ${(error as Error).message}`);
      await reply(ctx, escapeMarkdownV2(`Something went wrong: ${(error as Error).message}`));
    }
  });

  bot.callbackQuery('cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(escapeMarkdownV2('Cancelled.'), { parse_mode: 'MarkdownV2' });
  });

  bot.callbackQuery(/^confirm:archive:(.+)$/, async (ctx) => {
    const changeId = ctx.match[1];
    await ctx.answerCallbackQuery();

    try {
      // Routed through the same ArchiveCommand the CLI uses, so spec merging and
      // the incomplete-task warnings behave identically from either surface.
      await new ArchiveCommand().execute(changeId, { yes: true });
      await ctx.editMessageText(escapeMarkdownV2(`Archived ${changeId}.`), {
        parse_mode: 'MarkdownV2',
      });
    } catch (error) {
      await ctx.editMessageText(
        escapeMarkdownV2(`Could not archive ${changeId}: ${(error as Error).message}`),
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  bot.catch((error) => {
    // A throw inside a handler must not kill the polling loop; the bot has to
    // survive a transient Telegram 5xx the same way it survives a bad command.
    log(`Telegram bot error: ${error.message}`);
  });

  return bot;
}

/** Sends a notification to every authorized chat, best-effort. */
export async function broadcast(
  bot: Bot,
  chatIds: number[],
  text: string,
  log: (message: string) => void = () => {}
): Promise<void> {
  await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        await bot.api.sendMessage(chatId, truncateForTelegram(text), {
          parse_mode: 'MarkdownV2',
        });
      } catch (error) {
        log(`Could not notify chat ${chatId}: ${(error as Error).message}`);
      }
    })
  );
}
