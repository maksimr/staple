#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-import-text
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { all, issueContext, one, run, type Row } from "./db.ts";
import { cancel, recover, tick, wake } from "./orchestrator.ts";
import getAgent from "./sql/agents/get.sql" with { type: "text" };
import insertAgent from "./sql/agents/insert.sql" with { type: "text" };
import listAgents from "./sql/agents/list.sql" with { type: "text" };
import updateAgent from "./sql/agents/update.sql" with { type: "text" };
import getComment from "./sql/comments/get.sql" with { type: "text" };
import insertComment from "./sql/comments/insert.sql" with { type: "text" };
import getCompany from "./sql/companies/get.sql" with { type: "text" };
import insertCompany from "./sql/companies/insert.sql" with { type: "text" };
import listCompanies from "./sql/companies/list.sql" with { type: "text" };
import getIssue from "./sql/issues/get.sql" with { type: "text" };
import insertIssue from "./sql/issues/insert.sql" with { type: "text" };
import listIssues from "./sql/issues/list.sql" with { type: "text" };
import updateIssue from "./sql/issues/update.sql" with { type: "text" };
import getProject from "./sql/projects/get.sql" with { type: "text" };
import insertProject from "./sql/projects/insert.sql" with { type: "text" };
import listProjects from "./sql/projects/list.sql" with { type: "text" };
import runActor from "./sql/runs/actor.sql" with { type: "text" };
import getRun from "./sql/runs/get.sql" with { type: "text" };
import listRuns from "./sql/runs/list.sql" with { type: "text" };

/** Board = no token (local trusted, like paperclip's local_trusted mode). Agent = live run token. */
type Actor = { agentId?: string; companyId?: string };
type Ctx = { a: Actor; p: string[]; body: Row; q: URLSearchParams };

const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const need = (v: unknown, name: string) => (typeof v === "string" && v.trim() ? v : fail(422, `${name} is required`));
const byId = { companies: getCompany, agents: getAgent, projects: getProject, issues: getIssue };
const get = (table: keyof typeof byId, id: string) => one(byId[table], { id });

function actorOf(req: IncomingMessage): Actor {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return {};
  return one(runActor, { token }) ?? fail(401, "invalid or expired token");
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
  if (id != null && get(table, id as string)?.companyId !== companyId) {
    fail(422, `${table} ${id} not found in company`);
  }
}

/** `cols` must match the `$params` in `sql`; unset ones would bind null. */
function update(sql: string, row: Row, body: Row, cols: string[]) {
  run(sql, { id: row.id, ...Object.fromEntries(cols.map((k) => [k, k in body ? body[k] : row[k]])) });
}

function comment(a: Actor, issue: Row, body: string) {
  const id = randomUUID();
  run(insertComment, { id, issueId: issue.id, authorAgentId: a.agentId ?? null, body });
  // Agent chatter on closed issues stays inert; the board can always reopen a conversation.
  if (issue.assigneeAgentId && (!a.agentId || !["done", "cancelled"].includes(issue.status))) {
    wake(issue.assigneeAgentId, issue.id, "issue_commented", a.agentId);
  }
  return one(getComment, { id });
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
    run(insertCompany, { id, name: need(body.name, "name"), description: body.description ?? "", cwd: body.cwd ?? null });
    return get("companies", id);
  }],
  ["GET", /^\/api\/companies$/, ({ a }) =>
    a.companyId ? [get("companies", a.companyId)] : all(listCompanies)],
  ["GET", /^\/api\/companies\/([^/]+)$/, ({ a, p }) => company(a, p[0])],

  ["POST", /^\/api\/companies\/([^/]+)\/agents$/, ({ a, p, body }) => {
    boardOnly(a);
    company(a, p[0]);
    inCompany(p[0], "agents", body.reportsTo);
    const id = randomUUID();
    run(insertAgent, {
      id, companyId: p[0], name: need(body.name, "name"), role: body.role ?? "", reportsTo: body.reportsTo ?? null,
      instructions: body.instructions ?? "", model: body.model ?? null, thinking: body.thinking ?? null,
    });
    return get("agents", id);
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/agents$/, ({ a, p }) => {
    company(a, p[0]);
    return all(listAgents, { companyId: p[0] });
  }],
  ["GET", /^\/api\/agents\/me$/, ({ a }) => get("agents", a.agentId ?? fail(400, "not an agent"))],
  ["GET", /^\/api\/agents\/([^/]+)$/, ({ a, p }) => scoped(a, get("agents", p[0]))],
  ["PATCH", /^\/api\/agents\/([^/]+)$/, ({ a, p, body }) => {
    boardOnly(a);
    const agent = scoped(a, get("agents", p[0]));
    inCompany(agent.companyId, "agents", body.reportsTo);
    update(updateAgent, agent, body, ["name", "role", "reportsTo", "instructions", "model", "thinking", "status"]);
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
    run(insertProject, { id, companyId: p[0], name: need(body.name, "name"), description: body.description ?? "", cwd: body.cwd ?? null });
    return get("projects", id);
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/projects$/, ({ a, p }) => {
    company(a, p[0]);
    return all(listProjects, { companyId: p[0] });
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
    run(insertIssue, {
      id, companyId: p[0], parentId: body.parentId ?? null, projectId, title: need(body.title, "title"), description: body.description ?? "",
      status: body.status ?? "todo", assigneeAgentId: body.assigneeAgentId ?? null, createdByAgentId: a.agentId ?? null,
    });
    const issue = get("issues", id)!;
    notify(a, undefined, issue);
    return issue;
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/issues$/, ({ a, p, q }) => {
    company(a, p[0]);
    return all(listIssues, {
      companyId: p[0], assigneeAgentId: q.get("assigneeAgentId"), projectId: q.get("projectId"),
      statuses: q.has("status") ? JSON.stringify(q.get("status")!.split(",")) : null,
    });
  }],
  ["GET", /^\/api\/issues\/([^/]+)$/, ({ a, p }) => scoped(a, issueContext(p[0]))],
  ["PATCH", /^\/api\/issues\/([^/]+)$/, ({ a, p, body }) => {
    const before = scoped(a, get("issues", p[0]));
    inCompany(before.companyId, "agents", body.assigneeAgentId);
    inCompany(before.companyId, "issues", body.parentId);
    inCompany(before.companyId, "projects", body.projectId);
    update(updateIssue, before, body, ["title", "description", "status", "assigneeAgentId", "parentId", "projectId"]);
    const after = get("issues", before.id)!;
    if (body.comment) comment(a, after, need(body.comment, "comment"));
    notify(a, before, after);
    return issueContext(before.id);
  }],
  ["POST", /^\/api\/issues\/([^/]+)\/comments$/, ({ a, p, body }) =>
    comment(a, scoped(a, get("issues", p[0])), need(body.body, "body"))],

  ["GET", /^\/api\/companies\/([^/]+)\/runs$/, ({ a, p }) => {
    company(a, p[0]);
    return all(listRuns, { companyId: p[0] });
  }],
  ["GET", /^\/api\/runs\/([^/]+)$/, ({ a, p }) => scoped(a, one(getRun, { id: p[0] }))],
  ["POST", /^\/api\/runs\/([^/]+)\/cancel$/, ({ a, p }) => {
    boardOnly(a);
    cancel(scoped(a, one(getRun, { id: p[0] })).id);
    return one(getRun, { id: p[0] });
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
