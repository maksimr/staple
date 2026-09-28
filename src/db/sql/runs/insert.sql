INSERT INTO runs (id, companyId, agentId, issueId, reason)
SELECT $id, companyId, id, $issueId, $reason FROM agents WHERE id = $agentId
