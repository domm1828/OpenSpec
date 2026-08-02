# Integrations: Telegram and Trello

OpenSpec keeps everything in Markdown on disk. That is great for agents and for
git, and useless for anyone who is not sitting in front of the repo. This layer
opens that boundary in both directions:

- **Telegram** — a bot you can ask about changes and use to tick tasks.
- **Trello** — a two-way sync between `tasks.md` and a board's checklists.

Both are off by default and both are adapters over one shared layer, so adding a
third (Slack, Jira, Linear) means writing one file, not reworking the plumbing.

---

## How it works

```
openspec/                       watcher (polls every 5s)
  changes/<id>/tasks.md   ──▶   diff vs snapshot   ──▶   events   ──▶   adapters
                                                                        ├─ telegram
                                                                        └─ trello
```

The **watcher** is the important part. OpenSpec's CLI is an ephemeral process,
and in practice your AI agent does most of the mutating by editing Markdown
directly — no command ever runs. A design that only fired events from command
hooks would miss most of what happens in a project, so the watcher re-reads the
tree and diffs it against a stored snapshot.

Events: `change.created`, `change.updated`, `change.archived`, `change.validated`,
`task.checked`, `task.unchecked`, `spec.updated`.

### Where things live

| What | Where | In git? |
|---|---|---|
| Settings | `openspec/integrations.yaml` | **yes** — commit it |
| Credentials | env vars, or the user's global config dir | **never** |
| Sync state (card ids, baselines, pairings) | `.openspec-integrations/` | no — gitignored |

Settings sit beside `openspec/config.yaml` rather than in the global config
because a board id and a chat allowlist are properties of *this* project, not of
you across every project.

---

## Getting started

```bash
openspec integrations list          # what is registered and enabled
openspec integrations enable trello
openspec integrations status        # health check, with a fix for each problem
```

`status` is the command to reach for whenever something is off — it reports
missing credentials, unmapped lists and unlinked chats, each with the exact
command that fixes it.

### Credentials

Never put these in `openspec/integrations.yaml`; that file is committed.

```bash
openspec integrations secret set trelloKey        <key>
openspec integrations secret set trelloToken      <token>
openspec integrations secret set telegramBotToken <token>
openspec integrations secret list                 # values are masked
```

Environment variables take precedence, which is what you want in CI:

- `OPENSPEC_TRELLO_KEY`, `OPENSPEC_TRELLO_TOKEN`
- `OPENSPEC_TELEGRAM_BOT_TOKEN`

---

## Trello

### Credentials

1. Go to <https://trello.com/power-ups/admin> and create a Power-Up (this is now
   the only way to get an API key).
2. Open it → **API Key** tab → *Generate a new API Key*.
3. Get a user token by visiting, with your key substituted in:
   `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<KEY>`

### Linking a board

```bash
openspec trello link <boardId>
```

Reads the board's lists and writes a `listMap` into `openspec/integrations.yaml`,
matching by name (`To Do`/`Backlog` → proposed, `Doing`/`In Progress` →
in_progress, `Review`/`Done` → review). Anything it cannot match is left
unmapped rather than guessed at — edit the file to fix it.

The board id is in the board URL: `trello.com/b/<boardId>/my-board`.

### Using your own board layout

`listMap` maps roles to list **ids**, not names, so the name matching above is
only a convenience for the first setup. After `link`, edit the file and your
lists can be called anything.

- **Name lists however you like.** `Pendiente`, `Cocinando`, `Para revisar` all
  work — only the ids in `listMap` matter.
- **Reuse an existing board.** The sync only touches cards named after a change
  id or recorded in `.openspec-integrations/trello-state.json`; everything else
  on the board is left alone.
- **Map fewer lists.** An unmapped role means the card simply is not moved for
  it — no error. Map only `proposed` and every card lands in one list.
- **Rename the checklist** with `checklistName`.

Two behaviours are worth setting deliberately:

```yaml
trello:
  cardPlacement: once     # once | always
  onArchive: move         # move | close | nothing
```

`cardPlacement: once` (the default) places a card in the list matching its
progress when it is **created**, and never moves it again — so the board is
yours to organize. `always` re-derives the list on every sync, which keeps the
board mechanically consistent with `tasks.md` but silently undoes any card you
drag somewhere by hand.

`onArchive` decides what happens when a change is archived: `move` sends the
card to the list mapped as `archived` (a no-op if that role is unmapped),
`close` uses Trello's own card archiving, `nothing` leaves it in place.

What is **not** configurable: the four roles themselves, and the fact that they
are derived from task progress. OpenSpec has no status field on a change, so a
richer mapping would need a second source of truth that drifts from
`openspec list`. For the same reason, moving a card between lists in Trello
carries no information back into OpenSpec — list position is push-only.

### Syncing

```bash
openspec trello sync --dry-run          # always do this first
openspec trello sync                    # two-way
openspec trello sync --direction=push   # tasks.md → Trello only
openspec trello sync --direction=pull   # Trello → tasks.md only
openspec trello sync --change <id>      # just one change
openspec trello sync --json
```

Mapping: one change is one card, its tasks are items in a checklist called
`Tasks`, and the card moves between lists as the change progresses.

The direction flags mean one side is authoritative, which is sharper than it
sounds: `--direction=pull` will **revert** a local tick that Trello does not
have, and `--direction=push` will revert a remote one. That is the literal
meaning of the flag, but it bypasses conflict detection entirely — leave it off
unless you specifically want one side to win.

### How conflicts are decided

The sync is three-way: it compares `tasks.md`, the card, and a *baseline*
recorded at the end of the last sync.

Something worth knowing, because it means far fewer conflicts than you would
expect: **with a baseline present, a checkbox can never genuinely conflict.**
`done` is a boolean, so if the two sides disagree, exactly one of them still
equals the baseline — and the other is, unambiguously, the side that changed.
The three-way table collapses to a two-way one.

A conflict therefore only arises when:

- **there is no baseline** and the two sides disagree — a first sync, or a task
  created independently on both sides; or
- **a rename moved on both sides** — text has more than two possible values, so
  this one really can be three-way.

```yaml
trello:
  conflictPolicy: manual   # manual | local-wins | remote-wins
```

`manual` is the default: it writes **nothing**, reports the conflict, and does
not record a baseline (which would silently crown a winner on the next run).

### What it will and will not do

| Situation | What happens |
|---|---|
| Task added to `tasks.md` | Check item created |
| Task ticked on either side | Mirrored to the other |
| Task reworded on one side | Renamed on the other, item id preserved |
| Task reworded beyond recognition | Delete + create (reported) |
| Line deleted from `tasks.md` | Check item deleted — only if the baseline proves it was synced |
| Check item deleted in Trello | **Re-created.** A line is never removed from `tasks.md` |
| Item added directly in Trello | Reported every run, never written into `tasks.md` |

That last pair is deliberate. `tasks.md` is the source of truth for what work
exists, and a deleted line is unrecoverable; a card item that reappears is
merely annoying. Likewise, turning a card item into a `tasks.md` line means
inventing where in the document it belongs, so the sync reports it instead.

### Matching, and why not by position

Tasks are paired in three passes: by recorded remote id, then by normalized text
(which absorbs renumbering — `1.1` → `2.4` — and whitespace churn), then by
Sørensen–Dice similarity ≥ 0.6 against an item the baseline proves was synced.

Position is never used. Inserting a task at the top of `tasks.md` shifts every
ordinal below it, and a position-matched sync would rewrite every task's state
to its neighbour's.

The third pass exists to close a data-loss hole: without it, a locally reworded
task looks like "old deleted, new added", so the plan is delete-then-create —
and the new item is created with the *local* checkbox state, discarding a tick
someone made in Trello since the last sync.

### Rate limits

Trello allows 300 requests/10s per API key and 100/10s per token. Since every
call carries the same token, 100 is the ceiling that actually binds; the client
paces itself at 90 and retries 429s and 5xx with exponential backoff.

### Why polling, not webhooks

Trello webhooks require a publicly reachable HTTPS callback that answers a
`HEAD` request. A developer machine behind NAT does not have one without a
tunnel. Polling costs one request per interval and works everywhere.

---

## Telegram

### Setting up

1. Talk to [@BotFather](https://t.me/botfather), `/newbot`, copy the token.
2. `openspec integrations secret set telegramBotToken <token>`
3. `openspec integrations enable telegram`
4. `openspec telegram pair` → prints a one-time code
5. `openspec telegram serve` → starts the bot
6. In your chat with the bot: `/link <code>`

```bash
openspec telegram chats           # who is linked
openspec telegram unpair <chatId>
openspec telegram test            # verify the token and send a test message
openspec telegram serve           # bot + watcher, together
```

### Commands

| Command | Does |
|---|---|
| `/changes` | List active changes with progress |
| `/change <id>` | Goal, summary, progress |
| `/tasks <id>` | Numbered task list |
| `/check <id> <n>` | Tick task n |
| `/uncheck <id> <n>` | Untick task n |
| `/new <name> — <goal>` | Create a change scaffold |
| `/archive <id>` | Archive, with an inline confirmation |
| `/status` | One-line project summary |

Change ids can be abbreviated to any unambiguous prefix.

### Security

The bot can edit files and archive changes, so an unauthenticated chat is a
write path into your repository. Three things follow from that:

- **The allowlist fails closed.** No configured ids and no pairings means nobody
  is authorized. An empty allowlist never means "allow everyone".
- **Unauthorized updates get no reply.** Answering would confirm to a stranger
  that the bot is live and attached to a real project.
- **Pairing codes are single-use, CSPRNG-generated, expire in 10 minutes, and
  are compared in constant time.**

`/archive` always asks for confirmation via an inline keyboard, because it
deletes a directory and merges specs.

### What the bot cannot do

`/new` creates the change **scaffold** — directory, metadata, templates — and
nothing else. OpenSpec does not run a language model, so the proposal itself is
still written by your coding agent in your editor. "Create a proposal from
Telegram" means queueing one for the agent to fill in, and the bot says so in
its reply rather than leaving you to discover an empty file.

### Why long polling

A webhook needs a publicly reachable HTTPS endpoint. Long polling costs one idle
connection and works behind NAT with no tunnel.

---

## Running the watcher

```bash
openspec integrations watch --prime     # record the current state, notify nothing
openspec integrations watch             # all enabled adapters
openspec integrations watch --interval 2000
openspec telegram serve                 # bot + watcher in one process
```

Run `--prime` once when adopting the watcher in an established project.
Otherwise the first pass sees every existing change as new and fires a
`change.created` for each.

The snapshot is written only *after* events dispatch. If the process dies
mid-dispatch the same events are re-derived next time — a duplicate
notification is a far cheaper failure than a tick that never reaches Trello.

---

## Configuration reference

`openspec/integrations.yaml`:

```yaml
telegram:
  enabled: true
  allowedChatIds: [123456789]        # empty + no pairings = nobody
  notifyOn:
    - change.created
    - change.archived
    - task.checked
  autoCommit: false                  # commit task edits made from chat

trello:
  enabled: true
  boardId: "abc123"
  listMap:
    proposed: "list-id"
    in_progress: "list-id"
    review: "list-id"
    archived: "list-id"
  checklistName: Tasks
  conflictPolicy: manual             # manual | local-wins | remote-wins
  pollIntervalSec: 60
```

---

## Adding another adapter

1. Implement `IntegrationAdapter` from `src/integrations/types.ts`.
2. Add its config to `IntegrationsConfigSchema` in `src/integrations/config.ts`
   (use `.prefault({})`, not `.default({})` — Zod 4's `default` must satisfy the
   *output* type, so `{}` is rejected for a schema with required output fields).
3. `registerAdapter('yourId', createYourAdapter)` in
   `src/commands/integrations.ts`.
4. Reuse `readAllChangeSnapshots` and `applyCheckboxEdits` rather than parsing
   or writing Markdown yourself — the parser handles nested tasks, CRLF, and
   multi-file task globs, and the writer refuses a stale line rather than
   corrupting one.

---

## Troubleshooting

**`Missing credentials`** — run `openspec integrations status`; it names each
missing secret and the command that sets it.

**`No Trello list mapped for "proposed"`** — run `openspec trello link <boardId>`,
or fill in `listMap` by hand.

**The bot ignores me** — the chat is not authorized. `openspec telegram chats`
shows who is; `openspec telegram pair` adds you.

**Conflicts on every sync** — the two sides diverged with no baseline. Resolve
by hand once and sync; or set `conflictPolicy` if one side should always win.

**`⚠ skipped local edit: line changed since the last sync`** — the file moved
under the sync. Nothing was written. Re-run.
