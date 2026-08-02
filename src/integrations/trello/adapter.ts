import type {
  HealthReport,
  IntegrationAdapter,
  IntegrationContext,
  OpenSpecEvent,
} from '../types.js';
import type { TrelloConfig } from '../config.js';
import { getSecret, findMissingSecrets } from '../secrets.js';
import { TrelloClient } from './client.js';
import { archiveTrelloCard, syncTrello } from './sync.js';

/**
 * Trello adapter.
 *
 * Reacts to events by syncing only the affected change rather than the whole
 * board: a full pass costs one request per change plus one per checklist, and
 * ticking a single checkbox should not walk the entire project.
 */
export class TrelloAdapter implements IntegrationAdapter {
  readonly id = 'trello';

  private ctx?: IntegrationContext;
  private client?: TrelloClient;

  constructor(private readonly config: TrelloConfig) {}

  async init(ctx: IntegrationContext): Promise<void> {
    this.ctx = ctx;

    const key = getSecret('trelloKey');
    const token = getSecret('trelloToken');
    if (!key || !token) {
      throw new Error(
        'Trello credentials are not set. Run "openspec integrations secret set trelloKey <key>" and "... trelloToken <token>".'
      );
    }

    this.client = new TrelloClient({ key, token });
  }

  async onEvent(event: OpenSpecEvent): Promise<void> {
    if (!this.ctx || !this.client || !event.changeId) return;

    // Archiving needs its own path, not a sync. A regular sync enumerates
    // `openspec/changes/` and skips `archive/`, so an archived change is never
    // visited and its card would sit in whatever list it last occupied forever.
    if (event.type === 'change.archived') {
      const result = await archiveTrelloCard({
        projectRoot: this.ctx.projectRoot,
        config: this.config,
        client: this.client,
        changeId: event.changeId,
      });
      if (result.action === 'skipped' && result.reason) {
        this.ctx.log(`Trello: left the card for ${event.changeId} alone (${result.reason})`);
      }
      return;
    }

    await syncTrello({
      projectRoot: this.ctx.projectRoot,
      config: this.config,
      client: this.client,
      changeIds: [event.changeId],
      log: this.ctx.log,
    });
  }

  async healthcheck(): Promise<HealthReport> {
    if (!this.config.enabled) {
      return { id: this.id, level: 'disabled', message: 'Trello integration is off' };
    }

    const missing = findMissingSecrets(['trelloKey', 'trelloToken']);
    if (missing.length > 0) {
      return {
        id: this.id,
        level: 'error',
        message: `Missing credentials: ${missing.map((m) => m.name).join(', ')}`,
        fix: missing[0].hint,
      };
    }

    if (!this.config.boardId) {
      return {
        id: this.id,
        level: 'error',
        message: 'No board configured',
        fix: 'openspec trello link <boardId>',
      };
    }

    if (!this.client) {
      return { id: this.id, level: 'error', message: 'Adapter was not initialized' };
    }

    try {
      const me = await this.client.whoami();
      const lists = await this.client.getBoardLists(this.config.boardId);
      const mapped = Object.values(this.config.listMap).filter(Boolean).length;

      if (lists.length === 0) {
        // Distinct from "lists exist but none are mapped": re-running `link`
        // cannot fix an empty board, and sending the user back to it is a loop.
        return {
          id: this.id,
          level: 'error',
          message: `Connected as ${me.username}, but board ${this.config.boardId} has no lists`,
          fix: `Add columns in Trello, or run: openspec trello link ${this.config.boardId} --create-lists`,
        };
      }

      if (mapped === 0) {
        return {
          id: this.id,
          level: 'warn',
          message: `Connected as ${me.username}; board has ${lists.length} list(s) but none are mapped`,
          fix: `openspec trello link ${this.config.boardId}`,
        };
      }

      return {
        id: this.id,
        level: 'ok',
        message: `Connected as ${me.username}; ${mapped} list(s) mapped on board ${this.config.boardId}`,
      };
    } catch (error) {
      return { id: this.id, level: 'error', message: (error as Error).message };
    }
  }
}

export function createTrelloAdapter(config: unknown): IntegrationAdapter {
  return new TrelloAdapter(config as TrelloConfig);
}
