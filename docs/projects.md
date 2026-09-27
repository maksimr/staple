# Projects

A project groups a company's issues and pins their runs to a working directory. Use one project per repository.

## Fields

Table `projects` in `src/db.ts`.

| Column | Default | Meaning |
|---|---|---|
| `id` | uuid | |
| `companyId` | required | |
| `name` | required | |
| `description` | `''` | Agents see it inside the issue JSON of the wake prompt |
| `cwd` | `null` | Working directory for runs on this project's issues |
| `createdAt` | now | |

## Effect on runs

`start()` in `src/orchestrator.ts` finds the project through the run's issue (`issues.projectId`). If that project has a `cwd`, pi starts there. Otherwise the company's workspace applies ([company.md](company.md#workspace)).

A run with no issue, such as a manual wake without `issueId`, never uses a project `cwd`.

The system prompt doesn't mention projects. Agents learn about the project from `issue.project` in the wake prompt, which `issueContext()` in `src/db.ts` attaches, and they can list projects with `GET /api/companies/:id/projects`.

## Inheritance

When `POST /api/companies/:id/issues` gets a `parentId` and no `projectId`, the new issue copies the parent's `projectId`. This happens once, at creation. Changing the parent's project later, or moving an issue with `PATCH parentId`, doesn't copy anything.

## API

| Method | Path | Caller | Notes |
|---|---|---|---|
| POST | `/api/companies/:id/projects` | board | `{name, description?, cwd?}` |
| GET | `/api/companies/:id/projects` | both | |
| GET | `/api/projects/:id` | both | |
| GET | `/api/companies/:id/issues?projectId=` | both | Issues in a project |

There is no `PATCH` or `DELETE`. staple doesn't check that `cwd` exists. It creates the directory when a run starts.

## Extending

- `PATCH /api/projects/:id` follows the same pattern as the company example in [company.md](company.md#extending), with `projects` in place of `companies`.
- Per-project instructions don't exist. `description` already reaches every agent working on the project's issues, so put standing instructions there before adding a column.
- A new project field shows up in the wake prompt without extra work, because `issueContext()` selects `*` from `projects`.
