// Contracts between the agent loop (core), persistence (src/db) and the HTTP API (src/server).
// Entities mirror the tables in src/db/sql/schema.sql; timestamps are SQLite UTC strings.

export interface Company {
  id: string;
  name: string;
  description: string;
  cwd: string | null; // shared workspace for the company's agents
  createdAt: string;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  role: string;
  reportsTo: string | null;
  instructions: string;
  model: string | null;
  thinking: string | null;
  status: "active" | "paused";
  createdAt: string;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  description: string;
  cwd: string | null; // falls back to the company cwd
  createdAt: string;
}

export interface Issue {
  id: string;
  companyId: string;
  parentId: string | null;
  projectId: string | null;
  title: string;
  description: string;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
}

/** What agents see for an issue: `GET /api/issues/:id` and the wake prompt. */
export interface IssueContext extends Issue {
  comments: Comment[];
  project: Project | undefined;
  children: Pick<Issue, "id" | "title" | "status" | "assigneeAgentId">[];
}

export interface Comment {
  id: string;
  issueId: string;
  authorAgentId: string | null; // null = board
  body: string;
  createdAt: string;
}

/** Never carries its token. */
export interface Run {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  reason: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  summary: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// Store inputs and partial rows. Inserts get their id from the store.
export type NewCompany = Omit<Company, "id" | "createdAt">;
export type NewAgent = Omit<Agent, "id" | "status" | "createdAt">;
export type AgentUpdate = Omit<Agent, "companyId" | "createdAt">;
export type AgentRef = Pick<Agent, "id" | "name" | "role">;
export type NewProject = Omit<Project, "id" | "createdAt">;
export type NewIssue = Omit<Issue, "id" | "createdAt">;
export type IssueUpdate = Omit<Issue, "companyId" | "createdByAgentId" | "createdAt">;
/** Null filters match everything. */
export type IssueFilter = { companyId: string; assigneeAgentId: string | null; projectId: string | null; statuses: string[] | null };
export type NewComment = Omit<Comment, "id" | "createdAt">;
export type NewRun = Pick<Run, "agentId" | "issueId" | "reason">;
export type RunResult = Pick<Run, "id" | "exitCode" | "summary"> & { status: "succeeded" | "failed" };
export type RunActor = Pick<Run, "agentId" | "companyId">;

/** Persistence port, implemented by src/db. Core and server never see SQL. */
export interface Store {
  companyGet(id: string): Company | undefined;
  companyList(): Company[];
  companyInsert(company: NewCompany): Company;

  agentGet(id: string): Agent | undefined;
  agentList(companyId: string): Agent[];
  /** Direct reports. */
  agentReports(id: string): AgentRef[];
  agentInsert(agent: NewAgent): Agent;
  agentUpdate(agent: AgentUpdate): void;

  projectGet(id: string): Project | undefined;
  projectList(companyId: string): Project[];
  projectForIssue(issueId: string): Project | undefined;
  projectInsert(project: NewProject): Project;

  issueGet(id: string): Issue | undefined;
  issueList(filter: IssueFilter): Issue[];
  issueContext(id: string): IssueContext | undefined;
  issueInsert(issue: NewIssue): Issue;
  issueUpdate(issue: IssueUpdate): void;

  commentInsert(comment: NewComment): Comment;

  runGet(id: string): Run | undefined;
  /** Newest first, at most 100. */
  runList(companyId: string): Run[];
  /** Agent and company of the live run holding `token`. */
  runActor(token: string): RunActor | undefined;
  runQueued(agentId: string, issueId: string | null): boolean;
  /** Queued runs whose agent is active and has no live run, oldest first. */
  runReady(): Run[];
  runInsert(run: NewRun): void;
  runStart(id: string, token: string): void;
  runFinish(run: RunResult): void;
  runCancel(id: string): void;
  /** Fail every run still marked running. */
  runRecover(): void;
}

/** What the server tells the agent loop. Any call may spawn pi processes. */
export interface Orchestrator {
  /** Queue a heartbeat for an agent. Pending wakes for the same agent+issue coalesce into one run. */
  wake(agentId: string, issueId: string | null, reason: string, actorAgentId?: string): void;
  /** Start queued runs: one live run per agent, paused agents wait. */
  tick(): void;
  cancel(runId: string): void;
  /** Runs that were live when the server died can't be resumed; fail them and move on. */
  recover(): void;
  /** An issue was created (`before` undefined) or updated. */
  issueChanged(before: Issue | undefined, after: Issue, actorAgentId?: string): void;
  commented(issue: Issue, actorAgentId?: string): void;
}
