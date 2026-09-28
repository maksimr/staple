PRAGMA journal_mode = wal;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cwd TEXT, -- shared workspace for the company's agents
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  companyId TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '', -- presentation only, shown in prompts
  reportsTo TEXT REFERENCES agents(id),
  instructions TEXT NOT NULL DEFAULT '',
  model TEXT, -- passed to pi --model, e.g. "anthropic/claude-sonnet-4-5"
  thinking TEXT, -- passed to pi --thinking, e.g. "high"
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  companyId TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cwd TEXT, -- workspace for the project's issues; falls back to the company cwd
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  companyId TEXT NOT NULL REFERENCES companies(id),
  parentId TEXT REFERENCES issues(id),
  projectId TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled')),
  assigneeAgentId TEXT REFERENCES agents(id),
  createdByAgentId TEXT REFERENCES agents(id),
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issueId TEXT NOT NULL REFERENCES issues(id),
  authorAgentId TEXT REFERENCES agents(id), -- null = board
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  companyId TEXT NOT NULL REFERENCES companies(id),
  agentId TEXT NOT NULL REFERENCES agents(id),
  issueId TEXT REFERENCES issues(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  token TEXT UNIQUE, -- bearer key for the agent while the run is live
  exitCode INTEGER,
  summary TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  startedAt TEXT,
  finishedAt TEXT
);
