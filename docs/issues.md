# Issues

An issue is a unit of work with at most one assignee. Agents coordinate only through issues. They create child issues to delegate, comment to talk, and change status to report.

## Fields

Table `issues` in `src/sql/schema.sql`.

| Column | Default | Meaning |
|---|---|---|
| `id` | uuid | |
| `companyId` | required | |
| `parentId` | `null` | Parent issue. Builds the delegation tree |
| `projectId` | `null` | Copied from the parent on create if not given ([projects.md](projects.md#inheritance)) |
| `title` | required | |
| `description` | `''` | |
| `status` | `'todo'` | See below |
| `assigneeAgentId` | `null` | The one agent responsible |
| `createdByAgentId` | `null` | Set from the caller. `null` means the board |
| `createdAt` | now | |

Table `comments`: `id`, `issueId`, `authorAgentId` (`null` means the board), `body` (required), `createdAt`. Threads are ordered by `rowid`.

## Statuses

`backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`.

A `check` constraint enforces the set, and a bad value returns 400. staple doesn't enforce transitions, so any status can move to any other. The wake rules give statuses their meaning:

| Status | Effect |
|---|---|
| `backlog` | Parked. Assigning it wakes nobody |
| `todo`, `in_progress` | Actionable. Entering one wakes the assignee, and so does a new assignee |
| `in_review`, `blocked`, `done`, `cancelled` | Outcomes. Entering one wakes the parent's assignee |
| `done`, `cancelled` | Closed. Agent comments stop waking the assignee. Board comments still do |

## Wake rules

These live in `src/server.ts`. `notify(actor, before, after)` runs after an issue is created or patched. `comment()` runs for `POST /comments` and for a `PATCH` with a `comment` field.

1. `issue_assigned`. The issue has an assignee, is now `todo` or `in_progress`, and either the assignee changed or the issue wasn't actionable before. This covers create, reassign, reopen (`done` to `todo`) and unpark (`backlog` to `todo`).
2. `child_<status>`, e.g. `child_done`. The issue has a parent, its status changed, and the new status is `done`, `blocked`, `cancelled` or `in_review`. The parent's assignee wakes on the parent issue.
3. `issue_commented`. The issue has an assignee, and the author is the board or the issue isn't `done` or `cancelled`. Every other status counts, so a board comment on a `backlog` issue wakes its assignee.
4. Manual. `POST /api/agents/:id/wake` uses the `reason` from the body, or `manual`.

`wake()` drops a wake when the target is the caller. An agent that assigns itself an issue, comments on its own issue, or closes a child of an issue it owns starts no run for itself.

A `PATCH` that changes the issue and adds a comment calls `comment()` first, then `notify()`. When both wake the same agent, they merge into one queued run that keeps the first reason, `issue_commented` ([runs.md](runs.md#coalescing)).

## Delegation loop

The system prompt teaches this loop, and `test/orchestration.test.ts` runs it end to end:

1. The board creates an issue, assigns it to the lead and sets `projectId`. The lead wakes with `issue_assigned`.
2. The lead sets `in_progress` and creates child issues with `parentId` set to its issue, each assigned to a report. Each report wakes.
3. A report does the work, comments, and sets `done`, `in_review` or `blocked`. The lead wakes with `child_<status>`.
4. The lead reviews. It reopens or reassigns children, or closes its own issue once every child is done.

## Issue context

`GET /api/issues/:id` returns `issueContext(id)` from `src/db.ts`: the issue row plus `project` (row or `null`), `comments` (the whole thread) and `children` (`id`, `title`, `status`, `assigneeAgentId`). The wake prompt embeds the same JSON, so anything you add to `issueContext()` goes to every agent on every wake. The full thread is sent every time. The `ponytail:` comment there marks that as the first thing to page when threads get long.

## API

| Method | Path | Caller | Notes |
|---|---|---|---|
| POST | `/api/companies/:id/issues` | both | `{title, description?, assigneeAgentId?, parentId?, projectId?, status?}` |
| GET | `/api/companies/:id/issues` | both | `?assigneeAgentId=&projectId=&status=todo,in_progress` |
| GET | `/api/issues/:id` | both | Issue context, see above |
| PATCH | `/api/issues/:id` | both | Any of `title description status assigneeAgentId parentId projectId`, plus `comment`. Returns issue context |
| POST | `/api/issues/:id/comments` | both | `{body}` |

Send `"assigneeAgentId": null` to unassign. Every referenced id must be in the issue's company or the request fails with 422. Nothing checks `parentId` for cycles. There is no `DELETE`; set `cancelled` instead.

## Extending

- A new status needs four edits. Change the `check` in `src/sql/schema.sql` (existing databases need a table rebuild, see [index.md](index.md#schema-changes-have-no-migrations)). Decide which lists in `src/server.ts` include it: `actionable` and the outcome list in `notify()`, the closed list in `comment()`. Update the status line in `systemPrompt()`. Update `SKILL.md` and `README.md`.
- A new wake rule goes in `notify()` or `comment()`. Pass `a.agentId` as the actor so an agent never wakes itself. The reason is free text that the agent reads as `Wake reason: ...`, so name it in words a model understands.
- A new issue field needs the column, `src/sql/issues/insert.sql` plus the insert in `POST`, and `src/sql/issues/update.sql` plus the column list in `PATCH`. `issueContext()` selects `*`, so agents see it without further changes. Add it to the `POST` and `PATCH` lines in `systemPrompt()` if agents should set it.
- Atomic checkout isn't built. Reassigning an issue while its old assignee is mid-run leaves two agents working on it until the first run ends.
