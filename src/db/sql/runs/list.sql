-- Everything except the token, which must never leave the server.
SELECT id, companyId, agentId, issueId, reason, status, exitCode, summary, createdAt, startedAt, finishedAt
FROM runs WHERE companyId = $companyId ORDER BY rowid DESC LIMIT 100
