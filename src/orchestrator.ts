import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DATA_DIR, all, issueContext, one, run, type Row } from "./db.ts";

const PI_BIN = process.env.PI_BIN ?? "pi";
const PI_ARGS = process.env.PI_ARGS?.split(" ").filter(Boolean) ?? []; // e.g. "--yolo" or "--no-skills"
const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_SEC ?? 1800) * 1000;
const procs = new Map<string, ChildProcess>();

/** Queue a heartbeat for an agent. Pending wakes for the same agent+issue coalesce into one run. */
export function wake(agentId: string, issueId: string | null, reason: string, actorAgentId?: string) {
  if (agentId === actorAgentId) return; // an agent's own actions never wake itself
  const queued = one("select 1 from runs where agentId = ? and issueId is ? and status = 'queued'", agentId, issueId);
  if (!queued) {
    run(
      "insert into runs (id, companyId, agentId, issueId, reason) select ?, companyId, id, ?, ? from agents where id = ?",
      randomUUID(), issueId, reason, agentId,
    );
  }
  tick();
}

/** Start queued runs: one live run per agent, paused agents wait. */
export function tick() {
  const ready = all(`
    select r.* from runs r join agents a on a.id = r.agentId
    where r.status = 'queued' and a.status = 'active'
      and not exists (select 1 from runs x where x.agentId = r.agentId and x.status = 'running')
    order by r.rowid`);
  const started = new Set<string>();
  for (const r of ready) {
    if (started.has(r.agentId)) continue;
    started.add(r.agentId);
    start(r);
  }
}

export function cancel(runId: string) {
  run("update runs set status = 'cancelled', finishedAt = current_timestamp where id = ? and status in ('queued', 'running')", runId);
  procs.get(runId)?.kill();
}

/** Runs that were live when the server died can't be resumed; fail them and move on. */
export function recover() {
  run("update runs set status = 'failed', summary = 'server restarted', finishedAt = current_timestamp where status = 'running'");
  tick();
}

function start(r: Row) {
  const token = randomBytes(32).toString("hex");
  run("update runs set status = 'running', token = ?, startedAt = current_timestamp where id = ?", token, r.id);
  const agent = one("select * from agents where id = ?", r.agentId)!;
  const company = one("select * from companies where id = ?", r.companyId)!;
  const project = one("select p.* from projects p join issues i on i.projectId = p.id where i.id = ?", r.issueId);
  const cwd = project?.cwd ?? company.cwd ?? join(DATA_DIR, "workspaces", company.id);
  const session = join(DATA_DIR, "sessions", agent.id, `${r.issueId ?? "inbox"}.jsonl`); // continuity per agent+issue
  const logPath = join(DATA_DIR, "runs", `${r.id}.log`);
  for (const dir of [cwd, dirname(session), dirname(logPath)]) mkdirSync(dir, { recursive: true });

  const args = [
    "--mode", "json", "-p",
    "--session", session,
    "--append-system-prompt", systemPrompt(agent, company),
    ...(agent.model ? ["--model", agent.model] : []),
    ...(agent.thinking ? ["--thinking", agent.thinking] : []),
    ...PI_ARGS,
    wakePrompt(r),
  ];
  const child = spawn(PI_BIN, args, {
    cwd,
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      STAPLE_API_KEY: token,
      STAPLE_AGENT_ID: agent.id,
      STAPLE_COMPANY_ID: company.id,
      STAPLE_RUN_ID: r.id,
      STAPLE_TASK_ID: r.issueId ?? "",
      STAPLE_WAKE_REASON: r.reason,
    },
  });
  procs.set(r.id, child);

  const log = createWriteStream(logPath);
  let end: Row | undefined; // pi's final `agent_end` event
  child.stderr.pipe(log, { end: false });
  createInterface({ input: child.stdout }).on("line", (line) => {
    log.write(line + "\n");
    try {
      const event = JSON.parse(line);
      if (event.type === "agent_end") end = event;
    } catch {}
  });
  child.on("error", (err) => log.write(`[staple] ${err.message}\n`));
  child.on("close", (code, signal) => {
    procs.delete(r.id);
    log.end();
    const last = end?.messages?.at(-1);
    const text = typeof last?.content === "string"
      ? last.content
      : (last?.content ?? []).filter((c: Row) => c.type === "text").map((c: Row) => c.text).join("");
    // pi exits 0 even when the provider failed; the last message carries the error.
    const ok = code === 0 && last?.stopReason !== "error";
    run(
      "update runs set status = ?, exitCode = ?, summary = ?, finishedAt = current_timestamp where id = ? and status = 'running'",
      ok ? "succeeded" : "failed", code, last?.errorMessage || text || (signal ? `killed by ${signal}` : null), r.id,
    );
    tick();
  });
}

function systemPrompt(agent: Row, company: Row) {
  const boss = agent.reportsTo ? one("select id, name, role from agents where id = ?", agent.reportsTo) : undefined;
  const reports = all("select id, name, role from agents where reportsTo = ?", agent.id);
  const who = (a: Row) => `${a.name} (${a.role ? `${a.role}, ` : ""}id ${a.id})`;
  return `
# staple

You are agent ${who(agent)} in company "${company.name}".
Company description: ${company.description || "(none)"}
You report to: ${boss ? who(boss) : "the board (human operator)"}
Your direct reports: ${reports.map(who).join("; ") || "none"}

${agent.instructions}

## How you work
You run in short heartbeats: you are woken with a reason and an issue, do the work, record the outcome, exit.
Coordinate only through the control-plane HTTP API below, using curl from bash. Use only these endpoints.
Every request: -H "Authorization: Bearer $STAPLE_API_KEY" -H "Content-Type: application/json", base URL $STAPLE_API_URL.

GET   /api/agents/me
GET   /api/companies/$STAPLE_COMPANY_ID/agents
GET   /api/companies/$STAPLE_COMPANY_ID/projects
GET   /api/companies/$STAPLE_COMPANY_ID/issues?assigneeAgentId=<id>&projectId=<id>&status=todo,in_progress
GET   /api/issues/<id>                                 issue + project + comments + children
POST  /api/companies/$STAPLE_COMPANY_ID/issues      {"title","description","assigneeAgentId","parentId","projectId"}
PATCH /api/issues/<id>                                 {"status","assigneeAgentId","comment"}
POST  /api/issues/<id>/comments                        {"body"}

Issue statuses: backlog, todo, in_progress, in_review, blocked, done, cancelled.

## Rules
- Work on issues assigned to you. Set in_progress when you start.
- If you have reports, delegate: create child issues (parentId = your issue) assigned to the right report.
  You are woken again when a child becomes done, blocked, cancelled or in_review. Review it, then continue,
  re-assign, or close your issue once all children are done.
- Do real work in this heartbeat. Do not poll or wait for other agents; exit and you will be woken.
- Before exiting, comment what you did and set a final status: done, in_review, or blocked (say why and who can unblock).
`;
}

function wakePrompt(r: Row) {
  const issue = r.issueId ? issueContext(r.issueId) : undefined;
  return `Wake reason: ${r.reason}\n` + (issue
    ? `Issue:\n${JSON.stringify(issue, null, 2)}`
    : "No specific issue. Check your open assigned issues and continue.");
}
