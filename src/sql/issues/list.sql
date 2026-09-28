-- null filters match everything; $statuses is a JSON array
SELECT * FROM issues WHERE companyId = $companyId
  AND ($assigneeAgentId IS NULL OR assigneeAgentId = $assigneeAgentId)
  AND ($statuses IS NULL OR status IN (SELECT value FROM json_each($statuses)))
  AND ($projectId IS NULL OR projectId = $projectId)
ORDER BY rowid
