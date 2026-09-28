import { Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Issue, Orchestrator, Store } from "../core/types.ts";

/** Board = no token (local trusted, like paperclip's local_trusted mode). Agent = live run token. */
type Actor = { agentId?: string; companyId?: string };
/** Parsed request body: untrusted JSON; SQLite CHECK and FK constraints reject bad values. */
type Json = Record<string, any>;
type Ctx = { a: Actor; p: string[]; body: Json; q: URLSearchParams };
type Route = [method: string, path: RegExp, handler: (c: Ctx) => unknown];

const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const need = (v: unknown, name: string) => (typeof v === "string" && v.trim() ? v : fail(422, `${name} is required`));

/** 404 if missing, 403 if an agent reaches outside its company. */
function scoped<T extends { id: string; companyId?: string }>(a: Actor, row: T | undefined, companyId = row?.companyId): T {
  if (!row) return fail(404, "not found");
  if (a.companyId && a.companyId !== companyId) fail(403, "forbidden");
  return row;
}
const boardOnly = (a: Actor) => a.agentId && fail(403, "board only");

/** PATCH semantics: each of `cols` comes from `body` if present, else from `row`. The store writes all of them. */
const patch = <T extends { id: string }, K extends keyof T & string>(row: T, body: Json, cols: K[]) =>
  ({ id: row.id, ...Object.fromEntries(cols.map((k) => [k, k in body ? body[k] : row[k]])) }) as Pick<T, "id" | K>;

/** The HTTP API: routes over a Store, wake events to the Orchestrator. */
export class ApiServer extends Server {
  #store: Store;
  #core: Orchestrator;

  constructor(store: Store, core: Orchestrator) {
    super();
    this.#store = store;
    this.#core = core;
    this.on("request", (req, res) => this.#handle(req, res));
  }

  #actorOf(req: IncomingMessage): Actor {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return {};
    return this.#store.runActor(token) ?? fail(401, "invalid or expired token");
  }

  #company(a: Actor, id: string) {
    return scoped(a, this.#store.companyGet(id), id);
  }

  #lookup = {
    agents: (id: string) => this.#store.agentGet(id),
    projects: (id: string) => this.#store.projectGet(id),
    issues: (id: string) => this.#store.issueGet(id),
  };
  #inCompany(companyId: string, table: "agents" | "projects" | "issues", id: unknown) {
    if (id != null && this.#lookup[table](id as string)?.companyId !== companyId) {
      fail(422, `${table} ${id} not found in company`);
    }
  }

  #comment(a: Actor, issue: Issue, body: string) {
    const row = this.#store.commentInsert({ issueId: issue.id, authorAgentId: a.agentId ?? null, body });
    this.#core.commented(issue, a.agentId);
    return row;
  }

  #routes: Route[] = [
    ["GET", /^\/api\/health$/, () => ({ ok: true })],

    ["POST", /^\/api\/companies$/, ({ a, body }) => {
      boardOnly(a);
      return this.#store.companyInsert({ name: need(body.name, "name"), description: body.description ?? "", cwd: body.cwd ?? null });
    }],
    ["GET", /^\/api\/companies$/, ({ a }) =>
      a.companyId ? [this.#store.companyGet(a.companyId)] : this.#store.companyList()],
    ["GET", /^\/api\/companies\/([^/]+)$/, ({ a, p }) => this.#company(a, p[0])],

    ["POST", /^\/api\/companies\/([^/]+)\/agents$/, ({ a, p, body }) => {
      boardOnly(a);
      this.#company(a, p[0]);
      this.#inCompany(p[0], "agents", body.reportsTo);
      return this.#store.agentInsert({
        companyId: p[0], name: need(body.name, "name"), role: body.role ?? "", reportsTo: body.reportsTo ?? null,
        instructions: body.instructions ?? "", model: body.model ?? null, thinking: body.thinking ?? null,
      });
    }],
    ["GET", /^\/api\/companies\/([^/]+)\/agents$/, ({ a, p }) => {
      this.#company(a, p[0]);
      return this.#store.agentList(p[0]);
    }],
    ["GET", /^\/api\/agents\/me$/, ({ a }) => this.#store.agentGet(a.agentId ?? fail(400, "not an agent"))],
    ["GET", /^\/api\/agents\/([^/]+)$/, ({ a, p }) => scoped(a, this.#store.agentGet(p[0]))],
    ["PATCH", /^\/api\/agents\/([^/]+)$/, ({ a, p, body }) => {
      boardOnly(a);
      const agent = scoped(a, this.#store.agentGet(p[0]));
      this.#inCompany(agent.companyId, "agents", body.reportsTo);
      this.#store.agentUpdate(patch(agent, body, ["name", "role", "reportsTo", "instructions", "model", "thinking", "status"]));
      this.#core.tick(); // resuming a paused agent releases its queued runs
      return this.#store.agentGet(agent.id);
    }],
    ["POST", /^\/api\/agents\/([^/]+)\/wake$/, ({ a, p, body }) => {
      const agent = scoped(a, this.#store.agentGet(p[0]));
      this.#inCompany(agent.companyId, "issues", body.issueId);
      this.#core.wake(agent.id, body.issueId ?? null, body.reason ?? "manual", a.agentId);
      return { ok: true };
    }],

    ["POST", /^\/api\/companies\/([^/]+)\/projects$/, ({ a, p, body }) => {
      boardOnly(a);
      this.#company(a, p[0]);
      return this.#store.projectInsert({ companyId: p[0], name: need(body.name, "name"), description: body.description ?? "", cwd: body.cwd ?? null });
    }],
    ["GET", /^\/api\/companies\/([^/]+)\/projects$/, ({ a, p }) => {
      this.#company(a, p[0]);
      return this.#store.projectList(p[0]);
    }],
    ["GET", /^\/api\/projects\/([^/]+)$/, ({ a, p }) => scoped(a, this.#store.projectGet(p[0]))],

    ["POST", /^\/api\/companies\/([^/]+)\/issues$/, ({ a, p, body }) => {
      this.#company(a, p[0]);
      this.#inCompany(p[0], "agents", body.assigneeAgentId);
      this.#inCompany(p[0], "issues", body.parentId);
      this.#inCompany(p[0], "projects", body.projectId);
      // Child issues stay in the parent's project unless told otherwise.
      const projectId = body.projectId ?? (body.parentId && this.#store.issueGet(body.parentId)?.projectId) ?? null;
      const issue = this.#store.issueInsert({
        companyId: p[0], parentId: body.parentId ?? null, projectId, title: need(body.title, "title"), description: body.description ?? "",
        status: body.status ?? "todo", assigneeAgentId: body.assigneeAgentId ?? null, createdByAgentId: a.agentId ?? null,
      });
      this.#core.issueChanged(undefined, issue, a.agentId);
      return issue;
    }],
    ["GET", /^\/api\/companies\/([^/]+)\/issues$/, ({ a, p, q }) => {
      this.#company(a, p[0]);
      return this.#store.issueList({
        companyId: p[0], assigneeAgentId: q.get("assigneeAgentId"), projectId: q.get("projectId"),
        statuses: q.get("status")?.split(",") ?? null,
      });
    }],
    ["GET", /^\/api\/issues\/([^/]+)$/, ({ a, p }) => scoped(a, this.#store.issueContext(p[0]))],
    ["PATCH", /^\/api\/issues\/([^/]+)$/, ({ a, p, body }) => {
      const before = scoped(a, this.#store.issueGet(p[0]));
      this.#inCompany(before.companyId, "agents", body.assigneeAgentId);
      this.#inCompany(before.companyId, "issues", body.parentId);
      this.#inCompany(before.companyId, "projects", body.projectId);
      this.#store.issueUpdate(patch(before, body, ["title", "description", "status", "assigneeAgentId", "parentId", "projectId"]));
      const after = this.#store.issueGet(before.id)!;
      if (body.comment) this.#comment(a, after, need(body.comment, "comment"));
      this.#core.issueChanged(before, after, a.agentId);
      return this.#store.issueContext(before.id);
    }],
    ["POST", /^\/api\/issues\/([^/]+)\/comments$/, ({ a, p, body }) =>
      this.#comment(a, scoped(a, this.#store.issueGet(p[0])), need(body.body, "body"))],

    ["GET", /^\/api\/companies\/([^/]+)\/runs$/, ({ a, p }) => {
      this.#company(a, p[0]);
      return this.#store.runList(p[0]);
    }],
    ["GET", /^\/api\/runs\/([^/]+)$/, ({ a, p }) => scoped(a, this.#store.runGet(p[0]))],
    ["POST", /^\/api\/runs\/([^/]+)\/cancel$/, ({ a, p }) => {
      boardOnly(a);
      this.#core.cancel(scoped(a, this.#store.runGet(p[0])).id);
      return this.#store.runGet(p[0]);
    }],
  ];

  async #handle(req: IncomingMessage, res: ServerResponse) {
    let status = 200;
    let out: unknown;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const raw = Buffer.concat(await Array.fromAsync(req)).toString();
      const body: Json = (raw && JSON.parse(raw)) || {};
      const a = this.#actorOf(req);
      const route = this.#routes.find(([m, re]) => m === req.method && re.test(url.pathname)) ?? fail(404, "no such route");
      out = route[2]({ a, p: route[1].exec(url.pathname)!.slice(1), body, q: url.searchParams });
    } catch (e: any) {
      // Bad JSON, CHECK/FK violations and unbindable values are client errors.
      status = e.status ?? (e instanceof SyntaxError || String(e.code).startsWith("ERR_") ? 400 : 500);
      out = { error: e.message };
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
  }
}
