import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import schema from "./sql/schema.sql" with { type: "text" };
import listComments from "./sql/comments/list.sql" with { type: "text" };
import issueChildren from "./sql/issues/children.sql" with { type: "text" };
import getIssue from "./sql/issues/get.sql" with { type: "text" };
import getProject from "./sql/projects/get.sql" with { type: "text" };

export type Row = Record<string, any>;

export const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), ".staple");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, "db.sqlite"));
db.exec(schema);

/** `sql` is an imported .sql file; `params` bind to its `$name` placeholders. */
type Params = Record<string, SQLInputValue>;
export const one = (sql: string, params: Params = {}) => db.prepare(sql).get(params) as Row | undefined;
export const all = (sql: string, params: Params = {}) => db.prepare(sql).all(params) as Row[];
export const run = (sql: string, params: Params = {}) => db.prepare(sql).run(params);

export function issueContext(id: string) {
  const issue = one(getIssue, { id });
  if (!issue) return undefined;
  // ponytail: full comment thread every time; paginate when threads get long
  issue.comments = all(listComments, { issueId: id });
  issue.project = one(getProject, { id: issue.projectId });
  issue.children = all(issueChildren, { id });
  return issue;
}
