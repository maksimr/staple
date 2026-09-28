import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Agent, Company, Issue, Orchestrator, Run, Store } from "./types.ts";

export type Config = {
  dataDir: string; // workspaces, sessions and run logs
  piBin: string;
  piArgs: string[]; // extra flags for every run, e.g. "--yolo" or "--no-skills"
  timeoutMs: number;
};

/** Runs agents as pi processes. They get STAPLE_API_URL from process.env, which the server sets once it listens. */
export class PiOrchestrator implements Orchestrator {
  #store: Store;
  #config: Config;
  #procs = new Map<string, ChildProcess>();

  constructor(store: Store, config: Config) {
    this.#store = store;
    this.#config = config;
  }

  wake(agentId: string, issueId: string | null, reason: string, actorAgentId?: string) {
    if (agentId === actorAgentId) return; // an agent's own actions never wake itself
    if (!this.#store.runQueued(agentId, issueId)) this.#store.runInsert({ issueId, reason, agentId });
    this.tick();
  }

  tick() {
    const started = new Set<string>();
    for (const r of this.#store.runReady()) {
      if (started.has(r.agentId)) continue;
      started.add(r.agentId);
      this.#start(r);
    }
  }

  cancel(runId: string) {
    this.#store.runCancel(runId);
    this.#procs.get(runId)?.kill();
  }

  recover() {
    this.#store.runRecover();
    this.tick();
  }

  /** Wake the assignee on new actionable work, wake the parent's assignee on child outcomes. */
  issueChanged(before: Issue | undefined, issue: Issue, actorAgentId?: string) {
    const actionable = (i?: Issue) => i?.status === "todo" || i?.status === "in_progress";
    if (issue.assigneeAgentId && actionable(issue) && (issue.assigneeAgentId !== before?.assigneeAgentId || !actionable(before))) {
      this.wake(issue.assigneeAgentId, issue.id, "issue_assigned", actorAgentId);
    }
    if (issue.parentId && issue.status !== before?.status && ["done", "blocked", "cancelled", "in_review"].includes(issue.status)) {
      const parent = this.#store.issueGet(issue.parentId);
      if (parent?.assigneeAgentId) this.wake(parent.assigneeAgentId, parent.id, `child_${issue.status}`, actorAgentId);
    }
  }

  commented(issue: Issue, actorAgentId?: string) {
    // Agent chatter on closed issues stays inert; the board can always reopen a conversation.
    if (issue.assigneeAgentId && (!actorAgentId || !["done", "cancelled"].includes(issue.status))) {
      this.wake(issue.assigneeAgentId, issue.id, "issue_commented", actorAgentId);
    }
  }

  #start(r: Run) {
    const token = randomBytes(32).toString("hex");
    this.#store.runStart(r.id, token);
    const agent = this.#store.agentGet(r.agentId)!;
    const company = this.#store.companyGet(r.companyId)!;
    const project = r.issueId ? this.#store.projectForIssue(r.issueId) : undefined;
    const cwd = project?.cwd ?? company.cwd ?? join(this.#config.dataDir, "workspaces", company.id);
    const session = join(this.#config.dataDir, "sessions", agent.id, `${r.issueId ?? "inbox"}.jsonl`); // continuity per agent+issue
    const logPath = join(this.#config.dataDir, "runs", `${r.id}.log`);
    for (const dir of [cwd, dirname(session), dirname(logPath)]) mkdirSync(dir, { recursive: true });

    const args = [
      "--mode", "json", "-p",
      "--session", session,
      "--append-system-prompt", systemPrompt(this.#store, agent, company),
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.thinking ? ["--thinking", agent.thinking] : []),
      ...this.#config.piArgs,
      wakePrompt(this.#store, r),
    ];
    const child = spawn(this.#config.piBin, args, {
      cwd,
      timeout: this.#config.timeoutMs,
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
    this.#procs.set(r.id, child);

    const log = createWriteStream(logPath);
    let end: PiAgentEnd | undefined;
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
      this.#procs.delete(r.id);
      log.end();
      const last = end?.messages?.at(-1);
      const text = typeof last?.content === "string"
        ? last.content
        : (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      // pi exits 0 even when the provider failed; the last message carries the error.
      const ok = code === 0 && last?.stopReason !== "error";
      this.#store.runFinish({
        id: r.id, status: ok ? "succeeded" : "failed", exitCode: code,
        summary: last?.errorMessage || text || (signal ? `killed by ${signal}` : null),
      });
      this.tick();
    });
  }
}


/** The parts of pi's final `agent_end` event staple reads. */
type PiAgentEnd = {
  messages?: { content?: string | { type: string; text?: string }[]; stopReason?: string; errorMessage?: string }[];
};

function systemPrompt(store: Store, agent: Agent, company: Company) {
  const boss = agent.reportsTo ? store.agentGet(agent.reportsTo) : undefined;
  const reports = store.agentReports(agent.id);
  const who = (a: Pick<Agent, "id" | "name" | "role">) => `${a.name} (${a.role ? `${a.role}, ` : ""}id ${a.id})`;
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

function wakePrompt(store: Store, r: Run) {
  const issue = r.issueId ? store.issueContext(r.issueId) : undefined;
  return `Wake reason: ${r.reason}\n` + (issue
    ? `Issue:\n${JSON.stringify(issue, null, 2)}`
    : "No specific issue. Check your open assigned issues and continue.");
}
