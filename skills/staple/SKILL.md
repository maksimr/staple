---
name: staple
description: Operate a local staple server as the board (human operator). Use when the user wants to create or inspect staple companies, agents, projects or issues, assign work to an agent team, watch agent runs, read run logs, comment on issues, pause agents or cancel runs. Not for the upstream Paperclip product.
---

# staple board

staple is a small control plane that runs teams of `pi` agents. You act for the board, the human who owns the companies. You create the org, hand out work, watch it progress, and step in when needed.

If `STAPLE_RUN_ID` is set in your environment, you are an agent inside a staple run, not the board. Stop using this skill and follow your system prompt.

## Connecting

- Base URL is `${STAPLE_URL:-http://127.0.0.1:3100}`. Every endpoint is under `/api`.
- Board requests carry no auth header. The server trusts local callers as the board.
- Server data lives in `${DATA_DIR:-~/.staple}`. Run logs are in `runs/<runId>.log` under that directory.
- The server code is two directories above this skill file (`../..`).

Check the server first:

```bash
curl -sS "${STAPLE_URL:-http://127.0.0.1:3100}/api/health"
```

If the connection is refused, ask the user before starting it. Then start it from the repo root with `nohup npm start > /tmp/staple.log 2>&1 &` and check health again.

Send JSON with curl. Pipe the output through `jq` and summarize it for the user instead of pasting raw JSON:

```bash
U=${STAPLE_URL:-http://127.0.0.1:3100}/api
curl -sS "$U/companies" | jq -c '.[] | {id, name}'
curl -sS -X POST "$U/companies" -H 'Content-Type: application/json' -d '{"name":"Acme"}'
```

Every bash call starts a fresh shell, so set `U` again in each command. Build JSON bodies that contain user text with `jq -n --arg` so quotes don't break them.

## API

| Method | Path | Body or query |
|---|---|---|
| POST | `/companies` | `{name, description?, cwd?}` |
| GET | `/companies`, `/companies/:id` | |
| POST | `/companies/:id/agents` | `{name, role?, reportsTo?, instructions?, model?, thinking?}` |
| GET | `/companies/:id/agents`, `/agents/:id` | |
| PATCH | `/agents/:id` | `{status: "paused" or "active", name?, role?, reportsTo?, instructions?, model?, thinking?}` |
| POST | `/agents/:id/wake` | `{issueId?, reason?}` |
| POST | `/companies/:id/projects` | `{name, description?, cwd?}` |
| GET | `/companies/:id/projects`, `/projects/:id` | |
| POST | `/companies/:id/issues` | `{title, description?, assigneeAgentId?, projectId?, parentId?, status?}` |
| GET | `/companies/:id/issues` | `?assigneeAgentId=&projectId=&status=todo,in_progress` |
| GET | `/issues/:id` | returns the issue with its project, comments and children |
| PATCH | `/issues/:id` | `{status?, assigneeAgentId?, title?, description?, projectId?, parentId?, comment?}` |
| POST | `/issues/:id/comments` | `{body}` |
| GET | `/companies/:id/runs`, `/runs/:id` | the list returns the latest 100 runs, newest first |
| POST | `/runs/:id/cancel` | |

Issue statuses are `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done` and `cancelled`. Agent `model` goes straight to `pi --model`, for example `anthropic/claude-sonnet-4-5`, and `thinking` to `pi --thinking`, for example `high`. Leave either empty to use the user's pi default.

Errors come back as `{"error": "..."}`. A 422 means a missing field or an id from another company. A 400 means bad JSON or an invalid status value.

## What starts agent runs

Each run is a real `pi` process and spends tokens. Know what triggers one before you write anything:

- An issue with an assignee that becomes `todo` or `in_progress` wakes that assignee. This covers creating it, reassigning it, and reopening it.
- A board comment wakes the issue's assignee, even on a closed issue.
- When a child issue moves to `done`, `blocked`, `cancelled` or `in_review`, the assignee of the parent issue wakes up.
- `POST /agents/:id/wake` starts a run by hand.

Create an issue with `"status":"backlog"` to stage it without starting a run. Move it to `todo` when the user wants work to begin. A paused agent keeps its queued runs and starts them when set back to `active`.

## Common jobs

Set up a team. Create the company, then the lead agent (for example `role: "ceo"`), then its reports with `reportsTo` set to the lead's id. Put each agent's standing orders in `instructions`. Add a project with a `cwd` pointing at the repo the team should work in, since runs for that project's issues start there. Confirm the roster with the user before creating agents.

Hand out work. Create one issue with a clear title and description, assign it to the lead, and set `projectId`. The lead splits it into child issues for its reports, and those children inherit the project.

Report status. Show the issue tree and recent runs:

```bash
U=${STAPLE_URL:-http://127.0.0.1:3100}/api
curl -sS "$U/issues/$ISSUE" | jq '{title, status, children, comments: [.comments[] | {authorAgentId, body}]}'
curl -sS "$U/companies/$CO/runs" | jq -c '.[:10][] | {id, agentId, issueId, reason, status, summary}'
```

Resolve agent ids to names with `GET /companies/:id/agents`. Never show bare UUIDs to the user.

Dig into a run. The run's `summary` holds the agent's final message. For more detail, read the log. It is pi JSON output mixed with stderr lines, so parse with `jq -R 'fromjson?'`:

```bash
L=${DATA_DIR:-~/.staple}/runs/$RUN.log
jq -Rr 'fromjson? | select(.type=="tool_execution_start") | "\(.toolName): \(.args.command // .args | tostring | .[0:200])"' "$L"
jq -Rr 'fromjson? | select(.type=="message_end" and .message.role=="assistant") | .message.content[]? | select(.type=="text") | .text' "$L"
```

Step in. You have these moves:

- Comment on the issue to give direction. This wakes the assignee.
- PATCH `assigneeAgentId` to reassign.
- PATCH `status: "todo"` to reopen.
- PATCH the agent to `paused` to stop new runs.
- `POST /runs/:id/cancel` to kill a live run.

A failed run with summary `server restarted` died with the server. Wake the agent again with the issue id.

## Rules

- Do what the user asked and nothing more. If a write the user didn't spell out would start runs, cancel runs, pause agents or change the org, ask first. Reads need no confirmation.
- Before a PATCH or comment, fetch the current issue or agent so you act on fresh state.
- Don't do an agent's assigned work yourself unless the user asks. Comment or reassign instead.
