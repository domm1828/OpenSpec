/**
 * Shared vocabulary for the integrations layer.
 *
 * Everything here is transport-agnostic on purpose: a Trello card, a Telegram
 * message and a future Slack thread all consume the same `ChangeSnapshot` and
 * emit the same `OpenSpecEvent`. Adapters never parse Markdown themselves —
 * `snapshot.ts` owns that, using the same parser `openspec status` uses.
 */

/**
 * Events the layer can observe.
 *
 * Two producers exist and they overlap deliberately:
 *  - the CLI `postAction` hook, for mutations OpenSpec itself performs
 *  - the watcher, for mutations the AI agent performs by editing Markdown
 *
 * The watcher is the one that matters most: most real work happens in an editor,
 * not through the CLI, so a hook-only design would miss the majority of changes.
 */
export type OpenSpecEventType =
  | 'change.created'
  | 'change.updated'
  | 'change.archived'
  | 'change.validated'
  | 'task.checked'
  | 'task.unchecked'
  | 'spec.updated'
  /**
   * Version-control facts, emitted by an adapter rather than derived from disk.
   *
   * The watcher cannot produce these: a branch and a pull request are things an
   * adapter *did*, not things it observed in `openspec/`. They exist so one
   * adapter can tell the others what it did without either of them importing the
   * other — the Trello card learns its pull request URL this way.
   */
  | 'vcs.branch.created'
  | 'vcs.commit.created'
  | 'vcs.pr.opened';

export const ALL_EVENT_TYPES: readonly OpenSpecEventType[] = [
  'change.created',
  'change.updated',
  'change.archived',
  'change.validated',
  'task.checked',
  'task.unchecked',
  'spec.updated',
  'vcs.branch.created',
  'vcs.commit.created',
  'vcs.pr.opened',
] as const;

export interface OpenSpecEvent {
  type: OpenSpecEventType;
  /** Change id (directory name under openspec/changes/), when the event has one. */
  changeId?: string;
  /** Spec id, for `spec.updated`. */
  specId?: string;
  /** The task involved, for `task.checked` / `task.unchecked`. */
  task?: TaskRef;
  /** Snapshot of the change at the time the event fired, when available. */
  change?: ChangeSnapshot;
  /** ISO-8601. Supplied by the emitter so the layer stays clock-injectable. */
  at: string;
  /** Free-form extra context; adapters must tolerate unknown keys. */
  meta?: Record<string, unknown>;
}

/**
 * A single checkbox line.
 *
 * `file` and `lineIndex` are what make write-back possible: a change's tasks can
 * be spread across several files (the tracked-tasks artifact is a glob, not
 * necessarily a lone `tasks.md`), so a bare ordinal would address the wrong line
 * as soon as a second file appears.
 */
export interface TaskRef {
  /** Path relative to the change directory, POSIX separators. */
  file: string;
  /** 0-based index of the line within `file`. */
  lineIndex: number;
  /** Text after the checkbox, trimmed. */
  description: string;
  done: boolean;
  /**
   * Stable-ish identity for matching across syncs. Derived from the normalized
   * description, so it survives reordering and re-indentation but not a rewrite.
   * Renames are handled by the reconciler, not by this key.
   */
  key: string;
}

export interface ChangeSnapshot {
  id: string;
  /** Absolute path to the change directory. */
  dir: string;
  goal?: string;
  schema?: string;
  tasks: TaskRef[];
  completedTasks: number;
  totalTasks: number;
  /** ISO-8601 mtime of the most recently touched file in the change. */
  lastModified: string;
  /** First heading/paragraph of proposal.md, when present. */
  summary?: string;
}

export type HealthLevel = 'ok' | 'warn' | 'error' | 'disabled';

export interface HealthReport {
  id: string;
  level: HealthLevel;
  message: string;
  /** A pasteable command or URL that fixes the problem, mirroring `openspec doctor`. */
  fix?: string;
}

export interface IntegrationContext {
  /** Absolute path to the project root (the directory containing `openspec/`). */
  projectRoot: string;
  /** Resolved config for this adapter. */
  config: unknown;
  /** Emits a log line; the CLI decides whether it reaches stdout. */
  log: (message: string) => void;
  /** Current time as ISO-8601. Injected so tests are deterministic. */
  now: () => string;
  /**
   * Announces something this adapter just did to every *other* adapter.
   *
   * The alternative was for the Trello adapter to import the GitHub one and ask
   * it for the pull request URL, which couples two integrations that are meant
   * to be independently removable. Here GitHub states a fact and whoever cares
   * reacts — the same shape as every other event in the layer.
   *
   * The emitter never receives its own event, and an emitted event cannot emit
   * another: two adapters answering each other would otherwise loop forever.
   */
  emit?: (event: OpenSpecEvent) => Promise<void>;
}

/**
 * A change originating outside OpenSpec that wants to be applied locally.
 * Adapters describe intent; the layer decides whether it is safe to apply.
 */
export interface InboundChange {
  source: string;
  changeId: string;
  task: { file: string; lineIndex: number; key: string; description: string };
  done: boolean;
  /** ISO-8601 timestamp of the remote edit, when the remote reports one. */
  at?: string;
}

export interface IntegrationAdapter {
  id: string;
  init(ctx: IntegrationContext): Promise<void>;
  /**
   * Begins any long-running listening (Telegram's polling loop).
   *
   * Declared here rather than reached through an `instanceof` check so callers
   * never have to import the concrete adapter class — which would defeat the
   * lazy loading that keeps heavyweight transport dependencies out of every
   * unrelated CLI invocation.
   *
   * Resolves once listening has started, not when it stops.
   */
  start?(): Promise<void>;
  /** OpenSpec → outside. */
  onEvent?(event: OpenSpecEvent): Promise<void>;
  /**
   * Ends a watch pass: whatever the events of this pass added up to, do it now.
   *
   * `onEvent` sees one event at a time, so an adapter that wants to act on a
   * *pass* rather than on each event has nowhere to do it. The GitHub adapter is
   * the reason this exists: ticking three checkboxes in one edit produces three
   * `task.checked` events for one working tree, and committing per event would
   * put the whole diff in the first commit and leave the other two empty.
   *
   * Called once per pass, after every event has been dispatched and before the
   * snapshot is written.
   */
  flush?(): Promise<void>;
  /** Outside → OpenSpec. */
  pull?(): Promise<InboundChange[]>;
  healthcheck(): Promise<HealthReport>;
  dispose?(): Promise<void>;
}
