import type { Bot } from 'grammy';
import type {
  HealthReport,
  IntegrationAdapter,
  IntegrationContext,
  OpenSpecEvent,
} from '../types.js';
import type { TelegramConfig } from '../config.js';
import { findMissingSecrets, getSecret } from '../secrets.js';
import { describeEvent } from '../events.js';
import { getPairedChatIds } from './auth.js';
import { broadcast, createBot } from './bot.js';
import { escapeMarkdownV2 } from './format.js';

/**
 * Telegram adapter.
 *
 * Two modes share one class. `openspec telegram serve` calls `startPolling` and
 * the bot also answers commands; every other command path only ever uses
 * `onEvent`, which sends notifications through the same Bot API client without
 * opening a polling loop. Keeping both here means the notification format and
 * the chat allowlist have exactly one implementation.
 */
export class TelegramAdapter implements IntegrationAdapter {
  readonly id = 'telegram';

  private ctx?: IntegrationContext;
  private bot?: Bot;
  private polling = false;

  constructor(private readonly config: TelegramConfig) {}

  async init(ctx: IntegrationContext): Promise<void> {
    this.ctx = ctx;

    const token = getSecret('telegramBotToken');
    if (!token) {
      throw new Error(
        'Telegram bot token is not set. Run "openspec integrations secret set telegramBotToken <token>".'
      );
    }

    this.bot = createBot({
      projectRoot: ctx.projectRoot,
      config: this.config,
      token,
      log: ctx.log,
    });
  }

  /** Config allowlist plus everything paired at runtime. */
  private async recipients(): Promise<number[]> {
    if (!this.ctx) return [];
    const paired = await getPairedChatIds(this.ctx.projectRoot);
    return [...new Set([...this.config.allowedChatIds, ...paired])];
  }

  async onEvent(event: OpenSpecEvent): Promise<void> {
    if (!this.bot || !this.ctx) return;
    if (!this.config.notifyOn.includes(event.type)) return;

    const chatIds = await this.recipients();
    if (chatIds.length === 0) return;

    await broadcast(this.bot, chatIds, escapeMarkdownV2(describeEvent(event)), this.ctx.log);
  }

  /**
   * Starts long polling. Resolves once polling has begun, not when it stops —
   * grammY's `start()` only settles on shutdown, so awaiting it here would hang
   * every caller that just wants the bot running alongside other work.
   */
  async start(): Promise<void> {
    if (!this.bot || this.polling) return;
    this.polling = true;
    void this.bot.start({ drop_pending_updates: true });
  }

  async healthcheck(): Promise<HealthReport> {
    if (!this.config.enabled) {
      return { id: this.id, level: 'disabled', message: 'Telegram integration is off' };
    }

    const missing = findMissingSecrets(['telegramBotToken']);
    if (missing.length > 0) {
      return {
        id: this.id,
        level: 'error',
        message: 'Bot token is not set',
        fix: missing[0].hint,
      };
    }

    if (!this.bot) {
      return { id: this.id, level: 'error', message: 'Adapter was not initialized' };
    }

    const chatIds = await this.recipients();
    if (chatIds.length === 0) {
      // Not merely unhelpful — an empty allowlist is what stops a leaked token
      // from becoming write access, so it is worth surfacing as a real state.
      return {
        id: this.id,
        level: 'warn',
        message: 'No chats are linked, so the bot answers nobody',
        fix: 'openspec telegram pair',
      };
    }

    try {
      const me = await this.bot.api.getMe();
      return {
        id: this.id,
        level: 'ok',
        message: `Connected as @${me.username}; ${chatIds.length} chat(s) linked`,
      };
    } catch (error) {
      return { id: this.id, level: 'error', message: (error as Error).message };
    }
  }

  async dispose(): Promise<void> {
    if (this.bot && this.polling) {
      await this.bot.stop();
      this.polling = false;
    }
  }
}

export function createTelegramAdapter(config: unknown): IntegrationAdapter {
  return new TelegramAdapter(config as TelegramConfig);
}
