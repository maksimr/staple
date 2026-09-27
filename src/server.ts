#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { RUN_COLS, all, issueContext, one, run, type Row } from "./db.ts";
import { cancel, recover, tick, wake } from "./orchestrator.ts";

/** Board = no token (local trusted, like paperclip's local_trusted mode). Agent = live run token. */
type Actor = { agentId?: string; companyId?: string };
type Ctx = { a: Actor; p: string[]; body: Row; q: URLSearchParams };

const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const need = (v: unknown, name: string) => (typeof v === "string" && v.trim() ? v : fail(422, `${name} is required`));
const get = (table: "companies" | "agents" | "projects" | "issues", id: string) => one(`select * from ${table} where id = ?`, id);
const getRun = (id: string) => one(`select ${RUN_COLS} from runs where id = ?`, id);

function actorOf(req: IncomingMessage): Actor {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return {};
  return one("select agentId, companyId from runs where token = ? and status = 'running'", token) ?? fail(401, "invalid or expired token");
}

/** 404 if missing, 403 if an agent reaches outside its company. */
function scoped(a: Actor, row: Row | undefined, companyId = row?.companyId): Row {
  if (!row) return fail(404, "not found");
  if (a.companyId && a.companyId !== companyId) fail(403, "forbidden");
  return row;
}
const company = (a: Actor, id: string) => scoped(a, get("companies", id), id);
const boardOnly = (a: Actor) => a.agentId && fail(403, "board only");

function inCompany(companyId: string, table: "agents" | "projects" | "issues", id: unknown) {
  if (id != null && !one(`select 1 from ${table} where id = ? and companyId = ?`, id as string, companyId)) {
    fail(422, `${table} ${id} not found in company`);
  }
}

function update(table: "agents" | "issues", id: string, body: Row, cols: string[]) {
  const keys = cols.filter((k) => k in body);
  if (keys.length) run(`update ${table} set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`, ...keys.map((k) => body[k]), id);
}

function comment(a: Actor, issue: Row, body: string) {
  const id = randomUUID();
  run("insert into comments (id, issueId, authorAgentId, body) values (?, ?, ?, ?)", id, issue.id, a.agentId ?? null, body);
  // Agent chatter on closed issues stays inert; the board can always reopen a conversation.
  if (issue.assigneeAgentId && (!a.agentId || !["done", "cancelled"].includes(issue.status))) {
    wake(issue.assigneeAgentId, issue.id, "issue_commented", a.agentId);
  }
  return one("select * from comments where id = ?", id);
}

/** Orchestration rules: wake the assignee on new actionable work, wake the parent's assignee on child outcomes. */
function notify(a: Actor, before: Row | undefined, issue: Row) {
  const actionable = (i?: Row) => ["todo", "in_progress"].includes(i?.status);
  if (issue.assigneeAgentId && actionable(issue) && (issue.assigneeAgentId !== before?.assigneeAgentId || !actionable(before))) {
    wake(issue.assigneeAgentId, issue.id, "issue_assigned", a.agentId);
  }
  if (issue.parentId && issue.status !== before?.status && ["done", "blocked", "cancelled", "in_review"].includes(issue.status)) {
    const parent = get("issues", issue.parentId);
    if (parent?.assigneeAgentId) wake(parent.assigneeAgentId, parent.id, `child_${issue.status}`, a.agentId);
  }
}

const routes: [string, RegExp, (c: Ctx) => unknown][] = [
  ["GET", /^\/api\/health$/, () => ({ ok: true })],

  ["POST", /^\/api\/companies$/, ({ a, body }) => {
    boardOnly(a);
    const id = randomUUID();
    run("insert into companies (id, name, description, cwd) values (?, ?, ?, ?)", id, need(body.name, "name"), body.description ?? "", body.cwd ?? null);
    return get("companies", id);
  }],
  ["GET", /^\/api\/companies$/, ({ a }) =>
    a.companyId ? all("select * from companies where id = ?", a.companyId) : all("select * from companies order by rowid")],
  ["GET", /^\/api\/companies\/([^/]+)$/, ({ a, p }) => company(a, p[0])],

  ["POST", /^\/api\/companies\/([^/]+)\/agents$/, ({ a, p, body }) => {
    boardOnly(a);
    company(a, p[0]);
    inCompany(p[0], "agents", body.reportsTo);
    const id = randomUUID();
    run(
      "insert into agents (id, companyId, name, role, reportsTo, instructions, model, thinking) values (?, ?, ?, ?, ?, ?, ?, ?)",
      id, p[0], need(body.name, "name"), body.role ?? "", body.reportsTo ?? null, body.instructions ?? "", body.model ?? null, body.thinking ?? null,
    );
    return get("agents", id);
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/agents$/, ({ a, p }) => {
    company(a, p[0]);
    return all("select * from agents where companyId = ? order by rowid", p[0]);
  }],
  ["GET", /^\/api\/agents\/me$/, ({ a }) => get("agents", a.agentId ?? fail(400, "not an agent"))],
  ["GET", /^\/api\/agents\/([^/]+)$/, ({ a, p }) => scoped(a, get("agents", p[0]))],
  ["PATCH", /^\/api\/agents\/([^/]+)$/, ({ a, p, body }) => {
    boardOnly(a);
    const agent = scoped(a, get("agents", p[0]));
    inCompany(agent.companyId, "agents", body.reportsTo);
    update("agents", agent.id, body, ["name", "role", "reportsTo", "instructions", "model", "thinking", "status"]);
    tick(); // resuming a paused agent releases its queued runs
    return get("agents", agent.id);
  }],
  ["POST", /^\/api\/agents\/([^/]+)\/wake$/, ({ a, p, body }) => {
    const agent = scoped(a, get("agents", p[0]));
    inCompany(agent.companyId, "issues", body.issueId);
    wake(agent.id, body.issueId ?? null, body.reason ?? "manual", a.agentId);
    return { ok: true };
  }],

  ["POST", /^\/api\/companies\/([^/]+)\/projects$/, ({ a, p, body }) => {
    boardOnly(a);
    company(a, p[0]);
    const id = randomUUID();
    run(
      "insert into projects (id, companyId, name, description, cwd) values (?, ?, ?, ?, ?)",
      id, p[0], need(body.name, "name"), body.description ?? "", body.cwd ?? null,
    );
    return get("projects", id);
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/projects$/, ({ a, p }) => {
    company(a, p[0]);
    return all("select * from projects where companyId = ? order by rowid", p[0]);
  }],
  ["GET", /^\/api\/projects\/([^/]+)$/, ({ a, p }) => scoped(a, get("projects", p[0]))],

  ["POST", /^\/api\/companies\/([^/]+)\/issues$/, ({ a, p, body }) => {
    company(a, p[0]);
    inCompany(p[0], "agents", body.assigneeAgentId);
    inCompany(p[0], "issues", body.parentId);
    inCompany(p[0], "projects", body.projectId);
    // Child issues stay in the parent's project unless told otherwise.
    const projectId = body.projectId ?? (body.parentId && get("issues", body.parentId)?.projectId) ?? null;
    const id = randomUUID();
    run(
      "insert into issues (id, companyId, parentId, projectId, title, description, status, assigneeAgentId, createdByAgentId) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, p[0], body.parentId ?? null, projectId, need(body.title, "title"), body.description ?? "", body.status ?? "todo",
      body.assigneeAgentId ?? null, a.agentId ?? null,
    );
    const issue = get("issues", id)!;
    notify(a, undefined, issue);
    return issue;
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/issues$/, ({ a, p, q }) => {
    company(a, p[0]);
    return all(
      `select * from issues where companyId = ?1
         and (?2 is null or assigneeAgentId = ?2)
         and (?3 is null or status in (select value from json_each(?3)))
         and (?4 is null or projectId = ?4)
       order by rowid`,
      p[0], q.get("assigneeAgentId"), q.has("status") ? JSON.stringify(q.get("status")!.split(",")) : null, q.get("projectId"),
    );
  }],
  ["GET", /^\/api\/issues\/([^/]+)$/, ({ a, p }) => scoped(a, issueContext(p[0]))],
  ["PATCH", /^\/api\/issues\/([^/]+)$/, ({ a, p, body }) => {
    const before = scoped(a, get("issues", p[0]));
    inCompany(before.companyId, "agents", body.assigneeAgentId);
    inCompany(before.companyId, "issues", body.parentId);
    inCompany(before.companyId, "projects", body.projectId);
    update("issues", before.id, body, ["title", "description", "status", "assigneeAgentId", "parentId", "projectId"]);
    const after = get("issues", before.id)!;
    if (body.comment) comment(a, after, need(body.comment, "comment"));
    notify(a, before, after);
    return issueContext(before.id);
  }],
  ["POST", /^\/api\/issues\/([^/]+)\/comments$/, ({ a, p, body }) =>
    comment(a, scoped(a, get("issues", p[0])), need(body.body, "body"))],

  ["GET", /^\/api\/companies\/([^/]+)\/runs$/, ({ a, p }) => {
    company(a, p[0]);
    return all(`select ${RUN_COLS} from runs where companyId = ? order by rowid desc limit 100`, p[0]);
  }],
  ["GET", /^\/api\/runs\/([^/]+)$/, ({ a, p }) => scoped(a, getRun(p[0]))],
  ["POST", /^\/api\/runs\/([^/]+)\/cancel$/, ({ a, p }) => {
    boardOnly(a);
    cancel(scoped(a, getRun(p[0])).id);
    return getRun(p[0]);
  }],
];

export const server = createServer(async (req, res) => {
  let status = 200;
  let out: unknown;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = Buffer.concat(await Array.fromAsync(req)).toString();
    const body: Row = (raw && JSON.parse(raw)) || {};
    const a = actorOf(req);
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname)) ?? fail(404, "no such route");
    out = route[2]({ a, p: route[1].exec(url.pathname)!.slice(1), body, q: url.searchParams });
  } catch (e: any) {
    // Bad JSON, CHECK/FK violations and unbindable values are client errors.
    status = e.status ?? (e instanceof SyntaxError || String(e.code).startsWith("ERR_") ? 400 : 500);
    out = { error: e.message };
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
});

const HOST = process.env.HOST ?? "127.0.0.1";
server.listen(Number(process.env.PORT ?? 3100), HOST, () => {
  const { port } = server.address() as AddressInfo;
  process.env.STAPLE_API_URL = `http://${HOST}:${port}`; // inherited by agent processes
  console.log(`staple listening on ${process.env.STAPLE_API_URL}`);
  recover();
});
