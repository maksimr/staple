import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  Agent, AgentRef, AgentUpdate, Comment, Company, Issue, IssueContext, IssueFilter, IssueUpdate, NewAgent, NewComment,
  NewCompany, NewIssue, NewProject, NewRun, Project, Run, RunActor, RunResult, Store,
} from "../core/types.ts";
import schema from "./sql/schema.sql" with { type: "text" };
import agentReports from "./sql/agents/reports.sql" with { type: "text" };
import getAgent from "./sql/agents/get.sql" with { type: "text" };
import insertAgent from "./sql/agents/insert.sql" with { type: "text" };
import listAgents from "./sql/agents/list.sql" with { type: "text" };
import updateAgent from "./sql/agents/update.sql" with { type: "text" };
import getComment from "./sql/comments/get.sql" with { type: "text" };
import insertComment from "./sql/comments/insert.sql" with { type: "text" };
import listComments from "./sql/comments/list.sql" with { type: "text" };
import getCompany from "./sql/companies/get.sql" with { type: "text" };
import insertCompany from "./sql/companies/insert.sql" with { type: "text" };
import listCompanies from "./sql/companies/list.sql" with { type: "text" };
import issueChildren from "./sql/issues/children.sql" with { type: "text" };
import getIssue from "./sql/issues/get.sql" with { type: "text" };
import insertIssue from "./sql/issues/insert.sql" with { type: "text" };
import listIssues from "./sql/issues/list.sql" with { type: "text" };
import updateIssue from "./sql/issues/update.sql" with { type: "text" };
import projectForIssue from "./sql/projects/for-issue.sql" with { type: "text" };
import getProject from "./sql/projects/get.sql" with { type: "text" };
import insertProject from "./sql/projects/insert.sql" with { type: "text" };
import listProjects from "./sql/projects/list.sql" with { type: "text" };
import runActor from "./sql/runs/actor.sql" with { type: "text" };
import cancelRun from "./sql/runs/cancel.sql" with { type: "text" };
import finishRun from "./sql/runs/finish.sql" with { type: "text" };
import getRun from "./sql/runs/get.sql" with { type: "text" };
import insertRun from "./sql/runs/insert.sql" with { type: "text" };
import listRuns from "./sql/runs/list.sql" with { type: "text" };
import queuedRun from "./sql/runs/queued.sql" with { type: "text" };
import readyRuns from "./sql/runs/ready.sql" with { type: "text" };
import recoverRuns from "./sql/runs/recover.sql" with { type: "text" };
import startRun from "./sql/runs/start.sql" with { type: "text" };

type Params = Record<string, SQLInputValue>;

export class SqliteStore implements Store {
  #db: DatabaseSync;

  /** Opens (and creates) `dataDir/db.sqlite`. */
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#db = new DatabaseSync(join(dataDir, "db.sqlite"));
    this.#db.exec(schema);
  }

  // `sql` is an imported .sql file; `params` bind to its `$name` placeholders.
  // Rows are `any`: the method signatures type them, and the schema is what makes that true.
  #one(sql: string, params: Params = {}): any {
    return this.#db.prepare(sql).get(params);
  }
  #all(sql: string, params: Params = {}): any[] {
    return this.#db.prepare(sql).all(params);
  }
  #run(sql: string, params: Params = {}) {
    this.#db.prepare(sql).run(params);
  }
  /** Assigns the id and returns the stored row. */
  #insert(sql: string, get: string, row: Params) {
    const id = randomUUID();
    this.#run(sql, { ...row, id });
    return this.#one(get, { id });
  }

  companyGet(id: string): Company | undefined { return this.#one(getCompany, { id }); }
  companyList(): Company[] { return this.#all(listCompanies); }
  companyInsert(c: NewCompany): Company { return this.#insert(insertCompany, getCompany, c); }

  agentGet(id: string): Agent | undefined { return this.#one(getAgent, { id }); }
  agentList(companyId: string): Agent[] { return this.#all(listAgents, { companyId }); }
  agentReports(id: string): AgentRef[] { return this.#all(agentReports, { id }); }
  agentInsert(a: NewAgent): Agent { return this.#insert(insertAgent, getAgent, a); }
  agentUpdate(a: AgentUpdate) { this.#run(updateAgent, a); }

  projectGet(id: string): Project | undefined { return this.#one(getProject, { id }); }
  projectList(companyId: string): Project[] { return this.#all(listProjects, { companyId }); }
  projectForIssue(issueId: string): Project | undefined { return this.#one(projectForIssue, { issueId }); }
  projectInsert(p: NewProject): Project { return this.#insert(insertProject, getProject, p); }

  issueGet(id: string): Issue | undefined { return this.#one(getIssue, { id }); }
  issueList(f: IssueFilter): Issue[] {
    return this.#all(listIssues, { ...f, statuses: f.statuses && JSON.stringify(f.statuses) });
  }
  issueContext(id: string): IssueContext | undefined {
    const issue = this.#one(getIssue, { id });
    if (!issue) return undefined;
    // ponytail: full comment thread every time; paginate when threads get long
    issue.comments = this.#all(listComments, { issueId: id });
    issue.project = this.#one(getProject, { id: issue.projectId });
    issue.children = this.#all(issueChildren, { id });
    return issue;
  }
  issueInsert(i: NewIssue): Issue { return this.#insert(insertIssue, getIssue, i); }
  issueUpdate(i: IssueUpdate) { this.#run(updateIssue, i); }

  commentInsert(c: NewComment): Comment { return this.#insert(insertComment, getComment, c); }

  runGet(id: string): Run | undefined { return this.#one(getRun, { id }); }
  runList(companyId: string): Run[] { return this.#all(listRuns, { companyId }); }
  runActor(token: string): RunActor | undefined { return this.#one(runActor, { token }); }
  runQueued(agentId: string, issueId: string | null) { return !!this.#one(queuedRun, { agentId, issueId }); }
  runReady(): Run[] { return this.#all(readyRuns); }
  runInsert(r: NewRun) { this.#run(insertRun, { ...r, id: randomUUID() }); }
  runStart(id: string, token: string) { this.#run(startRun, { id, token }); }
  runFinish(r: RunResult) { this.#run(finishRun, r); }
  runCancel(id: string) { this.#run(cancelRun, { id }); }
  runRecover() { this.#run(recoverRuns); }
}
