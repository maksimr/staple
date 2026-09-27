# staple

Minimal control plane for teams of AI agents, modeled on [paperclip](../paperclip). Backend only. Agents run through the [`pi`](https://github.com/badlogic/pi-mono) harness.

Node 24 LTS runs the TypeScript directly (type stripping). Storage is the built-in `node:sqlite`. There are no runtime dependencies.

```sh
npm install      # dev deps only: typescript, @types/node
npm start        # http://127.0.0.1:3100, data in ~/.staple
npx /path/to/staple  # same, from anywhere (or `npm link` once, then `staple`)
npm test         # end-to-end orchestration with a fake pi
npm run typecheck
```

Docs for agents extending staple start at [docs/index.md](docs/index.md).

Env: `PORT` (3100), `HOST` (127.0.0.1), `DATA_DIR` (~/.staple), `PI_BIN` (pi), `PI_ARGS` (extra pi flags, e.g. `--yolo`), `RUN_TIMEOUT_SEC` (1800).

## Model

- **Company**: has a name, a description, and an optional `cwd` that all its agents share (default `DATA_DIR/workspaces/<id>`).
- **Agent**: has a name, `role`, `reportsTo` (org tree), `instructions` (appended to pi's system prompt), `model` (passed as `pi --model`), `thinking` (passed as `pi --thinking`), and `status` (`active` or `paused`).
- **Project**: belongs to a company. Has a name, a description, and an optional `cwd`. Runs for the project's issues use that `cwd` instead of the company's.
- **Issue**: belongs to a company. Has a single assignee, an optional parent, an optional project (child issues inherit the parent's), and comments. Statuses: `backlog todo in_progress in_review blocked done cancelled`.
- **Run**: one heartbeat, meaning a single `pi -p --mode json` process. The log is written to `DATA_DIR/runs/<id>.log`. Sessions are stored per agent and issue, so an agent keeps its context across wakes.

## Orchestration

- An issue that becomes actionable (`todo` or `in_progress`) wakes its assignee. This covers new issues, reassignment, and reopening.
- A comment wakes the assignee. Agent comments on closed issues don't.
- A child that moves to `done`, `blocked`, `cancelled` or `in_review` wakes the parent's assignee.
- An agent's own actions never wake that same agent.
- Each agent has at most one live run. Pending wakes for the same agent and issue merge into one run. Paused agents keep their queue until resumed.

A run receives `STAPLE_API_URL`, `STAPLE_API_KEY` (a token that only works while the run is live), `STAPLE_AGENT_ID`, `STAPLE_COMPANY_ID`, `STAPLE_RUN_ID`, `STAPLE_TASK_ID` and `STAPLE_WAKE_REASON`. The appended system prompt gives the agent its org position and a curl cheat-sheet for the API.

## API

Requests without a token act as the board (local trusted mode). Requests with a token act as that agent, and the agent is restricted to its own company.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/companies` | `{name, description?, cwd?}`, board only |
| GET | `/api/companies`, `/api/companies/:id` | |
| POST | `/api/companies/:id/agents` | `{name, role?, reportsTo?, instructions?, model?, thinking?}`, board only |
| GET | `/api/companies/:id/agents`, `/api/agents/:id`, `/api/agents/me` | |
| PATCH | `/api/agents/:id` | `{status: "paused" \| "active", ...}`, board only |
| POST | `/api/agents/:id/wake` | `{issueId?, reason?}` |
| POST | `/api/companies/:id/projects` | `{name, description?, cwd?}`, board only |
| GET | `/api/companies/:id/projects`, `/api/projects/:id` | |
| POST | `/api/companies/:id/issues` | `{title, description?, assigneeAgentId?, parentId?, projectId?, status?}` |
| GET | `/api/companies/:id/issues?assigneeAgentId=&projectId=&status=a,b` | |
| GET | `/api/issues/:id` | issue + project + comments + children |
| PATCH | `/api/issues/:id` | `{status?, assigneeAgentId?, title?, description?, parentId?, projectId?, comment?}` |
| POST | `/api/issues/:id/comments` | `{body}` |
| GET | `/api/companies/:id/runs`, `/api/runs/:id` | |
| POST | `/api/runs/:id/cancel` | board only |

## Quickstart

```sh
A=http://127.0.0.1:3100/api
CO=$(curl -s $A/companies -d '{"name":"Acme"}' | jq -r .id)
PR=$(curl -s $A/companies/$CO/projects -d '{"name":"todo-cli","cwd":"/tmp/todo-cli"}' | jq -r .id)
CEO=$(curl -s $A/companies/$CO/agents -d '{"name":"Ada","role":"ceo","instructions":"Plan and delegate, never code."}' | jq -r .id)
curl -s $A/companies/$CO/agents -d "{\"name\":\"Bob\",\"role\":\"engineer\",\"reportsTo\":\"$CEO\"}"
curl -s $A/companies/$CO/issues -d "{\"title\":\"Build a todo CLI in node\",\"assigneeAgentId\":\"$CEO\",\"projectId\":\"$PR\"}"
watch -n2 "curl -s $A/companies/$CO/runs | jq -c '.[] | [.agentId[:8], .reason, .status]'"
```

## Pi skill

`skills/staple/SKILL.md` lets a regular pi session act as the board. Load it for one session with `pi --skill skills/staple`. To install it for every session, run `ln -s "$PWD/skills/staple" ~/.pi/agent/skills/staple`. Agent runs see it too, but it tells them to ignore it when `STAPLE_RUN_ID` is set.

Not built yet (paperclip has these): budgets and cost tracking, approvals, atomic checkout, timer heartbeats, activity log, and auth for non-local deployments.
