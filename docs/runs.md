# Runs

This page follows an event from an API call to a finished pi process. The code is `src/orchestrator.ts`.

## Fields

A run is one heartbeat: one pi process for one agent, usually on one issue.

Table `runs` in `src/sql/schema.sql`.

| Column | Meaning |
|---|---|
| `id`, `companyId`, `agentId` | |
| `issueId` | The issue the agent woke for. `null` means no issue |
| `reason` | Wake reason, e.g. `issue_assigned`, `child_done`, `manual` |
| `status` | `queued`, `running`, `succeeded`, `failed`, `cancelled` |
| `token` | Bearer key while running. The API never returns it |
| `exitCode` | pi's exit code. `null` when killed by a signal |
| `summary` | Provider error, else the agent's last text, else `killed by <signal>` |
| `createdAt`, `startedAt`, `finishedAt` | |

```
queued ── tick() ──> running ── exit 0, no provider error ────────────> succeeded
  │                    ├────── non-zero exit, provider error, timeout ─> failed
  │                    ├────── server restart ─────────────────────────> failed
  │                    └────── cancel() ───────────────────────────────> cancelled
  └── cancel() ──────────────────────────────────────────────────────> cancelled
```

## Step by step

1. **Event.** A route calls `wake(agentId, issueId, reason, actorAgentId)`. [issues.md](issues.md#wake-rules) lists which routes do.
2. **Queue.** `wake()` returns if the target is the actor. If the agent already has a queued run for the same issue, the new wake merges into it. Otherwise it inserts a `queued` run. Either way it calls `tick()`.
3. **Schedule.** `tick()` takes queued runs whose agent is `active` and has nothing `running`. It starts the oldest one per agent.
4. **Start.** `start()` sets `running` and a fresh token, resolves the working directory ([company.md](company.md#workspace)), creates the workspace, session and log directories, and spawns:

   ```
   $PI_BIN --mode json -p \
     --session $DATA_DIR/sessions/<agentId>/<issueId|inbox>.jsonl \
     --append-system-prompt "<systemPrompt>" \
     [--model <agent.model>] [--thinking <agent.thinking>] [$PI_ARGS...] \
     "<wakePrompt>"
   ```

   The environment carries the `STAPLE_*` variables ([agents.md](agents.md#what-an-agent-sees)). Node kills the process after `RUN_TIMEOUT_SEC`.
5. **Work.** The agent calls the API with its token. Its writes can wake other agents, whose runs start in parallel.
6. **Log.** Every stdout line (pi JSON events) and all of stderr go to `$DATA_DIR/runs/<runId>.log`. staple also writes `[staple] <message>` lines there when spawning fails. It keeps the last `agent_end` event in memory.
7. **Finish.** On `close`, the run succeeded if the exit code is 0 and the last message in `agent_end` doesn't have `stopReason: "error"`. pi exits 0 even when the provider failed, which is why the second check exists. The update only touches rows still `running`, so a cancelled run stays cancelled. Then `tick()` starts the agent's next queued run.

## Concurrency

- Each agent has at most one `running` run. Different agents run in parallel with no global limit.
- One agent's queued runs start in insertion order.
- A wake for an issue the agent is working on right now creates a new queued run, because only queued runs merge. It starts after the current run ends, so the agent sees the change on its next heartbeat.

## Coalescing

`wake()` merges on `(agentId, issueId)` among queued runs. The merged run keeps the reason of the first wake. Ten comments while an agent is busy produce one follow-up run, and that run sees all ten in the issue context.

## Sessions

`--session` points pi at `$DATA_DIR/sessions/<agentId>/<issueId>.jsonl`, or `inbox.jsonl` without an issue. pi appends to it on every run, so the agent remembers its earlier heartbeats on the same issue. Delete the file to give an agent a clean start on that issue.

## Cancel, timeout, restart

- **Cancel.** `POST /api/runs/:id/cancel` (board only) sets a queued or running run to `cancelled` and sends the process SIGTERM. The `close` handler leaves the status alone and calls `tick()`.
- **Timeout.** Node sends SIGTERM after `RUN_TIMEOUT_SEC`. The run ends `failed` with summary `killed by SIGTERM`.
- **Spawn error.** If `PI_BIN` can't start, the run ends `failed` with a negative exit code and the error in its log.
- **Restart.** `recover()` runs when the server starts listening. It marks every `running` run `failed` with summary `server restarted`, then calls `tick()`. Queued runs survive and start. staple doesn't retry the failed run; wake the agent again with the same `issueId`.

## Watching runs

`GET /api/companies/:id/runs` returns the latest 100, newest first. `GET /api/runs/:id` returns one. `skills/staple/SKILL.md` has `jq` commands for reading run logs.

## Extending

- Code that must run when a run ends (cost tracking, retries, notifications) goes in the `close` handler inside `start()`.
- A global concurrency limit goes in `tick()`: count `running` runs before starting more.
- Timer heartbeats aren't built. `wake(agentId, null, "timer")` is the call a scheduler would make.
- To use a harness other than pi, see [agents.md](agents.md#extending).
- Don't call `start()` directly. Go through `wake()` so the one-run-per-agent and pause rules hold.
