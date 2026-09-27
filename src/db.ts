import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Row = Record<string, any>;

export const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), ".staple");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, "db.sqlite"));
db.exec(`
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists companies (
  id text primary key,
  name text not null,
  description text not null default '',
  cwd text, -- shared workspace for the company's agents
  createdAt text not null default current_timestamp
);

create table if not exists agents (
  id text primary key,
  companyId text not null references companies(id),
  name text not null,
  role text not null default '', -- presentation only, shown in prompts
  reportsTo text references agents(id),
  instructions text not null default '',
  model text, -- passed to pi --model, e.g. "anthropic/claude-sonnet-4-5"
  thinking text, -- passed to pi --thinking, e.g. "high"
  status text not null default 'active' check (status in ('active', 'paused')),
  createdAt text not null default current_timestamp
);

create table if not exists projects (
  id text primary key,
  companyId text not null references companies(id),
  name text not null,
  description text not null default '',
  cwd text, -- workspace for the project's issues; falls back to the company cwd
  createdAt text not null default current_timestamp
);

create table if not exists issues (
  id text primary key,
  companyId text not null references companies(id),
  parentId text references issues(id),
  projectId text references projects(id),
  title text not null,
  description text not null default '',
  status text not null default 'todo'
    check (status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled')),
  assigneeAgentId text references agents(id),
  createdByAgentId text references agents(id),
  createdAt text not null default current_timestamp
);

create table if not exists comments (
  id text primary key,
  issueId text not null references issues(id),
  authorAgentId text references agents(id), -- null = board
  body text not null,
  createdAt text not null default current_timestamp
);

create table if not exists runs (
  id text primary key,
  companyId text not null references companies(id),
  agentId text not null references agents(id),
  issueId text references issues(id),
  reason text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  token text unique, -- bearer key for the agent while the run is live
  exitCode integer,
  summary text,
  createdAt text not null default current_timestamp,
  startedAt text,
  finishedAt text
);
`);

export const one = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as Row | undefined;
export const all = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as Row[];
export const run = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);

// Everything except the token, which must never leave the server.
export const RUN_COLS = "id, companyId, agentId, issueId, reason, status, exitCode, summary, createdAt, startedAt, finishedAt";

export function issueContext(id: string) {
  const issue = one("select * from issues where id = ?", id);
  if (!issue) return undefined;
  // ponytail: full comment thread every time; paginate when threads get long
  issue.comments = all("select * from comments where issueId = ? order by rowid", id);
  issue.project = one("select * from projects where id = ?", issue.projectId);
  issue.children = all("select id, title, status, assigneeAgentId from issues where parentId = ? order by rowid", id);
  return issue;
}
