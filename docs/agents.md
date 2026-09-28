# Agents

An agent is a named pi configuration inside a company. It has no long-lived process. staple spawns pi for it every time it wakes and the process exits when the heartbeat is over ([runs.md](runs.md)).

## Fields

Table `agents` in `src/sql/schema.sql`.

| Column | Default | Meaning |
|---|---|---|
| `id` | uuid | |
| `companyId` | required | |
| `name` | required | |
| `role` | `''` | Free text. See below |
| `reportsTo` | `null` | Manager's agent id. `null` means the agent reports to the board |
| `instructions` | `''` | Standing orders, placed in the system prompt |
| `model` | `null` | Passed as `pi --model`, e.g. `anthropic/claude-sonnet-4-5`. `null` uses pi's default |
| `thinking` | `null` | Passed as `pi --thinking`, e.g. `high`. `null` uses pi's default |
| `status` | `'active'` | `active` or `paused` |
| `createdAt` | now | |

The server never branches on `role`. It only shows up in prompts, as `Ada (ceo, id ...)` for the agent itself and in the boss and reports lines. An empty role is left out. A CEO and an engineer behave differently because of their `instructions` and how the model reads the role. `test/fake-pi.ts` branches on `role === "ceo"`, but that is test code.

`reportsTo` builds the org tree. staple checks that the manager is in the same company. It doesn't check for cycles.

A paused agent keeps its queued runs and `tick()` skips them. Pausing doesn't stop a run that is already going; cancel it with `POST /api/runs/:id/cancel`. `PATCH /api/agents/:id` always calls `tick()`, so setting `active` starts the queue right away.

## What an agent sees

`start()` gives pi two texts.

The system prompt comes from `systemPrompt(agent, company)` and goes in through `--append-system-prompt`. pi keeps its own base prompt and adds this after it. It contains:

- the agent's name, role and id, the company name and description
- its manager (or "the board") and its direct reports, with ids
- `instructions`
- "How you work": heartbeats, auth headers, and the list of endpoints agents may call
- "Rules": set `in_progress` when starting, delegate with child issues, don't poll, and end every run with a comment and a final status

The user message comes from `wakePrompt(run)`. It is `Wake reason: <reason>` followed by the issue JSON from `issueContext()`, or a note to check open issues when the run has no issue.

The process environment is the server's environment plus:

| Env | Value |
|---|---|
| `STAPLE_API_URL` | Server base URL, e.g. `http://127.0.0.1:3100` |
| `STAPLE_API_KEY` | Bearer token, valid while this run is `running` |
| `STAPLE_AGENT_ID` | The agent's id |
| `STAPLE_COMPANY_ID` | The agent's company |
| `STAPLE_RUN_ID` | This run |
| `STAPLE_TASK_ID` | The issue id, or `''` |
| `STAPLE_WAKE_REASON` | Same as the wake reason in the prompt |

Provider API keys in the server's environment reach every run. pi also loads its usual resources for the run's `cwd`: context files such as `AGENTS.md`, skills, extensions and settings. Use `PI_ARGS` (e.g. `--no-skills`) to change that for every run. The board skill in `skills/staple` tells agents to ignore it when `STAPLE_RUN_ID` is set.

## Memory

An agent remembers earlier heartbeats only through its pi session file, `$DATA_DIR/sessions/<agentId>/<issueId>.jsonl` (`inbox.jsonl` for runs without an issue). There is one file per agent per issue. The agent resumes its own context when it returns to an issue and starts clean on a new one. Anything another agent needs must go into the issue (comments, description, child issues) or into files in the workspace.

## Auth and permissions

`actorOf(req)` in `src/server.ts` decides who is calling:

- No `Authorization` header: the board, `{}`.
- `Bearer <token>`: finds the run with that token and `status = 'running'` and returns `{agentId, companyId}`. No match returns 401.

`start()` creates the token (32 random bytes, hex) and stores it in `runs.token`. The API never returns it, because the run queries in `src/sql/runs/` (`get.sql`, `list.sql`) list their columns and leave it out. The token stops working as soon as the run leaves `running`.

| Action | Board | Agent |
|---|---|---|
| Create company, agent or project | yes | 403 |
| `PATCH /api/agents/:id` (edit, pause) | yes | 403 |
| Cancel a run | yes | 403 |
| Read | every company | own company only |
| Create or `PATCH` issues, comment | yes | any issue in its company |
| Wake an agent | yes | agents in its company. Waking itself does nothing |
| `GET /api/agents/me` | 400 | yes |

Agents have no ownership check on issues. An agent can edit, close or reassign an issue that belongs to someone else. The system prompt asks them not to; the server doesn't stop them.

## API

| Method | Path | Caller | Notes |
|---|---|---|---|
| POST | `/api/companies/:id/agents` | board | `{name, role?, reportsTo?, instructions?, model?, thinking?}` |
| GET | `/api/companies/:id/agents` | both | |
| GET | `/api/agents/me` | agent | |
| GET | `/api/agents/:id` | both | |
| PATCH | `/api/agents/:id` | board | Any of `name role reportsTo instructions model thinking status`. Bad `status` is 400 |
| POST | `/api/agents/:id/wake` | both | `{issueId?, reason?}`. `reason` defaults to `manual` |

The router takes the first route that matches. `/api/agents/me` sits above `/api/agents/([^/]+)` for that reason. Put specific paths above patterns.

## Extending

- To change what every agent is told, edit `systemPrompt()` in `src/orchestrator.ts`. Keep its endpoint list in step with `routes`.
- To pass a new per-agent setting to pi (tools, extra flags), add a column, add it to `src/sql/agents/insert.sql` and `POST /api/companies/:id/agents`, and to `src/sql/agents/update.sql` and the column list in `PATCH /api/agents/:id`, then push the flag onto `args` in `start()` the way `model` is.
- Per-agent environment variables and secrets don't exist. A run gets the server's environment plus the `STAPLE_*` variables.
- To run something other than pi, change the `args` in `start()` and the end-of-run parsing in its `close` handler, which reads pi's `agent_end` event. `test/fake-pi.ts` is the smallest program that ends a run as `succeeded` with a summary: read the `STAPLE_*` env, call the API, print one `{"type":"agent_end","messages":[...]}` line on stdout, exit 0.
