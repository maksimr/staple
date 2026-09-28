# staple

staple is a control plane for teams of AI agents. It stores companies, agents, projects and issues in SQLite and turns issue events into `pi` runs. Each run is one `pi -p --mode json` process. The agent inside that process talks back to staple over HTTP with curl.

The server is three files with no runtime dependencies. These docs describe the code as it is. If a doc and the code disagree, the code is right and the doc needs a fix.

## Which doc to read

| Task | Read |
|---|---|
| Company fields, shared workspace, tenant scoping | [company.md](company.md) |
| Projects and per-repo working directories | [projects.md](projects.md) |
| Agent fields, org tree, prompts, auth and permissions | [agents.md](agents.md) |
| Issue fields, statuses, comments, wake rules, delegation | [issues.md](issues.md) |
| Runs, queueing, the pi process, sessions, logs, restart | [runs.md](runs.md) |

Read [runs.md](runs.md) before changing anything that calls `wake()`. Every wake starts a real pi process that spends tokens.

## Source map

| File | Contents |
|---|---|
| `src/db.ts` | `one`/`all`/`run` helpers that take imported SQL and a `$param` object, `issueContext()` |
| `src/sql/` | `schema.sql`, plus one file per statement grouped by table, e.g. `issues/get.sql` |
| `src/server.ts` | HTTP routes, auth (`actorOf`, `scoped`, `boardOnly`, `inCompany`), wake rules (`notify`, `comment`), startup |
| `src/orchestrator.ts` | Run queue (`wake`, `tick`, `cancel`, `recover`), pi spawn (`start`), prompts (`systemPrompt`, `wakePrompt`) |
| `test/orchestration.test.ts` | End-to-end test with a real server and a fake pi |
| `test/fake-pi.ts` | Stands in for `pi`. Acts through the API based on the agent's role |
| `skills/staple/SKILL.md` | pi skill that lets a normal pi session act as the board |

## Data model

```
company            name, description, cwd
├── agents         role, reportsTo (tree), instructions, model, thinking, status
├── projects       name, description, cwd
├── issues         title, status, assigneeAgentId, parentId (tree), projectId
│   └── comments   body, authorAgentId (null = board)
└── runs           agentId, issueId, reason, status, token (while running)
```

## Callers

A request with no `Authorization` header comes from the board, the human operator. staple trusts any local caller as the board. A request with `Authorization: Bearer <token>` comes from an agent, and the token must belong to a run that is still `running`. Details in [agents.md](agents.md#auth-and-permissions).

## Configuration

| Env | Default | Used by |
|---|---|---|
| `PORT` | `3100` | server. `0` picks a free port (tests use this) |
| `HOST` | `127.0.0.1` | server |
| `DATA_DIR` | `~/.staple` | db, workspaces, sessions, logs |
| `PI_BIN` | `pi` | executable spawned for each run |
| `PI_ARGS` | empty | extra pi flags for every run, split on spaces, e.g. `--yolo` |
| `RUN_TIMEOUT_SEC` | `1800` | kill a run after this many seconds |

## Data directory

```
$DATA_DIR/
├── db.sqlite                            all tables
├── workspaces/<companyId>/              default company cwd
├── sessions/<agentId>/<issueId>.jsonl   pi session per agent and issue (inbox.jsonl when no issue)
└── runs/<runId>.log                     pi JSON events and stderr
```

## Conventions

- Node 24 runs `.ts` files directly by stripping types. `tsconfig.json` sets `erasableSyntaxOnly`, so `enum`, `namespace` and constructor parameter properties won't run. Import local files with the `.ts` extension.
- No runtime dependencies. Use `node:*` modules. The only dev dependencies are `typescript` and `@types/node`.
- SQL lives in `src/sql/`, one statement per file with `$name` placeholders. Import it where it runs: `import getIssue from "./sql/issues/get.sql" with { type: "text" }`, then `one(getIssue, { id })`. Text imports need Node 24.19+ and `--experimental-import-text`, which the npm scripts and the shebang pass. Columns are camelCase, ids come from `randomUUID()`, timestamps are SQLite `current_timestamp` (UTC, `YYYY-MM-DD HH:MM:SS`).
- Route handlers return rows and the server JSON-encodes them. Errors go through `fail(status, message)`.
- A `// ponytail:` comment marks a known shortcut and names its limit. Update it when you change the code around it.
- staple copies ideas from paperclip (`../paperclip`) and only builds what a task needs.

## Verify a change

```sh
npm run typecheck
npm test
```

`npm test` starts the server on a free port with a temp `DATA_DIR` and `PI_BIN=test/fake-pi.ts`. It needs no model and no network. To test new behavior, teach `fake-pi.ts` what to do (it branches on `role` today) and assert the result in `orchestration.test.ts`.

## Keep the API docs in sync

The API is written down in four places, one per reader. When you add or change an endpoint, update each one that applies:

1. `routes` in `src/server.ts`
2. The endpoint list in `systemPrompt()` in `src/orchestrator.ts`, if agents may call it
3. The API table in `skills/staple/SKILL.md`, if the board may call it
4. The API table in `README.md`

## Schema changes have no migrations

`db.ts` runs `src/sql/schema.sql` (`create table if not exists`) at startup. A new column or a changed `check` constraint never reaches an existing `db.sqlite`. In development, delete `$DATA_DIR/db.sqlite`. To keep data, add an `alter table ... add column` that skips when the column exists. SQLite can't alter a `check` constraint, so changing one on a live database means rebuilding the table.

## Not built

The README lists what paperclip has and staple lacks: budgets and cost tracking, approvals, atomic checkout, timer heartbeats, an activity log, and auth for non-local deployments. The code also has no deletes, no `PATCH` for companies or projects, and no cycle checks on `reportsTo` or `parentId`.
