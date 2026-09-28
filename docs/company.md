# Company

A company is the top-level tenant. Every agent, project, issue and run belongs to one company, and an agent's token can't reach outside it.

## Fields

Table `companies` in `src/sql/schema.sql`.

| Column | Default | Meaning |
|---|---|---|
| `id` | uuid | |
| `name` | required | Shown to agents in the system prompt |
| `description` | `''` | Shown to every agent as `Company description:`. Empty shows `(none)` |
| `cwd` | `null` | Working directory for runs that don't get one from a project |
| `createdAt` | now | |

## Workspace

`start()` in `src/orchestrator.ts` picks a run's working directory in this order:

1. `cwd` of the project of the run's issue
2. `companies.cwd`
3. `$DATA_DIR/workspaces/<companyId>`

staple creates the directory when a run starts, not when the company is created. Use absolute paths. A relative `cwd` resolves against the server's working directory.

All agents in a company share this directory, and different agents run at the same time. Nothing locks it, so two agents can edit the same files at once. Give parallel streams of work separate projects with separate `cwd`s.

## API

| Method | Path | Caller | Notes |
|---|---|---|---|
| POST | `/api/companies` | board | `{name, description?, cwd?}`. 422 without `name` |
| GET | `/api/companies` | both | An agent gets a list with only its own company |
| GET | `/api/companies/:id` | both | 403 for an agent from another company |

There is no `PATCH` or `DELETE`.

## Scoping

Three helpers in `src/server.ts` keep agents inside their company. Every route that takes an id must use them.

- `scoped(a, row, companyId?)` returns 404 when the row is missing and 403 when an agent reads another company's row.
- `company(a, id)` does the same for a company id.
- `inCompany(companyId, table, id)` returns 422 when a referenced id (`reportsTo`, `assigneeAgentId`, `parentId`, `projectId`) belongs to another company. `null` and missing ids pass.

The board has no company, so these checks never block it.

## Extending

Add a company field:

1. Add the column to `companies` in `src/sql/schema.sql`. Read [index.md](index.md#schema-changes-have-no-migrations) first.
2. Insert it in `src/sql/companies/insert.sql` and `POST /api/companies` in `src/server.ts`.
3. If agents need it, print it in `systemPrompt()` in `src/orchestrator.ts`.
4. Update the API tables ([index.md](index.md#keep-the-api-docs-in-sync)).

Add `PATCH /api/companies/:id`. Add `src/sql/companies/update.sql` (`update companies set name = $name, description = $description, cwd = $cwd where id = $id`) and import it as `updateCompany` in `src/server.ts`.

```ts
["PATCH", /^\/api\/companies\/([^/]+)$/, ({ a, p, body }) => {
  boardOnly(a);
  update(updateCompany, company(a, p[0]), body, ["name", "description", "cwd"]);
  return get("companies", p[0]);
}],
```

A new description reaches agents on their next run, because `systemPrompt()` reads the company at spawn time.
